import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const byKey = (results) => Object.fromEntries(results.map((item) => [item.key, item]));

test("project code: worktrees and their work arrive; a dirty checkout is left alone until /sync code", async () => {
  const { laptop, web } = setup();
  assert.deepEqual(laptop.project && { id: laptop.project.id, name: laptop.project.name }, { id: "p1", name: "eco" });

  // Laptop: a feature worktree with an unpushed commit and uncommitted work, an edit in the main checkout,
  // and a clean worktree of a new branch.
  const feat = join(laptop.root, "worktrees", "app", "feat");
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", feat);
  writeFileSync(join(feat, "c.txt"), "committed\n");
  git(feat, "add", ".");
  git(feat, "commit", "-qm", "unpushed");
  writeFileSync(join(feat, "a.txt"), "feature\n");
  writeFileSync(join(feat, "new.txt"), "new\n");
  writeFileSync(join(laptop.app, "a.txt"), "main edit\n");
  git(laptop.app, "worktree", "add", "-q", "-b", "idea", join(laptop.root, "worktrees", "app", "idea"));
  const shared = await shareProject(laptop.project, "macbook", allowed);
  assert.deepEqual(shared.map((item) => item.result), ["pushed", "pushed", "pushed"]);
  assert.deepEqual((await shareProject(laptop.project, "macbook", allowed)).map((item) => item.result), ["unchanged", "unchanged", "unchanged"], "nothing new: no push");

  // Web: its main checkout has its own uncommitted edit.
  writeFileSync(join(web.app, "b.txt"), "web's own\n");
  const arrived = byKey(await arriveProject(web.project));
  assert.equal(arrived["wt/feat"].result, "created");
  assert.equal(arrived["wt/feat"].device, "macbook");
  assert.equal(arrived["wt/idea"].result, "created", "a clean worktree arrives too");
  const webFeat = join(web.root, "worktrees", "app", "feat");
  assert.equal(git(webFeat, "rev-parse", "HEAD"), git(feat, "rev-parse", "HEAD"), "with its unpushed commit");
  assert.equal(git(webFeat, "symbolic-ref", "--short", "HEAD"), "feat");
  assert.equal(readFileSync(join(webFeat, "a.txt"), "utf8"), "feature\n");
  assert.equal(readFileSync(join(webFeat, "new.txt"), "utf8"), "new\n");
  assert.equal(arrived.repo.result, "pending", "a dirty checkout is not touched");
  assert.equal(readFileSync(join(web.app, "a.txt"), "utf8"), "one\n");
  assert.equal((await arriveProject(web.project)).filter((item) => item.result !== "pending").length, 0, "applied snapshots are not applied again");

  // Web holds what it received: sharing pushes nothing back, and its own edit does not overwrite the laptop's.
  const webShared = byKey(await shareProject(web.project, "web", allowed));
  assert.equal(webShared["wt/feat"].result, "unchanged");
  assert.equal(webShared["wt/idea"].result, "unchanged");
  assert.equal(webShared.repo.result, "behind");

  // /sync code: stash the local edit, then bring the laptop's.
  const forced = byKey(await arriveProject(web.project, { force: true }));
  assert.equal(forced.repo.result, "applied");
  assert.equal(readFileSync(join(web.app, "a.txt"), "utf8"), "main edit\n");
  assert.match(git(web.app, "stash", "list"), /local changes before bringing/);

  // Laptop commits feat: web's copy (as received) follows, with nothing stashed.
  git(feat, "add", ".");
  git(feat, "commit", "-qm", "feature");
  assert.equal(byKey(await shareProject(laptop.project, "macbook", allowed))["wt/feat"].result, "pushed");
  assert.equal(byKey(await arriveProject(web.project))["wt/feat"].result, "applied");
  assert.equal(git(webFeat, "rev-parse", "HEAD"), git(feat, "rev-parse", "HEAD"));
  assert.equal(git(webFeat, "status", "--porcelain"), "");
  assert.doesNotMatch(git(webFeat, "stash", "list"), /feat/);

  // Web carries on in feat; the laptop (as it left it) follows back.
  writeFileSync(join(webFeat, "w.txt"), "from web\n");
  assert.equal(byKey(await shareProject(web.project, "web", allowed))["wt/feat"].result, "pushed");
  assert.equal(byKey(await arriveProject(laptop.project))["wt/feat"].result, "applied");
  assert.equal(readFileSync(join(feat, "w.txt"), "utf8"), "from web\n");
});

