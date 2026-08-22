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

type BlockReason = "active_lease" | "uncertain" | "conflict" | "unreachable" | "invalid";

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

  const stopActive = async (release: boolean): Promise<void> => {
    clearHeartbeat();
    const previous = active;
    active = undefined;
    if (!previous) return;
    if (release && previous.token) {
      try {
        await clientFor(previous.binding.serverUrl).release(previous.binding.canonicalSessionId, previous.token);
      } catch {
        // The lease may already have expired or the server may be offline. The
        // token is still removed from local state below and can never mutate a
        // conversation after this runtime exits.
      }
    }
    const binding = await store.get(previous.binding.nativeSessionId);
    if (binding) await persistBinding(binding);
  };

  const showBlocked = (ctx: ExtensionContext | undefined) => {
    const text = blocked === "active_lease"
      ? "The synchronized conversation is in use by another client."
      : blocked === "conflict"
        ? "The synchronized conversation changed remotely. Use /sync to inspect the canonical copy; the local copy was preserved."
        : blocked === "invalid"
          ? "This file is not the recorded synchronized materialization. Use /sync to open the canonical copy safely."
          : "The synchronized conversation lease is uncertain. Pi will not accept another prompt until it can safely reacquire it.";
    notify(ctx, text, "warning");
  };

  const markBlocked = (ctx: ExtensionContext | undefined, reason: BlockReason) => {
    blocked = reason;
    setStatus(ctx, `sync: ${reason}`);
  };

  const startHeartbeat = (ctx: ExtensionContext, lease: ActiveLease) => {
    clearHeartbeat();
    lease.timer = setInterval(() => {
      void (async () => {
        if (active !== lease || !lease.token) return;
        try {
          const response = await clientFor(lease.binding.serverUrl).renew(lease.binding.canonicalSessionId, lease.token, { timeoutMs: 5_000 });
          lease.binding = {
            ...lease.binding,
            lastEtag: response.etag,
            leaseToken: lease.token,
            leaseExpiresAt: response.lease.expiresAt,
          };
          lease.uncertain = false;
          lease.notified = false;
          blocked = undefined;
          await store.set(lease.binding);
          setStatus(ctx, `sync: leased until ${response.lease.expiresAt}`);
        } catch (error) {
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

  const ready = (): boolean => Boolean(active?.token && !active.uncertain && !blocked);

  const activateBinding = async (ctx: ExtensionContext, binding: SyncBinding, allowReacquire = true): Promise<boolean> => {
    clearHeartbeat();
    blocked = undefined;
    const client = clientFor(binding.serverUrl);
    let token = binding.leaseToken;
    let expiresAt = binding.leaseExpiresAt;
    let etag = binding.lastEtag;

    if (token) {
      try {
        const renewed = await client.renew(binding.canonicalSessionId, token, { timeoutMs: 5_000 });
        if (etag && renewed.etag !== etag) {
          markBlocked(ctx, "conflict");
          notify(ctx, "The canonical synchronized session changed while this client was offline; local data was preserved.", "warning");
          return false;
        }
        etag = renewed.etag;
        expiresAt = renewed.lease.expiresAt;
      } catch (error) {
        if (!allowReacquire || (error instanceof SyncClientError && ["network_error", "timeout", "aborted"].includes(error.code))) {
          markBlocked(ctx, "uncertain");
          return false;
        }
        token = undefined;
        expiresAt = undefined;
      }
    }

    if (!token) {
      if (!allowReacquire) {
        markBlocked(ctx, "uncertain");
        return false;
      }
      try {
        const acquired = await client.acquire(binding.canonicalSessionId, deviceLabel, { timeoutMs: REQUEST_TIMEOUT_MS });
        if (etag && acquired.etag !== etag) {
          try {
            await client.release(binding.canonicalSessionId, acquired.lease.token);
          } catch {
            // Best effort only; the conflict is still surfaced locally.
          }
          markBlocked(ctx, "conflict");
          notify(ctx, "A newer canonical snapshot exists. The local materialization was not overwritten.", "warning");
          return false;
        }
        token = acquired.lease.token;
        etag = acquired.etag;
        expiresAt = acquired.lease.expiresAt;
      } catch (error) {
        if (error instanceof SyncClientError && error.code === "active_lease") markBlocked(ctx, "active_lease");
        else if (error instanceof SyncClientError && ["network_error", "timeout"].includes(error.code)) markBlocked(ctx, "unreachable");
        else markBlocked(ctx, "uncertain");
        return false;
      }
    }

    const nextBinding = await persistBinding({ ...binding, lastEtag: etag }, token, expiresAt);
    active = { binding: nextBinding, token, uncertain: false, notified: false };
    blocked = undefined;
    startHeartbeat(ctx, active);
    setStatus(ctx, `sync: leased until ${expiresAt ?? "unknown"}`);
    return true;
  };

  const ensureActive = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!currentSessionId) return false;
    if (ready()) return true;
    const binding = await store.get(currentSessionId);
    if (!binding) return false;
    return activateBinding(ctx, binding, true);
  };

  const workspaceFor = async (ctx: ExtensionContext) => deriveWorkspacePointer(ctx.cwd, async (command, args) => {
    const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 5_000 });
    return { stdout: result.stdout, code: result.code };
  });

  const normalizeCurrent = async (ctx: ExtensionContext): Promise<{ envelope: SessionEnvelope; path: string }> => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) throw new Error("synchronization requires a persistent Pi session");
    const envelope = await normalizeSessionFile(path, {
      requestedSessionId: ctx.sessionManager.getSessionId(),
      headEntryId: ctx.sessionManager.getLeafId() ?? "",
      title: ctx.sessionManager.getSessionName() ?? active?.binding.title ?? "",
      parentSessionId: active?.binding.parentSessionId,
      workspace: await workspaceFor(ctx),
    });
    return { envelope, path };
  };

  const commitSettled = async (ctx: ExtensionContext, final = false): Promise<void> => {
    if (!currentSessionId) return;
    const binding = await store.get(currentSessionId);
    if (!binding) return;
    if (!(await ensureActive(ctx))) {
      if (final) notify(ctx, "Pi sync could not verify the lease; the final local snapshot was not uploaded.", "warning");
      return;
    }
    const current = active;
    if (!current || !ready()) return;
    let normalized: { envelope: SessionEnvelope; path: string };
    try {
      normalized = await normalizeCurrent(ctx);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not normalize the Pi session.", "error");
      return;
    }
    const fingerprint = stableEnvelopeFingerprint(normalized.envelope);
    if (!final && current.binding.lastFingerprint === fingerprint) return;
    try {
      const response = await clientFor(current.binding.serverUrl).update(
        current.binding.canonicalSessionId,
        normalized.envelope,
        current.token,
        current.binding.lastEtag,
      );
      current.binding = {
        ...current.binding,
        lastEtag: response.etag,
        lastFingerprint: fingerprint,
        leaseToken: current.token,
        workspace: normalized.envelope.workspace,
        parentSessionId: normalized.envelope.parentSessionId,
        title: normalized.envelope.title,
      };
      await store.set(current.binding);
      setStatus(ctx, `sync: committed ${normalized.envelope.workspace?.branch ?? "conversation"}`);
    } catch (error) {
      if (error instanceof SyncClientError && error.code === "stale_etag") {
        current.uncertain = true;
        markBlocked(ctx, "conflict");
        notify(ctx, "Pi sync found a newer canonical snapshot. The local session was preserved and was not overwritten.", "warning");
      } else if (error instanceof SyncClientError && error.isLeaseFailure) {
        current.uncertain = true;
        markBlocked(ctx, "uncertain");
      } else {
        current.uncertain = true;
        markBlocked(ctx, "unreachable");
        notify(ctx, "Pi sync could not upload this settled turn; the local session remains available.", "warning");
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
      if (await activateBinding(ctx, existing)) notify(ctx, "Synchronized session lease active.", "info");
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
        canonicalSessionId: response.session.sessionId,
        lastEtag: response.etag,
        materializedFile: normalized.path,
        lastFingerprint: stableEnvelopeFingerprint(normalized.envelope),
        workspace: normalized.envelope.workspace,
        parentSessionId: normalized.envelope.parentSessionId,
        title: normalized.envelope.title,
      };
      await store.set(binding);
      if (await activateBinding(ctx, binding)) notify(ctx, "Conversation enrolled and synchronized.", "info");
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Conversation enrollment failed.", "error");
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
    try {
      await materializeSessionFile(target, acquired.session, { cwd: ctx.cwd });
      await store.set(targetBinding);
      const result = await ctx.switchSession(target, {
        withSession: async (replacement) => {
          await restoreHead((entryId, options) => replacement.navigateTree(entryId, options), acquired.session.headEntryId);
          replacement.ui.notify("Synchronized conversation opened. The lease heartbeat is active.", "info");
        },
      });
      if (result.cancelled) {
        await store.remove(targetBinding.nativeSessionId);
        await clientFor(url).release(acquired.session.sessionId, acquired.lease.token).catch(() => undefined);
      }
    } catch (error) {
      await store.remove(targetBinding.nativeSessionId).catch(() => undefined);
      await clientFor(url).release(acquired.session.sessionId, acquired.lease.token).catch(() => undefined);
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
    const state = blocked ?? (ready() ? "leased" : "not leased");
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
    if (!(await activateBinding(ctx, binding))) showBlocked(ctx);
  });

  pi.on("resources_discover", async () => {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });

  pi.on("input", async (_event, ctx) => {
    if (!currentSessionId) return { action: "continue" as const };
    const binding = await store.get(currentSessionId);
    if (!binding) return { action: "continue" as const };
    if (!ready()) {
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
    await commitSettled(ctx, true);
    await stopActive(true);
    setStatus(ctx);
    active = undefined;
    blocked = undefined;
  });
}
