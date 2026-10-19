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
    const recorded = await git(cwd, ["commit-tree", tree, "-p", head, "-m", `pi-sync working tree snapshot\n\nBranch: ${branch}`], {
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


const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes this repository's snapshot refs whose conversation the server no longer has (retention deletes
 * conversations idle for 14 days), at most once a day per checkout. `live` must be the server's full list.
 * Returns how many were deleted, or -1 when the remote could not be reached.
 */
export async function sweepSnapshots(cwd: string, live: ReadonlySet<string>, now = Date.now()): Promise<number> {
  const last = Number(await out(cwd, ["config", "--local", "pi-sync.lastSweep"]));
  if (Number.isFinite(last) && now - last < SWEEP_EVERY_MS) return 0;
  const remote = await remoteName(cwd);
  if (!remote) return 0;
  const listed = await git(cwd, ["ls-remote", remote, "refs/pi-sync/*"], { timeoutMs: 30_000 });
  if (listed.code !== 0) return -1;
  const stale = listed.stdout.split("\n").map((line) => line.split("\t")[1]?.trim()).filter((ref): ref is string => !!ref && !live.has(ref.slice("refs/pi-sync/".length)));
  if (stale.length) {
    const pushed = await git(cwd, ["push", "--no-verify", remote, ...stale.map((ref) => `:${ref}`)], { timeoutMs: 60_000 });
    if (pushed.code !== 0) return -1;
    for (const ref of stale) await git(cwd, ["update-ref", "-d", ref]);
  }
  await git(cwd, ["config", "--local", "pi-sync.lastSweep", String(now)]);
  return stale.length;
}

/** The working tree as a tree object (non-ignored files, untracked included), without touching the user's index. */
async function workingTree(cwd: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await git(cwd, ["read-tree", "HEAD"], { env })).code !== 0) return undefined;
    if ((await git(cwd, ["add", "-A", "--", ":/"], { env, timeoutMs: 60_000 })).code !== 0) return undefined;
    return (await git(cwd, ["write-tree"], { env })).stdout.trim() || undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const treeOf = (cwd: string, commit: string) => out(cwd, ["rev-parse", `${commit}^{tree}`]);

/**
 * Shares the working tree between turns: pushes a fresh snapshot when it changed since the last one this checkout
 * shared or received, or deletes the conversation's snapshot once everything is committed and pushed.
 * Returns what happened, for status and tests.
 */
