import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { type PiEntry, type SessionEnvelope, type WorkspacePointer, validateEnvelope } from "../protocol.js";

export interface NativeSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd?: string;
  parentSession?: string;
  [key: string]: unknown;
}

export interface NormalizeOptions {
  requestedSessionId?: string;
  headEntryId?: string;
  title?: string;
  parentSessionId?: string | null;
  resolveParentSessionId?: (parentSessionPath: string) => string | null | Promise<string | null>;
  workspace?: WorkspacePointer;
}

export async function normalizeSessionFile(path: string, options: NormalizeOptions = {}): Promise<SessionEnvelope> {
  return normalizeNativeJsonl(await readFile(path, "utf8"), options);
}

export const normalizeSession = normalizeNativeJsonl;

export async function normalizeNativeJsonl(text: string, options: NormalizeOptions = {}): Promise<SessionEnvelope> {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("session file is empty");
  const firstLine = lines[0];
  if (firstLine === undefined) throw new Error("session header is missing");
  const header = parseHeader(firstLine);
  if (options.requestedSessionId && header.id !== options.requestedSessionId) {
    throw new Error(`session ID mismatch: expected ${options.requestedSessionId}, got ${header.id}`);
  }

  const entries: PiEntry[] = [];
  for (let index = 1; index < lines.length; index++) {
    let value: unknown;
    const line = lines[index];
    if (line === undefined) throw new Error(`session entry ${index} is missing`);
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`session entry ${index} is not valid JSON`);
    }
    if (!isRecord(value) || typeof value.type !== "string") throw new Error(`session entry ${index} is invalid`);
    entries.push(value as PiEntry);
  }

  let parentSessionId = options.parentSessionId;
  if (parentSessionId === undefined && header.parentSession) {
    if (options.resolveParentSessionId) {
      parentSessionId = await options.resolveParentSessionId(header.parentSession);
    } else {
      parentSessionId = await resolveParentFileId(header.parentSession);
    }
  }
  parentSessionId ??= null;

  const inferredTitle = [...entries].reverse().find((entry) => entry.type === "session_info" && typeof entry.name === "string");
  const headEntryId = options.headEntryId ?? entries.at(-1)?.id ?? "";
  const envelope = {
    formatVersion: 1 as const,
    sessionId: header.id,
    piSessionVersion: Number.isInteger(header.version) ? (header.version as number) : 1,
    createdAt: header.timestamp,
    parentSessionId,
    headEntryId,
    title: options.title ?? (inferredTitle && typeof inferredTitle.name === "string" ? inferredTitle.name : ""),
    entries,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  } satisfies SessionEnvelope;
  return validateEnvelope(envelope);
}

export function parseHeader(line: string): NativeSessionHeader {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("session header is not valid JSON");
  }
  if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || typeof value.timestamp !== "string") {
    throw new Error("session header is invalid");
  }
  return value as NativeSessionHeader;
}

export interface MaterializeOptions {
  cwd: string;
  parentSessionPath?: string;
}

export function materializeNativeJsonl(envelope: SessionEnvelope, options: MaterializeOptions): string {
  const checked = validateEnvelope(envelope);
  const header: NativeSessionHeader = {
    type: "session",
    version: checked.piSessionVersion,
    id: checked.sessionId,
    timestamp: checked.createdAt,
    cwd: resolve(options.cwd),
    ...(options.parentSessionPath ? { parentSession: options.parentSessionPath } : {}),
  };
  return `${JSON.stringify(header)}\n${checked.entries.map((entry) => JSON.stringify(entry)).join("\n")}${checked.entries.length ? "\n" : ""}`;
}

export const materializeSession = materializeNativeJsonl;

export async function materializeSessionFile(path: string, envelope: SessionEnvelope, options: MaterializeOptions): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("refusing to materialize over a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp-${randomBytes(12).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(materializeNativeJsonl(envelope, options), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export const writeMaterializedSession = materializeSessionFile;

export async function restoreHead(
  navigateTree: (entryId: string, options?: { summarize?: boolean }) => Promise<{ cancelled?: boolean } | void>,
  headEntryId: string,
): Promise<void> {
  if (!headEntryId) return;
  const result = await navigateTree(headEntryId, { summarize: false });
  if (result && "cancelled" in result && result.cancelled) throw new Error("Pi cancelled head restoration");
}

async function resolveParentFileId(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    const firstLine = content.split("\n").find((line) => line.trim().length > 0);
    return firstLine ? parseHeader(firstLine).id : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
