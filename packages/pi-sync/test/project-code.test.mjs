import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectDesyncs, projectFor, resolveCheckout, syncProject } from "../dist/src/session/index.js";

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
  return { laptop: machine("laptop"), web: machine("web"), desk: machine("desk"), seed };
}

const allowed = async () => true;
const sync = async (m, device, options = {}) => Object.fromEntries((await syncProject(m.project, { device, allowed, fetch: true, apply: true, ...options })).map((item) => [item.key, item]));
const read = (path) => readFileSync(path, "utf8");
const wt = (m, ...rest) => join(m.root, "worktrees", "app", ...rest);
const edit = (path, text) => writeFileSync(path, text);

test("checkouts: worktrees, branches, unpushed commits and changes follow; nothing new is not pushed again", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", wt(laptop, "feat"));
  edit(join(wt(laptop, "feat"), "c.txt"), "committed\n");
  git(wt(laptop, "feat"), "add", ".");
  git(wt(laptop, "feat"), "commit", "-qm", "unpushed");
  edit(join(wt(laptop, "feat"), "a.txt"), "feature\n");
  edit(join(laptop.app, "a.txt"), "main edit\n");
  git(laptop.app, "worktree", "add", "-q", "-b", "idea", wt(laptop, "idea"));
  const shared = await sync(laptop, "macbook");
  assert.deepEqual(Object.values(shared).map((item) => item.result), ["shared", "shared", "shared"]);
  assert.deepEqual(Object.values(await sync(laptop, "macbook")).map((item) => item.result), ["unchanged", "unchanged", "unchanged"]);

  const arrived = await sync(web, "web");
  assert.equal(arrived["wt/feat"].result, "created");
  assert.equal(arrived["wt/idea"].result, "created");
  assert.equal(arrived.repo.result, "applied", "a clean checkout follows");
  assert.equal(git(wt(web, "feat"), "rev-parse", "HEAD"), git(wt(laptop, "feat"), "rev-parse", "HEAD"));
  assert.equal(git(wt(web, "feat"), "symbolic-ref", "--short", "HEAD"), "feat");
  assert.equal(read(join(wt(web, "feat"), "a.txt")), "feature\n");
  assert.equal(read(join(web.app, "a.txt")), "main edit\n");
  assert.deepEqual(Object.values(await sync(web, "web")).map((item) => item.result), ["unchanged", "unchanged", "unchanged"], "received states are not pushed back");
  assert.deepEqual(Object.values(await sync(laptop, "macbook")).map((item) => item.result), ["unchanged", "unchanged", "unchanged"]);

  // Web carries on; the laptop follows, and the laptop's commit then follows back.
  edit(join(wt(web, "feat"), "w.txt"), "from web\n");
  assert.equal((await sync(web, "web"))["wt/feat"].result, "shared");
  assert.equal((await sync(laptop, "macbook"))["wt/feat"].result, "applied");
  assert.equal(read(join(wt(laptop, "feat"), "w.txt")), "from web\n");
  git(wt(laptop, "feat"), "add", ".");
  git(wt(laptop, "feat"), "commit", "-qm", "both");
  await sync(laptop, "macbook");
  assert.equal((await sync(web, "web"))["wt/feat"].result, "applied");
  assert.equal(git(wt(web, "feat"), "rev-parse", "HEAD"), git(wt(laptop, "feat"), "rev-parse", "HEAD"));
  assert.equal(git(wt(web, "feat"), "status", "--porcelain"), "");
  assert.equal(git(web.app, "stash", "list"), "", "nothing was stashed along the way");
});

test("checkouts: machines that pulled at different times never desync", async () => {
  const { laptop, web, seed } = setup();
  await sync(laptop, "macbook");
  await sync(web, "web");
  const push = (text) => { edit(join(seed, "a.txt"), text); git(seed, "commit", "-qam", text); git(seed, "push", "-q", "origin", "HEAD:main"); };
  push("two\n");
  git(web.app, "pull", "-q");
  assert.equal((await sync(web, "web")).repo.result, "shared");
  push("three\n");
  git(laptop.app, "pull", "-q"); // laptop jumps past web's state without seeing it
  assert.equal((await sync(laptop, "macbook")).repo.result, "shared", "newer and clean: replaces web's");
  assert.equal((await sync(web, "web")).repo.result, "applied");
  assert.equal(read(join(web.app, "a.txt")), "three\n");
});

