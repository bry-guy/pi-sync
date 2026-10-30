import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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

/**
 * Model and thinking choices belong to each device, so they are never shared. The entries stay as placeholders with
 * the same id and parent: the server copy keeps the local file's shape, which counts and appends rely on.
 */
export function withoutLocalSettings(entries: PiEntry[]): PiEntry[] {
  return entries.map((entry) =>
    entry.type === "model_change" || entry.type === "thinking_level_change"
      ? ({ type: "custom", customType: "pi-sync-local-setting", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp } as PiEntry)
      : entry,
  );
}

/** The pi-projects link (`pi-project` custom entry): project folder name and cwd relative to it. */
export function projectLink(entries: readonly PiEntry[]): { name: string; rel: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as PiEntry & { customType?: unknown; data?: { name?: unknown; rel?: unknown } };
    if (entry.type !== "custom" || entry.customType !== "pi-project") continue;
    const { name, rel } = entry.data ?? {};
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) return undefined;
    return { name, rel: typeof rel === "string" ? rel : "" };
  }
  return undefined;
}

/** pi-projects' folder: PI_PROJECTS_DIR, else <agentDir>/pi-projects. */
export function projectsDir(agentDir: string): string {
  const env = process.env.PI_PROJECTS_DIR;
  return resolve(env ? env.replace(/^~(?=$|\/)/, homedir()) : join(agentDir, "pi-projects"));
}

/**
 * Where a conversation belongs on this machine: its project folder (plus the same subfolder) when the project
 * exists here, else `fallback`. A subfolder that is not there yet (an uncloned repo) falls back to the project root.
 */
export function projectCwd(entries: readonly PiEntry[], agentDir: string, fallback: string, exists: (path: string) => boolean): string {
  const link = projectLink(entries);
  if (!link) return fallback;
  const root = join(projectsDir(agentDir), link.name);
  if (!exists(join(root, "project.json"))) return fallback;
  const full = resolve(root, link.rel);
  if (full !== root && !full.startsWith(root + sep)) return root;
  return exists(full) ? full : root;
}

/** pi's default per-cwd sessions folder (session-manager getDefaultSessionDir). */
export function defaultSessionDir(cwd: string, agentDir: string): string {
  return join(resolve(agentDir), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
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
  const shared = withoutLocalSettings(entries);

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
    entries: shared,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(projectLink(entries) ? { project: projectLink(entries)!.name } : {}),
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

/** The native header line `materializeNativeJsonl` writes for this envelope. */
export function nativeHeaderLine(envelope: Pick<SessionEnvelope, "piSessionVersion" | "sessionId" | "createdAt">, options: MaterializeOptions): string {
  const header: NativeSessionHeader = {
    type: "session",
    version: envelope.piSessionVersion,
    id: envelope.sessionId,
    timestamp: envelope.createdAt,
    cwd: resolve(options.cwd),
    ...(options.parentSessionPath ? { parentSession: options.parentSessionPath } : {}),
  };
  return JSON.stringify(header);
}

export function materializeNativeJsonl(envelope: SessionEnvelope, options: MaterializeOptions): string {
  const checked = validateEnvelope(envelope);
  return `${nativeHeaderLine(checked, options)}\n${checked.entries.map((entry) => JSON.stringify(entry)).join("\n")}${checked.entries.length ? "\n" : ""}`;
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

export interface AppendExpectation {
  /** The exact header line the file must start with. */
  headerLine: string;
  /** Entries the file must hold after its header, and the id of the last one. */
  count: number;
  lastId: string;
}

/**
 * Adds `entries` to a session file that holds exactly the expected entries, without re-serializing it: the file is
 * copied (a clone where the filesystem supports it), the new lines appended and synced, then renamed into place.
 * Returns false, leaving the file untouched, when the file is not exactly as expected; callers then rewrite it whole.
 */
export async function appendSessionFile(path: string, expected: AppendExpectation, entries: readonly PiEntry[]): Promise<boolean> {
  const target = resolve(path);
  let data: Buffer;
  try {
    if ((await lstat(target)).isSymbolicLink()) return false;
    data = await readFile(target);
  } catch {
    return false;
  }
  if (!fileHolds(data, expected)) return false;
  const temporary = `${target}.tmp-${randomBytes(12).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await copyFile(target, temporary, constants.COPYFILE_FICLONE);
    await chmod(temporary, 0o600);
    handle = await open(temporary, "a");
    await handle.writeFile(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Whether `data` is the header line plus exactly `count` complete entry lines, the last with id `lastId`. */
function fileHolds(data: Buffer, expected: AppendExpectation): boolean {
  if (data.length === 0 || data[data.length - 1] !== 0x0a) return false;
  const headerEnd = data.indexOf(0x0a);
  if (data.subarray(0, headerEnd).toString("utf8") !== expected.headerLine) return false;
  let lines = 0;
  for (let at = headerEnd; (at = data.indexOf(0x0a, at + 1)) !== -1;) lines++;
  if (lines !== expected.count) return false;
  if (expected.count === 0) return expected.lastId === "";
  const lastStart = data.lastIndexOf(0x0a, data.length - 2) + 1;
  try {
    const last = JSON.parse(data.subarray(lastStart, data.length - 1).toString("utf8")) as { id?: unknown };
    return last.id === expected.lastId;
  } catch {
    return false;
  }
}

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
