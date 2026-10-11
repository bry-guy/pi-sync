import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BindingStore,
  type SyncBinding,
  SyncClient,
  SyncClientError,
  type SessionEnvelope,
  type SessionResponse,
  type PiEntry,
  deriveRepositoryIdentity,
  deriveWorkspacePointer,
  materializeSessionFile,
  normalizeSessionFile,
  repositoryIdentity,
  restoreHead,
} from "../src/index.js";

const HEARTBEAT_MS = Number(process.env.PI_SYNC_HEARTBEAT_MS) || 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
// Local-only entries of these types mean two devices really wrote the same conversation.
// Other local-only entries (model changes, names, extension state) are carried onto the newer copy.
const CONTEXT_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);

type CheckOutcome = "unchanged" | "busy" | "conflict" | "refreshed";
type CheckResult = { outcome: CheckOutcome; sessionId?: string; switched?: boolean };
type Replay = { sessionId: string; text: string; images?: unknown[] };
type HeldLease = { binding: SyncBinding; token: string; lost: boolean; timer?: ReturnType<typeof setInterval> };
type Acquired = { ok: true; acquired: { etag: string; lease: { token: string } } } | { ok: false; message: string };
type Fetched = { ok: true; snapshot: SessionResponse } | { ok: false; message: string };

function usefulTitle(title: unknown, ...placeholders: (string | undefined)[]): string {
  if (typeof title !== "string") return "";
  const value = title.trim();
  return value && !placeholders.includes(value) ? value : "";
}

function firstUserText(entries: readonly { type: string; message?: any }[]): string {
  const entry = entries.find((candidate) => candidate.type === "message" && candidate.message?.role === "user");
  const content = entry?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((part: any) => part?.type === "text")?.text ?? "" : "";
  return String(text).replace(/\s+/g, " ").trim().slice(0, 60);
}

function conversationTitle(ctx: ExtensionContext, binding?: SyncBinding): string {
  const sessionId = ctx.sessionManager.getSessionId();
  return usefulTitle(ctx.sessionManager.getSessionName(), sessionId) ||
    usefulTitle(binding?.title, binding?.nativeSessionId, binding?.canonicalSessionId) ||
    firstUserText(ctx.sessionManager.getEntries() as any[]);
}