export async function shareIdle(cwd: string, conversationId: string): Promise<"unchanged" | "pushed" | "cleared" | "failed"> {
  const ref = snapshotRef(conversationId);
  const known = await out(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (known) {
    const [tree, knownTree, head, knownBase] = await Promise.all([workingTree(cwd), treeOf(cwd, known), out(cwd, ["rev-parse", "HEAD"]), out(cwd, ["rev-parse", `${known}^`])]);
    if (tree && tree === knownTree && head === knownBase) return "unchanged";
  }
  const snapshot = await captureWorkspace(cwd);
  if (snapshot.kind === "skipped") return "failed";
  if (snapshot.kind === "clean") {
    if (!known) return "unchanged";
    await deleteSnapshot(cwd, conversationId, snapshot.workspace?.gitRemote);
    await git(cwd, ["update-ref", "-d", ref]);
    return "cleared";
  }
  const commit = snapshot.workspace.wip!.commit;
  const pushed = await pushSnapshot(cwd, snapshot.remote, commit, conversationId);
  if (pushed.code !== 0) return "failed";
  await git(cwd, ["update-ref", ref, commit]);
  return "pushed";
}

/** Records a snapshot this checkout pushed, so later checks know its working tree holds nothing new. */
export async function rememberSnapshot(cwd: string, conversationId: string, commit: string): Promise<void> {
  await git(cwd, ["update-ref", snapshotRef(conversationId), commit]);
}

export type CodeTarget = { branch: string; base: string; wip?: string; remote: string };

export type CodePlan =
  | { kind: "none"; failed?: true } // nothing recorded, another repository, or (failed) not reachable
  | { kind: "matches" }
  | { kind: "apply"; automatic: boolean; stash: boolean; target: CodeTarget; summary: string; here: string }
  | { kind: "blocked"; message: string };

async function defaultBranch(cwd: string, remote: string): Promise<string> {
  const head = await out(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.slice(remote.length + 1);
  for (const name of ["main", "master"]) if (await out(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`])) return name;
  return "main";
}

/**
 * Decides how to bring this checkout to the conversation's latest code. The newest state is the conversation's
 * snapshot ref when it exists (it is replaced on every change and deleted once everything is pushed), otherwise
 * the tip of the conversation's branch on the remote.
 *
 * Automatic only when nothing local can be lost and the checkout is either on the default branch at its remote
 * tip, or on the conversation's branch behind it. Otherwise the caller asks, and stashes local changes if needed.
 */
export async function planCode(cwd: string, workspace: WorkspacePointer | undefined, conversationId: string): Promise<CodePlan> {
  if (!workspace) return { kind: "none" };
  const remote = await remoteName(cwd, workspace.gitRemote);
  if (!remote) return { kind: "none" };
  const ref = snapshotRef(conversationId);
  const previous = await out(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  const fetchedRef = await git(cwd, ["fetch", "--no-tags", "--quiet", remote, `+${ref}:${ref}`], { timeoutMs: 60_000 });
  let wip: string | undefined;
  let branch = workspace.branch;
  if (fetchedRef.code === 0) {
    wip = await out(cwd, ["rev-parse", ref]);
    const message = (await out(cwd, ["log", "-1", "--format=%B", ref])) ?? "";
    branch = /^Branch: (.+)$/m.exec(message)?.[1] ?? workspace.wip?.branch ?? branch;
  } else if (/couldn't find remote ref|no such ref/i.test(fetchedRef.stderr)) {
    if (previous) await git(cwd, ["update-ref", "-d", ref]);
  } else {
    return { kind: "none", failed: true }; // offline: try again later
  }
  const fetched = await git(cwd, ["fetch", "--no-tags", "--quiet", remote], { timeoutMs: 60_000 });
  if (fetched.code !== 0) return { kind: "none", failed: true };
  let base: string | undefined;
  if (wip) base = await out(cwd, ["rev-parse", `${wip}^`]);
  else {
    const tip = await out(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
    const recorded = (await git(cwd, ["cat-file", "-e", `${workspace.commit}^{commit}`])).code === 0 ? workspace.commit : undefined;
    base = tip && (!recorded || (await git(cwd, ["merge-base", "--is-ancestor", recorded, tip])).code === 0) ? tip : recorded;
  }
  if (!base) return { kind: "blocked", message: `The conversation's code (${branch}) is not on ${remote} yet. Push it from the other device.` };

  const head = await out(cwd, ["rev-parse", "HEAD"]);
  const current = await out(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const tree = await workingTree(cwd);
  const headTree = head ? await treeOf(cwd, head) : undefined;
  const targetTree = await treeOf(cwd, wip ?? base);
  if (current === branch && head === base && tree === targetTree) return { kind: "matches" };

  const dirty = tree !== headTree;
  // No snapshot and this checkout is at the branch tip: the uncommitted changes are this device's own edits.
  if (!wip && current === branch && head === base) return { kind: "matches" };
  // A working tree equal to the snapshot this checkout last shared or received holds nothing new.
  const onlyKnown = dirty && previous !== undefined && tree === (await treeOf(cwd, previous));
  const local = await out(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local && (await git(cwd, ["merge-base", "--is-ancestor", local, base])).code !== 0) {
    return { kind: "blocked", message: `Local ${branch} has commits the conversation's code does not. Reconcile ${branch}, then run /sync code.` };
  }
  const main = await defaultBranch(cwd, remote);
  const onLatestMain = current === main && head === (await out(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${main}`]));
  const behindOnBranch = current === branch && !!head && (await git(cwd, ["merge-base", "--is-ancestor", head, base])).code === 0;
  const summary = wip ? `${branch} with uncommitted changes` : `${branch} at ${base.slice(0, 7)}`;
  const here = `${current ?? "a detached HEAD"}${dirty && !onlyKnown ? " with uncommitted changes" : ""}`;
  return {
    kind: "apply",
    automatic: (!dirty || onlyKnown) && (onLatestMain || behindOnBranch),
    stash: dirty,
    target: { branch, base, wip, remote },
    summary,
    here,
  };
}

/** Applies a plan: stashes local changes if asked, switches to the branch at the base, then lays the snapshot on top. */
export async function applyCode(cwd: string, target: CodeTarget, options: { stash: boolean }): Promise<{ ok: true; message: string; stashed: boolean } | { ok: false; message: string }> {
  let stashed = false;
  if (options.stash) {
    const saved = await git(cwd, ["stash", "push", "--include-untracked", "-m", `pi-sync: local changes before switching to ${target.branch}`], { timeoutMs: 60_000 });
    if (saved.code !== 0) return { ok: false, message: `Could not stash local changes: ${saved.stderr.trim()}` };
    stashed = true;
  }
  const stashNote = stashed ? " Your local changes are in git stash (git stash list)." : "";
  const fail = (message: string) => ({ ok: false as const, message: message + stashNote });
  const local = await out(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`]);
  const switched = local ? await git(cwd, ["checkout", "--quiet", target.branch]) : await git(cwd, ["checkout", "--quiet", "-b", target.branch, target.base]);
  if (switched.code !== 0) return fail(`Could not switch to ${target.branch}: ${switched.stderr.trim()}`);
  if (local && (await git(cwd, ["merge", "--ff-only", "--quiet", target.base])).code !== 0) return fail(`Could not fast-forward ${target.branch}.`);
  if (!local) await git(cwd, ["branch", "--quiet", "--set-upstream-to", `${target.remote}/${target.branch}`]);
  if (!target.wip) return { ok: true, stashed, message: `Checked out ${target.branch} at ${target.base.slice(0, 7)}.${stashNote}` };
  // Worktree-only: modified files become unstaged changes, new files untracked, deletions apply.
  const restored = await git(cwd, ["restore", `--source=${target.wip}`, "--worktree", "--", ":/"], { timeoutMs: 60_000 });
  if (restored.code !== 0) return fail(`Could not apply the shared changes: ${restored.stderr.trim()}`);
  return { ok: true, stashed, message: `Brought ${target.branch} here with the other device's uncommitted changes.${stashNote}` };
}
