import { randomUUID } from "node:crypto";

export interface RemoteSessionMeta {
  sessionId: string;
  hostId: string;
  device: string;
  cwd: string;
  title?: string;
  model?: string;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  context?: unknown;
  streaming: boolean;
  waitingDialog?: string;
  pendingQuestion?: unknown;
}

export interface RemoteCommand {
  reqId: string;
  sessionId: string;
  type: "transcript" | "message" | "stop" | "answer_question" | "set_thinking" | "set_model" | "close";
  payload?: unknown;
}

export interface RemoteReply {
  status: number;
  body: unknown;
}

export interface RemoteMessagePayload {
  text?: string;
  mode?: "prompt" | "steer" | "followUp";
  images?: unknown[];
  clientMessageId?: string;
}

export interface RemoteAnswerPayload {
  requestId: string;
  body?: unknown;
}

export interface RemoteHostHandlers {
  onTranscript: () => Promise<RemoteReply> | RemoteReply;
  onMessage: (payload: RemoteMessagePayload) => Promise<RemoteReply> | RemoteReply;
  onStop: () => Promise<RemoteReply> | RemoteReply;
  onAnswerQuestion: (payload: RemoteAnswerPayload) => Promise<RemoteReply> | RemoteReply;
  onSetThinking?: (payload: { level?: string }) => Promise<RemoteReply> | RemoteReply;
  onSetModel?: (payload: { model?: string }) => Promise<RemoteReply> | RemoteReply;
  onClose?: () => Promise<RemoteReply> | RemoteReply;
}

export type RemoteHostStatus = "connecting" | "online" | "offline" | "disabled";

export interface RemoteHostOptions {
  baseUrl: string;
  token?: string;
  hostId?: string;
  meta: Omit<RemoteSessionMeta, "hostId">;
  handlers: RemoteHostHandlers;
  pollWaitSec?: number;
  flushMs?: number;
  fetch?: typeof globalThis.fetch;
  onStatus?: (status: RemoteHostStatus) => void;
}

const IMMEDIATE_EVENTS = new Set([
  "user_message",
  "turn_start",
  "message_start",
  "message_end",
  "tool_start",
  "tool_end",
  "turn_end",
  "ask_user_prompt",
  "ask_user_cleared",
  "waiting_dialog",
  "working_message",
  "summary",
  "compaction_start",
  "compaction_end",
  "session_meta",
]);

/**
 * Outbound remote-control host client for a single live Pi session.
 * Uses <=20s HTTP long-polling for commands and batched POSTs for live events (zero extra deps).
 */
export class RemoteHost {
  readonly hostId: string;
  readonly sessionId: string;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly pollWaitSec: number;
  private readonly flushMs: number;
  private readonly handlers: RemoteHostHandlers;
  private readonly onStatus?: (status: RemoteHostStatus) => void;

