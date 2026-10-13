import { randomUUID } from "node:crypto";
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
  captureWorkspace,
  codeStatus,
  deleteSnapshot,
  hasUnsharedCode,
  pushSnapshot,
  restoreWorkspace,
  setShareSetting,
  shareSetting,
  type Snapshot,
  type WorkspacePointer,
  appendSessionFile,
  materializeSessionFile,
  nativeHeaderLine,
  normalizeSessionFile,
  repositoryIdentity,
  restoreHead,
} from "../src/index.js";

const HEARTBEAT_MS = Number(process.env.PI_SYNC_HEARTBEAT_MS) || 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ENROLL_BATCH_BYTES = 8 * 1024 * 1024;
// Local-only entries of these types mean two devices really wrote the same conversation.
// Other local-only entries (model changes, names, extension state) are carried onto the newer copy.
const CONTEXT_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
// Module scope: a catch-up re-creates the extension instance for the reopened session.
const keptSettings: { value?: { file: string; model: ExtensionContext["model"]; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> } } = {};

type CheckOutcome = "unchanged" | "busy" | "conflict" | "refreshed";
type CheckResult = { outcome: CheckOutcome; sessionId?: string; switched?: boolean };
type Replay = { sessionId: string; text: string; images?: unknown[]; compact?: { customInstructions?: string } };
type HeldLease = { binding: SyncBinding; token: string; lost: boolean; timer?: ReturnType<typeof setInterval> };
type Acquired = { ok: true; acquired: { etag: string; count?: number; session: SessionEnvelope; lease: { token: string } } } | { ok: false; message: string; holder?: string; offline?: boolean };
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

/**
 * Identifies the entry set and head in O(1). Entries only ever append, and the local file starts with the synchronized
 * entries in canonical order, so the count and last id stand for the whole list.
 */
function entriesFingerprint(entries: readonly { id?: unknown }[], headEntryId: string | null | undefined): string {
  return `ids-c${entries.length}-${String(entries.at(-1)?.id ?? "")}-${headEntryId ?? ""}`;
}

/**
 * How many of this device's synchronized entries the local copy still starts with: the binding's count when the copy
 * is intact, otherwise 0 (an older file reopened through /resume, or a binding from before counts were recorded).
 */
/**
 * Whether the local copy holds the whole canonical conversation. Bindings written before counts were recorded (or by
 * hosts such as pi-ez-web) fall back to comparing ids.
 */
function holdsCanonical(local: readonly { id?: unknown }[], binding: SyncBinding, canonical: readonly { id?: unknown }[]): boolean {
  if (binding.syncedCount !== undefined) return syncedPrefix(local, binding) === canonical.length;
  const ids = new Set(local.map((entry) => entry.id));
  return canonical.every((entry) => ids.has(entry.id));
}

