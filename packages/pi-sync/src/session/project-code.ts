import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { git, oversized, remoteName, treeOf, workingTree } from "./code.js";

/**
 * Checkout sync for pi projects.
 *
 * A pi project folder holds repositories (`repos/<name>`) and their worktrees (`worktrees/<name>/...`). Each
 * checkout's state (branch, commits, uncommitted changes) is shared as a commit on its repository's own remote at
 * `refs/pi-checkouts/<project id>/<key>`: its tree is the working tree, its first parent HEAD, its second the
 * previous shared state. A removed worktree is a commit marked `Removed: yes`. The ref only ever moves forward
 * (every push is a compare-and-swap against what this machine last saw), so it is a history every machine can
 * compare against, however many there are.
 *
 * Per checkout, three states decide everything: known (`refs/pi-checkouts/...` here, the state this machine last
 * agreed with), theirs (`refs/pi-checkouts-theirs/...`, the remote's latest, fetched) and the checkout now.
 *   unchanged here, unchanged there: nothing.   changed here only: share.   changed there only: follow.
 *   changed on both: desynced, unless one side is clean and contained in the other (a pull on one machine).
 * Desync is recomputed on every check, never decided by time or recency; it heals as soon as either machine
 * resolves it (/sync code: take theirs, keep mine, or stop syncing). The last result is cached in the repository's
 * git config (`pi-checkouts.<id>/<key>.desynced`) for status lines and pi-web; `.stopped` is the one real setting.
 */

export interface Project { root: string; id: string; name: string }

/** A checkout's ref: `key` is `repo` (the main checkout) or `wt/<path under worktrees/<repo>/>`. */
export function projectRef(projectId: string, key: string): string {
  return `refs/pi-checkouts/${projectId}/${key}`;
}

/** The pi project containing `cwd`: the first folder under `projectsDir` that has a project.json with an id. */
export function projectFor(cwd: string, projectsDir: string): Project | undefined {
  let dir: string;
  let here: string;
  try {
    dir = realpathSync(projectsDir);
    here = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const rel = relative(dir, here);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  const name = rel.split(sep)[0]!;
  const root = join(dir, name);
  try {
    const data = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as { id?: unknown };
    if (typeof data.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(data.id)) return undefined;
    return { root, id: data.id, name };
  } catch {
    return undefined;
  }
}

/** The project's repositories: `repos/<name>` folders that are Git checkouts. */
export function projectRepos(project: Project): string[] {
  const repos = join(project.root, "repos");
  if (!existsSync(repos)) return [];
  return readdirSync(repos, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".cloning") && existsSync(join(repos, entry.name, ".git")))
    .map((entry) => join(repos, entry.name))
    .sort();
}

// missing: listed by git but its folder is gone or unreadable (prunable); it counts as present, so it is neither
// shared, removed elsewhere, nor changed.
interface Checkout { path: string; key: string; missing?: boolean }

/**
 * Where a checkout sits in the project, as its ref key: `repo` for `repos/<name>`, `wt/<path>` for
 * `worktrees/<name>/<path>`. Checkouts elsewhere are not synced.
 */
function keyOf(project: Project, repo: string, path: string): string | undefined {
  if (path === repo) return "repo";
  const rel = relative(join(project.root, "worktrees", basename(repo)), path);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  const key = `wt/${rel.split(sep).join("/")}`;
  return validKey(key) ? key : undefined;
}

const validKey = (key: string) => key === "repo" || (/^wt\/[^\s~^:?*[\\]+$/.test(key) && !/(^|\/)\.|\.\.|\.lock(\/|$)|\/$|\/\/|@\{/.test(key));
const basename = (path: string) => path.slice(path.lastIndexOf(sep) + 1);
const pathOf = (project: Project, repo: string, key: string) => key === "repo" ? repo : join(project.root, "worktrees", basename(repo), ...key.slice(3).split("/"));
const knownRef = (project: Project, key: string) => `refs/pi-checkouts/${project.id}/${key}`;
const theirsRef = (project: Project, key: string) => `refs/pi-checkouts-theirs/${project.id}/${key}`;
const configKey = (project: Project, key: string, name: "desynced" | "stopped") => `pi-checkouts.${project.id}/${key}.${name}`;

/**
 * A repository's checkouts inside the project (its main checkout and worktrees under worktrees/<name>/), or
 * undefined when git cannot list them: callers then leave the repository alone, since a short list would read as
 * worktrees removed here and remove them everywhere.
 */
export async function checkouts(repo: string, project: Project): Promise<Checkout[] | undefined> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0 || !listed.stdout.trim()) return undefined;
  const found: Checkout[] = [];
  for (const block of listed.stdout.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const key = keyOf(project, repo, path);
    if (!key) continue;
    found.push(/^prunable/m.test(block) || !existsSync(path) ? { path, key, missing: true } : { path, key });
  }
  return found.some((item) => item.key === "repo") ? found : undefined;
}