test("checkouts: both changed desyncs the second machine, untouched; keep mine resolves it everywhere", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", wt(laptop, "feat"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  edit(join(wt(laptop, "feat"), "a.txt"), "laptop\n");
  edit(join(wt(web, "feat"), "a.txt"), "web\n");
  assert.equal((await sync(laptop, "macbook"))["wt/feat"].result, "shared", "first one wins");
  const second = (await sync(web, "web"))["wt/feat"];
  assert.equal(second.result, "desynced");
  assert.match(second.message, /app · feat desynced: this machine and macbook both changed it/);
  assert.equal(read(join(wt(web, "feat"), "a.txt")), "web\n", "nothing changed on disk");
  assert.deepEqual((await projectDesyncs(web.project)).map((item) => item.key), ["wt/feat"]);
  assert.equal((await sync(web, "web"))["wt/feat"].result, "desynced", "stays desynced until chosen");
  assert.equal((await sync(laptop, "macbook"))["wt/feat"].result, "unchanged", "the first machine is not bothered");

  assert.equal((await resolveCheckout(web.project, "app", "wt/feat", "mine", "web")).result, "shared");
  assert.deepEqual(await projectDesyncs(web.project), []);
  assert.equal((await sync(laptop, "macbook"))["wt/feat"].result, "applied");
  assert.equal(read(join(wt(laptop, "feat"), "a.txt")), "web\n");
});

test("checkouts: take theirs keeps local changes in git stash and local commits on a .mine branch", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", wt(laptop, "feat"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  edit(join(wt(laptop, "feat"), "a.txt"), "laptop\n");
  await sync(laptop, "macbook");
  edit(join(wt(web, "feat"), "b.txt"), "web commit\n");
  git(wt(web, "feat"), "add", ".");
  git(wt(web, "feat"), "commit", "-qm", "web's commit");
  const webCommit = git(wt(web, "feat"), "rev-parse", "HEAD");
  edit(join(wt(web, "feat"), "c.txt"), "web uncommitted\n");
  assert.equal((await sync(web, "web"))["wt/feat"].result, "desynced");
  const taken = await resolveCheckout(web.project, "app", "wt/feat", "theirs", "web");
  assert.equal(taken.result, "applied");
  assert.match(taken.message, /git stash/);
  assert.match(taken.message, /branch feat\.mine-/);
  assert.equal(read(join(wt(web, "feat"), "a.txt")), "laptop\n");
  assert.equal(existsSync(join(wt(web, "feat"), "c.txt")), false);
  assert.match(git(web.app, "stash", "list"), /before taking macbook's/);
  assert.equal(git(web.app, "for-each-ref", "--format=%(objectname)", "refs/heads/feat.mine-*"), webCommit);
  assert.equal((await sync(web, "web"))["wt/feat"].result, "unchanged");
});

test("checkouts: a removed worktree is removed everywhere it is unchanged; elsewhere it desyncs", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/x", wt(laptop, "feature", "x"));
  git(laptop.app, "worktree", "add", "-q", "-b", "feature/y", wt(laptop, "feature", "y"));
  edit(join(wt(laptop, "feature", "x"), "x.txt"), "x\n");
  await sync(laptop, "macbook");
  await sync(web, "web");
  assert.equal(read(join(wt(web, "feature", "x"), "x.txt")), "x\n", "nested paths (branches with a slash) work");
  edit(join(wt(web, "feature", "y"), "y.txt"), "web edit\n");
  git(laptop.app, "worktree", "remove", "--force", wt(laptop, "feature", "x"));
  git(laptop.app, "worktree", "remove", "--force", wt(laptop, "feature", "y"));
  const removed = await sync(laptop, "macbook");
  assert.equal(removed["wt/feature/x"].result, "shared");

  const arrived = await sync(web, "web");
  assert.equal(arrived["wt/feature/x"].result, "removed");
  assert.equal(existsSync(wt(web, "feature", "x")), false);
  assert.equal(git(web.app, "rev-parse", "--verify", "feature/x").length > 0, true, "the branch is kept");
  assert.equal(arrived["wt/feature/y"].result, "desynced");
  assert.match(arrived["wt/feature/y"].message, /macbook removed it, but it changed here since/);
  assert.equal(read(join(wt(web, "feature", "y"), "y.txt")), "web edit\n");

  // Web keeps it: it comes back on the laptop with web's edit; x stays gone.
  assert.equal((await resolveCheckout(web.project, "app", "wt/feature/y", "mine", "web")).result, "shared");
  const back = await sync(laptop, "macbook");
  assert.equal(back["wt/feature/y"].result, "created");
  assert.equal(read(join(wt(laptop, "feature", "y"), "y.txt")), "web edit\n");
  assert.equal(existsSync(wt(laptop, "feature", "x")), false);
  assert.equal((await sync(laptop, "macbook"))["wt/feature/x"].result, "unchanged");
});

