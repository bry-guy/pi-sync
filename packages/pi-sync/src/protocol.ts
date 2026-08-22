export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const DEFAULT_LEASE_EXPIRY_MS = 120_000;
export const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRIES = 100_000;

export interface WorkspacePointer {
  gitRemote: string;
  branch: string;
  commit: string;
}

export interface PiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionEnvelope {
  formatVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  piSessionVersion: number;
  createdAt: string;
  parentSessionId: string | null;
  headEntryId: string;
  title: string;
  entries: PiEntry[];
  workspace?: WorkspacePointer;
}

export interface SessionMetadata {
  sessionId: string;
  title: string;
  createdAt: string;
  headEntryId: string;
  etag: string;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
  workspace?: WorkspacePointer;
}

export interface Lease {
  token?: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface SessionListResponse {
  formatVersion: typeof PROTOCOL_VERSION;
  sessions: SessionMetadata[];
}

export interface SessionResponse {
  formatVersion: typeof PROTOCOL_VERSION;
  session: SessionEnvelope;
  etag: string;
}

export interface AcquireResponse extends SessionResponse {
  lease: Lease & { token: string };
}

export interface RenewResponse {
  formatVersion: typeof PROTOCOL_VERSION;
  etag: string;
  lease: Lease;
}

export interface HealthResponse {
  status: "ok";
  formatVersion: typeof PROTOCOL_VERSION;
  heartbeatSeconds: number;
  leaseExpirySeconds: number;
}

export interface ProtocolErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ProtocolError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ProtocolError";
    this.field = field;
  }
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const commit = /^[0-9a-fA-F]{7,128}$/;

function fail(message: string, field?: string): never {
  throw new ProtocolError(field ? `${field}: ${message}` : message, field);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) {
    fail("must be a bounded non-empty string", field);
  }
  return value;
}

function nullableId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !safeId.test(value)) fail("must be null or a portable identifier", field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = stringField(value, field, 128);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || Number.isNaN(Date.parse(result))) {
    fail("must be an RFC3339 timestamp", field);
  }
  return result;
}

export function validateWorkspace(value: unknown, field = "workspace"): WorkspacePointer | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail("must be an object", field);
  const gitRemote = stringField(value.gitRemote, `${field}.gitRemote`);
  const branch = stringField(value.branch, `${field}.branch`);
  if (branch.startsWith("-") || branch.includes("..")) fail("is not a portable branch name", `${field}.branch`);
  const workspaceCommit = stringField(value.commit, `${field}.commit`, 128);
  if (!commit.test(workspaceCommit)) fail("must be a hexadecimal commit identifier", `${field}.commit`);
  return { gitRemote, branch, commit: workspaceCommit };
}