function syncedPrefix(local: readonly { id?: unknown }[], binding: SyncBinding): number {
  const count = binding.syncedCount;
  if (!count || !binding.syncedLastId || local.length < count || local[count - 1]?.id !== binding.syncedLastId) return 0;
  return count;
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
  // Last binding seen per session in this process: an older pi-sync process sharing the file can
  // rewrite it without ours, so a missing binding we still know about is written back.
  const remembered = new Map<string, SyncBinding>();
  const bindingFor = async (sessionId: string): Promise<SyncBinding | undefined> => {
    const stored = await store.get(sessionId);
    if (stored) {
      remembered.set(sessionId, stored);
      return stored;
    }
    const known = remembered.get(sessionId);
    if (known) await store.set(known);
    return known;
  };
  const LINK_ENTRY = "pi-sync-link";
  const detachedHere = (ctx: ExtensionContext) => {
    const marker = [...ctx.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === LINK_ENTRY) as { data?: { detached?: boolean } } | undefined;
    return marker?.data?.detached === true;
  };
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

  // Fresh sessions already hold model and thinking entries; only messages make a conversation.
  const hasMessages = (ctx: ExtensionContext) => ctx.sessionManager.getEntries().some((entry) => entry.type === "message");

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

  const normalizeCurrent = async (ctx: ExtensionContext, binding?: SyncBinding, workspace?: WorkspacePointer): Promise<SessionEnvelope> => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) throw new Error("synchronization requires a persistent Pi session");
    return normalizeSessionFile(path, {
      requestedSessionId: ctx.sessionManager.getSessionId(),
      headEntryId: ctx.sessionManager.getLeafId() ?? "",
      title: conversationTitle(ctx, binding),
      parentSessionId: binding?.parentSessionId,
      workspace: workspace ?? (await idleWorkspace(ctx, binding)),
    });
  };

  // Idle uploads (renames, model switches) keep the last turn's code snapshot until the next turn replaces it.
  const idleWorkspace = async (ctx: ExtensionContext, binding?: SyncBinding): Promise<WorkspacePointer | undefined> => {
    const derived = await deriveWorkspacePointer(ctx.cwd, gitRunnerFor(ctx));
    const wip = binding?.workspace?.wip;
    return wip ? { ...(derived ?? binding!.workspace!), wip } : derived;
  };

  const syncedBinding = (binding: SyncBinding, envelope: SessionEnvelope, etag: string, materializedFile = binding.materializedFile): SyncBinding => {
    const next: SyncBinding = {
      ...binding,
      state: "ready",
      lastEtag: etag,
      lastFingerprint: remoteFingerprint(envelope),
      syncedCount: envelope.entries.length,
      syncedLastId: envelope.entries.at(-1)?.id ?? "",
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
    // Servers before the lease-free snapshot endpoint and advisory repository scope answer this way.
    if (["not_found", "method_not_allowed", "workspace_required", "workspace_mismatch"].includes(code)) {
      setStatus(ctx, "sync: server needs update");
      return `The sync server at ${binding.serverUrl} is older than this pi-sync client. Update pi-syncd to keep syncing.`;
    }
    if (code === "network_error" || code === "timeout") {
      setStatus(ctx, "sync: offline");
      return "The sync server is unreachable, so the prompt was not sent. Retry, or /sync detach to work on this copy alone.";
    }
    return error instanceof Error ? error.message : "Could not reach the synchronized conversation.";
  };

  const acquire = async (ctx: ExtensionContext, binding: SyncBinding, takeOver = false): Promise<Acquired> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const acquired = await clientFor(binding.serverUrl).acquire(binding.canonicalSessionId, deviceLabel, { timeoutMs: REQUEST_TIMEOUT_MS, takeOver, metadataOnly: true });
        return { ok: true, acquired };
      } catch (error) {
        // Another device's idle upload holds the lease for well under a second; wait that out.
        if (error instanceof SyncClientError && error.code === "active_lease" && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        const holder = error instanceof SyncClientError && error.code === "active_lease"
          ? (typeof error.details?.holder === "string" ? error.details.holder : "another device")
          : undefined;
        const offline = error instanceof SyncClientError && (error.code === "network_error" || error.code === "timeout");
        return { ok: false, message: await explainFailure(ctx, binding, error), holder, offline };
      }
    }
  };

  /**
   * The canonical conversation, downloading only the entries after this device's synchronized prefix. `local` is the
   * copy that prefix is taken from (none for a conversation not yet on this device).
   */
  const fetchCanonical = async (ctx: ExtensionContext, binding: SyncBinding, local: readonly PiEntry[] = []): Promise<Fetched> => {
    const client = clientFor(binding.serverUrl);
    let from = syncedPrefix(local, binding);
    for (;;) {
      try {
        const delta = await client.entriesSince(binding.canonicalSessionId, from, { prevId: from > 0 ? String(local[from - 1]?.id ?? "") : undefined });
        // The server's copy must still start with the prefix this device holds; otherwise download it all.
        if (from > 0 && delta.count < from) {
          from = 0;
          continue;
        }
        const entries = from === 0 ? delta.session.entries : [...local.slice(0, from), ...delta.session.entries];
        return { ok: true, snapshot: { ...delta, session: { ...delta.session, entries } } };
      } catch (error) {
        if (error instanceof SyncClientError && ["range_not_satisfiable", "prefix_mismatch"].includes(error.code) && from > 0) {
          from = 0;
          continue;
        }
        // Servers before appends serve only the whole conversation.
        if (error instanceof SyncClientError && (error.code === "not_found" || error.code === "method_not_allowed")) {
          try {
            return { ok: true, snapshot: await client.get(binding.canonicalSessionId) };
          } catch (legacyError) {
            return { ok: false, message: await explainFailure(ctx, binding, legacyError) };
          }
        }
        return { ok: false, message: await explainFailure(ctx, binding, error) };
      }
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

  /** Sends what this device added since it last synchronized; the whole conversation only to older servers. */
  const upload = async (ctx: ExtensionContext, binding: SyncBinding, token: string, workspace?: WorkspacePointer): Promise<SyncBinding> => {
    const client = clientFor(binding.serverUrl);
    const entries = ctx.sessionManager.getEntries() as PiEntry[];
    const file = ctx.sessionManager.getSessionFile() ?? binding.materializedFile;
    const base = syncedPrefix(entries, binding);
    if (base > 0) {
      const header = {
        headEntryId: ctx.sessionManager.getLeafId() ?? entries.at(-1)?.id ?? "",
        title: conversationTitle(ctx, binding),
        workspace: workspace ?? (await idleWorkspace(ctx, binding)),
      };
      try {
        const response = await client.append(binding.canonicalSessionId, token, binding.lastEtag, { baseCount: base, entries: entries.slice(base), ...header });
        const envelope = { formatVersion: 1 as const, sessionId: binding.canonicalSessionId, piSessionVersion: 3, createdAt: "", parentSessionId: binding.parentSessionId ?? null, ...header, entries };
        const next = syncedBinding(binding, envelope, response.etag, file);
        await store.set(next);
        return next;
      } catch (error) {
        if (!(error instanceof SyncClientError) || (error.code !== "not_found" && error.code !== "method_not_allowed")) throw error;
      }
    }
    const envelope = await normalizeCurrent(ctx, binding, workspace);
    const response = await client.update(binding.canonicalSessionId, envelope, token, binding.lastEtag);
    const next = syncedBinding(binding, envelope, response.etag, file);
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
    let snapshot: Snapshot | undefined;
    if ((await shareSetting(ctx.cwd)) === true) {
      try {
        snapshot = await captureWorkspace(ctx.cwd);
      } catch {
        snapshot = undefined;
      }
    }
    let uploaded = false;
    await exclusive(async () => {
      try {
        await upload(ctx, held.binding, held.token, snapshot?.workspace);
        uploaded = true;
        setStatus(ctx, "sync: up to date");
      } catch (error) {
        const code = error instanceof SyncClientError ? error.code : "";
        if (code === "session_not_found") await markSetupRequired(ctx, held.binding);
        else if (code === "stale_etag") setStatus(ctx, "sync: newer copy elsewhere; will refresh");
        else if (code === "lease_invalid" || code === "lease_not_found") {
          setStatus(ctx, "sync: taken over elsewhere");
          notify(ctx, "Another device took over this conversation. This reply will be kept as a separate copy when this copy catches up.", "warning");
        }
        else setStatus(ctx, "sync: upload pending");
      } finally {
        await release(held.binding, held.token);
        const stored = await bindingFor(held.binding.nativeSessionId);
        if (stored?.leaseToken === held.token) {
          delete stored.leaseToken;
          await store.set(stored);
        }
      }
    });
    if (uploaded && snapshot) void shareSnapshot(ctx, held.binding, snapshot);
  };

  /** Pushes (or clears) the turn's code snapshot after the lease is released, so it never delays the other device. */
  const shareSnapshot = async (ctx: ExtensionContext, binding: SyncBinding, snapshot: Snapshot) => {
    const id = binding.canonicalSessionId;
    if (snapshot.kind === "skipped") {
      notify(ctx, `Code for this turn was not shared: ${snapshot.reason}.`, "warning");
      return;
    }
    if (snapshot.kind === "clean") {
      if (binding.workspace?.wip) await deleteSnapshot(ctx.cwd, id, binding.workspace.gitRemote).catch(() => undefined);
      return;
    }
    const pushed = await pushSnapshot(ctx.cwd, snapshot.remote, snapshot.workspace.wip!.commit, id);
    if (pushed.code !== 0) notify(ctx, `Code for this turn was not shared: push to ${snapshot.remote} failed. ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`, "warning");
  };

  /** Asks once per repository whether uncommitted work may be pushed to a hidden ref on its remote. */
  const askToShareCode = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode === "json" || (await shareSetting(ctx.cwd)) !== undefined) return;
    if (!(await hasUnsharedCode(ctx.cwd))) return;
    const enabled = await ctx.ui.confirm(
      "Share uncommitted code with your other devices?",
      "After each turn, pi-sync can push this checkout's uncommitted and unpushed work to a hidden ref (refs/pi-sync/<conversation>) on this repository's remote, so another device can restore it with /sync code. Anyone who can read the remote can read that ref. Files in .gitignore are never included. Change later with /sync code on|off.",
    );
    await setShareSetting(ctx.cwd, enabled);
  };

  const lastCodeNotice = new Map<string, string>();
  /** Tells the user when this checkout doesn't have the conversation's code. */
  const noticeCode = async (cwd: string, sessionId: string, notifyUser: (message: string) => void) => {
    const binding = await bindingFor(sessionId);
    const workspace = binding?.workspace;
    if (!workspace) return;
    const key = workspace.wip?.commit ?? workspace.commit;
    if (lastCodeNotice.get(sessionId) === key) return;
    const status = await codeStatus(cwd, workspace).catch(() => ({ kind: "unknown" as const }));
    if (status.kind !== "restorable") return;
    lastCodeNotice.set(sessionId, key);
    notifyUser(`This conversation's code is ${status.summary}; this checkout differs. Run /sync code to bring it here.`);
  };

  const syncCode = async (ctx: ExtensionCommandContext, arg: string) => {
    if (arg === "on" || arg === "off") {
      await setShareSetting(ctx.cwd, arg === "on");
      notify(ctx, arg === "on" ? "Uncommitted code will be shared with your other devices after each turn." : "Uncommitted code will not be shared.", "info");
      return;
    }
    const binding = await bindingFor(ctx.sessionManager.getSessionId());
    if (!binding?.workspace) {
      notify(ctx, "No code state is recorded for this conversation.", "info");
      return;
    }
    const status = await codeStatus(ctx.cwd, binding.workspace);
    if (status.kind === "matches") return notify(ctx, "This checkout already has the conversation's code.", "info");
    if (status.kind !== "restorable") return notify(ctx, "This checkout is not the conversation's repository.", "warning");
    const ok = !ctx.hasUI || await ctx.ui.confirm("Bring the conversation's code here?", `Switch this checkout to ${status.summary}. Local uncommitted work is never overwritten; if there is any, this stops and explains.`);
    if (!ok) return;
    const result = await restoreWorkspace(ctx.cwd, binding.workspace, binding.canonicalSessionId);
    if (!result.ok) return fail(ctx, "sync_code_restore_failed", result.message);
    notify(ctx, result.message, "info");
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
    // A session_info entry makes the name show up in /resume and host session lists.
    const named = { type: "session_info", id: randomUUID().slice(0, 8), parentId: local.headEntryId || null, timestamp: new Date().toISOString(), name: title } as PiEntry;
    await materializeSessionFile(path, { ...local, sessionId, title, entries: [...local.entries, named], headEntryId: named.id }, { cwd: ctx.cwd });
    return title;
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
  ): Promise<{ binding: SyncBinding; headEntryId: string; copyTitle?: string }> => {
    const remoteIds = new Set(snapshot.session.entries.map((entry: PiEntry) => entry.id));
    const localOnly = local?.entries.filter((entry) => !remoteIds.has(entry.id)) ?? [];
    const diverged = localOnly.some((entry) => CONTEXT_ENTRY_TYPES.has(entry.type));
    const copyTitle = diverged && local ? await saveLocalCopy(ctx, local) : undefined;
    let headEntryId = snapshot.session.headEntryId;
    const carried = (diverged ? [] : localOnly).map((entry) => {
      const rebased = { ...entry, parentId: headEntryId };
      headEntryId = entry.id;
      return rebased;
    });
    const entries = snapshot.session.entries;
    const synced = binding.syncedCount ?? 0;
    // A pure append onto the file this device last synchronized: add the new lines instead of rewriting it all.
    const appended = !copyTitle && carried.length === 0 && binding.syncedLastId !== undefined && synced > 0
      && synced <= entries.length && entries[synced - 1]?.id === binding.syncedLastId
      && headEntryId === entries.at(-1)?.id
      && resolvePath(target) === resolvePath(binding.materializedFile)
      && await appendSessionFile(target, { headerLine: nativeHeaderLine(snapshot.session, { cwd: ctx.cwd }), count: synced, lastId: binding.syncedLastId }, entries.slice(synced));
    if (!appended) await materializeSessionFile(target, { ...snapshot.session, headEntryId, entries: [...entries, ...carried] }, { cwd: ctx.cwd });
    // Recorded as the canonical copy, so carried entries count as local changes and upload on the next check.
    const next = syncedBinding(binding, snapshot.session, snapshot.etag, target);
    await store.set(next);
    return { binding: next, headEntryId, copyTitle };
  };

  /** Re-opens `target` after it was rewritten, then optionally re-sends the prompt that triggered the refresh. */
  const reopen = async (ctx: ExtensionCommandContext, target: string, headEntryId: string, message: string | undefined, copyTitle: string | undefined, replay: Replay | undefined) => {
    // Pi adopts the model of the last reply, which may be another device's; a catch-up must not change this device's choice.
    keptSettings.value = { file: resolvePath(target), model: ctx.model, thinking: pi.getThinkingLevel() };
    const result = await ctx.switchSession(target, {
      withSession: async (replacement) => {
        try {
          // Usually the head is the last entry; navigating anyway prints a needless "Navigated" notice.
          if (replacement.sessionManager.getLeafId() !== headEntryId) {
            await restoreHead((entryId, options) => replacement.navigateTree(entryId, options), headEntryId);
          }
        } catch {
          // The materialized file's last entry remains a valid head.
        }
        if (copyTitle) replacement.ui.notify(`Turns from this device that never synchronized were kept as “${copyTitle}”. Open it with /resume.`, "warning");
        if (message) replacement.ui.notify(message, "info");
        await noticeCode(replacement.cwd, replacement.sessionManager.getSessionId(), (text) => replacement.ui.notify(text, "info")).catch(() => undefined);
        if (replay?.compact) {
          replacement.compact(replay.compact);
        } else if (replay) {
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
    const binding = await bindingFor(sessionId);
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
      const localEntries = ctx.sessionManager.getEntries() as PiEntry[];
      const fetched = await fetchCanonical(ctx, binding, localEntries);
      if (!fetched.ok) return { kind: "refused" as const, message: fetched.message };
      const { snapshot } = fetched;
      // Uploading a copy that lacks canonical entries would roll the conversation back, so it catches up instead.
      if (snapshot.etag === binding.lastEtag && holdsCanonical(localEntries, binding, snapshot.session.entries)) {
        const canonical = snapshot.session.entries;
let counted = binding;
                // First check with a binding that has no count: record it, so later turns send only what they add.
        if (binding.syncedCount === undefined && canonical.length > 0 && localEntries[canonical.length - 1]?.id === canonical.at(-1)?.id) {
          counted = { ...binding, syncedCount: canonical.length, syncedLastId: canonical.at(-1)!.id };
          await store.set(counted);
        }
        // Already current; push idle local changes (renames, model switches) under a brief lease.
        if (localFingerprint(ctx) !== binding.lastFingerprint) {
          const reserved = await acquire(ctx, counted);
          if (!reserved.ok) return { kind: "refused" as const, message: reserved.message };
          try {
            await upload(ctx, counted, reserved.acquired.lease.token);
            setStatus(ctx, "sync: up to date");
          } catch {
            setStatus(ctx, "sync: upload pending");
          } finally {
            await release(counted, reserved.acquired.lease.token);
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
    // Automatic catch-ups stay quiet: the new turns appearing is the signal.
    const message = mode === "manual" ? "Synchronized conversation refreshed." : undefined;
    await reopen(ctx, result.target, result.written.headEntryId, message, result.written.copyTitle, replay);
    return { outcome: result.written.copyTitle ? "conflict" : "refreshed", sessionId, switched: true };
  };

  /** Host-driven (pi-ez-web) check: refresh when the canonical copy moved, otherwise report. */
  const checkCurrent = async (ctx: ExtensionCommandContext): Promise<CheckResult> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const binding = await bindingFor(sessionId);
    if (!binding) return { outcome: "unchanged", sessionId };
    if (lease || binding.state === "setup_required" || !ctx.isIdle()) return { outcome: "busy", sessionId };
    let metadata;
    try {
      metadata = (await clientFor(binding.serverUrl).list()).sessions.find((item) => item.sessionId === binding.canonicalSessionId);
    } catch {
      return { outcome: "busy", sessionId };
    }
    if (!metadata) return { outcome: "busy", sessionId };
    if (metadata.leaseHolder) {
      setStatus(ctx, `sync: in use on ${metadata.leaseHolder}`);
      return { outcome: "busy", sessionId };
    }
    if (metadata.etag === binding.lastEtag && localFingerprint(ctx) === binding.lastFingerprint) {
      setStatus(ctx, "sync: up to date");
      return { outcome: "unchanged", sessionId };
    }
    return refreshCurrent(ctx, "check");
  };

  const poll = async (ctx: ExtensionContext, generation: number) => {
    if (generation !== pollGeneration || lease || busy || refreshDispatched || !currentSessionId) return;
    if (!ctx.isIdle() || hasPendingInput(ctx)) return;
    const binding = await bindingFor(currentSessionId);
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

  /** Uploads a new conversation; one that does not fit in a request is sent as a first part plus appends. */
  const enrollInBatches = async (url: string, envelope: SessionEnvelope): Promise<{ etag: string }> => {
    const client = clientFor(url);
    const batches: PiEntry[][] = [[]];
    let size = 0;
    for (const entry of envelope.entries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (size + bytes > ENROLL_BATCH_BYTES && batches.at(-1)!.length > 0) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(entry);
      size += bytes;
    }
    const first = batches[0]!;
    if (batches.length === 1) return client.enroll(envelope);
    let { etag } = await client.enroll({ ...envelope, entries: first, headEntryId: first.at(-1)!.id });
    const { lease: held } = await client.acquire(envelope.sessionId, deviceLabel, { metadataOnly: true });
    try {
      let count = first.length;
      for (const batch of batches.slice(1)) {
        ({ etag } = await client.append(envelope.sessionId, held.token, etag, { baseCount: count, entries: batch, headEntryId: batch.at(-1)!.id, title: envelope.title, ...(envelope.workspace ? { workspace: envelope.workspace } : {}) }));
        count += batch.length;
      }
      if (envelope.headEntryId !== batches.at(-1)!.at(-1)!.id) {
        ({ etag } = await client.append(envelope.sessionId, held.token, etag, { baseCount: count, entries: [], headEntryId: envelope.headEntryId, title: envelope.title, ...(envelope.workspace ? { workspace: envelope.workspace } : {}) }));
      }
    } finally {
      await client.release(envelope.sessionId, held.token).catch(() => undefined);
    }
    return { etag };
  };

  const enrollCurrent = async (ctx: ExtensionCommandContext, args: string) => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path || !existsSync(path)) return fail(ctx, "sync_not_persistent", "Send at least one message before synchronizing this conversation.");
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    const existing = await bindingFor(sessionId);
    const url = configuredUrl(args) ?? existing?.serverUrl;
    if (!url) return fail(ctx, "sync_not_configured", "Set PI_SYNC_SERVER_URL or run /sync attach <server URL>.");
    if (existing && existing.state !== "setup_required") {
      notify(ctx, "This conversation is already synchronized.", "info");
      startPoll(ctx);
      return;
    }
    if (detachedHere(ctx)) pi.appendEntry(LINK_ENTRY, { detached: false });
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
      const response = await enrollInBatches(url, envelope);
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
    const current = await bindingFor(ctx.sessionManager.getSessionId());
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
    await openSynced(ctx, url, row.item.sessionId, row.item.title);
  };

  /** Opens a shared conversation on this device, reusing its file when this device already has one. */
  const openSynced = async (ctx: ExtensionCommandContext, url: string, sessionId: string, title?: string) => {
    const existing = await bindingFor(sessionId);
    const reusable = existing && existsSync(existing.materializedFile) ? existing : undefined;
    const target = reusable?.materializedFile ?? join(ctx.sessionManager.getSessionDir(), `${Date.now()}_${sessionId}.jsonl`);
    const binding: SyncBinding = reusable ?? {
      nativeSessionId: sessionId,
      serverUrl: url,
      canonicalSessionId: sessionId,
      lastEtag: "",
      materializedFile: target,
      state: "ready",
    };
    const outcome = await exclusive(async () => {
      let local: SessionEnvelope | undefined;
      if (reusable) local = await normalizeSessionFile(target).catch(() => undefined);
      const fetched = await fetchCanonical(ctx, binding, local?.entries);
      if (!fetched.ok) return { kind: "failed" as const, message: fetched.message };
      return { kind: "written" as const, written: await materializeCanonical(ctx, target, local, binding, fetched.snapshot), snapshot: fetched.snapshot };
    }).catch((error) => ({ kind: "failed" as const, message: error instanceof Error ? error.message : "Could not open the synchronized conversation." }));
    if (outcome.kind === "failed") return fail(ctx, "sync_unavailable", outcome.message);
    const opened = title || outcome.snapshot.session.title;
    await reopen(ctx, target, outcome.written.headEntryId, `Opened “${opened || "conversation"}”.`, outcome.written.copyTitle, undefined);
  };

  /**
   * On a fresh start in a repository, offers the shared conversation this device hasn't caught up with.
   * shortcut: only conversations updated in the last day are offered and a "no" isn't remembered; persist declines if it nags.
   */
  const offerArrival = async (ctx: ExtensionContext) => {
    const url = configuredUrl();
    if (!url || !ctx.hasUI || ctx.mode === "json") return;
    const repository = await repositoryFor(ctx);
    if (!repository) return;
    const { sessions } = await clientFor(url).list({ timeoutMs: REQUEST_TIMEOUT_MS });
    const bindings = new Map((await store.all()).map((binding) => [binding.canonicalSessionId, binding]));
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const candidate = sessions
      .filter((item) => repositoryIdentity(item.workspace) === repository && (item.updatedAt ?? item.createdAt) > dayAgo)
      .filter((item) => bindings.get(item.sessionId)?.lastEtag !== item.etag)
      .sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt))[0];
    if (!candidate) return;
    // The user may have started typing meanwhile; never interrupt that.
    if (hasMessages(ctx) || hasPendingInput(ctx)) return;
    const title = usefulTitle(candidate.title, candidate.sessionId) || bindings.get(candidate.sessionId)?.title || "a shared conversation";
    const where = candidate.leaseHolder ? `running on ${candidate.leaseHolder}` : `updated ${relativeAge(candidate.updatedAt)}`;
    const yes = await ctx.ui.confirm("Continue a synchronized conversation?", `“${title}” (${where}). Open it here?`);
    // Slash commands sent as user messages only run with prompt expansion on.
    if (yes && !hasMessages(ctx)) pi.sendUserMessage(`/sync open ${candidate.sessionId}`, { expandPromptTemplates: true });
  };

  const detachCurrent = async (ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const binding = await bindingFor(sessionId);
    if (!binding) {
      notify(ctx, "This conversation is not synchronized.", "info");
      return;
    }
    await ctx.waitForIdle();
    await finishTurn(ctx);
    stopPoll();
    remembered.delete(sessionId);
    await store.remove(sessionId);
    pi.appendEntry(LINK_ENTRY, { detached: true });
    setStatus(ctx);
    notify(ctx, "Stopped synchronizing this conversation on this device. The server copy is unchanged.", "info");
  };

  const showStatus = async (ctx: ExtensionCommandContext) => {
    const binding = await bindingFor(ctx.sessionManager.getSessionId());
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
      if (command === "code") return syncCode(ctx, rest[0] ?? "");
      if (command === "open" && rest[0]) {
        const url = configuredUrl() ?? (await bindingFor(ctx.sessionManager.getSessionId()))?.serverUrl;
        if (!url) return fail(ctx, "sync_not_configured", "Set PI_SYNC_SERVER_URL before using /sync.");
        return openSynced(ctx, url, rest[0]);
      }
      if (command === "") return syncPick(ctx);
      notify(ctx, "Usage: /sync, /sync attach [server URL], /sync detach, /sync refresh, /sync status, or /sync code [on|off]", "error");
    },
  });

  /**
   * Restores a binding lost from the shared file when the server holds a conversation with this
   * session's own id. Copies have fresh ids and detached conversations carry a marker, so neither
   * reconnects. The normal check then uploads local-only turns or keeps them as an unsynced copy.
   */
  const reconnect = async (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    const url = configuredUrl();
    if (!url || !file || !existsSync(file) || detachedHere(ctx)) return;
    const base: SyncBinding = { nativeSessionId: sessionId, serverUrl: url, canonicalSessionId: sessionId, lastEtag: "", materializedFile: file, state: "ready" };
    let etag: string;
    try {
      const found = (await clientFor(url).list({ timeoutMs: 5_000 })).sessions.find((item) => item.sessionId === sessionId);
      if (!found) return;
      etag = found.etag;
    } catch {
      return; // Not on the server, or unreachable: stay unsynchronized and silent.
    }
    if (currentSessionId !== sessionId || (await store.get(sessionId))) return;
    await store.set({ ...base, lastEtag: etag });
    setStatus(ctx, "sync: reconnected");
    startPoll(ctx);
  };

  pi.on("session_start", async (event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    const kept = keptSettings.value;
    keptSettings.value = undefined;
    const reopened = ctx.sessionManager.getSessionFile();
    if (kept && reopened && resolvePath(reopened) === kept.file) {
      if (kept.model && (ctx.model?.provider !== kept.model.provider || ctx.model?.id !== kept.model.id)) await pi.setModel(kept.model);
      if (pi.getThinkingLevel() !== kept.thinking) pi.setThinkingLevel(kept.thinking);
    }
    stopHeartbeat();
    lease = undefined;
    refreshDispatched = false;
    stopPoll();
    await store.load();
    let binding = await bindingFor(currentSessionId);
    if (!binding) {
      setStatus(ctx);
      if (event.reason === "startup" && !hasMessages(ctx)) void offerArrival(ctx).catch(() => undefined);
      else void reconnect(ctx).catch(() => undefined);
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
    if (event.reason === "startup") void noticeCode(ctx.cwd, currentSessionId, (text) => notify(ctx, text, "info")).catch(() => undefined);
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
    const binding = await bindingFor(currentSessionId);
    if (!binding) return { action: "continue" as const };
    if (binding.state === "setup_required") {
      return refuse(ctx, event.text, "The sync server no longer has this conversation. Run /sync attach to upload this copy again.");
    }
    await askToShareCode(ctx).catch(() => undefined);
    let reserved = await exclusive(() => acquire(ctx, binding));
    if (!reserved.ok && reserved.holder && ctx.hasUI) {
      // A sleeping or crashed device can hold the lease for up to two minutes; let the user take it.
      const takeOver = await ctx.ui.confirm(
        `Running on ${reserved.holder}`,
        `This conversation is running on ${reserved.holder}. Take it over here? Anything ${reserved.holder} is still writing will be kept there as a separate copy.`,
      );
      if (takeOver) reserved = await exclusive(() => acquire(ctx, binding, true));
    }
    if (!reserved.ok && reserved.offline && ctx.hasUI) {
      const sendAnyway = await ctx.ui.confirm(
        "Sync server unreachable",
        "Send anyway? This turn uploads when the server is back. If another device continues the conversation meanwhile, this turn is kept as a separate copy.",
      );
      if (sendAnyway) {
        setStatus(ctx, "sync: offline; will upload later");
        return { action: "continue" as const };
      }
    }
    if (!reserved.ok) return refuse(ctx, event.text, reserved.message);
    const { acquired } = reserved;
    // The prefix check also refuses an older copy reopened through /resume, which would roll the conversation back.
    // A binding without a count has no cheap check; its first turn goes through a catch-up, which records the count.
    const intact = acquired.count === undefined || (binding.syncedCount !== undefined && syncedPrefix(ctx.sessionManager.getEntries() as PiEntry[], binding) === acquired.count);
    if (acquired.etag === binding.lastEtag && intact) {
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

  // Compaction outside a turn rewrites context, so it needs the lease and a current copy.
  // Inside a turn (threshold or overflow while the lease is held) it is part of that turn's upload.
  pi.on("session_before_compact", async (event, ctx) => {
    if (lease || !currentSessionId) return;
    const binding = await bindingFor(currentSessionId);
    if (!binding) return;
    const reserved = await exclusive(() => acquire(ctx, binding));
    if (!reserved.ok) {
      notify(ctx, reserved.message, "warning");
      return { cancel: true as const };
    }
    if (reserved.acquired.etag !== binding.lastEtag) {
      await release(binding, reserved.acquired.lease.token);
      // Catch up, then compact the current conversation; automatic compaction simply re-triggers later.
      if (event.reason === "manual") {
        pendingReplay = { sessionId: currentSessionId, text: "", compact: { customInstructions: event.customInstructions } };
        notify(ctx, "Catching up with changes from another device, then compacting…", "info");
      }
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
