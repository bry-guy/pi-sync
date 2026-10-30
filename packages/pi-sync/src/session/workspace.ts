import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { projectsDir } from "./adapter.js";
import type { WorkspacePointer } from "../protocol.js";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
  (command: string, args: string[]): Promise<{ stdout: string; code?: number }>;
}

/**
 * True for a checkout whose top level is pi-projects' folder: that repo holds project.json and memory.md for every
 * project and pi-projects syncs it itself, so conversations never share its code.
 */
export async function isProjectsStateRepo(cwd: string, runner: GitCommandRunner = defaultGitRunner(cwd)): Promise<boolean> {
  let dir: string;
  try {
    dir = realpathSync(projectsDir(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
    const here = realpathSync(cwd);
    // Only folders inside pi-projects can be in its repo; skip the git call everywhere else.
    if (here !== dir && !here.startsWith(dir + sep)) return false;
  } catch {
    return false;
  }
  const top = (await runOptional(runner, "git", ["rev-parse", "--show-toplevel"]))?.trim();
  try {
    return !!top && realpathSync(top) === dir;
  } catch {
    return false;
  }
}

export async function deriveWorkspacePointer(cwd: string, runner: GitCommandRunner = defaultGitRunner(cwd)): Promise<WorkspacePointer | undefined> {
  if (await isProjectsStateRepo(cwd, runner)) return undefined;
  const upstream = await runOptional(runner, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream) return undefined;
  const upstreamRef = upstream.trim();
  const separator = upstreamRef.indexOf("/");
  if (separator <= 0 || separator === upstreamRef.length - 1) return undefined;
  const remoteName = upstreamRef.slice(0, separator);
  const branch = upstreamRef.slice(separator + 1);
  const remote = await runOptional(runner, "git", ["remote", "get-url", remoteName]);
  const commit = await runOptional(runner, "git", ["rev-parse", "@{upstream}"]);
  const gitRemote = sanitizeRemote(remote);
  if (!gitRemote || !commit) return undefined;
  return { gitRemote, branch, commit: commit.trim() };
}

export async function deriveRepositoryIdentity(cwd: string, runner: GitCommandRunner = defaultGitRunner(cwd)): Promise<string | undefined> {
  const upstream = await runOptional(runner, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let remoteName: string | undefined;
  if (upstream) {
    const separator = upstream.indexOf("/");
    if (separator > 0) remoteName = upstream.slice(0, separator);
  }
  remoteName ||= "origin";
  let remote = await runOptional(runner, "git", ["remote", "get-url", remoteName]);
  if (!remote && remoteName === "origin") {
    const names = await runOptional(runner, "git", ["remote"]);
    const first = names?.split("\n").map((value) => value.trim()).find(Boolean);
    if (first) remote = await runOptional(runner, "git", ["remote", "get-url", first]);
  }
  return repositoryIdentity(remote);
}

export function repositoryIdentity(value: WorkspacePointer | string | undefined): string | undefined {
  const remote = typeof value === "string" ? value : value?.gitRemote;
  const sanitized = sanitizeRemote(remote);
  if (!sanitized) return undefined;
  if (!sanitized.includes("://")) {
    const scp = sanitized.match(/^(?:[^/@\s]+@)?([^:/\s]+):(.+)$/);
    if (scp?.[1] && scp[2]) return repositoryHostPath(scp[1], scp[2]);
  }
  try {
    const parsed = new URL(sanitized);
    if (!parsed.hostname) return sanitized;
    const host = parsed.host.toLowerCase();
    const path = trimRepositoryPath(parsed.pathname);
    return path ? `${host}/${path}` : host;
  } catch {
    return sanitized;
  }
}

function repositoryHostPath(host: string, path: string): string {
  const normalizedPath = trimRepositoryPath(path);
  return normalizedPath ? `${host.toLowerCase()}/${normalizedPath}` : host.toLowerCase();
}

function trimRepositoryPath(value: string): string {
  return value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

function sanitizeRemote(value: string | undefined): string | undefined {
  const remote = String(value || "").trim();
  if (!remote || /[\u0000\r\n\s]/.test(remote)) return undefined;
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "") || undefined;
  } catch {
    return remote;
  }
}

export function defaultGitRunner(cwd: string): GitCommandRunner {
  return async (command, args) => {
    try {
      const result = await execFileAsync(command, args, { cwd, maxBuffer: 256 * 1024 });
      return { stdout: result.stdout, code: 0 };
    } catch (error) {
      const value = error as { stdout?: string; code?: number };
      return { stdout: value.stdout ?? "", code: value.code };
    }
  };
}

async function runOptional(runner: GitCommandRunner, command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runner(command, args);
    if (result.code !== undefined && result.code !== 0) return undefined;
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}
