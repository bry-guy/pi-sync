import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspacePointer } from "../protocol.js";
import { deriveWorkspacePointer, repositoryIdentity } from "./workspace.js";

/**
 * Code-state sharing for synchronized conversations.
 *
 * When a turn ends with uncommitted or unpushed work, the working tree is
 * captured as a commit on top of HEAD (via a temporary index, so the user's
 * index, worktree, and stash are untouched) and pushed to the hidden ref
 * `refs/pi-sync/<conversation id>`. Another device restores it as unstaged
 * changes on the same branch. Sharing is opt-in per repository through
 * `git config pi-sync.shareWorkingTree true`, because every ref is visible to
 * anyone who can read the remote.
 */

export const SHARE_CONFIG_KEY = "pi-sync.shareWorkingTree";
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(cwd: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

async function out(cwd: string, args: string[]): Promise<string | undefined> {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export function snapshotRef(conversationId: string): string {
  return `refs/pi-sync/${conversationId}`;
}

/** Undefined when unset: the user has not been asked for this repository yet. */
export async function shareSetting(cwd: string): Promise<boolean | undefined> {
  const value = await out(cwd, ["config", "--get", SHARE_CONFIG_KEY]);
  return value === undefined ? undefined : value === "true";
}

export async function setShareSetting(cwd: string, enabled: boolean): Promise<void> {
  await git(cwd, ["config", "--local", SHARE_CONFIG_KEY, String(enabled)]);
}

/** True when the working tree has changes (including untracked, non-ignored files) or HEAD is not pushed. */
export async function hasUnsharedCode(cwd: string): Promise<boolean> {
  const status = await out(cwd, ["status", "--porcelain"]);
  if (status === undefined) return false; // not a Git repository
  if (status) return true;
  const ahead = await out(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return ahead === undefined || ahead !== "0";
}

async function remoteName(cwd: string, gitRemote?: string): Promise<string | undefined> {
  const names = (await out(cwd, ["remote"]))?.split("\n").map((name) => name.trim()).filter(Boolean) ?? [];
  if (gitRemote) {
    const wanted = repositoryIdentity(gitRemote);
    for (const name of names) {
      if (repositoryIdentity(await out(cwd, ["remote", "get-url", name])) === wanted) return name;
    }
    return undefined;
  }
  return names.includes("origin") ? "origin" : names[0];
}

export type Snapshot =
  | { kind: "clean"; workspace?: WorkspacePointer }
  | { kind: "captured"; workspace: WorkspacePointer; remote: string }
  // retryable: a git step failed (a lock held by another git command, a timeout); trying again later can succeed.
  | { kind: "skipped"; reason: string; retryable: boolean; workspace?: WorkspacePointer };

/** Captures the working tree as a commit without touching the user's index, worktree, or stash. */
export async function captureWorkspace(cwd: string): Promise<Snapshot> {
  const pushed = await deriveWorkspacePointer(cwd);
  if (!(await hasUnsharedCode(cwd))) return { kind: "clean", workspace: pushed };
  const head = await out(cwd, ["rev-parse", "HEAD"]);
  const branch = await out(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const remote = await remoteName(cwd, pushed?.gitRemote);
  const gitRemote = pushed?.gitRemote ?? (remote ? await out(cwd, ["remote", "get-url", remote]) : undefined);
  if (!head || !branch || !remote || !gitRemote) return { kind: "skipped", reason: "no branch or remote to share code through", retryable: false, workspace: pushed };
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    const failed = (reason: string, result: GitResult): Snapshot => {
      const detail = result.stderr.trim().split("\n").at(-1);
      return { kind: "skipped", reason: detail ? `${reason} (${detail})` : reason, retryable: true, workspace: pushed };
    };
    const read = await git(cwd, ["read-tree", "HEAD"], { env });
    if (read.code !== 0) return failed("could not read HEAD", read);
    const added = await git(cwd, ["add", "-A", "--", ":/"], { env, timeoutMs: 60_000 });
    if (added.code !== 0) return failed("could not stage the working tree", added);
    const written = await git(cwd, ["write-tree"], { env });
    const tree = written.stdout.trim();
    if (!tree) return failed("could not write the working tree", written);
    const tooLarge = await oversized(cwd, head, tree);
    if (tooLarge) return { kind: "skipped", reason: tooLarge, retryable: false, workspace: pushed };
    const recorded = await git(cwd, ["commit-tree", tree, "-p", head, "-m", "pi-sync working tree snapshot"], {
      env: { GIT_AUTHOR_NAME: "pi-sync", GIT_AUTHOR_EMAIL: "pi-sync@localhost", GIT_COMMITTER_NAME: "pi-sync", GIT_COMMITTER_EMAIL: "pi-sync@localhost" },
    });
    const commit = recorded.stdout.trim();
    if (!commit) return failed("could not record the snapshot", recorded);
    return {
      kind: "captured",
      remote,
      workspace: { gitRemote, branch: pushed?.branch ?? branch, commit: pushed?.commit ?? head, wip: { commit, branch } },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function oversized(cwd: string, head: string, tree: string): Promise<string | undefined> {
  const changed = await out(cwd, ["diff-tree", "-r", "--no-renames", "--diff-filter=AM", head, tree]);
  if (!changed) return undefined;
  let total = 0;
  for (const line of changed.split("\n")) {
    const [meta, path] = line.split("\t");
    const blob = meta?.split(" ")[3];
    if (!blob || !path) continue;
    const size = Number(await out(cwd, ["cat-file", "-s", blob]));
    if (size > MAX_FILE_BYTES) return `${path} is larger than 5 MB`;
    total += size;
    if (total > MAX_TOTAL_BYTES) return "changes are larger than 20 MB";
  }
  return undefined;
}

export async function pushSnapshot(cwd: string, remote: string, commit: string, conversationId: string): Promise<GitResult> {
  return git(cwd, ["push", "--force", "--no-verify", remote, `${commit}:${snapshotRef(conversationId)}`], { timeoutMs: 60_000 });
}

export async function deleteSnapshot(cwd: string, conversationId: string, gitRemote?: string): Promise<void> {
  const remote = await remoteName(cwd, gitRemote);
  if (remote) await git(cwd, ["push", "--no-verify", remote, `:${snapshotRef(conversationId)}`], { timeoutMs: 30_000 });
}

export type CodeStatus =
  | { kind: "unknown" }
  | { kind: "matches" }
  | { kind: "other-repository" }
  | { kind: "restorable"; workspace: WorkspacePointer; summary: string };

/** Compares this checkout with the code state recorded for the conversation. */
export async function codeStatus(cwd: string, workspace: WorkspacePointer | undefined): Promise<CodeStatus> {
  if (!workspace) return { kind: "unknown" };
  const remote = await remoteName(cwd, workspace.gitRemote);
  if (!remote) return { kind: "other-repository" };
  const head = await out(cwd, ["rev-parse", "HEAD"]);
  const branch = workspace.wip?.branch ?? workspace.branch;
  if (workspace.wip) {
    const base = await out(cwd, ["rev-parse", `${workspace.wip.commit}^`]);
    if (base && head === base && (await git(cwd, ["diff", "--quiet", workspace.wip.commit])).code === 0) return { kind: "matches" };
    return { kind: "restorable", workspace, summary: `${branch} with uncommitted changes` };
  }
  if ((await git(cwd, ["merge-base", "--is-ancestor", workspace.commit, "HEAD"])).code === 0) return { kind: "matches" };
  return { kind: "restorable", workspace, summary: `${branch} at ${workspace.commit.slice(0, 7)}` };
}

/**
 * Brings this checkout to the conversation's code: fast-forwards (or creates) the branch, then applies
 * any shared working-tree snapshot as unstaged changes. Refuses rather than overwrite local work.
 */
export async function restoreWorkspace(cwd: string, workspace: WorkspacePointer, conversationId: string): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const remote = await remoteName(cwd, workspace.gitRemote);
  if (!remote) return { ok: false, message: "This checkout has no remote for the conversation's repository." };
  if ((await out(cwd, ["status", "--porcelain"])) !== "") {
    return { ok: false, message: "This checkout has uncommitted changes. Commit or stash them, then run /sync code again." };
  }
  const branch = workspace.wip?.branch ?? workspace.branch;
  let base = workspace.commit;
  if (workspace.wip) {
    const ref = snapshotRef(conversationId);
    const fetched = await git(cwd, ["fetch", "--no-tags", remote, `+${ref}:${ref}`], { timeoutMs: 60_000 });
    if (fetched.code !== 0) return { ok: false, message: `Could not fetch the shared code: ${fetched.stderr.trim() || "fetch failed"}` };
    if ((await out(cwd, ["rev-parse", ref])) !== workspace.wip.commit) {
      return { ok: false, message: "The other device has not finished uploading this code yet. Try again in a moment." };
    }
    base = (await out(cwd, ["rev-parse", `${workspace.wip.commit}^`])) ?? base;
  } else {
    const fetched = await git(cwd, ["fetch", "--no-tags", remote, branch], { timeoutMs: 60_000 });
    if (fetched.code !== 0 || (await git(cwd, ["cat-file", "-e", `${base}^{commit}`])).code !== 0) {
      return { ok: false, message: `Commit ${base.slice(0, 7)} is not available from ${remote}. Push it from the other device first.` };
    }
  }
  const local = await out(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (local && (await git(cwd, ["merge-base", "--is-ancestor", local, base])).code !== 0) {
    return { ok: false, message: `Local ${branch} has commits the conversation's code does not. Reconcile ${branch} manually.` };
  }
  const switched = local
    ? await git(cwd, ["checkout", branch])
    : await git(cwd, ["checkout", "-b", branch, base]);
  if (switched.code !== 0) return { ok: false, message: `Could not switch to ${branch}: ${switched.stderr.trim()}` };
  if (local && (await git(cwd, ["merge", "--ff-only", base])).code !== 0) {
    return { ok: false, message: `Could not fast-forward ${branch}.` };
  }
  if (!workspace.wip) return { ok: true, message: `Checked out ${branch} at ${base.slice(0, 7)}.` };
  // Worktree-only restore: modified files become unstaged changes, new files stay untracked, deletions apply.
  const restored = await git(cwd, ["restore", `--source=${workspace.wip.commit}`, "--worktree", "--", ":/"]);
  if (restored.code !== 0) return { ok: false, message: `Could not apply the shared changes: ${restored.stderr.trim()}` };
  return { ok: true, message: `Restored ${branch} with the other device's uncommitted changes.` };
}
