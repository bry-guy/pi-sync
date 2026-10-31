import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { captureWorkspace, git, remoteName, treeOf, workingTree } from "./code.js";

/**
 * Code sharing for project conversations.
 *
 * A pi project folder holds several repositories (`repos/<name>`) and their worktrees. A conversation there may
 * touch any of them, so code is shared per project and branch rather than per conversation: after each turn every
 * checkout with uncommitted or unpushed work is captured (see captureWorkspace) and pushed to
 * `refs/pi-projects/<project id>/<branch>` on that repository's own remote, replacing the previous snapshot (the
 * newest wins: one machine edits a branch at a time). Arrival creates missing worktrees and lays a snapshot onto
 * a checkout only when nothing there can be lost; otherwise it reports, and /sync code brings it after asking.
 *
 * The local ref of the same name records the snapshot this repository last pushed or received.
 */

export interface Project { root: string; id: string; name: string }

export function projectRef(projectId: string, branch: string): string {
  return `refs/pi-projects/${projectId}/${branch}`;
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

interface Checkout { path: string; branch?: string }

/** A repository's checkouts inside the project (its main checkout and worktrees under the project folder). */
export async function checkouts(repo: string, project: Project): Promise<Checkout[]> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return [{ path: repo }];
  const found: Checkout[] = [];
  for (const block of listed.stdout.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || /^prunable/m.test(block)) continue;
    if (path !== project.root && !path.startsWith(project.root + sep)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    found.push(branch ? { path, branch } : { path });
  }
  return found;
}

const out = async (cwd: string, args: string[]) => {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
};

// behind: another device shared newer work on this branch that this checkout has not taken; nothing is overwritten.
export type ShareResult = { repo: string; checkout: string; branch?: string; result: "unchanged" | "pushed" | "cleared" | "behind" | "skipped" | "failed"; reason?: string };

/**
 * Pushes one checkout's work to its project ref when it changed since the snapshot this repository last pushed or
 * received, or deletes the ref once everything is committed and pushed. Both only if no other device replaced the
 * ref since (compare-and-swap through --force-with-lease), so unseen work from another device is never overwritten.
 */
export async function shareCheckout(cwd: string, project: Project, device: string, repo = cwd, skip?: (branch: string) => boolean): Promise<ShareResult> {
  const name = repo.slice(repo.lastIndexOf(sep) + 1);
  const r = (result: Omit<ShareResult, "repo" | "checkout">): ShareResult => ({ repo: name, checkout: cwd, ...result });
  const branch = await out(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch) return r({ result: "unchanged" }); // detached: nothing to name it by
  if (skip?.(branch)) return r({ branch, result: "skipped" });
  const ref = projectRef(project.id, branch);
  const known = await out(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (known) {
    const [tree, knownTree, head, knownBase] = await Promise.all([workingTree(cwd), treeOf(cwd, known), out(cwd, ["rev-parse", "HEAD"]), out(cwd, ["rev-parse", `${known}^`])]);
    if (tree && tree === knownTree && head === knownBase) return r({ branch, result: "unchanged" });
  }
  const snapshot = await captureWorkspace(cwd, `Device: ${device}`);
  if (snapshot.kind === "skipped") return r({ branch, result: "failed", reason: snapshot.reason });
  if (snapshot.kind === "clean") {
    if (!known) return r({ branch, result: "unchanged" });
    const remote = await remoteName(cwd);
    if (remote) await git(cwd, ["push", "--no-verify", `--force-with-lease=${ref}:${known}`, remote, `:${ref}`], { timeoutMs: 30_000 });
    await git(cwd, ["update-ref", "-d", ref]);
    return r({ branch, result: "cleared" });
  }
  const commit = snapshot.workspace.wip!.commit;
  const pushed = await git(cwd, ["push", "--no-verify", `--force-with-lease=${ref}:${known ?? ""}`, snapshot.remote, `${commit}:${ref}`], { timeoutMs: 60_000 });
  if (pushed.code !== 0 && /stale info|rejected/.test(pushed.stderr)) return r({ branch, result: "behind", reason: "another device shared newer changes on this branch; /sync code brings them" });
  if (pushed.code !== 0) return r({ branch, result: "failed", reason: pushed.stderr.trim().split("\n").at(-1) });
  await git(cwd, ["update-ref", ref, commit]);
  return r({ branch, result: "pushed" });
}

/**
 * Shares every checkout of every repository in the project that `allowed` permits, then withdraws snapshots of
 * branches this machine shared or received that no longer have a checkout here (a removed worktree, a deleted
 * branch), so other machines do not recreate them. Withdrawing is compare-and-swap like sharing.
 */
export async function shareProject(project: Project, device: string, allowed: (repo: string) => Promise<boolean>, skip?: (repo: string, branch: string) => boolean): Promise<ShareResult[]> {
  const results: ShareResult[] = [];
  const prefix = `refs/pi-projects/${project.id}/`;
  for (const repo of projectRepos(project)) {
    if (!(await allowed(repo))) continue;
    const here = await checkouts(repo, project);
    for (const checkout of here) results.push(await shareCheckout(checkout.path, project, device, repo, skip && ((branch) => skip(repo, branch))));
    const known = ((await out(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])) ?? "").split("\n").filter(Boolean);
    for (const line of known) {
      const [ref, sha] = line.split(" ") as [string, string];
      const branch = ref.slice(prefix.length);
      if (here.some((item) => item.branch === branch)) continue;
      const remote = await remoteName(repo);
      const removed = remote ? await git(repo, ["push", "--no-verify", `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`], { timeoutMs: 30_000 }) : undefined;
      // Already gone or replaced by another device: either way it is no longer this machine's to withdraw.
      if (!removed || removed.code === 0 || /stale info|rejected|unable to delete/.test(removed.stderr)) await git(repo, ["update-ref", "-d", ref]);
      results.push({ repo: repo.slice(repo.lastIndexOf(sep) + 1), checkout: repo, branch, result: removed && removed.code !== 0 && !/stale info|rejected|unable to delete/.test(removed.stderr) ? "failed" : "cleared" });
    }
  }
  return results;
}

