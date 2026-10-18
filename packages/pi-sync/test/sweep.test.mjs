import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepSnapshots } from "../dist/src/session/code.js";

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

test("sweep deletes snapshot refs of conversations the server no longer has, once a day", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  g(root, "init", "-q", "--bare", "remote.git");
  g(root, "init", "-q", "work");
  const work = join(root, "work");
  g(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  g(work, "remote", "add", "origin", join(root, "remote.git"));
  for (const id of ["live", "gone"]) g(work, "push", "-q", "origin", `HEAD:refs/pi-sync/${id}`), g(work, "update-ref", `refs/pi-sync/${id}`, "HEAD");
  assert.equal(await sweepSnapshots(work, new Set(["live"]), 1000), 1);
  assert.deepEqual(g(work, "ls-remote", "origin", "refs/pi-sync/*").split("\n").map((l) => l.split("\t")[1]), ["refs/pi-sync/live"]);
  assert.equal(g(work, "for-each-ref", "--format=%(refname)", "refs/pi-sync"), "refs/pi-sync/live");
  assert.equal(await sweepSnapshots(work, new Set(), 2000), 0, "throttled within a day");
});
