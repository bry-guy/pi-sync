// Real-Pi end-to-end checks: two isolated Pi homes in RPC mode, a real pi-syncd, and a fake LLM.
// Run with `PI_SYNC_E2E=1 npm run test:e2e` (needs `pi` and `go` on PATH).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pi, sleep } from "./rpc.mjs";

const enabled = process.env.PI_SYNC_E2E === "1";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const SYNC_PORT = 18180;
const LLM_PORT = 18181;
process.env.SYNC_URL = `http://127.0.0.1:${SYNC_PORT}`;
process.env.FAKE_LLM_PORT = String(LLM_PORT);

let root, daemonBin, daemon, llm, peers = [];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

const startDaemon = async (dataDir) => {
  daemon = spawn(daemonBin, [], { env: { ...process.env, PI_SYNC_LISTEN: `127.0.0.1:${SYNC_PORT}`, PI_SYNC_DATA_DIR: dataDir }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${process.env.SYNC_URL}/v1/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("pi-syncd did not start");
};
const stopDaemon = () => new Promise((resolve) => { if (!daemon || daemon.exitCode !== null) return resolve(); daemon.once("exit", resolve); daemon.kill(); });

let caseDir;
const peer = (name, sub = name.toLowerCase(), env = {}) => {
  const pi = new Pi(name, { cwd: join(caseDir, "git", sub), agentDir: join(caseDir, `agent${name}`), env });
  peers.push(pi);
  return pi;
};
const userTexts = async (pi) => (await pi.messages()).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const sessionFiles = (name) => {
  const dir = join(caseDir, `agent${name}`, "sessions");
  try {
    return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  } catch {
    return [];
  }
};
const ready = (pi) => pi.waitEvent(() => false, 2500).catch(() => undefined);

before(async () => {
  if (!enabled) return;
  root = mkdtempSync(join(tmpdir(), "pi-sync-e2e-"));
  daemonBin = join(root, "pi-syncd");
  execFileSync("go", ["build", "-o", daemonBin, "./cmd/pi-syncd"], { cwd: repoRoot });
  llm = spawn(process.execPath, [fileURLToPath(new URL("./fake-llm.mjs", import.meta.url))], { env: { ...process.env }, stdio: "ignore" });
});

beforeEach(async () => {
  if (!enabled) return;
  for (const p of peers) await p.stop();
  peers = [];
  await stopDaemon();
  caseDir = mkdtempSync(join(root, "case-"));
  const g = join(caseDir, "git");
  execFileSync("mkdir", ["-p", g]);
  git(g, "init", "-q", "--bare", "origin.git");
  git(g, "clone", "-q", "origin.git", "a");
  git(join(g, "a"), "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init");
  git(join(g, "a"), "push", "-q", "-u", "origin", "HEAD:main");
  git(g, "clone", "-q", "origin.git", "b");
  await startDaemon(join(caseDir, "data"));
});

after(async () => {
  if (!enabled) return;
  for (const p of peers) await p.stop();
  await stopDaemon();
  llm?.kill();
  rmSync(root, { recursive: true, force: true });
});

const opts = { skip: !enabled && "set PI_SYNC_E2E=1 to run real-Pi end-to-end checks" };

/** A attaches, B opens it through the picker. */
const handoff = async () => {
  const A = peer("A"), B = peer("B");
  await ready(A);
  await A.prompt("one");
  await A.prompt("/sync attach");
  await ready(B);
  B.answers.push((options) => options[0]);
  await B.prompt("/sync");
  await sleep(300);
  return { A, B };
};

test("switching devices and typing immediately catches up and sends the prompt", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  assert.deepEqual(await userTexts(B), ["one"]);
  await B.prompt("two");
  assert.equal(await A.prompt("three"), "handled"); // replayed after catching up
  assert.deepEqual(await userTexts(A), ["one", "two", "three"]);
  await B.prompt("four");
  assert.deepEqual(await userTexts(B), ["one", "two", "three", "four"]);
  assert.equal(sessionFiles("A").length, 1);
  assert.equal(sessionFiles("B").length, 1);
});

test("an idle device follows remote turns in the background", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await B.prompt("two");
  await sleep(2500);
  assert.deepEqual(await userTexts(A), ["one", "two"]);
  assert.equal(sessionFiles("A").length, 1);
});

test("simultaneous use is blocked with the prompt restored, then works once the other device is done", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  const running = A.prompt("sleep2500 long");
  await sleep(600);
  assert.equal(await B.prompt("during"), "handled");
  assert.match(B.notes.at(-1), /running on A/);
  assert.equal(B.editorText, "during");
  await running;
  await B.prompt("after");
  assert.deepEqual(await userTexts(B), ["one", "sleep2500 long", "after"]);
});

test("idle model/thinking changes never wedge synchronization", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await A.cmd({ type: "set_thinking_level", level: "high" });
  await A.cmd({ type: "set_session_name", name: "renamed on A" });
  await B.prompt("two");
  await A.prompt("three");
  assert.deepEqual(await userTexts(A), ["one", "two", "three"]);
  assert.equal((await A.state()).sessionName, "renamed on A", "idle local changes are carried, not dropped");
  await B.prompt("four");
  assert.deepEqual(await userTexts(B), ["one", "two", "three", "four"]);
  assert.equal((await B.state()).sessionName, "renamed on A");
  assert.equal(sessionFiles("A").length, 1, "no spurious unsynced copy");
});

