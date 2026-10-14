import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CodeSharing = "ask" | "auto" | "off";

/** Client settings: `<agent dir>/pi-sync.json`, overridden by PI_SYNC_* environment variables. */
export interface SyncConfig {
  serverUrl?: string;
  deviceLabel?: string;
  /** Uncommitted code: ask once per repository, share without asking, or never share. `off` wins over a repository's answer. */
  code: CodeSharing;
  /** Synchronize every conversation after its first reply, not only ones attached with /sync attach. */
  allSessions: boolean;
  /** Tests only (PI_SYNC_HEARTBEAT_MS): the heartbeat must stay well inside the server's 120 s lease expiry. */
  heartbeatMs: number;
  /** Settings that were ignored, for one warning at startup. */
  problems: string[];
}

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-sync.json");
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const problems: string[] = [];
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed as Record<string, unknown>;
    else problems.push(`${path} must hold a JSON object`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path} could not be read: ${(error as Error).message}`);
  }
  const pick = (key: string, envName: string): unknown => {
    const fromEnv = env[envName]?.trim();
    return fromEnv ? fromEnv : file[key];
  };
  const text = (key: string, envName: string): string | undefined => {
    const value = pick(key, envName);
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string") return value.trim();
    problems.push(`${key} must be a string`);
    return undefined;
  };
  const choice = <T extends string>(key: string, envName: string, allowed: readonly T[], fallback: T): T => {
    const value = pick(key, envName);
    if (value === undefined) return fallback;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    problems.push(`${key} must be one of ${allowed.join(", ")}`);
    return fallback;
  };
  const onOff = (key: string, envName: string): boolean => {
    const value = pick(key, envName);
    if (value === undefined) return false;
    if (value === true || value === "on" || value === "true" || value === "1") return true;
    if (value === false || value === "off" || value === "false" || value === "0") return false;
    problems.push(`${key} must be on or off`);
    return false;
  };
  const heartbeat = Math.min(30_000, Math.max(250, Number(env.PI_SYNC_HEARTBEAT_MS) || 20_000));
  const serverUrl = env.PI_SYNC_SERVER_URL?.trim() || env.PI_SYNC_URL?.trim() || text("serverUrl", "PI_SYNC_SERVER_URL");
  if (serverUrl && !/^https?:\/\//i.test(serverUrl)) problems.push("serverUrl must start with http:// or https://");
  return {
    serverUrl: serverUrl && /^https?:\/\//i.test(serverUrl) ? serverUrl : undefined,
    deviceLabel: text("deviceLabel", "PI_SYNC_DEVICE_LABEL")?.slice(0, 64),
    code: choice("code", "PI_SYNC_CODE", ["ask", "auto", "off"] as const, "ask"),
    allSessions: onOff("allSessions", "PI_SYNC_ALL_SESSIONS"),
    heartbeatMs: heartbeat,
    problems,
  };
}