/** Identifies the entry set and head so local-only changes can be detected cheaply. */
function entriesFingerprint(entries: readonly { id?: unknown }[], headEntryId: string | null | undefined): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${String(entry.id)}\n`);
  hash.update(`head:${headEntryId ?? ""}`);
  return `ids-${hash.digest("hex")}`;
}

function defaultDeviceLabel(): string {
  const configured = process.env.PI_SYNC_DEVICE_LABEL?.trim();
  if (configured) return configured.slice(0, 64);
  return hostname().split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64) || "pi";
}

function relativeAge(value: string | undefined): string {
  if (!value) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 90) return "just now";
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default function syncExtension(pi: ExtensionAPI) {
  const store = new BindingStore(getAgentDir());
  const deviceLabel = defaultDeviceLabel();
  let currentSessionId: string | undefined;
  let lease: HeldLease | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollGeneration = 0;
  let refreshDispatched = false;
  let busy: Promise<unknown> | undefined;
  let pendingReplay: Replay | undefined;

  const notify = (ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(message, level);
    } catch {
      // A replaced session invalidates its context; the message is no longer relevant.
    }
  };

  const setStatus = (ctx: ExtensionContext | undefined, text?: string) => {
    try {
      if (ctx?.hasUI) ctx.ui.setStatus("pi-sync", text);
    } catch {
      // A replaced session invalidates its context; the new session sets its own status.
    }
  };

  /** Command failures are thrown for host integrations (pi-ez-web) and only shown in interactive Pi. */
  const fail = (ctx: ExtensionContext, code: string, message: string): never | void => {
    notify(ctx, message, "error");
    if (ctx.mode === "json") throw Object.assign(new Error(message), { code });
  };

  const configuredUrl = (args = ""): string | undefined => {
    const candidate = args.trim().split(/\s+/).find((part) => /^https?:\/\//i.test(part));
    return candidate ?? process.env.PI_SYNC_SERVER_URL ?? process.env.PI_SYNC_URL;
  };

  const clientFor = (url: string): SyncClient => new SyncClient({ baseUrl: url, timeoutMs: REQUEST_TIMEOUT_MS });

  /** Serializes network/file operations so a background upload never races a prompt's acquisition. */
  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    while (busy) await busy.catch(() => undefined);
    const running = task();
    busy = running;
    try {
      return await running;
    } finally {
      if (busy === running) busy = undefined;
    }
  };

  const hasPendingInput = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.hasPendingMessages() || (ctx.hasUI && typeof ctx.ui.getEditorText === "function" && ctx.ui.getEditorText().length > 0);
    } catch {
      return true;
    }
  };

  const gitRunnerFor = (ctx: ExtensionContext) => async (command: string, args: string[]) => {
    const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 5_000 });
    return { stdout: result.stdout, code: result.code };
  };

  const repositoryFor = async (ctx: ExtensionContext): Promise<string | undefined> => {
    try {
      return await deriveRepositoryIdentity(ctx.cwd, gitRunnerFor(ctx));
    } catch {
      return undefined;
    }
  };

  const localFingerprint = (ctx: ExtensionContext) =>
    entriesFingerprint(ctx.sessionManager.getEntries() as { id?: unknown }[], ctx.sessionManager.getLeafId());

  const remoteFingerprint = (envelope: SessionEnvelope) => entriesFingerprint(envelope.entries, envelope.headEntryId);

  const normalizeCurrent = async (ctx: ExtensionContext, binding?: SyncBinding): Promise<SessionEnvelope> => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) throw new Error("synchronization requires a persistent Pi session");
    return normalizeSessionFile(path, {
      requestedSessionId: ctx.sessionManager.getSessionId(),
      headEntryId: ctx.sessionManager.getLeafId() ?? "",
      title: conversationTitle(ctx, binding),
      parentSessionId: binding?.parentSessionId,
      workspace: await deriveWorkspacePointer(ctx.cwd, gitRunnerFor(ctx)),
    });
  };

  const syncedBinding = (binding: SyncBinding, envelope: SessionEnvelope, etag: string, materializedFile = binding.materializedFile): SyncBinding => {
    const next: SyncBinding = {
      ...binding,
      state: "ready",
      lastEtag: etag,
      lastFingerprint: remoteFingerprint(envelope),
      materializedFile,
      workspace: envelope.workspace,
      parentSessionId: envelope.parentSessionId,
      title: envelope.title,
    };
    delete next.leaseToken;
    delete next.leaseExpiresAt;
    return next;
  };

  const markSetupRequired = async (ctx: ExtensionContext, binding: SyncBinding) => {
    const next: SyncBinding = { ...binding, state: "setup_required" };
    delete next.leaseToken;
    delete next.leaseExpiresAt;
    await store.set(next);
    setStatus(ctx, "sync: server copy missing (/sync attach)");
  };

  const explainFailure = async (ctx: ExtensionContext, binding: SyncBinding, error: unknown): Promise<string> => {
    const code = error instanceof SyncClientError ? error.code : "";
    if (code === "session_not_found") {
      await markSetupRequired(ctx, binding);
      return "The sync server no longer has this conversation. Run /sync attach to upload this copy again.";
    }
    if (code === "active_lease") {
      const holder = error instanceof SyncClientError && typeof error.details?.holder === "string" ? error.details.holder : "another device";
      setStatus(ctx, `sync: in use on ${holder}`);
      return `This conversation is running on ${holder}. Wait for it to finish, then send again.`;
    }
    if (code === "network_error" || code === "timeout") {
      setStatus(ctx, "sync: offline");
      return "The sync server is unreachable, so the prompt was not sent. Retry, or /sync detach to work on this copy alone.";
    }
    return error instanceof Error ? error.message : "Could not reach the synchronized conversation.";
  };

  const acquire = async (ctx: ExtensionContext, binding: SyncBinding): Promise<Acquired> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const acquired = await clientFor(binding.serverUrl).acquire(binding.canonicalSessionId, deviceLabel, { timeoutMs: REQUEST_TIMEOUT_MS });
        return { ok: true, acquired };
      } catch (error) {
        // Another device's idle upload holds the lease for well under a second; wait that out.
        if (error instanceof SyncClientError && error.code === "active_lease" && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        return { ok: false, message: await explainFailure(ctx, binding, error) };
      }
    }
  };

  const fetchCanonical = async (ctx: ExtensionContext, binding: SyncBinding): Promise<Fetched> => {
    try {
      return { ok: true, snapshot: await clientFor(binding.serverUrl).get(binding.canonicalSessionId) };
    } catch (error) {
      return { ok: false, message: await explainFailure(ctx, binding, error) };
    }
  };

  const release = async (binding: SyncBinding, token: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await clientFor(binding.serverUrl).release(binding.canonicalSessionId, token);
        return;
      } catch (error) {
        // An invalid token means the lease is already gone; anything else expires server-side.
        if (error instanceof SyncClientError && ["lease_invalid", "lease_not_found", "session_not_found"].includes(error.code)) return;
      }
    }
  };

  const upload = async (ctx: ExtensionContext, binding: SyncBinding, token: string): Promise<SyncBinding> => {
    const envelope = await normalizeCurrent(ctx, binding);
    const response = await clientFor(binding.serverUrl).update(binding.canonicalSessionId, envelope, token, binding.lastEtag);
    const next = syncedBinding(binding, envelope, response.etag, ctx.sessionManager.getSessionFile() ?? binding.materializedFile);
    await store.set(next);
    return next;
  };

  const stopHeartbeat = () => {
    if (lease?.timer) clearInterval(lease.timer);
    if (lease) lease.timer = undefined;
  };

  const holdLease = (ctx: ExtensionContext, binding: SyncBinding, token: string) => {
    stopHeartbeat();
    const held: HeldLease = { binding, token, lost: false };
    held.timer = setInterval(() => {
      void clientFor(binding.serverUrl).renew(binding.canonicalSessionId, token, { timeoutMs: 5_000 }).then(
        () => { held.lost = false; },
        (error) => {
          // Transient failures are retried on the next beat; the upload's ETag check is the real guard.
          if (error instanceof SyncClientError && ["lease_invalid", "lease_not_found", "session_not_found"].includes(error.code)) held.lost = true;
        },
      );
    }, HEARTBEAT_MS);
    held.timer.unref?.();
    lease = held;
    // Persisted so a restart after a crash can release the lease instead of waiting for expiry.
    void store.set({ ...binding, leaseToken: token }).catch(() => undefined);
    setStatus(ctx, "sync: working");
  };

  /** Uploads the settled conversation and releases the turn's lease. Never blocks the user. */
  const finishTurn = async (ctx: ExtensionContext) => {
    const held = lease;
    if (!held) return;
    stopHeartbeat();
    lease = undefined;
    await exclusive(async () => {
      try {
        await upload(ctx, held.binding, held.token);
        setStatus(ctx, "sync: up to date");
      } catch (error) {
        const code = error instanceof SyncClientError ? error.code : "";
        if (code === "session_not_found") await markSetupRequired(ctx, held.binding);
        else if (code === "stale_etag") setStatus(ctx, "sync: newer copy elsewhere; will refresh");
        else setStatus(ctx, "sync: upload pending");
      } finally {
        await release(held.binding, held.token);
        const stored = await store.get(held.binding.nativeSessionId);
        if (stored?.leaseToken === held.token) {
          delete stored.leaseToken;
          await store.set(stored);
        }
      }
    });
  };

  const dispatchRefresh = () => {
    if (refreshDispatched) return;
    refreshDispatched = true;
    setTimeout(() => {
      try {
        pi.sendUserMessage("/sync refresh auto", { expandPromptTemplates: true });
      } catch {
        refreshDispatched = false;
      }
    }, 0);
  };

  /** Saves local-only conversation entries as a separate, unsynchronized session before replacing the file. */
  const saveLocalCopy = async (ctx: ExtensionContext, local: SessionEnvelope): Promise<string> => {
    const sessionId = randomUUID();
    const title = `${local.title || firstUserText(local.entries as any[]) || "conversation"} (unsynced copy)`;
    const path = join(ctx.sessionManager.getSessionDir(), `${Date.now()}_${sessionId}.jsonl`);
    await materializeSessionFile(path, { ...local, sessionId, title }, { cwd: ctx.cwd });
    return path;
  };

  /**
   * Writes the canonical snapshot over `target`, first preserving any local
   * conversation entries the snapshot lacks, and records the new binding.
   */
  const materializeCanonical = async (
    ctx: ExtensionContext,
    target: string,
    local: SessionEnvelope | undefined,
    binding: SyncBinding,
    snapshot: SessionResponse,
  ): Promise<{ binding: SyncBinding; headEntryId: string; copyPath?: string }> => {
    const remoteIds = new Set(snapshot.session.entries.map((entry: PiEntry) => entry.id));
    const localOnly = local?.entries.filter((entry) => !remoteIds.has(entry.id)) ?? [];
    const diverged = localOnly.some((entry) => CONTEXT_ENTRY_TYPES.has(entry.type));
    const copyPath = diverged && local ? await saveLocalCopy(ctx, local) : undefined;
    let headEntryId = snapshot.session.headEntryId;
    const carried = (diverged ? [] : localOnly).map((entry) => {
      const rebased = { ...entry, parentId: headEntryId };
      headEntryId = entry.id;
      return rebased;
    });
    await materializeSessionFile(target, { ...snapshot.session, headEntryId, entries: [...snapshot.session.entries, ...carried] }, { cwd: ctx.cwd });
    // Recorded as the canonical copy, so carried entries count as local changes and upload on the next check.
    const next = syncedBinding(binding, snapshot.session, snapshot.etag, target);
    await store.set(next);
    return { binding: next, headEntryId, copyPath };
  };

  /** Re-opens `target` after it was rewritten, then optionally re-sends the prompt that triggered the refresh. */
  const reopen = async (ctx: ExtensionCommandContext, target: string, headEntryId: string, message: string | undefined, copyPath: string | undefined, replay: Replay | undefined) => {
    const result = await ctx.switchSession(target, {
      withSession: async (replacement) => {
        try {
          await restoreHead((entryId, options) => replacement.navigateTree(entryId, options), headEntryId);
        } catch {
          // The materialized file's last entry remains a valid head.
        }
        if (copyPath) replacement.ui.notify(`This device had turns that were never synchronized; they were saved as a separate session (${copyPath}).`, "warning");
        if (message) replacement.ui.notify(message, "info");
        if (replay) {
          const content = replay.images?.length ? [{ type: "text" as const, text: replay.text }, ...(replay.images as any[])] : replay.text;
          await replacement.sendUserMessage(content as any);
        }
      },
    });
    return !result.cancelled;
  };

  const refreshCurrent = async (ctx: ExtensionCommandContext, mode: "manual" | "auto" | "check"): Promise<CheckResult> => {
    if (mode === "auto") refreshDispatched = false;
    await ctx.waitForIdle();
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    const replay = pendingReplay?.sessionId === sessionId ? pendingReplay : undefined;
    pendingReplay = undefined;
    const binding = await store.get(sessionId);
    const restoreReplay = (message: string) => {
      notify(ctx, message, "warning");
      if (replay) {
        try {
          ctx.ui.setEditorText(replay.text);
        } catch {
          // No editor in this host; the warning already explains what happened.
        }
      }
    };
    if (!binding) {
      if (mode === "manual") notify(ctx, "This conversation is not synchronized. Use /sync attach first.", "info");
      return { outcome: "unchanged", sessionId };
    }
    if (binding.state === "setup_required") {
      if (mode !== "check") restoreReplay("The sync server no longer has this conversation. Run /sync attach to upload this copy again.");
      return { outcome: "busy", sessionId };
    }
    if (lease) return { outcome: "busy", sessionId };

    const result = await exclusive(async () => {
      const fetched = await fetchCanonical(ctx, binding);
      if (!fetched.ok) return { kind: "refused" as const, message: fetched.message };
      const { snapshot } = fetched;
      if (snapshot.etag === binding.lastEtag) {
        // Already current; push idle local changes (renames, model switches) under a brief lease.
        if (localFingerprint(ctx) !== binding.lastFingerprint) {
          const reserved = await acquire(ctx, binding);
          if (!reserved.ok) return { kind: "refused" as const, message: reserved.message };
          try {
            await upload(ctx, binding, reserved.acquired.lease.token);
            setStatus(ctx, "sync: up to date");
          } catch {
            setStatus(ctx, "sync: upload pending");
          } finally {
            await release(binding, reserved.acquired.lease.token);
          }
        } else {
          setStatus(ctx, "sync: up to date");
        }
        return { kind: "current" as const };
      }
      let local: SessionEnvelope | undefined;
      try {
        local = await normalizeCurrent(ctx, binding);
      } catch {
        local = undefined;
      }
      const target = ctx.sessionManager.getSessionFile() ?? binding.materializedFile;
      const written = await materializeCanonical(ctx, target, local, binding, snapshot);
      return { kind: "written" as const, written, target, snapshot };
    });

    if (result.kind === "refused") {
      if (mode !== "check" || replay) restoreReplay(result.message);
      return { outcome: "busy", sessionId };
    }
    if (result.kind === "current") {
      if (mode === "manual") notify(ctx, "The synchronized conversation is already current.", "info");
      if (replay) pi.sendUserMessage(replay.text);
      return { outcome: "unchanged", sessionId };
    }
    const message = mode === "manual" ? "Synchronized conversation refreshed." : replay ? undefined : "Updated with changes from another device.";
    await reopen(ctx, result.target, result.written.headEntryId, message, result.written.copyPath, replay);
    return { outcome: result.written.copyPath ? "conflict" : "refreshed", sessionId, switched: true };
  };

  /** Host-driven (pi-ez-web) check: refresh when the canonical copy moved, otherwise report. */
  const checkCurrent = async (ctx: ExtensionCommandContext): Promise<CheckResult> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const binding = await store.get(sessionId);
    if (!binding) return { outcome: "unchanged", sessionId };
    if (lease || binding.state === "setup_required" || !ctx.isIdle()) return { outcome: "busy", sessionId };
    let metadata;
    try {
      metadata = (await clientFor(binding.serverUrl).list()).sessions.find((item) => item.sessionId === binding.canonicalSessionId);
    } catch {
      return { outcome: "busy", sessionId };
    }
    if (!metadata) return { outcome: "busy", sessionId };
    if (metadata.leaseHolder) return { outcome: "busy", sessionId };
    if (metadata.etag === binding.lastEtag && localFingerprint(ctx) === binding.lastFingerprint) return { outcome: "unchanged", sessionId };
    return refreshCurrent(ctx, "check");
  };

  const poll = async (ctx: ExtensionContext, generation: number) => {
    if (generation !== pollGeneration || lease || busy || refreshDispatched || !currentSessionId) return;
    if (!ctx.isIdle() || hasPendingInput(ctx)) return;
    const binding = await store.get(currentSessionId);
    if (!binding || binding.state === "setup_required") return;
    let metadata;
    try {
      metadata = (await clientFor(binding.serverUrl).list()).sessions.find((item) => item.sessionId === binding.canonicalSessionId);
    } catch {
      setStatus(ctx, "sync: offline");
      return;
    }
    if (generation !== pollGeneration || lease || busy || !ctx.isIdle() || hasPendingInput(ctx)) return;
    if (!metadata) {
      await markSetupRequired(ctx, binding);
      notify(ctx, "The sync server no longer has this conversation. Run /sync attach to upload this copy again.", "warning");
      return;
    }
    if (metadata.leaseHolder) {
      setStatus(ctx, `sync: in use on ${metadata.leaseHolder}`);
      return;
    }
    if (metadata.etag !== binding.lastEtag || localFingerprint(ctx) !== binding.lastFingerprint) {
      dispatchRefresh();
      return;
    }
    setStatus(ctx, "sync: up to date");
  };

  const stopPoll = () => {
    pollGeneration++;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const startPoll = (ctx: ExtensionContext) => {
    stopPoll();
    // pi-ez-web drives checks itself through /sync auto-check.
    if (ctx.mode === "json") return;
    const generation = pollGeneration;
    const tick = () => void poll(ctx, generation).catch(() => undefined);
    setTimeout(tick, 250).unref?.();
    pollTimer = setInterval(tick, HEARTBEAT_MS);
    pollTimer.unref?.();
  };

  const enrollCurrent = async (ctx: ExtensionCommandContext, args: string) => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path || !existsSync(path)) return fail(ctx, "sync_not_persistent", "Send at least one message before synchronizing this conversation.");
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    const existing = await store.get(sessionId);
    const url = configuredUrl(args) ?? existing?.serverUrl;
    if (!url) return fail(ctx, "sync_not_configured", "Set PI_SYNC_SERVER_URL or run /sync attach <server URL>.");
    if (existing && existing.state !== "setup_required") {
      notify(ctx, "This conversation is already synchronized.", "info");
      startPoll(ctx);
      return;
    }
    let envelope: SessionEnvelope;
    try {
      envelope = await normalizeCurrent(ctx, existing);
    } catch (error) {
      return fail(ctx, "sync_enrollment_failed", error instanceof Error ? error.message : "Could not read this conversation.");
    }
    const base: SyncBinding = {
      nativeSessionId: sessionId,
      serverUrl: url,
      canonicalSessionId: sessionId,
      lastEtag: "",
      materializedFile: path,
      state: "ready",
    };
    try {
      const response = await clientFor(url).enroll(envelope);
      await store.set(syncedBinding(base, envelope, response.etag, path));
      setStatus(ctx, "sync: up to date");
      notify(ctx, "Conversation synchronized. Open it elsewhere with /sync.", "info");
    } catch (error) {
      if (!(error instanceof SyncClientError) || error.code !== "duplicate_enrollment") {
        return fail(ctx, "sync_enrollment_failed", error instanceof Error ? error.message : "Could not synchronize this conversation.");
      }
      // The server already has it (re-attach after detach or a lost binding): adopt the server copy,
      // preserving any local-only turns as a separate session.
      await store.set(base);
      await refreshCurrent(ctx, "auto");
      return;
    }
    startPoll(ctx);
  };

  const syncPick = async (ctx: ExtensionCommandContext) => {
    const current = await store.get(ctx.sessionManager.getSessionId());
    const url = configuredUrl() ?? current?.serverUrl;
    if (!url) return fail(ctx, "sync_not_configured", "Set PI_SYNC_SERVER_URL before using /sync.");
    if (!ctx.hasUI) return fail(ctx, "sync_ui_required", "The synchronized-session picker requires an interactive UI.");
    let sessions;
    try {
      sessions = (await clientFor(url).list()).sessions;
    } catch (error) {
      return fail(ctx, "sync_unavailable", error instanceof Error ? error.message : "Could not list synchronized conversations.");
    }
    if (sessions.length === 0) {
      notify(ctx, "No conversations are synchronized yet. Use /sync attach in a conversation to share it.", "info");
      return;
    }
    const repository = await repositoryFor(ctx);
    const bindings = new Map((await store.all()).map((binding) => [binding.canonicalSessionId, binding]));
    const ranked = [...sessions].sort((left, right) => {
      const leftHere = repositoryIdentity(left.workspace) === repository ? 0 : 1;
      const rightHere = repositoryIdentity(right.workspace) === repository ? 0 : 1;
      if (leftHere !== rightHere) return leftHere - rightHere;
      return (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt);
    });
    const rows = ranked.map((item) => {
      const title = usefulTitle(item.title, item.sessionId) || bindings.get(item.sessionId)?.title || `untitled ${item.sessionId.slice(-8)}`;
      const where = item.workspace ? `${repositoryIdentity(item.workspace)?.split("/").slice(-1)[0]}:${item.workspace.branch}` : "no repo";
      const parts = [title, where, relativeAge(item.updatedAt)];
      if (item.leaseHolder) parts.push(`running on ${item.leaseHolder}`);
      if (item.sessionId === current?.canonicalSessionId) parts.push("current");
      else if (bindings.has(item.sessionId)) parts.push("on this device");
      return { item, label: parts.filter(Boolean).join(" · ") };
    });
    const selected = await ctx.ui.select("Synchronized conversations", rows.map((row) => row.label));
    const row = rows.find((candidate) => candidate.label === selected);
    if (!row) return;
    if (row.item.sessionId === current?.canonicalSessionId) {
      await refreshCurrent(ctx, "manual");
      return;
    }

    const existing = bindings.get(row.item.sessionId);
    const reusable = existing && existsSync(existing.materializedFile) ? existing : undefined;
    const target = reusable?.materializedFile ?? join(ctx.sessionManager.getSessionDir(), `${Date.now()}_${row.item.sessionId}.jsonl`);
    const binding: SyncBinding = reusable ?? {
      nativeSessionId: row.item.sessionId,
      serverUrl: url,
      canonicalSessionId: row.item.sessionId,
      lastEtag: "",
      materializedFile: target,
      state: "ready",
    };
    const outcome = await exclusive(async () => {
      const fetched = await fetchCanonical(ctx, binding);
      if (!fetched.ok) return { kind: "failed" as const, message: fetched.message };
      let local: SessionEnvelope | undefined;
      if (reusable) local = await normalizeSessionFile(target).catch(() => undefined);
      return { kind: "written" as const, written: await materializeCanonical(ctx, target, local, binding, fetched.snapshot), snapshot: fetched.snapshot };
    }).catch((error) => ({ kind: "failed" as const, message: error instanceof Error ? error.message : "Could not open the synchronized conversation." }));
    if (outcome.kind === "failed") return fail(ctx, "sync_unavailable", outcome.message);
    await reopen(ctx, target, outcome.written.headEntryId, `Opened “${row.item.title || "conversation"}”.`, outcome.written.copyPath, undefined);
  };

  const detachCurrent = async (ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const binding = await store.get(sessionId);
    if (!binding) {
      notify(ctx, "This conversation is not synchronized.", "info");
      return;
    }
    await ctx.waitForIdle();
    await finishTurn(ctx);
    stopPoll();
    await store.remove(sessionId);
    setStatus(ctx);
    notify(ctx, "Stopped synchronizing this conversation on this device. The server copy is unchanged.", "info");
  };

  const showStatus = async (ctx: ExtensionCommandContext) => {
    const binding = await store.get(ctx.sessionManager.getSessionId());
    if (!binding) {
      notify(ctx, "This conversation is not synchronized. Use /sync attach to share it.", "info");
      return;
    }
    let remote = "server unreachable";
    try {
      const metadata = (await clientFor(binding.serverUrl).list()).sessions.find((item) => item.sessionId === binding.canonicalSessionId);
      remote = !metadata
        ? "missing on server"
        : metadata.leaseHolder
          ? `running on ${metadata.leaseHolder}`
          : metadata.etag === binding.lastEtag
            ? localFingerprint(ctx) === binding.lastFingerprint ? "up to date" : "local changes pending upload"
            : "newer copy on server";
    } catch {
      // Status stays useful offline.
    }
    const workspace = binding.workspace ? `upstream ${binding.workspace.branch}@${binding.workspace.commit.slice(0, 12)}` : "no upstream";
    notify(ctx, `Sync ${binding.serverUrl}: ${remote}; this device is “${deviceLabel}”; ${workspace}`, "info");
  };

  pi.registerCommand("sync", {
    description: "Open, attach, detach, refresh, or inspect synchronized conversations",
    handler: async (args, ctx) => {
      const [command = "", ...rest] = args.trim().split(/\s+/);
      await store.load();
      if (command === "attach") return enrollCurrent(ctx, rest.join(" "));
      if (command === "detach") return detachCurrent(ctx);
      if (command === "refresh") {
        await refreshCurrent(ctx, rest[0] === "auto" ? "auto" : "manual");
        return;
      }
      if (command === "auto-check" || command === "reconcile") {
        const result: unknown = await checkCurrent(ctx);
        // SAFETY: Pi types command handlers as void, but host integrations (pi-ez-web) read the returned CheckResult.
        return result as void;
      }
      if (command === "status") return showStatus(ctx);
      if (command === "") return syncPick(ctx);
      notify(ctx, "Usage: /sync, /sync attach [server URL], /sync detach, /sync refresh, or /sync status", "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    stopHeartbeat();
    lease = undefined;
    refreshDispatched = false;
    stopPoll();
    await store.load();
    let binding = await store.get(currentSessionId);
    if (!binding) {
      setStatus(ctx);
      return;
    }
    if (binding.leaseToken) {
      // Left behind by a crash mid-turn; the server lease expires anyway, so drop it.
      await release(binding, binding.leaseToken);
      binding = { ...binding };
      delete binding.leaseToken;
      delete binding.leaseExpiresAt;
      await store.set(binding);
    }
    const file = ctx.sessionManager.getSessionFile();
    if (file && resolvePath(file) !== resolvePath(binding.materializedFile)) {
      // Opened through /resume or a copy from an older pi-sync; adopt it as this device's file.
      binding = { ...binding, materializedFile: file };
      await store.set(binding);
    }
    setStatus(ctx, binding.state === "setup_required" ? "sync: server copy missing (/sync attach)" : "sync: on");
    startPoll(ctx);
  });

  pi.on("resources_discover", async () => {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });

  const refuse = (ctx: ExtensionContext, text: string, message: string) => {
    notify(ctx, message, "warning");
    try {
      if (ctx.hasUI && text) ctx.ui.setEditorText(text);
    } catch {
      // Hosts without an editor keep the warning only.
    }
    return { action: "handled" as const };
  };

  pi.on("input", async (event, ctx) => {
    if (!currentSessionId || lease) return { action: "continue" as const };
    const binding = await store.get(currentSessionId);
    if (!binding) return { action: "continue" as const };
    if (binding.state === "setup_required") {
      return refuse(ctx, event.text, "The sync server no longer has this conversation. Run /sync attach to upload this copy again.");
    }
    const reserved = await exclusive(() => acquire(ctx, binding));
    if (!reserved.ok) return refuse(ctx, event.text, reserved.message);
    const { acquired } = reserved;
    if (acquired.etag === binding.lastEtag) {
      holdLease(ctx, binding, acquired.lease.token);
      return { action: "continue" as const };
    }
    // Another device moved the conversation on: bring this copy up to date, then send the prompt.
    await release(binding, acquired.lease.token);
    pendingReplay = { sessionId: currentSessionId, text: event.text, images: event.images };
    notify(ctx, "Catching up with changes from another device…", "info");
    dispatchRefresh();
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event) => {
    const workspace = lease?.binding.workspace;
    if (!workspace) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nSynchronized workspace: upstream branch ${workspace.branch} at pushed commit ${workspace.commit}. Follow the synchronized-workspace skill before handing work to another runtime.`,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await finishTurn(ctx);
  });

  // Manual compaction rewrites context outside a turn, so it needs the lease and a current copy.
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason !== "manual" || lease || !currentSessionId) return;
    const binding = await store.get(currentSessionId);
    if (!binding) return;
    const reserved = await exclusive(() => acquire(ctx, binding));
    if (!reserved.ok) {
      notify(ctx, reserved.message, "warning");
      return { cancel: true as const };
    }
    if (reserved.acquired.etag !== binding.lastEtag) {
      await release(binding, reserved.acquired.lease.token);
      notify(ctx, "Another device changed this conversation; updating first. Run /compact again afterwards.", "warning");
      dispatchRefresh();
      return { cancel: true as const };
    }
    holdLease(ctx, binding, reserved.acquired.lease.token);
  });
  pi.on("session_compact", async (_event, ctx) => finishTurn(ctx));
  pi.on("session_compact_failed", async (_event, ctx) => finishTurn(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPoll();
    await finishTurn(ctx);
  });
}
