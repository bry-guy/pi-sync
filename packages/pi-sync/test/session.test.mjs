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