test("project code: removing a worktree removes it everywhere, unless it has changes there", async () => {
  const { laptop, web } = setup();
  const x = join(laptop.root, "worktrees", "app", "feature", "x");
  const y = join(laptop.root, "worktrees", "app", "feature", "y");
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/x", x);
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/y", y);
  writeFileSync(join(x, "x.txt"), "x\n");
  const shared = byKey(await shareProject(laptop.project, "macbook", allowed));
  assert.equal(shared["wt/feature/x"].result, "pushed", "a nested path (branch with a slash) shares");
  await arriveProject(web.project);
  const webX = join(web.root, "worktrees", "app", "feature", "x");
  const webY = join(web.root, "worktrees", "app", "feature", "y");
  assert.equal(readFileSync(join(webX, "x.txt"), "utf8"), "x\n");
  assert.equal(existsSync(webY), true);

  // Web edits y; the laptop then removes both worktrees.
  writeFileSync(join(webY, "y.txt"), "web edit\n");
  git(laptop.app, "worktree", "remove", "--force", x);
  git(laptop.app, "worktree", "remove", "--force", y);
  const removed = byKey(await shareProject(laptop.project, "macbook", allowed));
  assert.equal(removed["wt/feature/x"].result, "removed");
  assert.equal(removed["wt/feature/y"].result, "removed");

  const arrived = byKey(await arriveProject(web.project));
  assert.equal(arrived["wt/feature/x"].result, "removed");
  assert.equal(existsSync(webX), false);
  assert.equal(arrived["wt/feature/y"].result, "kept", "web's unshared edit is never thrown away");
  assert.equal(readFileSync(join(webY, "y.txt"), "utf8"), "web edit\n");
  // ...and it is shared again, so it comes back on the laptop with web's edit.
  assert.equal(byKey(await shareProject(web.project, "web", allowed))["wt/feature/y"].result, "pushed");
  const back = byKey(await arriveProject(laptop.project));
  assert.equal(back["wt/feature/y"].result, "created");
  assert.equal(readFileSync(join(y, "y.txt"), "utf8"), "web edit\n");
  assert.equal(existsSync(x), false, "x stays removed");
  assert.equal(git(laptop.app, "ls-remote", "origin", "refs/pi-checkouts/p1/wt/feature/x"), "");
});

test("project code: switching the main checkout's branch follows when the checkout is clean", async () => {
  const { laptop, web } = setup();
  await shareProject(laptop.project, "macbook", allowed);
  git(laptop.app, "switch", "-q", "-c", "topic");
  writeFileSync(join(laptop.app, "t.txt"), "t\n");
  git(laptop.app, "add", ".");
  git(laptop.app, "commit", "-qm", "topic");
  await shareProject(laptop.project, "macbook", allowed);
  assert.equal(byKey(await arriveProject(web.project)).repo.result, "applied");
  assert.equal(git(web.app, "symbolic-ref", "--short", "HEAD"), "topic");
  assert.equal(git(web.app, "rev-parse", "HEAD"), git(laptop.app, "rev-parse", "HEAD"));
});

test("project code: machines that pulled at different times do not flag each other", async () => {
  const { laptop, web } = setup();
  await shareProject(laptop.project, "macbook", allowed);
  // main moves on the remote; web pulls, the laptop does not.
  const seed = join(laptop.root, "..", "..", "seed");
  writeFileSync(join(seed, "a.txt"), "two\n");
  git(seed, "commit", "-qam", "two");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(web.app, "pull", "-q");
  assert.equal(byKey(await arriveProject(web.project)).repo.result, "matches", "older and clean: nothing to bring");
  assert.equal(byKey(await shareProject(web.project, "web", allowed)).repo.result, "pushed");
  assert.equal(byKey(await arriveProject(laptop.project)).repo.result, "applied", "and the laptop catches up");
  assert.equal(git(laptop.app, "rev-parse", "HEAD"), git(web.app, "rev-parse", "HEAD"));
});

test("project code: a worktree whose folder is missing is not removed everywhere", async () => {
  const { laptop, web } = setup();
  const x = join(laptop.root, "worktrees", "app", "x");
  git(laptop.app, "worktree", "add", "-q", "-b", "x", x);
  await shareProject(laptop.project, "macbook", allowed);
  await arriveProject(web.project);
  rmSync(x, { recursive: true, force: true }); // unmounted, half-moved: git lists it as prunable
  const shared = byKey(await shareProject(laptop.project, "macbook", allowed));
  assert.equal(shared["wt/x"], undefined, "neither shared nor withdrawn");
  assert.notEqual(git(laptop.app, "ls-remote", "origin", "refs/pi-checkouts/p1/wt/x"), "");
  await arriveProject(web.project);
  assert.equal(existsSync(join(web.root, "worktrees", "app", "x")), true);
});

test("project code: a detached commit on no branch is never moved away from", async () => {
  const { laptop, web } = setup();
  await shareProject(laptop.project, "macbook", allowed);
  await arriveProject(web.project);
  git(web.app, "switch", "-q", "--detach");
  writeFileSync(join(web.app, "d.txt"), "d\n");
  git(web.app, "add", ".");
  git(web.app, "commit", "-qm", "detached work");
  const orphan = git(web.app, "rev-parse", "HEAD");
  writeFileSync(join(laptop.app, "a.txt"), "laptop\n");
  await shareProject(laptop.project, "macbook", allowed);
  for (const force of [false, true]) assert.equal(byKey(await arriveProject(web.project, { force })).repo.result, "pending");
  assert.equal(git(web.app, "rev-parse", "HEAD"), orphan);
});
