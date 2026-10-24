import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveRepositoryIdentity, deriveWorkspacePointer, materializeNativeJsonl, normalizeNativeJsonl, repositoryIdentity, restoreHead } from "../dist/src/session/index.js";

test("normalizes and materializes a portable Pi JSONL session", async () => {
  const native = [
    JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/laptop/project", parentSession: "/laptop/parent.jsonl" }),
    JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "future_entry", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z", custom: { keep: true } }),
  ].join("\n") + "\n";
  const envelope = await normalizeNativeJsonl(native, {
    requestedSessionId: "session-1",
    headEntryId: "a",
    resolveParentSessionId: (path) => path.endsWith("parent.jsonl") ? "parent-1" : null,
  });
  assert.equal(envelope.parentSessionId, "parent-1");
  assert.equal(envelope.headEntryId, "a");
  assert.equal(envelope.entries[1].type, "future_entry");
  const output = materializeNativeJsonl(envelope, { cwd: "/web/workspace" });
  const header = JSON.parse(output.split("\n")[0]);
  assert.equal(header.cwd, "/web/workspace");
  assert.equal(header.parentSession, undefined);
  assert.equal(JSON.parse(output.split("\n")[2]).custom.keep, true);
});

test("derives only the pushed upstream workspace pointer", async () => {
  const calls = [];
  const workspace = await deriveWorkspacePointer("/work", async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "origin/feature/example\n", code: 0 };
    if (args[0] === "remote") return { stdout: "git@github.com:owner/repo.git\n", code: 0 };
    return { stdout: "0123456789abcdef0123456789abcdef01234567\n", code: 0 };
  });
  assert.deepEqual(workspace, {
    gitRemote: "git@github.com:owner/repo.git",
    branch: "feature/example",
    commit: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(calls.length, 3);
});

test("normalizes equivalent Git remote forms to one repository identity", () => {
  assert.equal(repositoryIdentity("git@github.com:owner/repo.git"), "github.com/owner/repo");
  assert.equal(repositoryIdentity("https://user:secret@github.com/owner/repo.git?token=secret"), "github.com/owner/repo");
  assert.notEqual(repositoryIdentity("https://github.com/owner/repo.git"), repositoryIdentity("https://github.com/other/repo.git"));
});

test("derives a repository identity when the current branch has no upstream", async () => {
  const workspace = await deriveRepositoryIdentity("/work", async (_command, args) => {
    if (args[0] === "rev-parse") return { stdout: "", code: 1 };
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") return { stdout: "https://github.com/owner/repo.git\n", code: 0 };
    return { stdout: "", code: 1 };
  });
  assert.equal(workspace, "github.com/owner/repo");
});

test("falls back to the first Git remote when origin is unavailable", async () => {
  const repository = await deriveRepositoryIdentity("/work", async (_command, args) => {
    if (args[0] === "rev-parse") return { stdout: "", code: 1 };
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") return { stdout: "", code: 2 };
    if (args[0] === "remote" && args.length === 1) return { stdout: "upstream\n", code: 0 };
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "upstream") return { stdout: "git@github.com:owner/repo.git\n", code: 0 };
    return { stdout: "", code: 1 };
  });
  assert.equal(repository, "github.com/owner/repo");
});

test("restores the canonical head through Pi navigation", async () => {
  const calls = [];
  await restoreHead(async (id, options) => {
    calls.push({ id, options });
    return { cancelled: false };
  }, "head");
  assert.deepEqual(calls, [{ id: "head", options: { summarize: false } }]);
});

test("appending to a session file matches a full rewrite and refuses a file that is not as expected", async () => {
  const { appendSessionFile, materializeSessionFile, nativeHeaderLine } = await import("../dist/src/session/index.js");
  const { mkdtemp, readFile, writeFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-append-"));
  const entry = (id, parentId) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `text ${id} "quoted"\nline` } });
  const all = [entry("a", null), entry("b", "a"), entry("c", "b"), entry("d", "c")];
  const envelope = (entries) => ({ formatVersion: 1, sessionId: "s", piSessionVersion: 3, createdAt: "2026-01-01T00:00:00Z", parentSessionId: null, headEntryId: entries.at(-1).id, title: "", entries });
  const options = { cwd: dir };
  const headerLine = nativeHeaderLine(envelope(all), options);
  const fast = join(dir, "fast.jsonl");
  const full = join(dir, "full.jsonl");
  await materializeSessionFile(fast, envelope(all.slice(0, 2)), options);
  await materializeSessionFile(full, envelope(all), options);
  assert.equal(await appendSessionFile(fast, { headerLine, count: 2, lastId: "b" }, all.slice(2)), true);
  assert.equal(await readFile(fast, "utf8"), await readFile(full, "utf8"), "byte-identical to a full rewrite");

  const before = await readFile(fast, "utf8");
  const refuse = async (expected, label) => assert.equal(await appendSessionFile(fast, expected, [entry("e", "d")]), false, label);
  await refuse({ headerLine, count: 3, lastId: "c" }, "wrong count");
  await refuse({ headerLine, count: 4, lastId: "x" }, "wrong last id");
  await refuse({ headerLine: nativeHeaderLine(envelope(all), { cwd: "/elsewhere" }), count: 4, lastId: "d" }, "different header");
  await writeFile(fast, before.slice(0, -5));
  await refuse({ headerLine, count: 4, lastId: "d" }, "truncated last line");
  await writeFile(fast, before);
  assert.equal(await appendSessionFile(join(dir, "missing.jsonl"), { headerLine, count: 0, lastId: "" }, []), false, "missing file");
  assert.equal(await readFile(fast, "utf8"), before, "refusals leave the file untouched");
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".tmp-")), [], "no temporary files left");
});

test("model and thinking switches are shared only as placeholders", async () => {
  const native = [
    JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "thinking_level_change", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:01Z", thinkingLevel: "high" }),
    JSON.stringify({ type: "model_change", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:01Z", provider: "x", modelId: "y" }),
  ].join("\n");
  const { entries } = await normalizeNativeJsonl(native);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.parentId, entry.type]), [["a", null, "message"], ["b", "a", "custom"], ["c", "b", "custom"]]);
  assert.equal(entries[1].thinkingLevel, undefined);
});