const out = async (cwd: string, args: string[]) => {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
};
// git's own last line is often a fragment ("and the repository exists."), so name the common causes plainly.
const lastLine = (text: string) => {
  if (/Permission denied|correct access rights|Repository not found|access denied|denied to|returned error: 403/i.test(text))
    return "no permission to push to this repo's remote (use /sync code to stop syncing it)";
  const lines = text.trim().split("\n");
  return [...lines].reverse().find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "";
};
const isAncestor = async (cwd: string, older: string, newer: string) => older === newer || (await git(cwd, ["merge-base", "--is-ancestor", older, newer])).code === 0;

const refsUnder = async (repo: string, prefix: string) => new Map(
  ((await out(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])) ?? "").split("\n").filter(Boolean).map((line) => {
    const [ref, sha] = line.split(" ") as [string, string];
    return [ref.slice(prefix.length), sha] as const;
  }),
);

/** A checkout now. */
interface State { head: string; branch?: string; tree: string; clean: boolean }
async function stateOf(cwd: string): Promise<State | undefined> {
  const [head, branch, tree] = await Promise.all([out(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]), out(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]), workingTree(cwd)]);
  if (!head || !tree) return undefined;
  return { head, ...(branch ? { branch } : {}), tree, clean: tree === (await treeOf(cwd, head)) };
}

/** A shared state: base (HEAD then), branch, tree, the device that shared it, or a removal. */
interface Shared { sha: string; base?: string; branch?: string; tree?: string; device?: string; removed: boolean; clean: boolean }
async function sharedOf(repo: string, sha: string): Promise<Shared> {
  const text = (await out(repo, ["log", "-1", "--format=%P%n%T%n%B", sha])) ?? "";
  const [parents = "", tree = "", ...body] = text.split("\n");
  const message = body.join("\n");
  const base = parents.split(" ")[0] || undefined;
  const removed = /^Removed: yes$/m.test(message);
  return {
    sha, base, tree, removed,
    branch: /^Branch: (.+)$/m.exec(message)?.[1],
    device: /^Device: (.+)$/m.exec(message)?.[1],
    clean: !removed && !!base && tree === (await treeOf(repo, base)),
  };
}

/** The checkout (or its absence) is exactly the shared state. */
const same = (state: State | undefined, shared: Shared | undefined) =>
  !state ? !shared || shared.removed : !!shared && !shared.removed && state.head === shared.base && state.branch === shared.branch && state.tree === shared.tree;

export type SyncResult = {
  repo: string;
  key: string;
  checkout: string;
  branch?: string;
  device?: string;
  result: "unchanged" | "shared" | "applied" | "created" | "removed" | "desynced" | "stopped" | "failed";
  message?: string;
};

export interface SyncOptions {
  /** This machine's name, recorded on what it shares. */
  device: string;
  /** Repositories that sync at all (pi-sync's code setting). */
  allowed: (repo: string) => Promise<boolean>;
  /** Ask the remote for other machines' states (one ls-remote and fetch per repository); otherwise share only. */
  fetch: boolean;
  /** Checkouts may be changed here (no turn is running in the project). */
  apply: boolean;
}

interface Ctx { project: Project; repo: string; name: string; remote: string; device: string }

