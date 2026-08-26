import { existsSync } from "node:fs";
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
  deriveWorkspacePointer,
  materializeSessionFile,
  normalizeSessionFile,
  restoreHead,
  stableEnvelopeFingerprint,
} from "../src/index.js";

const HEARTBEAT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;

type BlockReason = "active_lease" | "uncertain" | "conflict" | "unreachable" | "setup_required" | "invalid";

type ActiveLease = {
  binding: SyncBinding;
  token: string;
  uncertain: boolean;
  notified: boolean;
  timer?: ReturnType<typeof setInterval>;
};

export default function syncExtension(pi: ExtensionAPI) {
  const store = new BindingStore(getAgentDir());
  let deviceLabel = "pi-client";
  let currentSessionId: string | undefined;
  let active: ActiveLease | undefined;
  let blocked: BlockReason | undefined;

  const notify = (ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  };

  const setStatus = (ctx: ExtensionContext | undefined, text?: string) => {
    if (ctx?.hasUI) ctx.ui.setStatus("pi-sync", text);
  };

  const configuredUrl = (args = ""): string | undefined => {
    const candidate = args.trim().split(/\s+/).find((part) => /^https?:\/\//i.test(part));
    return candidate ?? process.env.PI_SYNC_SERVER_URL ?? process.env.PI_SYNC_URL;
  };

  const clientFor = (url: string): SyncClient => new SyncClient({ baseUrl: url, timeoutMs: REQUEST_TIMEOUT_MS });

  const clearHeartbeat = () => {
    if (active?.timer) clearInterval(active.timer);
    if (active) active.timer = undefined;
  };

  const persistBinding = async (binding: SyncBinding, token?: string, expiresAt?: string): Promise<SyncBinding> => {
    const next: SyncBinding = { ...binding };
    if (token) {
      next.leaseToken = token;
      next.leaseExpiresAt = expiresAt;
    } else {
      delete next.leaseToken;
      delete next.leaseExpiresAt;
    }
    await store.set(next);
    return next;
  };

  const showBlocked = (ctx: ExtensionContext | undefined) => {
    const text = blocked === "active_lease"
      ? "The synchronized conversation is in use by another client."
      : blocked === "conflict"
        ? "The synchronized conversation changed remotely. Use /sync to inspect the canonical copy; the local copy was preserved."
        : blocked === "setup_required"
          ? "The sync server no longer has this conversation. Run /sync start to set it up again from this local copy."
          : blocked === "invalid"
            ? "This file is not the recorded synchronized materialization. Use /sync to open the canonical copy safely."
            : "The synchronized conversation lease is uncertain. Pi will not accept another prompt until it can safely reacquire it.";
    notify(ctx, text, "warning");
  };

  const markBlocked = (ctx: ExtensionContext | undefined, reason: BlockReason) => {
    blocked = reason;
    setStatus(ctx, `sync: ${reason}`);
  };

  const markSetupRequired = async (ctx: ExtensionContext | undefined, binding: SyncBinding, notifyUser = false, releaseLease = true): Promise<SyncBinding> => {
    const previous = active?.binding.nativeSessionId === binding.nativeSessionId ? active : undefined;
    if (previous) {
      clearHeartbeat();
      active = undefined;
    }
    if (releaseLease && previous?.token) {
      await clientFor(previous.binding.serverUrl).release(previous.binding.canonicalSessionId, previous.token).catch(() => undefined);
    }
    const next: SyncBinding = { ...binding, state: "setup_required" };
    delete next.leaseToken;
    delete next.leaseExpiresAt;
    await store.set(next);
    blocked = "setup_required";
    setStatus(ctx, "sync: setup required");
    if (notifyUser) notify(ctx, "The sync server no longer has this conversation. Run /sync start to set it up again from this local copy.", "warning");
    return next;
  };

  const releaseConflictLease = async (ctx: ExtensionContext, lease: ActiveLease): Promise<void> => {
    let released = false;
    try {
      await clientFor(lease.binding.serverUrl).release(lease.binding.canonicalSessionId, lease.token);
      released = true;
      const binding = await store.get(lease.binding.nativeSessionId);
      if (binding?.leaseToken === lease.token) await persistBinding(binding);
    } catch {
    }
    lease.uncertain = true;
    clearHeartbeat();
    if (released && active === lease) active = undefined;
    markBlocked(ctx, "conflict");
    notify(ctx, "The canonical synchronized session changed while this client was offline; local data was preserved. Use /sync to open it.", "warning");
  };

  const startHeartbeat = (ctx: ExtensionContext, lease: ActiveLease) => {
    clearHeartbeat();
    lease.timer = setInterval(() => {
      void (async () => {
        if (active !== lease || !lease.token) return;
        try {
          const response = await clientFor(lease.binding.serverUrl).renew(lease.binding.canonicalSessionId, lease.token, { timeoutMs: 5_000 });
          if (lease.binding.lastEtag && response.etag !== lease.binding.lastEtag) {
            await releaseConflictLease(ctx, lease);
            return;
          }
          lease.binding = {
            ...lease.binding,
            state: "ready",
            lastEtag: lease.binding.lastEtag || response.etag,
            leaseToken: lease.token,
            leaseExpiresAt: response.lease.expiresAt,
          };
          lease.uncertain = false;
          lease.notified = false;
          blocked = undefined;
          await store.set(lease.binding);
          setStatus(ctx, `sync: leased until ${response.lease.expiresAt}`);
        } catch (error) {
          if (error instanceof SyncClientError && error.code === "session_not_found") {
            await markSetupRequired(ctx, lease.binding, true);
            return;
          }
          lease.uncertain = true;
          markBlocked(ctx, error instanceof SyncClientError && error.code === "active_lease" ? "active_lease" : "uncertain");
          if (!lease.notified) {
            lease.notified = true;
            notify(ctx, "Pi sync heartbeat failed; the current turn may finish, but the next prompt is blocked until the lease is verified.", "warning");
          }
        }
      })();
    }, HEARTBEAT_MS);
    lease.timer.unref?.();
  };

  const resumeActive = (ctx: ExtensionContext, binding: SyncBinding): boolean => {
    if (!binding.leaseToken) return false;
    active = { binding, token: binding.leaseToken, uncertain: false, notified: false };
    startHeartbeat(ctx, active);
    setStatus(ctx, `sync: leased until ${binding.leaseExpiresAt ?? "unknown"}`);
    return true;
  };

  const ready = (): boolean => Boolean(active?.token && !active.uncertain && !blocked);

  const acquireBinding = async (ctx: ExtensionContext, binding: SyncBinding): Promise<boolean> => {
    clearHeartbeat();
    active = undefined;
    blocked = undefined;
    if (binding.state === "setup_required") {
      markBlocked(ctx, "setup_required");
      return false;
    }
    try {
      const acquired = await clientFor(binding.serverUrl).acquire(binding.canonicalSessionId, deviceLabel, { timeoutMs: REQUEST_TIMEOUT_MS });
      if (binding.lastEtag && acquired.etag !== binding.lastEtag) {
        const conflictBinding = { ...binding, leaseToken: acquired.lease.token, leaseExpiresAt: acquired.lease.expiresAt };
        await store.set(conflictBinding).catch(() => undefined);
        const conflictLease: ActiveLease = { binding: conflictBinding, token: acquired.lease.token, uncertain: false, notified: false };
        active = conflictLease;
        await releaseConflictLease(ctx, conflictLease);
        return false;
      }
      const nextBinding = await persistBinding({ ...binding, state: "ready", lastEtag: acquired.etag }, acquired.lease.token, acquired.lease.expiresAt);
      active = { binding: nextBinding, token: acquired.lease.token, uncertain: false, notified: false };
      startHeartbeat(ctx, active);
      setStatus(ctx, `sync: leased until ${acquired.lease.expiresAt}`);
      return true;
    } catch (error) {
      if (error instanceof SyncClientError && error.code === "session_not_found") {
        await markSetupRequired(ctx, binding);
      } else if (error instanceof SyncClientError && ["active_lease", "lease_invalid"].includes(error.code)) {
        markBlocked(ctx, "active_lease");
      } else if (error instanceof SyncClientError && ["network_error", "timeout"].includes(error.code)) {
        markBlocked(ctx, "unreachable");
      } else {
        markBlocked(ctx, "uncertain");
      }
      return false;
    }
  };

  const verifyPendingLease = async (ctx: ExtensionContext, binding: SyncBinding): Promise<boolean> => {
    if (!binding.leaseToken) return true;
    const lease = active;
    if (!lease || lease.token !== binding.leaseToken) return false;
    try {
      const response = await clientFor(binding.serverUrl).renew(binding.canonicalSessionId, lease.token, { timeoutMs: 5_000 });
      if (binding.lastEtag && response.etag !== binding.lastEtag) {
        await releaseConflictLease(ctx, lease);
        return false;
      }
      lease.binding = {
        ...binding,
        lastEtag: binding.lastEtag || response.etag,
        leaseToken: lease.token,
        leaseExpiresAt: response.lease.expiresAt,
      };
      await store.set(lease.binding);
      blocked = undefined;
      return true;
    } catch (error) {
      if (error instanceof SyncClientError && error.code === "session_not_found") {
        await markSetupRequired(ctx, binding);
      } else if (error instanceof SyncClientError && ["lease_invalid", "lease_not_found", "lease_required"].includes(error.code)) {
        return acquireBinding(ctx, binding);
      } else if (error instanceof SyncClientError && error.code === "active_lease") {
        markBlocked(ctx, "active_lease");
      } else if (error instanceof SyncClientError && ["network_error", "timeout"].includes(error.code)) {
        markBlocked(ctx, "unreachable");
      } else {
        markBlocked(ctx, "uncertain");
      }
      return false;
    }
  };

  const releaseTurn = async (ctx: ExtensionContext, lease: ActiveLease): Promise<boolean> => {
    try {
      await clientFor(lease.binding.serverUrl).release(lease.binding.canonicalSessionId, lease.token);
    } catch (error) {
      lease.uncertain = true;
      if (error instanceof SyncClientError && ["active_lease", "lease_invalid", "lease_not_found"].includes(error.code)) {
        markBlocked(ctx, "uncertain");
      } else if (error instanceof SyncClientError && ["network_error", "timeout"].includes(error.code)) {
        markBlocked(ctx, "unreachable");
      } else {
        markBlocked(ctx, "uncertain");
      }
      notify(ctx, "Pi sync could not release the settled turn; the next prompt is blocked.", "warning");
      return false;
    }
    try {
      const binding = await store.get(lease.binding.nativeSessionId);
      if (binding?.leaseToken === lease.token) await persistBinding(binding);
    } catch {
      lease.uncertain = true;
      markBlocked(ctx, "uncertain");
      notify(ctx, "Pi sync released the turn but could not clear its local lease state; the next prompt is blocked.", "warning");
      return false;
    }
    clearHeartbeat();
    if (active === lease) active = undefined;
    blocked = undefined;
    return true;
  };

  const completeTurn = async (ctx: ExtensionContext, forceUpload: boolean, final = false): Promise<boolean> => {
    if (!currentSessionId) return true;
    if (blocked === "conflict" || blocked === "setup_required" || blocked === "invalid") return false;
    let lease = active;
    if (!lease) {
      const binding = await store.get(currentSessionId);
      if (!binding?.leaseToken) return true;
      resumeActive(ctx, binding);
      lease = active;
    }
    if (!lease?.token) return true;

    let normalized: { envelope: SessionEnvelope; path: string };
    try {
      normalized = await normalizeCurrent(ctx, lease.binding);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not normalize the Pi session.", "error");
      markBlocked(ctx, "invalid");
      return false;
    }
    const fingerprint = stableEnvelopeFingerprint(normalized.envelope);
    if (forceUpload || lease.binding.lastFingerprint !== fingerprint) {
      try {
        const response = await clientFor(lease.binding.serverUrl).update(
          lease.binding.canonicalSessionId,
          normalized.envelope,
          lease.token,
          lease.binding.lastEtag,
        );
        const nextBinding = {
          ...lease.binding,
          state: "ready" as const,
          lastEtag: response.etag,
          lastFingerprint: fingerprint,
          leaseToken: lease.token,
          workspace: normalized.envelope.workspace,
          parentSessionId: normalized.envelope.parentSessionId,
          title: normalized.envelope.title,
        };
        await store.set(nextBinding);
        lease.binding = nextBinding;
      } catch (error) {
        if (error instanceof SyncClientError && error.code === "session_not_found") {
          await markSetupRequired(ctx, lease.binding, true, false);
        } else if (error instanceof SyncClientError && error.code === "stale_etag") {
          await releaseConflictLease(ctx, lease);
        } else if (error instanceof SyncClientError && error.isLeaseFailure) {
          lease.uncertain = true;
          markBlocked(ctx, "uncertain");
        } else {
          lease.uncertain = true;
          markBlocked(ctx, "unreachable");
          notify(ctx, "Pi sync could not upload this settled turn; the local session remains available.", "warning");
        }
        if (final) notify(ctx, "The final local snapshot was not uploaded.", "warning");
        return false;
      }
    }
    if (!(await releaseTurn(ctx, lease))) return false;
    setStatus(ctx, `sync: committed ${normalized.envelope.workspace?.branch ?? "conversation"}`);
    return true;
  };

  const workspaceFor = async (ctx: ExtensionContext) => deriveWorkspacePointer(ctx.cwd, async (command, args) => {
    const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 5_000 });
    return { stdout: result.stdout, code: result.code };
  });

  const normalizeCurrent = async (ctx: ExtensionContext, binding?: SyncBinding): Promise<{ envelope: SessionEnvelope; path: string }> => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) throw new Error("synchronization requires a persistent Pi session");
    const envelope = await normalizeSessionFile(path, {
      requestedSessionId: ctx.sessionManager.getSessionId(),
      headEntryId: ctx.sessionManager.getLeafId() ?? "",
      title: ctx.sessionManager.getSessionName() ?? binding?.title ?? active?.binding.title ?? "",
      parentSessionId: binding?.parentSessionId ?? active?.binding.parentSessionId,
      workspace: await workspaceFor(ctx),
    });
    return { envelope, path };
  };

  const commitSettled = async (ctx: ExtensionContext, final = false): Promise<void> => {
    await completeTurn(ctx, true, final);
  };

  const repairCurrent = async (ctx: ExtensionCommandContext, binding: SyncBinding): Promise<void> => {
    if (!ctx.hasUI) {
      notify(ctx, "Open Pi interactively and run /sync start to confirm rebuilding this missing server session.", "warning");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Recreate synchronized session?",
      "The server no longer has this conversation. Recreate it from this local session?",
    );
    if (!confirmed) {
      notify(ctx, "Synchronized session setup was left unchanged.", "info");
      return;
    }

    let normalized: { envelope: SessionEnvelope; path: string };
    try {
      normalized = await normalizeCurrent(ctx, binding);
      if (normalized.envelope.sessionId !== binding.canonicalSessionId) {
        throw new Error("the current Pi session ID does not match its synchronization binding");
      }
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not normalize the local Pi session.", "error");
      return;
    }

    try {
      const response = await clientFor(binding.serverUrl).enroll(normalized.envelope);
      const nextBinding: SyncBinding = {
        ...binding,
        state: "ready",
        canonicalSessionId: response.session.sessionId,
        lastEtag: response.etag,
        materializedFile: normalized.path,
        lastFingerprint: stableEnvelopeFingerprint(normalized.envelope),
        workspace: normalized.envelope.workspace,
        parentSessionId: normalized.envelope.parentSessionId,
        title: normalized.envelope.title,
      };
      await persistBinding(nextBinding);
      notify(ctx, "The local conversation was re-enrolled; the next prompt will acquire its lease.", "info");
    } catch (error) {
      if (error instanceof SyncClientError && error.code === "duplicate_enrollment") {
        notify(ctx, "A server copy already exists. The local file was preserved; use /sync to open the canonical copy.", "warning");
      } else {
        notify(ctx, error instanceof Error ? error.message : "Could not re-enroll the local conversation.", "error");
      }
    }
  };

  const enrollCurrent = async (ctx: ExtensionCommandContext, args: string) => {
    if (!ctx.sessionManager.getSessionFile()) {
      notify(ctx, "Only persistent Pi sessions can be synchronized.", "error");
      return;
    }
    currentSessionId = ctx.sessionManager.getSessionId();
    const existing = await store.get(currentSessionId);
    const url = configuredUrl(args) ?? existing?.serverUrl;
    if (!url) {
      notify(ctx, "Set PI_SYNC_SERVER_URL or provide a sync server URL after /sync start.", "error");
      return;
    }
    if (existing) {
      if (existing.serverUrl !== url) {
        notify(ctx, "This session is already bound to a different sync server.", "error");
        return;
      }
      if (existing.state === "setup_required") {
        await repairCurrent(ctx, existing);
        return;
      }
      notify(ctx, existing.leaseToken
        ? "Synchronized session is already in an active turn."
        : "Synchronized session is enrolled; the next prompt will acquire its lease.", "info");
      return;
    }
    let normalized: { envelope: SessionEnvelope; path: string };
    try {
      normalized = await normalizeCurrent(ctx);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not normalize the Pi session.", "error");
      return;
    }
    try {
      const response = await clientFor(url).enroll(normalized.envelope);
      const binding: SyncBinding = {
        nativeSessionId: normalized.envelope.sessionId,
        serverUrl: url,
        state: "ready",
        canonicalSessionId: response.session.sessionId,
        lastEtag: response.etag,
        materializedFile: normalized.path,
        lastFingerprint: stableEnvelopeFingerprint(normalized.envelope),
        workspace: normalized.envelope.workspace,
        parentSessionId: normalized.envelope.parentSessionId,
        title: normalized.envelope.title,
      };
      await store.set(binding);
      notify(ctx, "Conversation enrolled; the next prompt will acquire its lease.", "info");
    } catch (error) {
      if (error instanceof SyncClientError && error.code === "duplicate_enrollment") {
        notify(ctx, "A server copy already exists. The local file was preserved; use /sync to open the canonical copy.", "warning");
      } else {
        notify(ctx, error instanceof Error ? error.message : "Conversation enrollment failed.", "error");
      }
    }
  };

  const syncPick = async (ctx: ExtensionCommandContext) => {
    const currentBinding = await store.get(ctx.sessionManager.getSessionId());
    const url = configuredUrl() ?? currentBinding?.serverUrl;
    if (!url) {
      notify(ctx, "Set PI_SYNC_SERVER_URL before using /sync.", "error");
      return;
    }
    if (!ctx.hasUI) {
      notify(ctx, "The synchronized-session picker requires Pi interactive UI.", "error");
      return;
    }
    let list;
    try {
      list = await clientFor(url).list();
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not list synchronized sessions.", "error");
      return;
    }
    if (list.sessions.length === 0) {
      notify(ctx, "No synchronized conversations are enrolled yet. Use /sync start.", "info");
      return;
    }
    const rows = list.sessions.map((item) => ({
      item,
      label: `${item.title || item.sessionId} — ${item.leaseHolder ? `in use by ${item.leaseHolder}` : "available"}`,
    }));
    const selected = await ctx.ui.select("Synchronized conversations", rows.map((row) => row.label));
    if (!selected) return;
    const row = rows.find((candidate) => candidate.label === selected);
    if (!row) return;
    let acquired;
    try {
      acquired = await clientFor(url).acquire(row.item.sessionId, deviceLabel);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not acquire synchronized session.", "error");
      return;
    }
    const sessionDir = ctx.sessionManager.getSessionDir();
    const target = join(sessionDir, `${Date.now()}_${acquired.session.sessionId}.jsonl`);
    const targetBinding: SyncBinding = {
      nativeSessionId: acquired.session.sessionId,
      serverUrl: url,
      state: "ready",
      canonicalSessionId: acquired.session.sessionId,
      lastEtag: acquired.etag,
      materializedFile: target,
      leaseToken: acquired.lease.token,
      leaseExpiresAt: acquired.lease.expiresAt,
      lastFingerprint: stableEnvelopeFingerprint(acquired.session),
      workspace: acquired.session.workspace,
      parentSessionId: acquired.session.parentSessionId,
      title: acquired.session.title,
    };
    let stored = false;
    let released = false;
    const releasePickerLease = async (): Promise<boolean> => {
      try {
        await clientFor(url).release(acquired.session.sessionId, acquired.lease.token);
        released = true;
        return true;
      } catch {
        return false;
      }
    };
    try {
      await materializeSessionFile(target, acquired.session, { cwd: ctx.cwd });
      await store.set(targetBinding);
      stored = true;
      if (await releasePickerLease()) {
        await persistBinding(targetBinding);
      } else {
        notify(ctx, "The synchronized session was materialized, but its lease could not be released; the next prompt will retry.", "warning");
      }
      const result = await ctx.switchSession(target, {
        withSession: async (replacement) => {
          await restoreHead((entryId, options) => replacement.navigateTree(entryId, options), acquired.session.headEntryId);
          replacement.ui.notify("Synchronized conversation opened. The next prompt will acquire its lease.", "info");
        },
      });
      if (result.cancelled) {
        if (!released) await releasePickerLease();
        if (stored && released) await store.remove(targetBinding.nativeSessionId);
      }
    } catch (error) {
      if (!released) await releasePickerLease();
      if (stored && released) await store.remove(targetBinding.nativeSessionId).catch(() => undefined);
      notify(ctx, error instanceof Error ? error.message : "Could not open synchronized session.", "error");
    }
  };

  const showStatus = async (ctx: ExtensionCommandContext) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    const binding = await store.get(currentSessionId);
    if (!binding) {
      notify(ctx, "This Pi session is not synchronized.", "info");
      return;
    }
    let health = "unreachable";
    try {
      await clientFor(binding.serverUrl).health({ timeoutMs: 5_000 });
      health = "available";
    } catch {
      // Status remains useful offline; do not expose transport details.
    }
    const state = blocked ?? (binding.state === "setup_required" ? "setup_required" : ready() ? "leased" : "not leased");
    const workspace = binding.workspace ? ` upstream ${binding.workspace.branch}@${binding.workspace.commit}` : " no upstream";
    notify(ctx, `${health}; ${state}; ETag ${binding.lastEtag};${workspace}`, health === "available" ? "info" : "warning");
  };

  pi.registerCommand("sync", {
    description: "Open, enroll, or inspect synchronized Pi conversations",
    handler: async (args, ctx) => {
      await store.load();
      deviceLabel = await store.deviceLabel();
      const command = args.trim();
      if (command === "start" || command.startsWith("start ")) {
        await enrollCurrent(ctx, command.slice("start".length).trim());
      } else if (command === "status") {
        await showStatus(ctx);
      } else if (command === "" || command === "open") {
        await syncPick(ctx);
      } else {
        notify(ctx, "Usage: /sync, /sync start [server URL], or /sync status", "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    await store.load();
    deviceLabel = await store.deviceLabel();
    active = undefined;
    blocked = undefined;
    const binding = await store.get(currentSessionId);
    if (!binding) {
      setStatus(ctx);
      return;
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile && binding.materializedFile && resolvePath(sessionFile) !== resolvePath(binding.materializedFile)) {
      markBlocked(ctx, "invalid");
      showBlocked(ctx);
      return;
    }
    if (binding.leaseToken) resumeActive(ctx, binding);
    else setStatus(ctx, "sync: not leased");
  });

  pi.on("resources_discover", async () => {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (!currentSessionId) return { action: "continue" as const };
    let binding = await store.get(currentSessionId);
    if (!binding) return { action: "continue" as const };
    if (blocked === "conflict" || blocked === "setup_required" || blocked === "invalid") {
      showBlocked(ctx);
      return { action: "handled" as const };
    }
    if (binding.leaseToken) {
      if (!active || active.token !== binding.leaseToken) resumeActive(ctx, binding);
      if (!(await verifyPendingLease(ctx, binding))) {
        showBlocked(ctx);
        return { action: "handled" as const };
      }
      binding = await store.get(currentSessionId);
      if (!binding) return { action: "continue" as const };
      if (event.streamingBehavior === undefined) {
        if (!(await completeTurn(ctx, false))) {
          showBlocked(ctx);
          return { action: "handled" as const };
        }
        binding = await store.get(currentSessionId);
        if (!binding) return { action: "continue" as const };
      }
    }
    if (ready()) return { action: "continue" as const };
    if (!(await acquireBinding(ctx, binding))) {
      showBlocked(ctx);
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!currentSessionId || !ready() || !active?.binding.workspace) return;
    const workspace = active.binding.workspace;
    return {
      systemPrompt: `${event.systemPrompt}\n\nSynchronized workspace: upstream branch ${workspace.branch} at pushed commit ${workspace.commit}. Follow the synchronized-workspace skill before handing work to another runtime.`,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await commitSettled(ctx);
  });

  const guardDurableMutation = async (ctx: ExtensionContext) => {
    if (!currentSessionId) return;
    const binding = await store.get(currentSessionId);
    if (binding && !ready()) {
      showBlocked(ctx);
      return { cancel: true as const };
    }
  };
  pi.on("session_before_tree", async (_event, ctx) => guardDurableMutation(ctx));
  pi.on("session_before_compact", async (_event, ctx) => guardDurableMutation(ctx));
  pi.on("session_before_fork", async (_event, ctx) => guardDurableMutation(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    if (active?.token && (blocked === "conflict" || blocked === "invalid")) await releaseTurn(ctx, active);
    else await completeTurn(ctx, false, true);
    clearHeartbeat();
    active = undefined;
    setStatus(ctx);
    blocked = undefined;
  });
}