export type ArriveResult = {
  repo: string;
  branch: string;
  device?: string;
  checkout?: string;
  result: "matches" | "applied" | "created" | "settled" | "pending" | "failed";
  message?: string;
};

/**
 * Brings the project's snapshots to this machine. For each snapshot not already known here: creates the branch's
 * worktree under `worktrees/<repo>/<branch>` when no checkout has it, then lays the snapshot on a checkout that is
 * clean (or holds only the previous snapshot) and at or behind its base. Anything else is "pending"; with `force`
 * the caller has agreed to stash local changes first. A snapshot that was deleted (the other device committed and
 * pushed) leaves this checkout's copy of it in a stash and fast-forwards, when that copy is unchanged here.
 */
export async function arriveProject(project: Project, options: { force?: boolean } = {}): Promise<ArriveResult[]> {
  const results: ArriveResult[] = [];
  for (const repo of projectRepos(project)) {
    const name = repo.slice(repo.lastIndexOf(sep) + 1);
    const remote = await remoteName(repo);
    if (!remote) continue;
    const listed = await git(repo, ["ls-remote", remote, `refs/pi-projects/${project.id}/*`], { timeoutMs: 30_000 });
    if (listed.code !== 0) {
      results.push({ repo: name, branch: "", result: "failed", message: listed.stderr.trim().split("\n").at(-1) });
      continue;
    }
    const prefix = `refs/pi-projects/${project.id}/`;
    const remoteRefs = new Map(listed.stdout.split("\n").map((line) => line.split("\t")).filter(([sha, ref]) => sha && ref?.startsWith(prefix)).map(([sha, ref]) => [ref!.slice(prefix.length).trim(), sha!.trim()]));
    const localRefs = new Map(((await out(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])) ?? "").split("\n").filter(Boolean).map((line) => {
      const [ref, sha] = line.split(" ");
      return [ref!.slice(prefix.length), sha!] as const;
    }));
    let fetchedMain = false;
    const fetchMain = async () => {
      if (!fetchedMain) fetchedMain = (await git(repo, ["fetch", "--no-tags", "--quiet", remote], { timeoutMs: 60_000 })).code === 0;
      return fetchedMain;
    };
    const here = await checkouts(repo, project);
    // Deleted on the remote: the other device committed and pushed (or withdrew it). When this checkout's files are
    // exactly the pushed branch tip, move HEAD there (nothing changes on disk); otherwise its work is its own now.
    for (const [branch, known] of localRefs) {
      if (remoteRefs.has(branch)) continue;
      const ref = projectRef(project.id, branch);
      const checkout = here.find((item) => item.branch === branch);
      if (checkout && (await workingTree(checkout.path)) === (await treeOf(checkout.path, known)) && (await fetchMain())) {
        const tip = await out(checkout.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
        const head = await out(checkout.path, ["rev-parse", "HEAD"]);
        if (tip && head && tip !== head && (await git(checkout.path, ["merge-base", "--is-ancestor", head, tip])).code === 0
          && (await treeOf(checkout.path, tip)) === (await workingTree(checkout.path))
          && (await git(checkout.path, ["reset", "--quiet", "--mixed", tip])).code === 0) {
          results.push({ repo: name, branch, checkout: checkout.path, result: "settled", message: `${name}/${branch}: the other device committed and pushed its changes; this checkout now matches it.` });
        }
      }
      await git(repo, ["update-ref", "-d", ref]);
    }
    for (const [branch, sha] of remoteRefs) {
      if (localRefs.get(branch) === sha) continue;
      const ref = projectRef(project.id, branch);
      const incoming = `refs/pi-projects-incoming/${project.id}/${branch}`;
      const fetched = await git(repo, ["fetch", "--no-tags", "--quiet", remote, `+${ref}:${incoming}`], { timeoutMs: 60_000 });
      if (fetched.code !== 0) {
        results.push({ repo: name, branch, result: "failed", message: fetched.stderr.trim().split("\n").at(-1) });
        continue;
      }
      try {
        const device = /^Device: (.+)$/m.exec((await out(repo, ["log", "-1", "--format=%B", incoming])) ?? "")?.[1];
        const base = await out(repo, ["rev-parse", `${incoming}^`]);
        if (!base) continue;
        let checkout = here.find((item) => item.branch === branch)?.path;
        let created = false;
        if (!checkout) {
          const path = join(project.root, "worktrees", name, branch);
          if (existsSync(path)) {
            results.push({ repo: name, branch, device, result: "pending", message: `${name}/${branch} from ${device ?? "another device"}: ${path} exists but is not a checkout of ${branch}.` });
            continue;
          }
          const local = await out(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
          const added = local ? await git(repo, ["worktree", "add", "--quiet", path, branch]) : await git(repo, ["worktree", "add", "--quiet", "-b", branch, path, base]);
          if (added.code !== 0) {
            results.push({ repo: name, branch, device, result: "failed", message: added.stderr.trim().split("\n").at(-1) });
            continue;
          }
          if (!local && (await fetchMain())) await git(path, ["branch", "--quiet", "--set-upstream-to", `${remote}/${branch}`]);
          checkout = path;
          created = true;
        }
        const target = await treeOf(repo, incoming);
        const head = await out(checkout, ["rev-parse", "HEAD"]);
        const tree = await workingTree(checkout);
        if (tree === target && head === base) {
          await git(repo, ["update-ref", ref, sha]);
          results.push({ repo: name, branch, device, checkout, result: "matches" });
          continue;
        }
        const known = localRefs.get(branch);
        const clean = tree === (head ? await treeOf(checkout, head) : undefined);
        const onlyKnown = !clean && !!known && tree === (await treeOf(checkout, known));
        const behind = !!head && (head === base || (await git(checkout, ["merge-base", "--is-ancestor", head, base])).code === 0);
        const automatic = behind && (clean || (onlyKnown && head === base));
        if (!automatic && !options.force) {
          results.push({ repo: name, branch, device, checkout, result: "pending", message: `${name}/${branch} has newer changes from ${device ?? "another device"}; run /sync code to bring them here.` });
          continue;
        }
        if (!behind) {
          results.push({ repo: name, branch, device, checkout, result: "pending", message: `Local ${name}/${branch} has commits the other device's changes do not. Reconcile ${branch}, then run /sync code.` });
          continue;
        }
        let note = "";
        if (!automatic && !clean) {
          const stashed = await git(checkout, ["stash", "push", "--include-untracked", "-m", `pi-sync: local changes before bringing ${branch} from ${device ?? "another device"}`], { timeoutMs: 60_000 });
          if (stashed.code !== 0) {
            results.push({ repo: name, branch, device, checkout, result: "failed", message: `Could not stash local changes in ${checkout}: ${stashed.stderr.trim()}` });
            continue;
          }
          note = " Your local changes are in git stash.";
        }
        if (head !== base && (await git(checkout, ["merge", "--ff-only", "--quiet", base])).code !== 0) {
          results.push({ repo: name, branch, device, checkout, result: "failed", message: `Could not fast-forward ${name}/${branch}.${note}` });
          continue;
        }
        const restored = await git(checkout, ["restore", `--source=${incoming}`, "--worktree", "--", ":/"], { timeoutMs: 60_000 });
        if (restored.code !== 0) {
          results.push({ repo: name, branch, device, checkout, result: "failed", message: `Could not apply ${name}/${branch}: ${restored.stderr.trim()}${note}` });
          continue;
        }
        await git(repo, ["update-ref", ref, sha]);
        results.push({ repo: name, branch, device, checkout, result: created ? "created" : "applied", message: `${name}/${branch}: brought ${device ?? "another device"}'s uncommitted changes${created ? ` into a new worktree` : ""}.${note}` });
      } finally {
        await git(repo, ["update-ref", "-d", incoming]);
      }
    }
  }
  return results;
}
