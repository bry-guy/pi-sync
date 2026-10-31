import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { git, oversized, remoteName, treeOf, workingTree } from "./code.js";

/**
 * Code sharing for project conversations.
 *
 * A pi project folder holds several repositories (`repos/<name>`) and their worktrees (`worktrees/<name>/...`). A
 * conversation there may touch any of them, so the checkouts themselves are mirrored across machines, not per
 * conversation: each has a ref `refs/pi-projects/<project id>/<key>` on its repository's own remote holding its
 * branch, commit and uncommitted work (a commit on top of HEAD). After each turn changed checkouts are pushed and
 * removed worktrees deleted; arrival creates, removes and updates checkouts to match, but only where nothing here
 * can be lost (otherwise it reports, and /sync code brings it after asking). Every push and delete is
 * compare-and-swap, so another device's unseen work is never overwritten: one machine edits a checkout at a time.
 *
 * The local ref of the same name records the snapshot this machine last pushed or received.
 */

export interface Project { root: string; id: string; name: string }

/** A checkout's ref: `key` is `repo` (the main checkout) or `wt/<path under worktrees/<repo>/>`. */
export function projectRef(projectId: string, key: string): string {
  return `refs/pi-projects/${projectId}/${key}`;
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

interface Checkout { path: string; key: string }

/**
 * Where a checkout sits in the project, as its ref key: `repo` for `repos/<name>`, `wt/<path>` for
 * `worktrees/<name>/<path>`. Checkouts elsewhere are not shared.
 */
function keyOf(project: Project, repo: string, path: string): string | undefined {
  const name = repo.slice(repo.lastIndexOf(sep) + 1);
  if (path === repo) return "repo";
  const rel = relative(join(project.root, "worktrees", name), path);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  const key = `wt/${rel.split(sep).join("/")}`;
  return validKey(key) ? key : undefined;
}

const validKey = (key: string) => key === "repo" || (/^wt\/[^\s~^:?*[\\]+$/.test(key) && !/(^|\/)\.|\.\.|\.lock(\/|$)|\/$|\/\//.test(key));
const pathOf = (project: Project, repo: string, key: string) => key === "repo" ? repo : join(project.root, "worktrees", repo.slice(repo.lastIndexOf(sep) + 1), ...key.slice(3).split("/"));
/** How a checkout is named in messages: its branch, or where it is. */
const labelOf = (key: string, branch?: string) => branch ?? (key === "repo" ? "main checkout (detached)" : key.slice(3));

/** A repository's checkouts inside the project (its main checkout and worktrees under worktrees/<name>/). */
export async function checkouts(repo: string, project: Project): Promise<Checkout[]> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return [{ path: repo, key: "repo" }];
  const found: Checkout[] = [];
  for (const block of listed.stdout.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || /^prunable/m.test(block)) continue;
    const key = keyOf(project, repo, path);
    if (key) found.push({ path, key });
  }
  return found;
}

const out = async (cwd: string, args: string[]) => {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
};

const refsOf = async (repo: string, project: Project) => new Map(
  ((await out(repo, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/pi-projects/${project.id}/`])) ?? "").split("\n").filter(Boolean).map((line) => {
    const [ref, sha] = line.split(" ") as [string, string];
    return [ref.slice(`refs/pi-projects/${project.id}/`.length), sha] as const;
  }),
);

interface State { head?: string; branch?: string; tree?: string }
const stateOf = async (cwd: string): Promise<State> => {
  const [head, branch, tree] = await Promise.all([out(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]), out(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]), workingTree(cwd)]);
  return { head, branch, tree };
};
/** What a snapshot commit records: its base (parent), the branch it was on, the device, and its tree. */
const snapshotOf = async (cwd: string, commit: string) => {
  const [base, tree, body] = await Promise.all([out(cwd, ["rev-parse", `${commit}^`]), treeOf(cwd, commit), out(cwd, ["log", "-1", "--format=%B", commit])]);
  return { base, tree, branch: /^Branch: (.+)$/m.exec(body ?? "")?.[1], device: /^Device: (.+)$/m.exec(body ?? "")?.[1] };
};
/** The checkout is exactly as the snapshot left it (same commit, branch and files). */
const holds = (state: State, snap: Awaited<ReturnType<typeof snapshotOf>>) =>
  !!state.tree && state.tree === snap.tree && state.head === snap.base && state.branch === snap.branch;

export type ShareResult = {
  repo: string; key: string; checkout: string; branch?: string;
  // behind: another device shared newer work for this checkout that this machine has not taken; nothing is overwritten.
  result: "unchanged" | "pushed" | "removed" | "behind" | "skipped" | "failed"; reason?: string;
};

/**
 * Pushes one checkout's state (branch, commit and working tree, as a commit on top of HEAD) to its project ref when
 * it changed since the snapshot this machine last pushed or received, only if no other device replaced the ref
 * since (compare-and-swap through --force-with-lease), so unseen work from another device is never overwritten.
 */
async function shareCheckout(repo: string, checkout: Checkout, project: Project, device: string, known: string | undefined, remote: string): Promise<ShareResult> {
  const r = (result: Omit<ShareResult, "repo" | "key" | "checkout">): ShareResult => ({ repo: repo.slice(repo.lastIndexOf(sep) + 1), key: checkout.key, checkout: checkout.path, ...result });
  const state = await stateOf(checkout.path);
  if (!state.head || !state.tree) return r({ branch: state.branch, result: "failed", reason: "could not read the checkout" });
  if (known && holds(state, await snapshotOf(repo, known))) return r({ branch: state.branch, result: "unchanged" });
  const tooLarge = await oversized(checkout.path, state.head, state.tree);
  if (tooLarge) return r({ branch: state.branch, result: "failed", reason: tooLarge });
  const recorded = await git(checkout.path, ["commit-tree", state.tree, "-p", state.head, "-m", `pi-projects checkout\n\n${state.branch ? `Branch: ${state.branch}\n` : ""}Device: ${device}`], {
    env: { GIT_AUTHOR_NAME: "pi-sync", GIT_AUTHOR_EMAIL: "pi-sync@localhost", GIT_COMMITTER_NAME: "pi-sync", GIT_COMMITTER_EMAIL: "pi-sync@localhost" },
  });
  const commit = recorded.stdout.trim();
  if (!commit) return r({ branch: state.branch, result: "failed", reason: "could not record the snapshot" });
  const ref = projectRef(project.id, checkout.key);
  const pushed = await git(repo, ["push", "--no-verify", `--force-with-lease=${ref}:${known ?? ""}`, remote, `${commit}:${ref}`], { timeoutMs: 60_000 });
  if (pushed.code !== 0 && /stale info|rejected/.test(pushed.stderr)) return r({ branch: state.branch, result: "behind", reason: "another device changed it since; /sync code brings that here" });
  if (pushed.code !== 0) return r({ branch: state.branch, result: "failed", reason: pushed.stderr.trim().split("\n").at(-1) });
  await git(repo, ["update-ref", ref, commit]);
  return r({ branch: state.branch, result: "pushed" });
}

/**
 * Mirrors this machine's checkouts to the project refs, for every repository `allowed` permits: each main checkout
 * and worktree has a ref holding its branch, commit and uncommitted work; a worktree removed here has its ref
 * deleted (compare-and-swap), so other machines remove it too. `skip` holds back checkouts whose last push was refused.
 */
export async function shareProject(project: Project, device: string, allowed: (repo: string) => Promise<boolean>, skip?: (repo: string, key: string) => boolean): Promise<ShareResult[]> {
  const results: ShareResult[] = [];
  for (const repo of projectRepos(project)) {
    if (!(await allowed(repo))) continue;
    const remote = await remoteName(repo);
    if (!remote) continue;
    const name = repo.slice(repo.lastIndexOf(sep) + 1);
    const here = await checkouts(repo, project);
    const known = await refsOf(repo, project);
    for (const checkout of here) {
      if (skip?.(repo, checkout.key)) results.push({ repo: name, key: checkout.key, checkout: checkout.path, result: "skipped" });
      else results.push(await shareCheckout(repo, checkout, project, device, known.get(checkout.key), remote));
    }
    for (const [key, sha] of known) {
      if (here.some((item) => item.key === key)) continue;
      const ref = `refs/pi-projects/${project.id}/${key}`;
      const removed = await git(repo, ["push", "--no-verify", `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`], { timeoutMs: 30_000 });
      // Refused: another device changed it since, so it is theirs now and arrives back here; either way not ours to track.
      const refused = removed.code !== 0 && /stale info|rejected/.test(removed.stderr);
      if (removed.code === 0 || refused) await git(repo, ["update-ref", "-d", ref]);
      results.push({ repo: name, key, checkout: pathOf(project, repo, key), result: removed.code === 0 ? "removed" : refused ? "behind" : "failed", reason: removed.code === 0 || refused ? undefined : removed.stderr.trim().split("\n").at(-1) });
    }
  }
  return results;
}

export type ArriveResult = {
  repo: string;
  key: string;
  branch?: string;
  device?: string;
  checkout?: string;
  result: "matches" | "applied" | "created" | "removed" | "kept" | "pending" | "failed";
  message?: string;
};

/**
 * Makes this machine's checkouts match the project refs other devices pushed: creates worktrees they added, removes
 * worktrees they removed, and moves a checkout to their branch, commits and uncommitted work. A checkout is changed
 * only when nothing here can be lost: it is clean, or exactly as the last snapshot left it, and its branch has no
 * commits the incoming one lacks. Anything else is "pending"; with `force` the caller agreed to stash local changes.
 * A worktree removed elsewhere that was changed here since is kept, and shared again.
 */
export async function arriveProject(project: Project, options: { force?: boolean } = {}): Promise<ArriveResult[]> {
  const results: ArriveResult[] = [];
  for (const repo of projectRepos(project)) {
    const name = repo.slice(repo.lastIndexOf(sep) + 1);
    const remote = await remoteName(repo);
    if (!remote) continue;
    const prefix = `refs/pi-projects/${project.id}/`;
    const listed = await git(repo, ["ls-remote", remote, `${prefix}*`], { timeoutMs: 30_000 });
    if (listed.code !== 0) {
      results.push({ repo: name, key: "", result: "failed", message: listed.stderr.trim().split("\n").at(-1) });
      continue;
    }
    const remoteRefs = new Map(listed.stdout.split("\n").map((line) => line.split("\t")).filter(([sha, ref]) => sha && ref?.startsWith(prefix)).map(([sha, ref]) => [ref!.slice(prefix.length).trim(), sha!.trim()] as const).filter(([key]) => validKey(key)));
    const localRefs = await refsOf(repo, project);
    const here = await checkouts(repo, project);

    for (const [key, known] of localRefs) {
      if (remoteRefs.has(key) || !validKey(key)) continue;
      const ref = projectRef(project.id, key);
      const checkout = here.find((item) => item.key === key);
      if (checkout && key !== "repo") {
        const snap = await snapshotOf(repo, known);
        const label = `${name} ${labelOf(key, snap.branch)}`;
        const state = await stateOf(checkout.path);
        const clean = !!state.tree && !!state.head && state.tree === (await treeOf(checkout.path, state.head));
        // Nothing here to lose: as the other device last saw it, or clean on a branch (its commits stay on the branch).
        if (holds(state, snap) || (clean && !!state.branch)) {
          const removed = await git(repo, ["worktree", "remove", "--force", checkout.path]);
          if (removed.code === 0) {
            removeEmptyParents(checkout.path, join(project.root, "worktrees", name));
            results.push({ repo: name, key, branch: snap.branch, checkout: checkout.path, result: "removed", message: `${label}: removed on another device, so removed here (the branch is kept).` });
          } else results.push({ repo: name, key, branch: snap.branch, checkout: checkout.path, result: "failed", message: `${label} was removed on another device, but could not be removed here: ${removed.stderr.trim()}` });
        } else {
          results.push({ repo: name, key, branch: snap.branch, checkout: checkout.path, result: "kept", message: `${label} was removed on another device, but has changes made here since; kept, and shared again.` });
        }
      }
      await git(repo, ["update-ref", "-d", ref]);
    }

    for (const [key, sha] of remoteRefs) {
      if (localRefs.get(key) === sha) continue;
      const ref = projectRef(project.id, key);
      const incoming = `refs/pi-projects-incoming/${project.id}/${key}`;
      const fetched = await git(repo, ["fetch", "--no-tags", "--quiet", remote, `+${ref}:${incoming}`], { timeoutMs: 60_000 });
      if (fetched.code !== 0) {
        results.push({ repo: name, key, result: "failed", message: fetched.stderr.trim().split("\n").at(-1) });
        continue;
      }
      try {
        results.push(await arriveCheckout(project, repo, key, sha, incoming, here.find((item) => item.key === key)?.path, localRefs.get(key), remote, !!options.force));
      } finally {
        await git(repo, ["update-ref", "-d", incoming]);
      }
    }
  }
  return results;
}

async function arriveCheckout(project: Project, repo: string, key: string, sha: string, incoming: string, existing: string | undefined, known: string | undefined, remote: string, force: boolean): Promise<ArriveResult> {
  const name = repo.slice(repo.lastIndexOf(sep) + 1);
  const snap = await snapshotOf(repo, incoming);
  const label = `${name} ${labelOf(key, snap.branch)}`;
  const from = snap.device ?? "another device";
  const r = (result: ArriveResult["result"], checkout?: string, message?: string): ArriveResult => ({ repo: name, key, branch: snap.branch, device: snap.device, checkout, result, ...(message ? { message } : {}) });
  if (!snap.base || !snap.tree) return r("failed", existing, `${label}: the snapshot from ${from} is unreadable.`);
  // The branch may already be here with commits the incoming one lacks: then nothing moves.
  const branchTip = snap.branch ? await out(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${snap.branch}`]) : undefined;
  const fitsBranch = !branchTip || branchTip === snap.base || (await git(repo, ["merge-base", "--is-ancestor", branchTip, snap.base])).code === 0;
  // An older, clean state of a branch this machine has moved past (each pulled at a different time): nothing to
  // bring. Taking it as seen lets this machine's newer state replace it on the next share.
  if (existing && !fitsBranch && snap.tree === (await treeOf(repo, snap.base)) && (await git(repo, ["merge-base", "--is-ancestor", snap.base, branchTip!])).code === 0) {
    await git(repo, ["update-ref", projectRef(project.id, key), sha]);
    return r("matches", existing);
  }
  const diverged = `Local ${label} has commits that ${from}'s does not. Reconcile ${snap.branch}, then run /sync code.`;

  let checkout = existing;
  let created = false;
  if (!checkout) {
    if (key === "repo") return r("failed", undefined, `${label}: no main checkout here.`);
    const path = pathOf(project, repo, key);
    if (existsSync(path)) return r("pending", path, `${label} from ${from}: ${path} exists but is not a worktree of ${name}.`);
    if (!fitsBranch) return r("pending", path, diverged);
    const added = !snap.branch ? await git(repo, ["worktree", "add", "--quiet", "--detach", path, snap.base])
      : branchTip ? await git(repo, ["worktree", "add", "--quiet", path, snap.branch])
      : await git(repo, ["worktree", "add", "--quiet", "-b", snap.branch, path, snap.base]);
    if (added.code !== 0) return r("failed", path, `${label} from ${from}: ${added.stderr.trim().split("\n").at(-1)}`);
    if (snap.branch && !branchTip && (await out(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${snap.branch}`]))) {
      await git(path, ["branch", "--quiet", "--set-upstream-to", `${remote}/${snap.branch}`]);
    }
    checkout = path;
    created = true;
  }

  const state = await stateOf(checkout);
  if (holds(state, snap)) {
    await git(repo, ["update-ref", projectRef(project.id, key), sha]);
    return created ? r("created", checkout, `${label}: new worktree from ${from}.`) : r("matches", checkout);
  }
  const clean = !!state.tree && state.tree === (state.head ? await treeOf(checkout, state.head) : undefined);
  const asLeft = !!known && holds(state, await snapshotOf(repo, known));
  if (!fitsBranch) return r("pending", checkout, diverged);
  if (!clean && !asLeft && !force) return r("pending", checkout, `${label} has newer changes from ${from}; run /sync code to bring them here.`);

  let note = "";
  if (!clean && !asLeft) {
    const stashed = await git(checkout, ["stash", "push", "--include-untracked", "-m", `pi-sync: local changes before bringing ${label} from ${from}`], { timeoutMs: 60_000 });
    if (stashed.code !== 0) return r("failed", checkout, `Could not stash local changes in ${checkout}: ${stashed.stderr.trim()}`);
    note = " Your local changes are in git stash.";
  } else if (!clean) {
    // Exactly the last snapshot (which the local ref still holds): set it aside without a stash.
    await git(checkout, ["reset", "--quiet", "--hard"]);
    await git(checkout, ["clean", "-fdq"]);
  }
  const moved = snap.branch ? await git(checkout, ["switch", "--quiet", "-C", snap.branch, snap.base]) : await git(checkout, ["switch", "--quiet", "--detach", snap.base]);
  if (moved.code !== 0) return r("failed", checkout, `Could not move ${label} to ${from}'s commit: ${moved.stderr.trim().split("\n").at(-1)}.${note}`);
  if (snap.tree !== (await treeOf(checkout, snap.base))) {
    const restored = await git(checkout, ["restore", `--source=${incoming}`, "--worktree", "--", ":/"], { timeoutMs: 60_000 });
    if (restored.code !== 0) return r("failed", checkout, `Could not apply ${label}: ${restored.stderr.trim()}${note}`);
  }
  await git(repo, ["update-ref", projectRef(project.id, key), sha]);
  return r(created ? "created" : "applied", checkout, `${label}: now matches ${from}${created ? " (new worktree)" : ""}.${note}`);
}

function removeEmptyParents(path: string, stop: string) {
  for (let dir = dirname(path); dir.startsWith(stop + sep); dir = dirname(dir)) {
    try { if (readdirSync(dir).length) return; rmdirSync(dir); } catch { return; }
  }
}