/** Syncs every checkout of every allowed repository in the project. */
export async function syncProject(project: Project, options: SyncOptions): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const repo of projectRepos(project)) {
    if (!(await options.allowed(repo))) continue;
    const name = basename(repo);
    const remote = await remoteName(repo);
    if (!remote) continue;
    const listed = await checkouts(repo, project);
    if (!listed) {
      results.push({ repo: name, key: "", checkout: repo, result: "failed", message: `${name}: git could not list its worktrees; left alone.` });
      continue;
    }
    const ctx: Ctx = { project, repo, name, remote, device: options.device };
    if (options.fetch) {
      const failed = await fetchTheirs(ctx);
      if (failed) {
        results.push({ repo: name, key: "", checkout: repo, result: "failed", message: `${name}: ${failed}` });
        continue;
      }
    }
    const here = new Map(listed.map((item) => [item.key, item]));
    const known = await refsUnder(repo, `refs/pi-checkouts/${project.id}/`);
    const theirs = await refsUnder(repo, `refs/pi-checkouts-theirs/${project.id}/`);
    const keys = [...new Set([...here.keys(), ...known.keys(), ...theirs.keys()])].filter(validKey).sort();
    for (const key of keys) {
      if (here.get(key)?.missing) continue;
      results.push(await syncCheckout(ctx, key, here.get(key)?.path, options.apply));
    }
  }
  return results;
}

/** Fetches every changed remote state into the theirs refs, dropping ones the remote no longer has. */
async function fetchTheirs(ctx: Ctx): Promise<string | undefined> {
  const prefix = `refs/pi-checkouts/${ctx.project.id}/`;
  const listed = await git(ctx.repo, ["ls-remote", ctx.remote, `${prefix}*`], { timeoutMs: 30_000 });
  if (listed.code !== 0) return lastLine(listed.stderr) || "could not reach the remote";
  const remote = new Map(listed.stdout.split("\n").map((line) => line.split("\t")).filter(([sha, ref]) => sha && ref?.startsWith(prefix)).map(([sha, ref]) => [ref!.slice(prefix.length).trim(), sha!.trim()] as const).filter(([key]) => validKey(key)));
  const local = await refsUnder(ctx.repo, `refs/pi-checkouts-theirs/${ctx.project.id}/`);
  const wanted = [...remote].filter(([key, sha]) => local.get(key) !== sha).map(([key]) => `+${knownRef(ctx.project, key)}:${theirsRef(ctx.project, key)}`);
  if (wanted.length) {
    const fetched = await git(ctx.repo, ["fetch", "--no-tags", "--quiet", ctx.remote, ...wanted], { timeoutMs: 120_000 });
    if (fetched.code !== 0) return lastLine(fetched.stderr) || "could not fetch";
  }
  for (const key of local.keys()) if (!remote.has(key)) await git(ctx.repo, ["update-ref", "-d", theirsRef(ctx.project, key)]);
  return undefined;
}

