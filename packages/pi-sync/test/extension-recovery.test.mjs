import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BindingStore } from "../dist/src/bindings.js";
import extension from "../dist/extensions/sync.js";

const sessionEnvelope = {
  formatVersion: 1,
  sessionId: "session-1",
  piSessionVersion: 3,
  createdAt: "2026-01-01T00:00:00Z",
  parentSessionId: null,
  headEntryId: "a",
  title: "",
  entries: [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z" }],
};

test("explicitly repairs a missing server record from the local session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-extension-"));
  const sessionPath = join(root, "session.jsonl");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  let createCount = 0;
  let acquireCount = 0;
  try {
    await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: sessionEnvelope.createdAt })}\n${JSON.stringify(sessionEnvelope.entries[0])}\n`);
    process.env.PI_CODING_AGENT_DIR = root;
    await new BindingStore(root).set({
      nativeSessionId: "session-1",
      serverUrl: "http://sync.test",
      canonicalSessionId: "session-1",
      lastEtag: "old-etag",
      materializedFile: sessionPath,
      state: "setup_required",
    });

    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/lease/renew")) {
        return Response.json({ error: { code: "session_not_found", message: "not exposed" } }, { status: 404 });
      }
      if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/v1/sessions" && init.method === "POST") {
        createCount++;
        return Response.json({ formatVersion: 1, session: JSON.parse(init.body), etag: "new-etag" }, { status: 201 });
      }
      if (path.endsWith("/lease") && init.method === "POST") {
        acquireCount++;
        return Response.json({
          formatVersion: 1,
          session: sessionEnvelope,
          etag: "new-etag",
          lease: {
            token: "new-token",
            holder: "pi-test",
            acquiredAt: sessionEnvelope.createdAt,
            expiresAt: "2026-01-01T00:02:00Z",
          },
        });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };

    const handlers = new Map();
    const pi = {
      registerCommand(name, command) { handlers.set(`command:${name}`, command.handler); },
      on(name, handler) { handlers.set(name, handler); },
      exec: async () => ({ stdout: "", code: 1 }),
    };
    extension(pi);
    const ctx = {
      hasUI: true,
      cwd: root,
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => sessionPath,
        getSessionDir: () => root,
        getLeafId: () => "a",
        getSessionName: () => "",
      },
    };

    await handlers.get("session_start")({}, ctx);
    assert.equal((await new BindingStore(root).get("session-1")).state, "setup_required");
    assert.equal(acquireCount, 0);

    await handlers.get("command:sync")("attach", ctx);
    const repaired = await new BindingStore(root).get("session-1");
    assert.equal(repaired.state, "ready");
    assert.equal(repaired.lastEtag, "new-etag");
    assert.equal(repaired.leaseToken, undefined);
    assert.equal(createCount, 1);
    assert.equal(acquireCount, 0);

    await handlers.get("input")({}, ctx);
    const leased = await new BindingStore(root).get("session-1");
    assert.equal(leased.leaseToken, "new-token");
    assert.equal(acquireCount, 1);

    await handlers.get("session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