test("checkouts: stop syncing persists and resume settles it", async () => {
  const { laptop, web } = setup();
  await sync(laptop, "macbook");
  await sync(web, "web");
  await resolveCheckout(web.project, "app", "repo", "stop", "web");
  edit(join(laptop.app, "a.txt"), "laptop\n");
  await sync(laptop, "macbook");
  assert.equal((await sync(web, "web")).repo.result, "stopped");
  assert.equal(read(join(web.app, "a.txt")), "one\n");
  assert.deepEqual((await projectDesyncs(web.project)).map((item) => [item.key, item.stopped]), [["repo", true]]);
  assert.equal((await resolveCheckout(web.project, "app", "repo", "resume", "web")).result, "applied");
  assert.equal(read(join(web.app, "a.txt")), "laptop\n");
});

test("checkouts: a worktree whose folder is missing is not removed anywhere", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "x", wt(laptop, "x"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  rmSync(wt(laptop, "x"), { recursive: true, force: true });
  assert.equal((await sync(laptop, "macbook"))["wt/x"], undefined);
  assert.equal((await sync(web, "web"))["wt/x"].result, "unchanged");
  assert.equal(existsSync(wt(web, "x")), true);
});

test("checkouts: no changes to checkouts while a turn runs (share only)", async () => {
  const { laptop, web } = setup();
  await sync(laptop, "macbook");
  await sync(web, "web");
  edit(join(laptop.app, "a.txt"), "laptop\n");
  await sync(laptop, "macbook");
  assert.equal((await sync(web, "web", { apply: false })).repo.result, "unchanged");
  assert.equal(read(join(web.app, "a.txt")), "one\n");
  assert.equal((await sync(web, "web")).repo.result, "applied");
});