async function refreshTheirs(ctx: Ctx, key: string): Promise<void> {
  const fetched = await git(ctx.repo, ["fetch", "--no-tags", "--quiet", ctx.remote, `+${knownRef(ctx.project, key)}:${theirsRef(ctx.project, key)}`], { timeoutMs: 60_000 });
  if (fetched.code !== 0 && /couldn't find remote ref|no such ref/i.test(fetched.stderr)) await git(ctx.repo, ["update-ref", "-d", theirsRef(ctx.project, key)]);
}

const refOf = (repo: string, ref: string) => out(repo, ["rev-parse", "--verify", "--quiet", ref]);

async function syncCheckout(ctx: Ctx, key: string, path: string | undefined, apply: boolean, retried = false): Promise<SyncResult> {
  const { project, repo } = ctx;
  const base: SyncResult = { repo: ctx.name, key, checkout: path ?? pathOf(project, repo, key), result: "unchanged" };
  if ((await out(repo, ["config", "--local", "--get", configKey(project, key, "stopped")])) === "true") return { ...base, result: "stopped" };
  const current = path ? await stateOf(path) : undefined;
  if (path && !current) return { ...base, result: "failed", message: `${ctx.name} ${key}: could not read the checkout.` };
  let K = await refOf(repo, knownRef(project, key));
  const T = await refOf(repo, theirsRef(project, key));
  if (K && !T && !retried) {
    // The shared state is gone from the remote (cleared by hand, or never pushed): start over from this checkout.
    await git(repo, ["update-ref", "-d", knownRef(project, key)]);
    K = undefined;
  }
  const known = K ? await sharedOf(repo, K) : undefined;
  const theirs = T ? await sharedOf(repo, T) : undefined;
  const label = labelOf(ctx, key, current?.branch ?? theirs?.branch ?? known?.branch);
  const from = theirs?.device ?? "another machine";
  const changedHere = !same(current, known);
  const movedThere = !!T && T !== K;
  const r = async (result: SyncResult["result"], message?: string): Promise<SyncResult> => {
    await cacheDesync(ctx, key, result === "desynced" ? message : undefined);
    return { ...base, branch: current?.branch ?? theirs?.branch, ...(theirs?.device ? { device: theirs.device } : {}), result, ...(message ? { message } : {}) };
  };

  if (!changedHere && !movedThere) return r("unchanged");
  if (!movedThere) {
    if (!current && !known) return r("unchanged");
    const pushed = await share(ctx, key, current, K ? [K] : [], K);
    if (pushed === "rejected" && !retried) {
      await refreshTheirs(ctx, key);
      return syncCheckout(ctx, key, path, apply, true);
    }
    return pushed === "rejected" ? r("unchanged") : pushed.startsWith("failed") ? r("failed", `${label}: ${pushed.slice(7)}`) : r("shared");
  }
  if (same(current, theirs)) {
    await agree(ctx, key, T!);
    return r("unchanged");
  }
  if (!changedHere) {
    if (!apply) return r("unchanged");
    return finish(r, await follow(ctx, key, path, current, theirs!, false));
  }
  // Changed on both. A clean checkout that the other side's commits contain loses nothing by following; a clean
  // other side contained in this checkout loses nothing by being replaced (one machine pulled, the other did not).
  if (current && theirs && !theirs.removed && theirs.base) {
    if (current.clean && (await onBranch(path!, current)) && (await isAncestor(repo, current.head, theirs.base))) {
      if (!apply) return r("unchanged");
      return finish(r, await follow(ctx, key, path, current, theirs, false));
    }
    if (theirs.clean && (await isAncestor(repo, theirs.base, current.head))) {
      const pushed = await share(ctx, key, current, [T!], T);
      return pushed === "shared" ? r("shared") : pushed === "rejected" ? r("unchanged") : r("failed", `${label}: ${pushed.slice(7)}`);
    }
  }
  const why = !current ? `removed here, but ${from} changed it since`
    : theirs!.removed ? `${from} removed it, but it changed here since`
    : `this machine and ${from} both changed it since they last matched`;
  return r("desynced", desyncMessage(ctx, key, label, why));
}

const labelOf = (ctx: Ctx, key: string, branch?: string) => `${ctx.name} · ${branch ?? (key === "repo" ? "main checkout" : key.slice(3))}`;
const desyncMessage = (ctx: Ctx, key: string, label: string, why: string) =>
  `${label} desynced: ${why}. Nothing was changed. /sync code to choose (compare: git diff HEAD ${theirsRef(ctx.project, key)}).`;

type Followed = { result: "applied" | "created" | "removed" | "unchanged"; message?: string } | { result: "desynced" | "failed"; message: string };
const finish = (r: (result: SyncResult["result"], message?: string) => Promise<SyncResult>, followed: Followed) => r(followed.result, followed.message);

/** Records `sha` as the state this machine agrees with (known), and as the remote's when it pushed it. */
async function agree(ctx: Ctx, key: string, sha: string, pushed = false) {
  await git(ctx.repo, ["update-ref", knownRef(ctx.project, key), sha]);
  if (pushed) await git(ctx.repo, ["update-ref", theirsRef(ctx.project, key), sha]);
}

/**
 * Pushes this checkout's state (or its removal) on top of `parents`, only if the remote still holds `lease`.
 * Returns "shared", "rejected" (the remote moved on) or "failed: <reason>".
 */
async function share(ctx: Ctx, key: string, state: State | undefined, parents: string[], lease: string | undefined): Promise<string> {
  let commit: string | undefined;
  const env = { GIT_AUTHOR_NAME: "pi-sync", GIT_AUTHOR_EMAIL: "pi-sync@localhost", GIT_COMMITTER_NAME: "pi-sync", GIT_COMMITTER_EMAIL: "pi-sync@localhost" };
  if (state) {
    const tooLarge = await oversized(ctx.repo, state.head, state.tree);
    if (tooLarge) return `failed: ${tooLarge}`;
    const args = ["commit-tree", state.tree, "-p", state.head, ...parents.filter((parent) => parent !== state.head).flatMap((parent) => ["-p", parent])];
    commit = (await git(ctx.repo, [...args, "-m", `pi-sync checkout\n\n${state.branch ? `Branch: ${state.branch}\n` : ""}Device: ${ctx.device}`], { env })).stdout.trim();
  } else {
    const tree = parents[0] ? await treeOf(ctx.repo, parents[0]) : undefined;
    if (!tree || !parents.length) return "failed: nothing to record";
    commit = (await git(ctx.repo, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", `pi-sync checkout removed\n\nRemoved: yes\nDevice: ${ctx.device}`], { env })).stdout.trim();
  }
  if (!commit) return "failed: could not record the state";
  const ref = knownRef(ctx.project, key);
  const pushed = await git(ctx.repo, ["push", "--no-verify", `--force-with-lease=${ref}:${lease ?? ""}`, ctx.remote, `${commit}:${ref}`], { timeoutMs: 60_000 });
  if (pushed.code !== 0) return /stale info|rejected/.test(pushed.stderr) ? "rejected" : `failed: ${lastLine(pushed.stderr)}`;
  await agree(ctx, key, commit, true);
  return "shared";
}

/**
 * Makes the checkout match `theirs`: creates, removes, or moves it to their branch, commit and changes. Without
 * `force` only where nothing can be lost (callers checked that it is unchanged or clean and contained); with
 * `force` (take theirs) local changes go to git stash and commits theirs lacks to a `<branch>.mine-<time>` branch.
 */
async function follow(ctx: Ctx, key: string, path: string | undefined, current: State | undefined, theirs: Shared, force: boolean): Promise<Followed> {
  const { project, repo } = ctx;
  const label = labelOf(ctx, key, theirs.branch ?? current?.branch);
  const from = theirs.device ?? "another machine";
  const desynced = (why: string): Followed => ({ result: "desynced", message: desyncMessage(ctx, key, label, why) });
  const unchangedSince = async () => {
    if (!path) return true;
    const now = await stateOf(path);
    return !!now && !!current && now.head === current.head && now.tree === current.tree && now.branch === current.branch;
  };
  let note = "";
  const setAside = async (cwd: string, state: State) => {
    if (!force) {
      // Unchanged since the last agreed state, which the known ref still holds: nothing to keep.
      if (!state.clean) {
        await git(cwd, ["reset", "--quiet", "--hard"]);
        await git(cwd, ["clean", "-fdq"]);
      }
      return true;
    }
    if (!state.clean) {
      const stashed = await git(cwd, ["stash", "push", "--include-untracked", "-m", `pi-sync: ${label} before taking ${from}'s`], { timeoutMs: 60_000 });
      if (stashed.code !== 0) return false;
      note += " Your uncommitted changes are in git stash.";
    }
    return true;
  };
  const keepCommits = async (sha: string | undefined, branch: string | undefined) => {
    if (!force || !sha || (theirs.base && (await isAncestor(repo, sha, theirs.base)))) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
    const backup = `${branch ?? "pi-sync"}.mine-${stamp}`;
    if ((await git(repo, ["branch", "--force", backup, sha])).code === 0) note += ` Your commits are on branch ${backup}.`;
  };

  if (theirs.removed) {
    if (!path || !current) return { result: "unchanged" };
    if (key === "repo") return { result: "unchanged" };
    if (!(await onBranch(path, current)) && !force) return desynced("HEAD here is a detached commit on no branch");
    if (!(await unchangedSince())) return { result: "unchanged" };
    if (!(await setAside(path, current))) return { result: "failed", message: `${label}: could not stash local changes.` };
    if (!current.branch) await keepCommits(current.head, undefined);
    const removed = await git(repo, ["worktree", "remove", "--force", path]);
    if (removed.code !== 0) return { result: "failed", message: `${label}: could not remove it: ${lastLine(removed.stderr)}` };
    removeEmptyParents(path, join(project.root, "worktrees", ctx.name));
    await agree(ctx, key, theirs.sha);
    return { result: "removed", message: `${label}: removed on ${from}, so removed here (the branch is kept).${note}` };
  }

  if (!theirs.base || !theirs.tree) return { result: "failed", message: `${label}: ${from}'s state is unreadable.` };
  const branchTip = theirs.branch ? await refOf(repo, `refs/heads/${theirs.branch}`) : undefined;
  const fits = !branchTip || (await isAncestor(repo, branchTip, theirs.base));
  if (!fits && !force) return desynced(`local branch ${theirs.branch} has commits ${from}'s does not`);
  if (!fits) await keepCommits(branchTip, theirs.branch);

  let target = path;
  let created = false;
  if (!target) {
    target = pathOf(project, repo, key);
    if (existsSync(target)) return desynced(`${target} exists but is not a worktree of ${ctx.name}`);
    const added = !theirs.branch ? await git(repo, ["worktree", "add", "--quiet", "--detach", target, theirs.base])
      : branchTip ? await git(repo, ["worktree", "add", "--quiet", "-B", theirs.branch, target, theirs.base])
      : await git(repo, ["worktree", "add", "--quiet", "-b", theirs.branch, target, theirs.base]);
    if (added.code !== 0) return { result: "failed", message: `${label}: could not create the worktree: ${lastLine(added.stderr)}` };
    if (theirs.branch && !branchTip && (await refOf(repo, `refs/remotes/${ctx.remote}/${theirs.branch}`))) {
      await git(target, ["branch", "--quiet", "--set-upstream-to", `${ctx.remote}/${theirs.branch}`]);
    }
    created = true;
  } else {
    if (!current) return { result: "failed", message: `${label}: could not read the checkout.` };
    if (!(await onBranch(target, current)) && !force) return desynced("HEAD here is a detached commit on no branch");
    // An agent may be writing here: re-read right before changing anything.
    if (!(await unchangedSince())) return { result: "unchanged" };
    if (!(await setAside(target, current))) return { result: "failed", message: `${label}: could not stash local changes.` };
    await keepCommits(current.head, current.branch);
    const moved = theirs.branch ? await git(target, ["switch", "--quiet", "--force", "-C", theirs.branch, theirs.base]) : await git(target, ["switch", "--quiet", "--force", "--detach", theirs.base]);
    if (moved.code !== 0) return { result: "failed", message: `${label}: could not move to ${from}'s commit: ${lastLine(moved.stderr)}.${note}` };
  }
  if (theirs.tree !== (await treeOf(repo, theirs.base))) {
    const restored = await git(target, ["restore", `--source=${theirs.sha}`, "--worktree", "--", ":/"], { timeoutMs: 60_000 });
    if (restored.code !== 0) return { result: "failed", message: `${label}: could not apply ${from}'s changes: ${lastLine(restored.stderr)}${note}` };
  }
  await agree(ctx, key, theirs.sha);
  return created
    ? { result: "created", message: `${label}: new worktree from ${from}.` }
    : { result: "applied", message: `${label}: now matches ${from}.${note}` };
}

/** HEAD is on a branch, or a detached commit some branch contains: moving away from it loses no commit. */
async function onBranch(cwd: string, state: State): Promise<boolean> {
  if (state.branch) return true;
  return !!(await out(cwd, ["for-each-ref", "--count=1", "--contains", state.head, "--format=%(refname)", "refs/heads/"]));
}

async function cacheDesync(ctx: Ctx, key: string, message: string | undefined) {
  const name = configKey(ctx.project, key, "desynced");
  const cached = await out(ctx.repo, ["config", "--local", "--get", name]);
  if (cached === message) return;
  if (message) await git(ctx.repo, ["config", "--local", name, message]);
  else if (cached !== undefined) await git(ctx.repo, ["config", "--local", "--unset", name]);
}

export type Desync = { repo: string; key: string; checkout: string; message?: string; stopped: boolean };

/** The project's desynced and stopped checkouts as of the last check (read from git config; no network). */
export async function projectDesyncs(project: Project): Promise<Desync[]> {
  const found: Desync[] = [];
  for (const repo of projectRepos(project)) {
    const lines = (await out(repo, ["config", "--local", "--get-regexp", `^pi-checkouts\\.${project.id.replace(/[.]/g, "\\.")}/`])) ?? "";
    const byKey = new Map<string, Desync>();
    for (const line of lines.split("\n").filter(Boolean)) {
      const space = line.indexOf(" ");
      const name = line.slice(0, space);
      const value = line.slice(space + 1);
      const sub = name.slice("pi-checkouts.".length + project.id.length + 1, name.lastIndexOf("."));
      const field = name.slice(name.lastIndexOf(".") + 1);
      const item = byKey.get(sub) ?? { repo: basename(repo), key: sub, checkout: pathOf(project, repo, sub), stopped: false };
      if (field === "desynced") item.message = value;
      if (field === "stopped" && value === "true") item.stopped = true;
      byKey.set(sub, item);
    }
    found.push(...[...byKey.values()].filter((item) => item.message || item.stopped));
  }
  return found;
}

/**
 * Settles one desynced (or stopped) checkout as the user chose: take theirs, keep mine (replaces theirs, only if the
 * remote still holds what was fetched just now), stop syncing it here, or resume.
 */
export async function resolveCheckout(project: Project, repoName: string, key: string, choice: "theirs" | "mine" | "stop" | "resume", device: string): Promise<SyncResult> {
  const repo = join(project.root, "repos", repoName);
  const remote = await remoteName(repo);
  const ctx: Ctx = { project, repo, name: repoName, remote: remote ?? "", device };
  const path = (await checkouts(repo, project))?.find((item) => item.key === key && !item.missing)?.path;
  const base: SyncResult = { repo: repoName, key, checkout: path ?? pathOf(project, repo, key), result: "unchanged" };
  if (choice === "stop") {
    await git(repo, ["config", "--local", configKey(project, key, "stopped"), "true"]);
    await cacheDesync(ctx, key, undefined);
    return { ...base, result: "stopped", message: `${labelOf(ctx, key)}: no longer synced on this machine.` };
  }
  if (choice === "resume") await git(repo, ["config", "--local", "--unset", configKey(project, key, "stopped")]);
  if (!remote) return { ...base, result: "failed", message: `${repoName} has no remote.` };
  // Keep mine replaces only the version last fetched (what the desync was about); the others take the newest.
  if (choice !== "mine") await refreshTheirs(ctx, key);
  if (choice === "resume") return syncCheckout(ctx, key, path, true);
  const T = await refOf(repo, theirsRef(project, key));
  const current = path ? await stateOf(path) : undefined;
  const theirs = T ? await sharedOf(repo, T) : undefined;
  const label = labelOf(ctx, key, current?.branch ?? theirs?.branch);
  const done = async (result: SyncResult["result"], message?: string): Promise<SyncResult> => {
    if (result !== "desynced" && result !== "failed") await cacheDesync(ctx, key, undefined);
    return { ...base, result, ...(message ? { message } : {}) };
  };
  if (!T || !theirs) return done("unchanged", `${label}: nothing shared from other machines; it syncs normally.`);
  if (choice === "theirs") {
    const followed = await follow(ctx, key, path, current, theirs, true);
    return done(followed.result, followed.message ?? `${label}: now matches ${theirs.device ?? "the other machine"}.`);
  }
  const pushed = await share(ctx, key, current, [T], T);
  if (pushed === "rejected") await refreshTheirs(ctx, key);
  if (pushed === "rejected") return done("desynced", `${label}: ${theirs.device ?? "another machine"} changed it again just now; /sync code to choose again.`);
  if (pushed !== "shared") return done("failed", `${label}: ${pushed.slice(7)}`);
  return done("shared", `${label}: your version replaces ${theirs.device ?? "the other machine"}'s; other machines follow it.`);
}

function removeEmptyParents(path: string, stop: string) {
  for (let dir = dirname(path); dir.startsWith(stop + sep); dir = dirname(dir)) {
    try { if (readdirSync(dir).length) return; rmdirSync(dir); } catch { return; }
  }
}