export function validateEnvelope(value: unknown): SessionEnvelope {
  if (!isObject(value)) fail("must be a JSON object");
  if (value.formatVersion !== PROTOCOL_VERSION) fail("unsupported format version", "formatVersion");
  const sessionId = stringField(value.sessionId, "sessionId", 128);
  if (!safeId.test(sessionId)) fail("must be a portable identifier", "sessionId");
  if (!Number.isInteger(value.piSessionVersion) || (value.piSessionVersion as number) < 1 || (value.piSessionVersion as number) > 100) {
    fail("must be an integer between 1 and 100", "piSessionVersion");
  }
  const createdAt = timestamp(value.createdAt, "createdAt");
  const parentSessionId = nullableId(value.parentSessionId, "parentSessionId");
  const title = typeof value.title === "string" ? value.title : fail("must be a string", "title");
  if (title.length > 2_000 || /\u0000/.test(title)) fail("is too long or contains a NUL byte", "title");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail("must be an array with a bounded length", "entries");

  const entries: PiEntry[] = [];
  const ids = new Set<string>();
  const parents = new Map<string, string>();
  for (const [index, raw] of value.entries.entries()) {
    const field = `entries[${index}]`;
    if (!isObject(raw)) fail("must be an object", field);
    const type = stringField(raw.type, `${field}.type`, 128);
    const id = stringField(raw.id, `${field}.id`, 128);
    if (!safeId.test(id)) fail("must be a portable identifier", `${field}.id`);
    if (ids.has(id)) fail("duplicates another entry id", `${field}.id`);
    ids.add(id);
    const parentId = raw.parentId === null ? null : nullableId(raw.parentId, `${field}.parentId`);
    const entryTimestamp = timestamp(raw.timestamp, `${field}.timestamp`);
    entries.push({ ...raw, type, id, parentId, timestamp: entryTimestamp });
    parents.set(id, parentId ?? "");
  }

  if (entries.length === 0) {
    if (value.headEntryId !== "") fail("must be empty when entries is empty", "headEntryId");
  } else {
    const headEntryId = stringField(value.headEntryId, "headEntryId", 128);
    if (!safeId.test(headEntryId) || !ids.has(headEntryId)) fail("must identify an entry", "headEntryId");
    let roots = 0;
    for (const [id, parentId] of parents) {
      if (parentId === "") {
        roots++;
      } else if (!ids.has(parentId)) {
        fail(`refers to missing parent ${parentId}`, `entries.${id}.parentId`);
      }
    }
    if (roots !== 1) fail("must contain exactly one root entry", "entries");
    for (const id of ids) {
      const visited = new Set<string>();
      let current = id;
      while (current !== "") {
        if (visited.has(current)) fail(`contains a cycle at ${current}`, "entries");
        visited.add(current);
        current = parents.get(current) ?? "";
      }
    }
  }

  const workspace = validateWorkspace(value.workspace);
  return {
    formatVersion: PROTOCOL_VERSION,
    sessionId,
    piSessionVersion: value.piSessionVersion as number,
    createdAt,
    parentSessionId,
    headEntryId: value.headEntryId as string,
    title,
    entries,
    ...(workspace ? { workspace } : {}),
  };
}

export function assertProtocolVersion(value: unknown): void {
  if (!isObject(value) || value.formatVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported or missing protocol version");
  }
}

export function validateMetadata(value: unknown): SessionMetadata {
  if (!isObject(value)) fail("session metadata must be an object");
  const sessionId = stringField(value.sessionId, "sessionId", 128);
  if (!safeId.test(sessionId)) fail("must be a portable identifier", "sessionId");
  const title = typeof value.title === "string" ? value.title : fail("must be a string", "title");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const headEntryId = typeof value.headEntryId === "string" ? value.headEntryId : fail("must be a string", "headEntryId");
  const etag = stringField(value.etag, "etag", 512);
  const leaseHolder = value.leaseHolder === null || value.leaseHolder === undefined ? null : stringField(value.leaseHolder, "leaseHolder", 128);
  const leaseExpiresAt = value.leaseExpiresAt === null || value.leaseExpiresAt === undefined ? null : timestamp(value.leaseExpiresAt, "leaseExpiresAt");
  return { sessionId, title, createdAt, headEntryId, etag, leaseHolder, leaseExpiresAt, workspace: validateWorkspace(value.workspace) };
}

export function validateSessionResponse(value: unknown): SessionResponse {
  assertProtocolVersion(value);
  if (!isObject(value)) fail("response must be an object");
  return {
    formatVersion: PROTOCOL_VERSION,
    session: validateEnvelope(value.session),
    etag: stringField(value.etag, "etag", 512),
  };
}

export function validateListResponse(value: unknown): SessionListResponse {
  assertProtocolVersion(value);
  if (!isObject(value) || !Array.isArray(value.sessions)) fail("response sessions must be an array");
  return { formatVersion: PROTOCOL_VERSION, sessions: value.sessions.map((item) => validateMetadata(item)) };
}

export function validateLease(value: unknown, requireToken: boolean): Lease {
  if (!isObject(value)) fail("lease must be an object");
  const token = value.token === undefined ? undefined : stringField(value.token, "lease.token", 512);
  if (requireToken && !token) fail("lease token is missing", "lease.token");
  const holder = stringField(value.holder, "lease.holder", 128);
  const acquiredAt = timestamp(value.acquiredAt, "lease.acquiredAt");
  const expiresAt = timestamp(value.expiresAt, "lease.expiresAt");
  return { ...(token ? { token } : {}), holder, acquiredAt, expiresAt };
}

export function stableEnvelopeFingerprint(envelope: SessionEnvelope): string {
  return JSON.stringify(envelope);
}