  private meta: RemoteSessionMeta;
  private stopped = false;
  private registered = false;
  private status: RemoteHostStatus = "connecting";
  private pollAbort?: AbortController;
  private eventQueue: unknown[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private seenMessageIds: string[] = [];
  private seenMessageSet = new Set<string>();
  private loopPromise?: Promise<void>;

  constructor(options: RemoteHostOptions) {
    this.hostId = options.hostId || randomUUID();
    this.sessionId = options.meta.sessionId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.pollWaitSec = Math.min(20, Math.max(1, options.pollWaitSec ?? 20));
    this.flushMs = Math.max(10, options.flushMs ?? 40);
    this.handlers = options.handlers;
    this.onStatus = options.onStatus;
    this.meta = { ...options.meta, hostId: this.hostId };
  }

  getStatus(): RemoteHostStatus {
    return this.status;
  }

  start(): void {
    if (this.loopPromise || this.stopped) return;
    this.loopPromise = this.runLoop();
  }

  updateMeta(patch: Partial<Omit<RemoteSessionMeta, "sessionId" | "hostId">>): void {
    this.meta = { ...this.meta, ...patch };
    if (this.stopped || !this.registered) return;
    void this.registerOnce().catch(() => {
      this.registered = false;
    });
  }

  pushEvent(event: Record<string, unknown>): void {
    if (this.stopped || !this.registered) return;
    this.eventQueue.push(event);
    const type = typeof event.type === "string" ? event.type : "";
    if (IMMEDIATE_EVENTS.has(type) || this.eventQueue.length >= 24) {
      void this.flushEvents();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushEvents();
      }, this.flushMs);
      this.flushTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.eventQueue = [];
    this.pollAbort?.abort();
    const wasRegistered = this.registered;
    this.registered = false;
    if (wasRegistered) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 1_500);
      timer.unref?.();
      try {
        await this.fetchImpl(
          `${this.baseUrl}/v1/remote/host/sessions/${encodeURIComponent(this.sessionId)}?hostId=${encodeURIComponent(this.hostId)}`,
          { method: "DELETE", headers: this.headers(), signal: abort.signal },
        );
      } catch {
        // Best-effort unregister; server TTL cleans up if offline.
      } finally {
        clearTimeout(timer);
      }
    }
    await this.loopPromise?.catch(() => undefined);
  }

  private setStatus(next: RemoteHostStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatus?.(next);
  }

  private headers(json = false): Record<string, string> {
    const out: Record<string, string> = {};
    if (json) out["content-type"] = "application/json";
    if (this.token) out.authorization = `Bearer ${this.token}`;
    return out;
  }

  private async registerOnce(): Promise<"ok" | "disabled" | "retry"> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/remote/host/register`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(this.meta),
      signal: this.pollAbort?.signal,
    });
    if (res.status === 404) return "disabled";
    if (!res.ok) return "retry";
    this.registered = true;
    this.setStatus("online");
    return "ok";
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 500;
    while (!this.stopped) {
      this.pollAbort = new AbortController();
      try {
        if (!this.registered) {
          const outcome = await this.registerOnce();
          if (outcome === "disabled") {
            this.setStatus("disabled");
            return;
          }
          if (outcome === "retry") {
            this.setStatus("offline");
            await this.sleep(backoffMs);
            backoffMs = Math.min(10_000, backoffMs * 2);
            continue;
          }
          backoffMs = 500;
        }

        const res = await this.fetchImpl(
          `${this.baseUrl}/v1/remote/host/poll?hostId=${encodeURIComponent(this.hostId)}&wait=${this.pollWaitSec}`,
          { method: "GET", headers: this.headers(), signal: this.pollAbort.signal },
        );
        if (res.status === 404) {
          this.registered = false;
          this.setStatus("disabled");
          return;
        }
        if (!res.ok) {
          this.registered = false;
          this.setStatus("offline");
          await this.sleep(backoffMs);
          backoffMs = Math.min(10_000, backoffMs * 2);
          continue;
        }
        backoffMs = 500;
        this.setStatus("online");
        const data = (await res.json()) as { commands?: RemoteCommand[] };
        for (const cmd of data.commands ?? []) {
          void this.handleCommand(cmd);
        }
      } catch {
        if (this.stopped) return;
        this.registered = false;
        this.setStatus("offline");
        await this.sleep(backoffMs);
        backoffMs = Math.min(10_000, backoffMs * 2);
      }
    }
  }

  private async handleCommand(cmd: RemoteCommand): Promise<void> {
    let reply: RemoteReply;
    try {
      if (cmd.sessionId !== this.sessionId) {
        reply = { status: 404, body: { error: "session_mismatch", message: "session is no longer active on this host" } };
      } else if (cmd.type === "transcript") {
        reply = await this.handlers.onTranscript();
      } else if (cmd.type === "message") {
        const payload = (cmd.payload ?? {}) as RemoteMessagePayload;
        if (payload.clientMessageId && this.seenMessageSet.has(payload.clientMessageId)) {
          reply = { status: 200, body: { ok: true, duplicate: true } };
        } else {
          if (payload.clientMessageId) this.rememberMessageId(payload.clientMessageId);
          reply = await this.handlers.onMessage(payload);
        }
      } else if (cmd.type === "stop") {
        reply = await this.handlers.onStop();
      } else if (cmd.type === "answer_question") {
        reply = await this.handlers.onAnswerQuestion((cmd.payload ?? { requestId: "" }) as RemoteAnswerPayload);
      } else if (cmd.type === "set_thinking" && this.handlers.onSetThinking) {
        reply = await this.handlers.onSetThinking((cmd.payload ?? {}) as { level?: string });
      } else if (cmd.type === "set_model" && this.handlers.onSetModel) {
        reply = await this.handlers.onSetModel((cmd.payload ?? {}) as { model?: string });
      } else if (cmd.type === "close" && this.handlers.onClose) {
        reply = await this.handlers.onClose();
      } else {
        reply = { status: 400, body: { error: "unknown_command", message: `unsupported command ${String(cmd.type)}` } };
      }
    } catch (error) {
      reply = { status: 500, body: { error: "host_error", message: error instanceof Error ? error.message : String(error) } };
    }
    try {
      await this.fetchImpl(`${this.baseUrl}/v1/remote/host/reply`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ hostId: this.hostId, reqId: cmd.reqId, status: reply.status, body: reply.body }),
      });
    } catch {
      // Controller will time out if the relay dropped.
    }
  }

  private rememberMessageId(id: string): void {
    this.seenMessageSet.add(id);
    this.seenMessageIds.push(id);
    if (this.seenMessageIds.length > 64) {
      const oldest = this.seenMessageIds.shift();
      if (oldest) this.seenMessageSet.delete(oldest);
    }
  }

  private async flushEvents(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.stopped || !this.registered || this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/remote/host/events`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ hostId: this.hostId, sessionId: this.sessionId, events: batch }),
      });
      if (res.status === 404) this.registered = false;
    } catch {
      // Transient drop: live events are ephemeral; transcript stays authoritative on reconnect.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this.pollAbort?.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