test("turns made while the server was down upload later, or fork if someone else moved on", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  await stopDaemon();
  await A.prompt("offline-ish"); // lease held at input? no: acquisition fails, so prompt is refused
  assert.match(A.notes.at(-1), /unreachable/);
  assert.equal(A.editorText, "offline-ish");
  await startDaemon(join(caseDir, "data"));

  // Lose the upload: the turn starts with the lease, the server dies before settle.
  const turn = A.prompt("sleep1500 lost upload");
  await sleep(500);
  await stopDaemon();
  await turn;
  await startDaemon(join(caseDir, "data"));
  await B.prompt("b moved on");
  await A.prompt("a again");
  const texts = await userTexts(A);
  assert.deepEqual(texts, ["one", "b moved on", "a again"]);
  assert.equal(sessionFiles("A").length, 2, "the unsynced local turn is kept as a separate session");
});

test("a crashed mid-turn device does not hold the conversation after restart", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  A.prompt("sleep5000 crash").catch(() => undefined);
  await sleep(700);
  await A.stop("SIGKILL");
  const A3 = new Pi("A", { cwd: join(caseDir, "git", "a"), agentDir: join(caseDir, "agentA"), args: ["-c"] });
  peers.push(A3);
  await ready(A3);
  await B.prompt("b after crash");
  assert.deepEqual((await userTexts(B)).at(-1), "b after crash");
});

test("a conversation started on an unpushed branch keeps syncing after push", { ...opts, timeout: 90_000 }, async () => {
  const a = join(caseDir, "git", "a");
  git(a, "checkout", "-q", "-b", "feature");
  const A = peer("A");
  await ready(A);
  await A.prompt("on feature");
  await A.prompt("/sync attach");
  git(a, "push", "-q", "-u", "origin", "feature");
  await A.prompt("after push");
  const B = peer("B");
  await ready(B);
  B.answers.push((options) => options[0]);
  await B.prompt("/sync");
  await sleep(300);
  assert.deepEqual(await userTexts(B), ["on feature", "after push"]);
});

test("picking a conversation this device already has reuses its file", { ...opts, timeout: 90_000 }, async () => {
  const { B } = await handoff();
  await B.prompt("two");
  await B.cmd({ type: "new_session" });
  B.answers.push((options) => options.find((o) => o.includes("on this device")));
  await B.prompt("/sync");
  await sleep(300);
  assert.deepEqual(await userTexts(B), ["one", "two"]);
  assert.equal(sessionFiles("B").length, 1);
  const state = await B.state();
  assert.ok(statSync(state.sessionFile));
});

test("manual compaction syncs like a turn", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await B.prompt("two");
  const compacted = await A.cmd({ type: "compact" });
  if (process.env.PI_SYNC_E2E_VERBOSE) console.log("compact", JSON.stringify(compacted));
  // The first attempt may be cancelled while A catches up; the second must succeed.
  if (!compacted.success) {
    await sleep(1500);
    assert.ok((await A.cmd({ type: "compact" })).success);
  }
  await sleep(2500);
  const entries = (await B.cmd({ type: "get_entries" })).data.entries;
  assert.ok(entries.some((entry) => entry.type === "compaction"), "B received the compaction");
  await B.prompt("three");
  assert.equal((await userTexts(B)).at(-1), "three");
});

test("a server that lost the conversation is repaired with /sync attach", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  const sessionsDir = join(caseDir, "data", "sessions");
  for (const file of readdirSync(sessionsDir)) rmSync(join(sessionsDir, file));
  assert.equal(await A.prompt("lost"), "handled");
  assert.match(A.notes.at(-1), /\/sync attach/);
  await A.prompt("/sync attach");
  await A.prompt("restored");
  await B.prompt("b continues");
  assert.deepEqual(await userTexts(B), ["one", "restored", "b continues"]);
});

test("detach then attach adopts the server copy without duplicates", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await A.prompt("/sync detach");
  await B.prompt("two");
  await A.prompt("/sync attach");
  await sleep(500);
  assert.deepEqual(await userTexts(A), ["one", "two"]);
  await A.prompt("three");
  await sleep(2500);
  assert.deepEqual(await userTexts(B), ["one", "two", "three"]);
});

test("resuming an older copy of the file catches up instead of rolling the conversation back", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  const { copyFileSync } = await import("node:fs");
  const file = (await A.state()).sessionFile;
  copyFileSync(file, `${file}.old`);
  await B.prompt("two");
  await sleep(2500);
  await A.stop();
  copyFileSync(`${file}.old`, file); // A's file is now behind the canonical copy
  rmSync(`${file}.old`);
  const A2 = new Pi("A", { cwd: join(caseDir, "git", "a"), agentDir: join(caseDir, "agentA"), args: ["-c"] });
  peers.push(A2);
  await sleep(3000);
  await A2.prompt("three");
  assert.deepEqual(await userTexts(A2), ["one", "two", "three"]);
  await sleep(2500);
  assert.deepEqual(await userTexts(B), ["one", "two", "three"]);
});
