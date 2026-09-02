import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BindingStore } from "../dist/src/bindings.js";
import extension from "../dist/extensions/sync.js";

const baseEnvelope = {
  formatVersion: 1,
  sessionId: "session-1",
  piSessionVersion: 3,
  createdAt: "2026-01-01T00:00:00Z",
  parentSessionId: null,
  headEntryId: "a",
  title: "",
  entries: [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z" }],
};

const compactionEntry = {
  type: "compaction",
  id: "c1",
  parentId: "a",
  timestamp: "2026-01-01T00:00:02Z",
  summary: "The earlier conversation was summarized.",
  firstKeptEntryId: "a",
  tokensBefore: 100,
  details: {},
  usage: {},
  fromHook: false,
};

async function harness(fetch, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-compaction-"));
  const sessionPath = join(root, "session.jsonl");
  const header = { type: "session", version: 3, id: baseEnvelope.sessionId, timestamp: baseEnvelope.createdAt };
  let entries = [...(options.entries || baseEnvelope.entries)];
  let headEntryId = options.headEntryId ?? entries.at(-1)?.id ?? "";
  const writeSession = () => writeFile(sessionPath, `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeSession();

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousServerUrl = process.env.PI_SYNC_SERVER_URL;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = root;
  if (options.serverUrl) process.env.PI_SYNC_SERVER_URL = options.serverUrl;
  else delete process.env.PI_SYNC_SERVER_URL;
  globalThis.fetch = fetch;

  const handlers = new Map();
  const notices = [];
  const statuses = [];
  const pi = {
    registerCommand(name, command) { handlers.set(`command:${name}`, command.handler); },
    on(name, handler) { handlers.set(name, handler); },
    exec: async () => ({ stdout: "", code: 1 }),
  };
  extension(pi);
  const ctx = {
    ...(options.mode ? { mode: options.mode } : {}),
    hasUI: true,
    cwd: root,
    ui: {
      confirm: async () => true,
      notify: (message) => notices.push(message),
      setStatus: (_id, text) => statuses.push(text),
    },
    sessionManager: {
      getSessionId: () => baseEnvelope.sessionId,
      getSessionFile: () => sessionPath,
      getSessionDir: () => root,
      getLeafId: () => headEntryId,
      getSessionName: () => "",
      getEntries: () => entries,
    },
  };
  return {
    root,
    sessionPath,
    handlers,
    ctx,
    notices,
    statuses,
    store: new BindingStore(root),
    async binding() { return new BindingStore(root).get(baseEnvelope.sessionId); },
    async setEntries(next, head = next.at(-1)?.id ?? "") {
      entries = [...next];
      headEntryId = head;
      await writeSession();
    },
    async close() {
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousServerUrl === undefined) delete process.env.PI_SYNC_SERVER_URL;
      else process.env.PI_SYNC_SERVER_URL = previousServerUrl;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function responseForLease(token = "token-1", etag = "e1") {
  return Response.json({
    formatVersion: 1,
    session: baseEnvelope,
    etag,
    lease: {
      token,
      holder: "pi-test",
      acquiredAt: baseEnvelope.createdAt,
      expiresAt: "2026-01-01T00:02:00Z",
    },
  });
}

function responseForUpdate(session, etag = "e2") {
  return Response.json({ formatVersion: 1, session, etag });
}

function requestRecord(url, init = {}) {
  return {
    path: new URL(url).pathname,
    method: init.method,
    body: init.body ? JSON.parse(init.body) : undefined,
  };
}

async function bind(fake) {
  await fake.store.set({
    nativeSessionId: baseEnvelope.sessionId,
    serverUrl: "http://sync.test",
    canonicalSessionId: baseEnvelope.sessionId,
    lastEtag: "e1",
    lastFingerprint: JSON.stringify(baseEnvelope),
    materializedFile: fake.sessionPath,
    state: "ready",
  });
  await fake.handlers.get("session_start")({}, fake.ctx);
}

test("manual compaction acquires, uploads, and releases in JSON mode", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.path.endsWith("/lease") && request.method === "POST") return responseForLease("compact-token");
    if (request.method === "PUT") return responseForUpdate(request.body);
    if (request.path.endsWith("/lease") && request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { serverUrl: "http://sync.test", mode: "json" });
  try {
    await bind(fake);
    await fake.setEntries([...baseEnvelope.entries, compactionEntry]);
    assert.equal(await fake.handlers.get("session_before_compact")({ reason: "manual" }, fake.ctx), undefined);
    await fake.handlers.get("session_compact")({ reason: "manual" }, fake.ctx);

    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
      "POST /v1/sessions/session-1/lease",
      "PUT /v1/sessions/session-1",
      "DELETE /v1/sessions/session-1/lease",
    ]);
    const update = requests.find(({ method }) => method === "PUT");
    assert.equal(update.body.headEntryId, "c1");
    assert.equal(update.body.entries.at(-1).type, "compaction");
    const binding = await fake.binding();
    assert.equal(binding.lastEtag, "e2");
    assert.equal(binding.leaseToken, undefined);
  } finally {
    await fake.close();
  }
});

test("manual compaction is cancelled when the lease is unavailable", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.path.endsWith("/lease") && request.method === "POST") {
      return Response.json({ error: { code: "active_lease" } }, { status: 423 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { serverUrl: "http://sync.test", mode: "json" });
  try {
    await bind(fake);
    assert.deepEqual(await fake.handlers.get("session_before_compact")({ reason: "manual" }, fake.ctx), { cancel: true });
    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ["POST /v1/sessions/session-1/lease"]);
    assert.equal((await fake.binding()).leaseToken, undefined);
  } finally {
    await fake.close();
  }
});

test("failed manual compaction releases an unchanged lease without uploading", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.path.endsWith("/lease") && request.method === "POST") return responseForLease("failed-token");
    if (request.path.endsWith("/lease") && request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "unexpected_request" } }, { status: 500 });
  }, { serverUrl: "http://sync.test", mode: "json" });
  try {
    await bind(fake);
    await fake.handlers.get("session_before_compact")({ reason: "manual" }, fake.ctx);
    await fake.handlers.get("session_compact_failed")({ reason: "manual", aborted: true }, fake.ctx);
    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
      "POST /v1/sessions/session-1/lease",
      "DELETE /v1/sessions/session-1/lease",
    ]);
    const binding = await fake.binding();
    assert.equal(binding.lastEtag, "e1");
    assert.equal(binding.leaseToken, undefined);
  } finally {
    await fake.close();
  }
});

test("automatic compaction keeps the turn lease until settlement", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const request = requestRecord(url, init);
    requests.push(request);
    if (request.path.endsWith("/lease") && request.method === "POST") return responseForLease("turn-token");
    if (request.method === "PUT") return responseForUpdate(request.body);
    if (request.path.endsWith("/lease") && request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { serverUrl: "http://sync.test", mode: "json" });
  try {
    await bind(fake);
    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "continue" });
    assert.equal(await fake.handlers.get("session_before_compact")({ reason: "threshold" }, fake.ctx), undefined);
    await fake.setEntries([...baseEnvelope.entries, compactionEntry]);
    await fake.handlers.get("session_compact")({ reason: "threshold" }, fake.ctx);
    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ["POST /v1/sessions/session-1/lease"]);
    assert.equal((await fake.binding()).leaseToken, "turn-token");

    await fake.handlers.get("agent_settled")({}, fake.ctx);
    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
      "POST /v1/sessions/session-1/lease",
      "PUT /v1/sessions/session-1",
      "DELETE /v1/sessions/session-1/lease",
    ]);
  } finally {
    await fake.close();
  }
});
