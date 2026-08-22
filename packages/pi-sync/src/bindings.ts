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
  private loaded = false;

  constructor(root = defaultAgentDir()) {
    this.root = resolve(root);
    this.path = join(this.root, "sync-bindings.json");
    this.devicePath = join(this.root, "sync-device.json");
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<BindingFile>;
      if (value.version !== 1 || !Array.isArray(value.bindings)) throw new Error("invalid sync binding file");
      this.bindings.clear();
      for (const raw of value.bindings) {
        if (!isBinding(raw)) continue;
        this.bindings.set(raw.nativeSessionId, { ...raw });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.bindings.clear();
    }
    this.loaded = true;
  }

  async get(nativeSessionId: string): Promise<SyncBinding | undefined> {
    await this.ensureLoaded();
    const value = this.bindings.get(nativeSessionId);
    return value ? { ...value } : undefined;
  }

  async all(): Promise<SyncBinding[]> {
    await this.ensureLoaded();
    return [...this.bindings.values()].map((value) => ({ ...value }));
  }

  async set(binding: SyncBinding): Promise<void> {
    await this.ensureLoaded();
    this.bindings.set(binding.nativeSessionId, { ...binding });
    await this.flush();
  }

  async update(nativeSessionId: string, patch: Partial<SyncBinding>): Promise<SyncBinding | undefined> {
    await this.ensureLoaded();
    const current = this.bindings.get(nativeSessionId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.bindings.set(nativeSessionId, next);
    await this.flush();
    return { ...next };
  }

  async remove(nativeSessionId: string): Promise<void> {
    await this.ensureLoaded();
    this.bindings.delete(nativeSessionId);
    await this.flush();
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

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async flush(): Promise<void> {
    const value: BindingFile = { version: 1, bindings: [...this.bindings.values()] };
    await atomicWrite(this.path, JSON.stringify(value) + "\n");
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
