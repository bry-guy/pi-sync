import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { WorkspacePointer } from "./protocol.js";

export type SyncBindingState = "ready" | "setup_required";

export interface SyncBinding {
  nativeSessionId: string;
  serverUrl: string;
  canonicalSessionId: string;
  lastEtag: string;
  materializedFile: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastFingerprint?: string;
  workspace?: WorkspacePointer;
  parentSessionId?: string | null;
  title?: string;
  state?: SyncBindingState;
}

interface BindingFile {
  version: 1;
  bindings: SyncBinding[];
}

const writeQueues = new Map<string, Promise<void>>();

export class BindingStore {
  readonly root: string;
  readonly path: string;
  readonly devicePath: string;
  private bindings = new Map<string, SyncBinding>();

  constructor(root = defaultAgentDir()) {
    this.root = resolve(root);
    this.path = join(this.root, "sync-bindings.json");
    this.devicePath = join(this.root, "sync-device.json");
  }

  async load(): Promise<void> {
    this.bindings = await this.read();
  }

  private async read(): Promise<Map<string, SyncBinding>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let value: Partial<BindingFile> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        value = JSON.parse(await readFile(this.path, "utf8")) as Partial<BindingFile>;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        // A read racing a replacement on some filesystems (NFS) sees a torn file; the next read is whole.
        if (!(error instanceof SyntaxError) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    if (value && (value.version !== 1 || !Array.isArray(value.bindings))) throw new Error("invalid sync binding file");
    const bindings = new Map<string, SyncBinding>();
    for (const raw of value?.bindings ?? []) {
      if (!isBinding(raw)) continue;
      const binding = { ...raw };
      // Older clients stored whole envelopes here, making the file megabytes; only compact fingerprints are meaningful now.
      if (binding.lastFingerprint && !binding.lastFingerprint.startsWith("ids-")) delete binding.lastFingerprint;
      bindings.set(binding.nativeSessionId, binding);
    }
    return bindings;
  }

  // Every read and mutation goes to disk: several Pi processes (and every session runtime in a
  // host such as pi-ez-web) share this file, so an in-memory copy would overwrite their changes.
  async get(nativeSessionId: string): Promise<SyncBinding | undefined> {
    await this.load();
    const value = this.bindings.get(nativeSessionId);
    return value ? { ...value } : undefined;
  }

  async all(): Promise<SyncBinding[]> {
    await this.load();
    return [...this.bindings.values()].map((value) => ({ ...value }));
  }

  async set(binding: SyncBinding): Promise<void> {
    await this.mutate((bindings) => {
      bindings.set(binding.nativeSessionId, { ...binding });
    });
  }

  async update(nativeSessionId: string, patch: Partial<SyncBinding>): Promise<SyncBinding | undefined> {
    let next: SyncBinding | undefined;
    await this.mutate((bindings) => {
      const current = bindings.get(nativeSessionId);
      if (!current) return;
      next = { ...current, ...patch };
      bindings.set(nativeSessionId, next);
    });
    return next ? { ...next } : undefined;
  }

  async remove(nativeSessionId: string): Promise<void> {
    await this.mutate((bindings) => {
      bindings.delete(nativeSessionId);
    });
  }

  /** Read-modify-write under a cross-process lock so concurrent writers never lose each other's bindings. */
  private async mutate(change: (bindings: Map<string, SyncBinding>) => void): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await withFileLock(`${this.path}.lock`, async () => {
      const bindings = await this.read();
      change(bindings);
      await atomicWrite(this.path, JSON.stringify({ version: 1, bindings: [...bindings.values()] } satisfies BindingFile) + "\n");
      this.bindings = bindings;
    });
  }

  async deviceLabel(): Promise<string> {
    try {
      const value = JSON.parse(await readFile(this.devicePath, "utf8")) as { version?: number; label?: unknown };
      if (value.version === 1 && typeof value.label === "string" && /^[a-z0-9-]{8,64}$/.test(value.label)) return value.label;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const label = `pi-${randomBytes(8).toString("hex")}`;
    await atomicWrite(this.devicePath, JSON.stringify({ version: 1, label }) + "\n");
    return label;
  }

}

function isBinding(value: unknown): value is SyncBinding {
  if (!isRecord(value)) return false;
  return typeof value.nativeSessionId === "string" &&
    typeof value.serverUrl === "string" && /^https?:\/\//i.test(value.serverUrl) &&
    typeof value.canonicalSessionId === "string" &&
    typeof value.lastEtag === "string" &&
    typeof value.materializedFile === "string" &&
    (value.leaseToken === undefined || typeof value.leaseToken === "string") &&
    (value.leaseExpiresAt === undefined || typeof value.leaseExpiresAt === "string") &&
    (value.lastFingerprint === undefined || typeof value.lastFingerprint === "string") &&
    (value.workspace === undefined || isRecord(value.workspace)) &&
    (value.parentSessionId === undefined || value.parentSessionId === null || typeof value.parentSessionId === "string") &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.state === undefined || value.state === "ready" || value.state === "setup_required");
}

async function withFileLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock older than a few seconds belongs to a crashed writer; writes take milliseconds.
      const info = await lstat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 5_000) await rm(lockPath, { force: true });
      else if (attempt > 400) throw new Error(`timed out waiting for ${lockPath}`);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.tmp-${randomBytes(12).toString("hex")}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  writeQueues.set(path, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
