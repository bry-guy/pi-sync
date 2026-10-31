import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { arriveProject, projectFor, shareProject } from "../dist/src/session/index.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A bare remote with one commit on main, and two machines with the same project cloning it. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), "pi-sync-project-code-"));
  const remote = join(base, "app.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const machine = (label) => {
    const projects = join(base, label);
    const root = join(projects, "eco");
    mkdirSync(join(root, "repos"), { recursive: true });
    writeFileSync(join(root, "project.json"), JSON.stringify({ id: "p1", name: "eco" }));
    git(base, "clone", "-q", remote, join(root, "repos", "app"));
    return { root, app: join(root, "repos", "app"), project: projectFor(root, projects) };
  };
  return { laptop: machine("laptop"), web: machine("web") };
}

const allowed = async () => true;

test("project code: a worktree's work arrives in a new worktree; a dirty checkout is left alone until /sync code", async () => {
  const { laptop, web } = setup();
  assert.deepEqual(laptop.project && { id: laptop.project.id, name: laptop.project.name }, { id: "p1", name: "eco" });

  // Laptop: uncommitted work in a feature worktree, and in the main checkout.
  const feat = join(laptop.root, "worktrees", "app", "feat");
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", feat);
  writeFileSync(join(feat, "a.txt"), "feature\n");
  writeFileSync(join(feat, "new.txt"), "new\n");
  writeFileSync(join(laptop.app, "a.txt"), "main edit\n");
  const shared = await shareProject(laptop.project, "macbook", allowed);
  assert.deepEqual(shared.map((item) => item.result).sort(), ["pushed", "pushed"]);
  assert.deepEqual((await shareProject(laptop.project, "macbook", allowed)).map((item) => item.result), ["unchanged", "unchanged"], "nothing new: no push");

  // Web: its main checkout has its own uncommitted edit.
  writeFileSync(join(web.app, "b.txt"), "web's own\n");
  const arrived = await arriveProject(web.project);
  const byBranch = Object.fromEntries(arrived.map((item) => [item.branch, item]));
  assert.equal(byBranch.feat.result, "created");
  assert.equal(byBranch.feat.device, "macbook");
  const webFeat = join(web.root, "worktrees", "app", "feat");
  assert.equal(readFileSync(join(webFeat, "a.txt"), "utf8"), "feature\n");
  assert.equal(readFileSync(join(webFeat, "new.txt"), "utf8"), "new\n");
  assert.equal(byBranch.main.result, "pending", "a dirty checkout is not touched");
  assert.equal(readFileSync(join(web.app, "a.txt"), "utf8"), "one\n");
  assert.equal((await arriveProject(web.project)).filter((item) => item.result !== "pending").length, 0, "applied snapshots are not applied again");

  // Web received the feat snapshot unchanged: sharing pushes nothing back.
  const webShared = await shareProject(web.project, "web", async (repo) => repo === web.app);
  assert.equal(webShared.find((item) => item.branch === "feat").result, "unchanged");
  assert.equal(webShared.find((item) => item.branch === "main").result, "behind", "web's own edit does not overwrite the laptop's unseen work");

  // /sync code: stash the local edit, then bring the laptop's.
  const forced = await arriveProject(web.project, { force: true });
  assert.equal(forced.find((item) => item.branch === "main").result, "applied");
  assert.equal(readFileSync(join(web.app, "a.txt"), "utf8"), "main edit\n");
  assert.match(git(web.app, "stash", "list"), /local changes before bringing main/);

  // Laptop commits and pushes feat: its snapshot is deleted, and web's copy (unchanged there) catches up.
  git(feat, "add", ".");
  git(feat, "commit", "-qm", "feature");
  git(feat, "push", "-q", "-u", "origin", "feat");
  assert.equal((await shareProject(laptop.project, "macbook", allowed)).find((item) => item.branch === "feat").result, "cleared");
  const settled = await arriveProject(web.project);
  assert.equal(settled.find((item) => item.branch === "feat").result, "settled");
  assert.equal(git(webFeat, "rev-parse", "HEAD"), git(feat, "rev-parse", "HEAD"));
  assert.equal(git(webFeat, "status", "--porcelain"), "", "files already matched the pushed tip: nothing changed on disk, nothing stashed");
  assert.equal(existsSync(join(webFeat, "new.txt")), true);
  assert.doesNotMatch(git(web.app, "stash", "list"), /feat/);
});

test("project code: a removed worktree's snapshot is withdrawn, so other machines do not recreate it", async () => {
  const { laptop, web } = setup();
  const wt = join(laptop.root, "worktrees", "app", "feature", "x");
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/x", wt);
  writeFileSync(join(wt, "x.txt"), "x\n");
  const shared = await shareProject(laptop.project, "macbook", allowed);
  assert.equal(shared.find((item) => item.branch === "feature/x").result, "pushed", "a branch with a slash shares");
  assert.match(git(laptop.app, "ls-remote", "origin", "refs/pi-projects/p1/*"), /refs\/pi-projects\/p1\/feature\/x/);

  // Laptop drops the worktree (and branch) with the work still uncommitted.
  git(laptop.app, "worktree", "remove", "--force", wt);
  git(laptop.app, "branch", "-D", "feature/x");
  const withdrawn = await shareProject(laptop.project, "macbook", allowed);
  assert.equal(withdrawn.find((item) => item.branch === "feature/x").result, "cleared");
  assert.equal(git(laptop.app, "ls-remote", "origin", "refs/pi-projects/p1/*"), "");
  await arriveProject(web.project);
  assert.equal(existsSync(join(web.root, "worktrees", "app", "feature", "x")), false);
});

test("project code: a branch with a slash arrives in a nested worktree", async () => {
  const { laptop, web } = setup();
  const wt = join(laptop.root, "worktrees", "app", "feature", "y");
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/y", wt);
  writeFileSync(join(wt, "y.txt"), "y\n");
  await shareProject(laptop.project, "macbook", allowed);
  const arrived = await arriveProject(web.project);
  assert.equal(arrived.find((item) => item.branch === "feature/y").result, "created");
  const webWt = join(web.root, "worktrees", "app", "feature", "y");
  assert.equal(readFileSync(join(webWt, "y.txt"), "utf8"), "y\n");
  // Web holds only what it received: sharing pushes nothing, withdraws nothing.
  const again = await shareProject(web.project, "web", allowed);
  assert.equal(again.find((item) => item.branch === "feature/y").result, "unchanged");
});

test("project code: only folders inside a project with an id count", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-sync-project-for-"));
  mkdirSync(join(base, "eco", "repos"), { recursive: true });
  assert.equal(projectFor(join(base, "eco"), base), undefined, "no project.json");
  writeFileSync(join(base, "eco", "project.json"), JSON.stringify({ id: "p1", name: "eco" }));
  assert.equal(projectFor(join(base, "eco", "repos"), base)?.root.endsWith("/eco"), true);
  assert.equal(projectFor(base, base), undefined, "the projects folder itself");
  assert.equal(projectFor(tmpdir(), base), undefined);
});