test("checkouts: three machines: one winner, losers desync alone, racing resolutions, a long absence", async () => {
  const { laptop, web, desk } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "feat", wt(laptop, "feat"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  await sync(desk, "desk");
  // Desk goes away for a while.

  edit(join(wt(web, "feat"), "a.txt"), "web\n");
  edit(join(wt(laptop, "feat"), "a.txt"), "laptop\n");
  assert.equal((await sync(web, "web"))["wt/feat"].result, "shared");
  assert.equal((await sync(laptop, "macbook"))["wt/feat"].result, "desynced", "only the loser desyncs");

  // Web edits again before the laptop resolves: keep mine is refused, then goes through on the second try.
  edit(join(wt(web, "feat"), "a.txt"), "web again\n");
  await sync(web, "web");
  const refused = await resolveCheckout(laptop.project, "app", "wt/feat", "mine", "macbook");
  assert.equal(refused.result, "desynced");
  assert.match(refused.message, /changed it again/);
  assert.equal((await resolveCheckout(laptop.project, "app", "wt/feat", "mine", "macbook")).result, "shared");
  assert.equal((await sync(web, "web"))["wt/feat"].result, "applied", "web follows the resolution");
  assert.equal(read(join(wt(web, "feat"), "a.txt")), "laptop\n");

  // Desk comes back after all of that: one step.
  assert.equal((await sync(desk, "desk"))["wt/feat"].result, "applied");
  assert.equal(read(join(wt(desk, "feat"), "a.txt")), "laptop\n");
  for (const [m, device] of [[laptop, "macbook"], [web, "web"], [desk, "desk"]]) {
    assert.deepEqual(Object.values(await sync(m, device)).map((item) => item.result), ["unchanged", "unchanged"]);
    assert.deepEqual(await projectDesyncs(m.project), []);
  }
});

test("checkouts: a branch deleted on one machine is not brought back by another", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "old", wt(laptop, "old"));
  edit(join(wt(laptop, "old"), "o.txt"), "o\n");
  git(wt(laptop, "old"), "add", ".");
  git(wt(laptop, "old"), "commit", "-qm", "old work");
  await sync(laptop, "macbook");
  await sync(web, "web");
  git(laptop.app, "worktree", "remove", "--force", wt(laptop, "old"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  assert.equal(existsSync(wt(web, "old")), false);
  git(laptop.app, "branch", "-D", "old");
  for (let round = 0; round < 2; round++) {
    await sync(web, "web");
    await sync(laptop, "macbook");
  }
  assert.equal(git(laptop.app, "branch", "--list", "old"), "", "not recreated on the machine that deleted it");
  assert.equal(existsSync(wt(laptop, "old")), false);
  assert.equal(git(web.app, "branch", "--list", "old").trim(), "old", "the other machine keeps its own branch");
});

const remoteTip = (m, key) => git(m.app, "ls-remote", "origin", `refs/pi-checkouts/p1/${key}`).split("\t")[0];
const localRef = (m, kind, key) => { try { return git(m.app, "rev-parse", "--verify", "--quiet", `refs/${kind}/p1/${key}`); } catch { return ""; } };

test("checkouts: a theirs ref dropped by another process's stale listing still ends in a shared removal", async () => {
  const { laptop } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "gone", wt(laptop, "gone"));
  await sync(laptop, "macbook");
  const snapshot = remoteTip(laptop, "wt/gone");
  // What a pass that listed the remote before this key was pushed does to it.
  git(laptop.app, "update-ref", "-d", "refs/pi-checkouts-theirs/p1/wt/gone");
  git(laptop.app, "worktree", "remove", "--force", wt(laptop, "gone"));
  assert.equal((await sync(laptop, "macbook", { fetch: false }))["wt/gone"].result, "shared");
  const tip = remoteTip(laptop, "wt/gone");
  assert.match(git(laptop.app, "log", "-1", "--format=%B", tip), /^Removed: yes$/m);
  assert.equal(git(laptop.app, "log", "-1", "--format=%P", tip), snapshot);
});

test("checkouts: a new key shared by one pass keeps both local refs when a racing pass lost its theirs ref", async () => {
  const { laptop } = setup();
  await sync(laptop, "macbook");
  // Pass B shares a new key; pass A, which listed the remote before that push, drops the theirs ref and carries on.
  git(laptop.app, "worktree", "add", "-q", "-b", "fresh", wt(laptop, "fresh"));
  assert.equal((await sync(laptop, "macbook"))["wt/fresh"].result, "shared");
  git(laptop.app, "update-ref", "-d", "refs/pi-checkouts-theirs/p1/wt/fresh");
  assert.equal((await sync(laptop, "macbook", { fetch: false }))["wt/fresh"].result, "unchanged");
  const tip = remoteTip(laptop, "wt/fresh");
  assert.equal(localRef(laptop, "pi-checkouts", "wt/fresh"), tip);
  assert.equal(localRef(laptop, "pi-checkouts-theirs", "wt/fresh"), tip);
});

test("checkouts: a remote snapshot with no local record and no checkout is followed (re-created)", async () => {
  const { laptop, web } = setup();
  git(laptop.app, "worktree", "add", "-q", "-b", "merged", wt(laptop, "merged"));
  await sync(laptop, "macbook");
  await sync(web, "web");
  // Web lost its refs, then removed the worktree and deleted the merged branch.
  git(web.app, "update-ref", "-d", "refs/pi-checkouts/p1/wt/merged");
  git(web.app, "update-ref", "-d", "refs/pi-checkouts-theirs/p1/wt/merged");
  git(web.app, "worktree", "remove", "--force", wt(web, "merged"));
  git(web.app, "branch", "-q", "-D", "merged");
  assert.equal((await sync(web, "web", { fetch: false }))["wt/merged"], undefined, "share only: nothing to share");
  assert.equal((await sync(web, "web"))["wt/merged"].result, "created");
  assert.equal(existsSync(wt(web, "merged")), true);
});
