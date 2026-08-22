import {
  type AcquireResponse,
  assertProtocolVersion,
  type HealthResponse,
  type Lease,
  type ProtocolErrorBody,
  PROTOCOL_VERSION,
  type SessionEnvelope,
  type SessionListResponse,
  type SessionResponse,
  type RenewResponse,
  MAX_ENVELOPE_BYTES,
  validateEnvelope,
  validateLease,
  validateListResponse,
  validateSessionResponse,
} from "../protocol.js";

export interface SyncClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class SyncClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: { status?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "SyncClientError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }

  get isConflict(): boolean {
    return this.code === "stale_etag" || this.code === "active_lease";
  }

  get isLeaseFailure(): boolean {
    return this.code === "lease_required" || this.code === "lease_invalid" || this.code === "active_lease";
  }
}

const messages: Record<string, string> = {
  active_lease: "The synchronized session is in use by another client.",
  duplicate_enrollment: "This session is already synchronized.",
  stale_etag: "The synchronized session changed on another client.",
  lease_required: "This operation requires the synchronized session lease.",
  lease_invalid: "The synchronized session lease expired or is no longer valid.",
  lease_not_found: "The synchronized session lease is no longer active.",
  session_not_found: "The synchronized session no longer exists.",
  invalid_session: "The synchronized session data was rejected by the server.",
  request_too_large: "The synchronized session is too large.",
  not_found: "The synchronization endpoint was not found.",
};

export class SyncClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: SyncClientOptions | string) {
    const config = typeof options === "string" ? { baseUrl: options } : options;
    if (!config.baseUrl || !/^https?:\/\//i.test(config.baseUrl)) {
      throw new TypeError("sync server URL must use http or https");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = config.timeoutMs ?? 10_000;
  }

  async health(options: RequestOptions = {}): Promise<HealthResponse> {
    const value = await this.request("/v1/health", { method: "GET" }, options);
    assertProtocolVersion(value);
    if (!isRecord(value) || value.status !== "ok" || typeof value.heartbeatSeconds !== "number" || typeof value.leaseExpirySeconds !== "number") {
      throw new SyncClientError("invalid_response", "The sync server returned an invalid health response.");
    }
    return {
      status: "ok",
      formatVersion: PROTOCOL_VERSION,
      heartbeatSeconds: value.heartbeatSeconds,
      leaseExpirySeconds: value.leaseExpirySeconds,
    };
  }

  async list(options: RequestOptions = {}): Promise<SessionListResponse> {
    const value = await this.request("/v1/sessions", { method: "GET" }, options);
    try {
      return validateListResponse(value);
    } catch {
      throw new SyncClientError("invalid_response", "The sync server returned an invalid session list.");
    }
  }

  async enroll(envelope: SessionEnvelope, options: RequestOptions = {}): Promise<SessionResponse> {
    return this.sessionRequest("/v1/sessions", "POST", envelope, options);
  }

  async acquire(sessionId: string, holder: string, options: RequestOptions = {}): Promise<AcquireResponse> {
    const value = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder }),
    }, options);
    try {
      if (!isRecord(value)) throw new Error("object expected");
      const response = validateSessionResponse(value);
      const lease = validateLease(value.lease, true) as Lease & { token: string };
      return { ...response, lease };
    } catch {
      throw new SyncClientError("invalid_response", "The sync server returned an invalid lease response.");
    }
  }

  async renew(sessionId: string, token: string, options: RequestOptions = {}): Promise<RenewResponse> {
    const value = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/lease/renew`, {
      method: "POST",
      headers: this.leaseHeaders(token),
    }, options);
    try {
      if (!isRecord(value)) throw new Error("object expected");
      assertProtocolVersion(value);
      const lease = validateLease(value.lease, false);
      if (typeof value.etag !== "string") throw new Error("etag missing");
      return { formatVersion: PROTOCOL_VERSION, etag: value.etag, lease };
    } catch {
      throw new SyncClientError("invalid_response", "The sync server returned an invalid renewal response.");
    }
  }

  async update(sessionId: string, envelope: SessionEnvelope, token: string, etag: string, options: RequestOptions = {}): Promise<SessionResponse> {
    return this.sessionRequest(`/v1/sessions/${encodeURIComponent(sessionId)}`, "PUT", envelope, options, {
      ...this.leaseHeaders(token),
      "If-Match": etag,
    });
  }

  async release(sessionId: string, token: string, options: RequestOptions = {}): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
      method: "DELETE",
      headers: this.leaseHeaders(token),
    }, options, { allowEmpty: true });
  }

  private async sessionRequest(path: string, method: "POST" | "PUT", envelope: SessionEnvelope, options: RequestOptions, extraHeaders: Record<string, string> = {}): Promise<SessionResponse> {
    const validated = validateEnvelope(envelope);
    const body = JSON.stringify(validated);
    if (new TextEncoder().encode(body).byteLength > MAX_ENVELOPE_BYTES) {
      throw new SyncClientError("request_too_large", "The synchronized session is too large.");
    }
    const value = await this.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body,
    }, options);
    try {
      return validateSessionResponse(value);
    } catch {
      throw new SyncClientError("invalid_response", "The sync server returned invalid session data.");
    }
  }

  private leaseHeaders(token: string): Record<string, string> {
    if (!token) throw new TypeError("lease token must not be empty");
    return { "X-Pi-Sync-Lease": token };
  }

  private async request(path: string, init: RequestInit, options: RequestOptions = {}, responseOptions: { allowEmpty?: boolean } = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      const length = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(length) && length > 16 * 1024 * 1024) {
        throw new SyncClientError("response_too_large", "The sync server returned an oversized response.", { status: response.status });
      }
      const text = await response.text();
      if (text.length > 16 * 1024 * 1024) {
        throw new SyncClientError("response_too_large", "The sync server returned an oversized response.", { status: response.status });
      }
      if (!response.ok) throw this.errorFromResponse(response.status, text);
      if (!text.trim()) {
        if (responseOptions.allowEmpty) return undefined;
        throw new SyncClientError("invalid_response", "The sync server returned an empty response.", { status: response.status });
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SyncClientError("invalid_response", "The sync server returned invalid JSON.", { status: response.status });
      }
    } catch (error) {
      if (error instanceof SyncClientError) throw error;
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new SyncClientError("aborted", "The synchronization request was cancelled.");
        throw new SyncClientError("timeout", "The synchronization server did not respond in time.");
      }
      throw new SyncClientError("network_error", "The synchronization server could not be reached.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private errorFromResponse(status: number, text: string): SyncClientError {
    let body: ProtocolErrorBody | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: ProtocolErrorBody };
      if (isRecord(parsed.error) && typeof parsed.error.code === "string") {
        body = {
          code: parsed.error.code.slice(0, 80),
          message: typeof parsed.error.message === "string" ? parsed.error.message.slice(0, 256) : "",
          details: isRecord(parsed.error.details) ? parsed.error.details : undefined,
        };
      }
    } catch {
      // Use a status-derived safe error below.
    }
    const code = body?.code ?? statusCode(status);
    const message = messages[code] ?? `Synchronization request failed (HTTP ${status}).`;
    return new SyncClientError(code, message, { status, details: body?.details });
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusCode(status: number): string {
  switch (status) {
    case 400: return "invalid_request";
    case 404: return "not_found";
    case 409: return "conflict";
    case 412: return "stale_etag";
    case 423: return "lease_invalid";
    case 413: return "request_too_large";
    default: return "http_error";
  }
}
