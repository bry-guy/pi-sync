// Real-Pi end-to-end checks: two isolated Pi homes in RPC mode, a real pi-syncd, and a fake LLM.
// Run with `PI_SYNC_E2E=1 npm run test:e2e` (needs `pi` and `go` on PATH).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const git = (cwd, ...args) => { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (error) { if (args[0] === "config") return ""; throw error; } };

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
/** Polls `read` until it deep-equals `expected` or 20 s pass, returning the last value for the assertion. */
const eventually = async (read, expected) => {
  let value;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(250)) {
    value = await read();
    if (JSON.stringify(value) === JSON.stringify(expected)) break;
  }
  return value;
};
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

test("a device can take over from one that is stuck mid-turn; the stuck reply is kept as a copy", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  const running = A.prompt("sleep6000 stuck");
  await sleep(800);
  B.answers.push(true); // confirm the take-over
  await B.prompt("took over");
  assert.deepEqual(await userTexts(B), ["one", "took over"]);
  await running;
  await sleep(4000); // A's upload is refused; its next background check catches up and keeps the reply aside
  assert.deepEqual(await userTexts(A), ["one", "took over"]);
  assert.equal(sessionFiles("A").length, 2, "A's stuck reply is saved as a separate copy");
  assert.ok(A.notes.some((note) => /took over/.test(note)));
  assert.ok(A.notes.some((note) => /“sleep6000 stuck.*\(unsynced copy\)”.*\/resume/.test(note) || /\(unsynced copy\)”. Open it with \/resume/.test(note)), "the copy is named and findable");
  await A.prompt("back on A");
  await sleep(2500);
  assert.deepEqual(await userTexts(B), ["one", "took over", "back on A"]);
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

test("a turn whose upload was lost to a server outage uploads once the server is back", { ...opts, timeout: 120_000 }, async () => {
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
  // Nobody else moved on, so A's background retry must upload the lost turn before B continues.
  await sleep(2500);
  await B.prompt("b moved on");
  await A.prompt("a again");
  const expected = ["one", "sleep1500 lost upload", "b moved on", "a again"];
  // A catches up and replays "a again"; under load that outlasts the prompt call, so wait for it rather than sample once.
  assert.deepEqual(await eventually(() => userTexts(A), expected), expected);
  assert.deepEqual(await eventually(() => userTexts(B), expected), expected);
  assert.equal(sessionFiles("A").length, 1, "the lost turn is uploaded, not saved aside");
});

test("a server restart mid-turn is not reported as a take-over, and the turn still uploads", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  const turn = A.prompt("sleep2500 across restart");
  await sleep(700);
  await stopDaemon();
  await startDaemon(join(caseDir, "data")); // leases live in memory, so A's token is gone
  await turn;
  await sleep(500);
  assert.ok(!A.notes.some((note) => /took over/.test(note)), `no take-over warning: ${JSON.stringify(A.notes)}`);
  const expected = ["one", "sleep2500 across restart"];
  assert.deepEqual(await eventually(() => userTexts(B), expected), expected);
  assert.equal(sessionFiles("A").length, 1, "no separate copy");
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
  // If A was behind, the attempt is cancelled, A catches up, and compaction reruns by itself.
  if (!compacted.success) assert.ok(A.notes.some((note) => /then compacting/.test(note)), JSON.stringify(compacted));
  await sleep(4000);
  const aEntries = (await A.cmd({ type: "get_entries" })).data.entries;
  const at = (predicate) => aEntries.findIndex(predicate);
  assert.ok(at((entry) => entry.type === "compaction") > at((entry) => JSON.stringify(entry.message?.content ?? "").includes("two")), "A compacted after catching up with B's turn");
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

test("uncommitted and unpushed code follows the conversation when sharing is enabled", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  const a = join(caseDir, "git", "a"), b = join(caseDir, "git", "b");
  writeFileSync(join(a, "committed.txt"), "local commit\n");
  git(a, "add", "committed.txt");
  git(a, "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-q", "-m", "unpushed");
  writeFileSync(join(a, "new.txt"), "untracked work\n");
  writeFileSync(join(a, ".gitignore"), "secret.env\n");
  writeFileSync(join(a, "secret.env"), "TOKEN=1\n");
  A.answers.push(true); // share uncommitted code for this repository
  await A.prompt("two");
  assert.equal(git(a, "config", "--get", "pi-sync.shareWorkingTree"), "true");
  assert.match(git(a, "status", "--porcelain"), /\?\? new\.txt/, "A's own index and worktree are untouched");
  await sleep(4000);
  assert.match(git(join(caseDir, "git", "origin.git"), "for-each-ref", "refs/pi-sync/"), /refs\/pi-sync\//, "the snapshot is on a hidden ref, not a branch");
  assert.ok(B.notes.some((note) => /\/sync code/.test(note)), "B is told its checkout lacks the conversation's code");

  writeFileSync(join(b, "scratch.txt"), "mine\n");
  B.answers.push(true);
  await B.prompt("/sync code");
  assert.match(B.notes.at(-1), /uncommitted changes/, "local work is never overwritten");
  rmSync(join(b, "scratch.txt"));

  B.answers.push(true);
  await B.prompt("/sync code");
  assert.match(B.notes.at(-1), /Restored main/);
  assert.equal(git(b, "rev-parse", "HEAD"), git(a, "rev-parse", "HEAD"));
  assert.equal(readFileSync(join(b, "new.txt"), "utf8"), "untracked work\n");
  assert.match(git(b, "status", "--porcelain"), /\?\? new\.txt/, "restored work stays uncommitted");
  assert.throws(() => statSync(join(b, "secret.env")), "ignored files are never shared");
});

test("starting pi on another device warns which clients the conversation is on", { ...opts, timeout: 90_000 }, async () => {
  const A = peer("A");
  await ready(A);
  await A.prompt("from A");
  await A.prompt("/sync attach");
  const B = peer("B");
  await sleep(4000);
  const warning = B.notes.find((note) => note.includes("is synchronized on other clients"));
  assert.ok(warning, `B warned on start: ${JSON.stringify(B.notes)}`);
  assert.match(warning, /: A\b/, "the warning names the client the conversation is on");
  assert.doesNotMatch(warning, /\bB\b/, "and not this client");
  assert.deepEqual(await userTexts(B), [], "nothing was opened without asking");
});

test("sending anyway while the server is down uploads the turn once it is back", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  await stopDaemon();
  A.answers.push(true); // send anyway
  await A.prompt("written offline");
  assert.ok((await userTexts(A)).includes("written offline"));
  await startDaemon(join(caseDir, "data"));
  await sleep(5000);
  assert.deepEqual(await userTexts(B), ["one", "written offline"]);
  assert.equal(sessionFiles("A").length, 1, "no copy when nobody else moved on");
});

test("code: auto shares without asking, and a failed push is retried on a later turn", { ...opts, timeout: 120_000 }, async () => {
  const A = peer("A", "a", { PI_SYNC_CODE: "auto" });
  await ready(A);
  await A.prompt("one");
  await A.prompt("/sync attach");
  const a = join(caseDir, "git", "a"), origin = join(caseDir, "git", "origin.git");
  writeFileSync(join(a, "wip.txt"), "work\n");
  renameSync(origin, origin + ".away"); // the remote is unreachable
  await A.prompt("two");
  await sleep(1500);
  assert.ok(A.notes.some((note) => /will retry/.test(note)), `told the push will be retried: ${JSON.stringify(A.notes)}`);
  assert.equal(git(a, "config", "--get", "pi-sync.shareWorkingTree"), "", "auto never stored a per-repository answer");
  renameSync(origin + ".away", origin);
  await A.prompt("three");
  await sleep(1500);
  assert.match(git(origin, "for-each-ref", "refs/pi-sync/"), /refs\/pi-sync\//, "the snapshot reached the remote");
});

test("allSessions synchronizes a conversation after its first reply", { ...opts, timeout: 90_000 }, async () => {
  const A = peer("A", "a", { PI_SYNC_ALL_SESSIONS: "on" });
  await ready(A);
  await A.prompt("never attached");
  await sleep(1500);
  const B = peer("B");
  await ready(B);
  B.answers.push((options) => options[0]);
  await B.prompt("/sync");
  await sleep(500);
  assert.deepEqual(await userTexts(B), ["never attached"]);
});

test("the agent is told which machine it runs on and when the conversation moved", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  const reply = async (pi) => (await pi.messages()).filter((m) => m.role === "assistant").map((m) => typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("")).at(-1);
  await B.prompt("whereami");
  assert.match(await reply(B), /runs on "B"/);
  assert.doesNotMatch(await reply(B), /previous turn ran/, "A's first turn predates any marker");
  await sleep(2500);
  await A.prompt("whereami");
  assert.match(await reply(A), /runs on "A".*previous turn ran on "B"/);
  await A.prompt("whereami");
  assert.doesNotMatch(await reply(A), /previous turn ran/, "no move, no warning");
});

test("a conversation deleted for inactivity starts a new synchronized chat, with a warning", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  const [{ sessionId: old }] = (await (await fetch(`${process.env.SYNC_URL}/v1/sessions`)).json()).sessions;
  // What the retention sweep does: entries removed, a tombstone keeps the id.
  await stopDaemon();
  const sessions = join(caseDir, "data", "sessions");
  for (const name of readdirSync(sessions)) if (name.includes(old)) rmSync(join(sessions, name));
  writeFileSync(join(sessions, `.${old}.deleted`), JSON.stringify({ deletedAt: new Date().toISOString() }));
  await startDaemon(join(caseDir, "data"));

  await A.prompt("after deletion");
  await sleep(2500);
  assert.ok(A.notes.some((note) => /history was deleted/.test(note)), `A warned: ${JSON.stringify(A.notes)}`);
  assert.deepEqual(await userTexts(A), ["after deletion"], "A is in a new chat that starts with the prompt");
  const listed = (await (await fetch(`${process.env.SYNC_URL}/v1/sessions`)).json()).sessions;
  assert.equal(listed.length, 1, "the new chat is synchronized");
  assert.notEqual(listed[0].sessionId, old);
  assert.equal(sessionFiles("A").length, 2, "the old local copy is kept");
  assert.ok(B.notes.some((note) => /history was deleted/.test(note)), `idle B warned: ${JSON.stringify(B.notes)}`);
  const usage = (await (await fetch(`${process.env.SYNC_URL}/v1/usage`)).json()).rows;
  assert.ok(Array.isArray(usage), "usage is served");
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("images survive the trip to another device", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await A.prompt("look at this", { images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
  await sleep(2500);
  const message = (await B.messages()).find((m) => m.role === "user" && JSON.stringify(m.content).includes("look at this"));
  assert.ok(message, "B caught up with the image prompt");
  assert.ok(message.content.some((part) => part.type === "image" && part.data === PNG), "the image bytes are identical");
});

test("automatic compaction during a turn syncs like the turn", { ...opts, timeout: 120_000 }, async () => {
  const A = peer("A", "a", { PI_E2E_CONTEXT_WINDOW: "20000" }), B = peer("B");
  await ready(A);
  await A.prompt("one");
  await A.prompt("/sync attach");
  await ready(B);
  B.answers.push((options) => options[0]);
  await B.prompt("/sync");
  await sleep(300);
  // The fake model reports 19000 prompt tokens, crossing A's threshold, so Pi compacts after this turn.
  await A.prompt("two usage19000");
  await sleep(4000);
  const aEntries = (await A.cmd({ type: "get_entries" })).data.entries;
  assert.ok(aEntries.some((entry) => entry.type === "compaction"), "A compacted automatically");
  const bEntries = (await B.cmd({ type: "get_entries" })).data.entries;
  assert.ok(bEntries.some((entry) => entry.type === "compaction"), "B received the automatic compaction");
  await B.prompt("three");
  await sleep(2500);
  assert.equal((await userTexts(A)).at(-1), "three");
  assert.equal(sessionFiles("A").length, 1, "no spurious copy");
});

// Mimics an older pi-sync process rewriting the shared bindings file without this conversation.
const eraseBindings = (name) => writeFileSync(join(caseDir, `agent${name}`, "sync-bindings.json"), JSON.stringify({ version: 1, bindings: [] }));

test("erased bindings reconnect, mid-session and after a restart", { ...opts, timeout: 150_000 }, async () => {
  const { A, B } = await handoff();
  await A.prompt("a two");
  await sleep(1500);
  eraseBindings("A");
  await B.prompt("b three");
  await sleep(500);
  await A.prompt("a four");
  await sleep(2500);
  assert.deepEqual(await userTexts(A), ["one", "a two", "b three", "a four"]);
  assert.deepEqual(await userTexts(B), ["one", "a two", "b three", "a four"]);
  await A.stop();
  peers.splice(peers.indexOf(A), 1);
  eraseBindings("A");
  await B.prompt("b five");
  await sleep(500);
  const A2 = new Pi("A", { cwd: join(caseDir, "git", "a"), agentDir: join(caseDir, "agentA"), args: ["-c"] });
  peers.push(A2);
  await sleep(4000);
  assert.deepEqual(await userTexts(A2), ["one", "a two", "b three", "a four", "b five"]);
  await A2.prompt("a six");
  await sleep(2500);
  assert.equal((await userTexts(B)).at(-1), "a six");
  assert.equal(sessionFiles("A").length, 1, "no unsynced copy");
});

test("a detached conversation stays detached after the bindings file is lost", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  await A.prompt("/sync detach");
  await A.stop();
  peers.splice(peers.indexOf(A), 1);
  eraseBindings("A");
  await B.prompt("b two");
  const A2 = new Pi("A", { cwd: join(caseDir, "git", "a"), agentDir: join(caseDir, "agentA"), args: ["-c"] });
  peers.push(A2);
  await sleep(4000);
  await A2.prompt("/sync status");
  assert.match(A2.notes.at(-1), /not synchronized/);
  assert.deepEqual(await userTexts(A2), ["one"]);
  assert.equal(JSON.parse(readFileSync(join(caseDir, "agentA", "sync-bindings.json"), "utf8")).bindings.length, 0);
});

test("catching up keeps this device's model and thinking level", { ...opts, timeout: 90_000 }, async () => {
  const { A, B } = await handoff();
  await B.cmd({ type: "set_model", provider: "fake", modelId: "other" });
  await B.cmd({ type: "set_thinking_level", level: "high" });
  await B.prompt("two from the other model");
  await sleep(2500);
  assert.deepEqual(await userTexts(A), ["one", "two from the other model"], "A caught up");
  const state = await A.state();
  assert.equal(state.model?.id, "echo", "A keeps its model");
  assert.notEqual(state.thinkingLevel, "high", "A keeps its thinking level");
  await A.prompt("three");
  await sleep(2500);
  assert.equal((await B.state()).model?.id, "other", "B keeps its model too");
  assert.equal(sessionFiles("A").length, 1);
});

test("idle devices, including restarts, stop uploading", { ...opts, timeout: 120_000 }, async () => {
  const { A, B } = await handoff();
  await A.cmd({ type: "set_thinking_level", level: "high" });
  await B.prompt("two");
  await sleep(3000);
  const etag = async () => (await (await fetch(`${process.env.SYNC_URL}/v1/sessions`)).json()).sessions[0].etag;
  const settled = await etag();
  let current = B;
  for (let round = 0; round < 2; round++) {
    await current.stop();
    peers.splice(peers.indexOf(current), 1);
    current = new Pi("B", { cwd: join(caseDir, "git", "b"), agentDir: join(caseDir, "agentB"), args: ["-c"] });
    peers.push(current);
    await ready(current);
    await sleep(4000);
  }
  assert.equal(await etag(), settled, "nothing was uploaded while both devices sat idle");
  assert.deepEqual(await userTexts(A), ["one", "two"]);
});

test("a 40 MB conversation syncs, and each turn sends only what it added", { ...opts, timeout: 240_000 }, async () => {
  // Observational-memory style: thousands of large custom entries that never reach the model.
  const dir = join(caseDir, "agentA", "sessions", "big");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "big.jsonl");
  const sessionId = "01a1b000-0000-7000-8000-000000000001";
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-01T00:00:00.000Z", cwd: join(caseDir, "git", "a") })];
  let parent = null;
  const pad = "o".repeat(20_000);
  for (let i = 0; i < 2000; i++) {
    const id = `om${String(i).padStart(6, "0")}`;
    lines.push(JSON.stringify({ type: "custom", customType: "om.observations.recorded", data: { text: pad, i }, id, parentId: parent, timestamp: "2026-10-01T00:00:01.000Z" }));
    parent = id;
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  const A = new Pi("A", { cwd: join(caseDir, "git", "a"), agentDir: join(caseDir, "agentA"), args: ["--session", file] });
  peers.push(A);
  await ready(A);
  await A.prompt("one");
  let started = Date.now();
  await A.prompt("/sync attach");
  assert.match(A.notes.at(-1), /synchronized/i, A.notes.at(-1));
  const attachMs = Date.now() - started;

  const B = peer("B");
  await ready(B);
  B.answers.push((options) => options[0]);
  started = Date.now();
  await B.prompt("/sync");
  await sleep(300);
  const openMs = Date.now() - started;
  assert.deepEqual(await userTexts(B), ["one"]);

  const turns = [];
  for (const [who, text] of [[B, "two"], [A, "three"], [B, "four"]]) {
    started = Date.now();
    await who.prompt(text);
    turns.push(Date.now() - started);
  }
  await sleep(2500);
  assert.deepEqual(await userTexts(A), ["one", "two", "three", "four"]);
  assert.deepEqual(await userTexts(B), ["one", "two", "three", "four"]);
  const stored = readdirSync(join(caseDir, "data", "sessions"));
  assert.ok(stored.some((name) => name.endsWith(".log")), "stored as an append-only log");
  const binding = JSON.parse(readFileSync(join(caseDir, "agentB", "sync-bindings.json"), "utf8")).bindings[0];
  assert.ok(binding.syncedCount > 2000, "B records how much it has synchronized");
  console.log(`# 40 MB: attach ${attachMs} ms, open on B ${openMs} ms, turns incl. catch-up ${turns.join(" / ")} ms`);
});
