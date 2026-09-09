import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BindingStore } from "../dist/src/bindings.js";
import extension from "../dist/extensions/sync.js";

const envelope = {
  formatVersion: 1,
  sessionId: "session-1",
  piSessionVersion: 3,
  createdAt: "2026-01-01T00:00:00Z",
  parentSessionId: null,
  headEntryId: "a",
  title: "",
  entries: [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z" }],
};

async function harness(fetch, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-turn-"));
  const sessionPath = join(root, "session.jsonl");
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: envelope.sessionId, timestamp: envelope.createdAt })}\n${JSON.stringify(envelope.entries[0])}\n`);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const intervals = new Set();
  if (options.captureIntervals) {
    globalThis.setInterval = (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      intervals.add(timer);
      return timer;
    };
    globalThis.clearInterval = (timer) => intervals.delete(timer);
  }
  process.env.PI_CODING_AGENT_DIR = root;
  globalThis.fetch = fetch;
  const handlers = new Map();
  const notices = [];
  const statuses = [];
  const pi = {
    registerCommand(name, command) { handlers.set(`command:${name}`, command.handler); },
    on(name, handler) { handlers.set(name, handler); },
    exec: async () => ({ stdout: "", code: 1 }),
    sendUserMessage() {},
  };
  extension(pi);
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: root,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      confirm: async () => true,
      notify: (message) => notices.push(message),
      setStatus: (_id, text) => statuses.push(text),
    },
    waitForIdle: async () => {},
    sessionManager: {
      getSessionId: () => envelope.sessionId,
      getSessionFile: () => sessionPath,
      getSessionDir: () => root,
      getLeafId: () => envelope.headEntryId,
      getSessionName: () => envelope.title,
    },
  };
  return {
    root,
    sessionPath,
    handlers,
    pi,
    ctx,
    notices,
    statuses,
    intervals,
    store: new BindingStore(root),
    async binding() { return new BindingStore(root).get(envelope.sessionId); },
    async tickIntervals() {
      await Promise.all([...intervals].map((timer) => timer.callback()));
    },
    async close() {
      intervals.clear();
      if (options.captureIntervals) {
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
      }
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function responseForLease(token, etag = "e1") {
  return Response.json({
    formatVersion: 1,
    session: envelope,
    etag,
    lease: {
      token,
      holder: "pi-test",
      acquiredAt: envelope.createdAt,
      expiresAt: "2026-01-01T00:02:00Z",
    },
  });
}

function responseForUpdate(etag) {
  return Response.json({ formatVersion: 1, session: envelope, etag });
}

function responseForRenew(etag) {
  return Response.json({
    formatVersion: 1,
    etag,
    lease: { holder: "pi-test", acquiredAt: envelope.createdAt, expiresAt: "2026-01-01T00:02:00Z" },
  });
}

test("acquires per input, settles PUT before DELETE, and reacquires next input", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    requests.push({ path: new URL(url).pathname, method: init.method });
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease/renew")) return responseForRenew("e1");
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease")) {
      return responseForLease(requests.filter((request) => request.method === "POST").length === 1 ? "token-1" : "token-2", requests.filter((request) => request.method === "POST").length === 1 ? "e1" : "e2");
    }
    if (init.method === "PUT") return responseForUpdate("e2");
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    assert.deepEqual(requests, []);

    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "continue" });
    assert.deepEqual(await fake.handlers.get("input")({ streamingBehavior: "followUp" }, fake.ctx), { action: "continue" });
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "POST"]);
    assert.deepEqual(await fake.handlers.get("agent_settled")({}, fake.ctx), undefined);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "POST", "PUT", "DELETE"]);
    const settled = await fake.binding();
    assert.equal(settled.lastEtag, "e2");
    assert.equal(settled.leaseToken, undefined);
    assert.equal(settled.leaseExpiresAt, undefined);

    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "continue" });
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "POST", "PUT", "DELETE", "POST"]);
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
  } finally {
    await fake.close();
  }
});

test("failed PUT blocks without DELETE and preserves the local session and binding base", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    requests.push({ path: new URL(url).pathname, method: init.method });
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease/renew")) return responseForRenew("e1");
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease")) return responseForLease("token-1");
    if (init.method === "PUT") return Response.json({ error: { code: "http_error" } }, { status: 500 });
    return new Response(null, { status: 204 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: "old-fingerprint",
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.handlers.get("input")({}, fake.ctx);
    const before = await readFile(fake.sessionPath, "utf8");
    await fake.handlers.get("agent_settled")({}, fake.ctx);
    assert.equal((await readFile(fake.sessionPath, "utf8")), before);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "PUT"]);
    const failed = await fake.binding();
    assert.equal(failed.leaseToken, "token-1");
    assert.equal(failed.lastEtag, "e1");
    assert.equal(failed.lastFingerprint, "old-fingerprint");

    const result = await fake.handlers.get("input")({}, fake.ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(requests.filter(({ method }) => method === "DELETE").length, 0);
    assert.equal((await readFile(fake.sessionPath, "utf8")), before);
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
  } finally {
    await fake.close();
  }
});

test("stale PUT releases safely and preserves the local binding base", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path.endsWith("/lease") && init.method === "POST") return responseForLease("token-1", "e1");
    if (init.method === "PUT") return Response.json({ error: { code: "stale_etag" } }, { status: 412 });
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: "old-fingerprint",
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    const before = await readFile(fake.sessionPath, "utf8");
    await fake.handlers.get("input")({}, fake.ctx);
    await fake.handlers.get("agent_settled")({}, fake.ctx);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "PUT", "DELETE"]);
    assert.equal((await readFile(fake.sessionPath, "utf8")), before);
    const binding = await fake.binding();
    assert.equal(binding.leaseToken, undefined);
    assert.equal(binding.lastEtag, "e1");
    assert.equal(binding.lastFingerprint, "old-fingerprint");
    assert.match(fake.notices.join(" "), /\/sync/);
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
  } finally {
    await fake.close();
  }
});

test("release failure retains the committed token for a delete-only retry", async () => {
  const requests = [];
  let releaseCount = 0;
  const fake = await harness(async (url, init = {}) => {
    requests.push({ path: new URL(url).pathname, method: init.method });
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease/renew")) return responseForRenew("e2");
    if (init.method === "POST" && new URL(url).pathname.endsWith("/lease")) {
      return responseForLease(releaseCount === 0 ? "token-1" : "token-2", releaseCount === 0 ? "e1" : "e2");
    }
    if (init.method === "PUT") return responseForUpdate("e2");
    if (init.method === "DELETE") {
      releaseCount++;
      return releaseCount === 1
        ? Response.json({ error: { code: "http_error" } }, { status: 500 })
        : new Response(null, { status: 204 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.handlers.get("input")({}, fake.ctx);
    await fake.handlers.get("agent_settled")({}, fake.ctx);
    assert.equal((await fake.binding()).leaseToken, "token-1");
    assert.equal(fake.statuses.some((status) => String(status).includes("committed")), false);

    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "continue" });
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "PUT", "DELETE", "POST", "DELETE", "POST"]);
    assert.equal((await fake.binding()).leaseToken, "token-2");
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
  } finally {
    await fake.close();
  }
});

test("expired persisted leases reacquire only on input when the ETag is unchanged", async () => {
  const requests = [];
  let acquireCount = 0;
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path.endsWith("/lease/renew")) return Response.json({ error: { code: "lease_invalid" } }, { status: 423 });
    if (path.endsWith("/lease") && init.method === "POST") {
      acquireCount++;
      return responseForLease(acquireCount === 1 ? "new-token" : "turn-token", "e1");
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: JSON.stringify(envelope),
      leaseToken: "expired-token",
      leaseExpiresAt: "2026-01-01T00:01:00Z",
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    assert.deepEqual(requests, []);
    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "continue" });
    assert.deepEqual(requests.map(({ path, method }) => `${method} ${path}`), [
      "POST /v1/sessions/session-1/lease/renew",
      "POST /v1/sessions/session-1/lease",
      "DELETE /v1/sessions/session-1/lease",
      "POST /v1/sessions/session-1/lease",
    ]);
    assert.equal((await fake.binding()).leaseToken, "turn-token");
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
  } finally {
    await fake.close();
  }
});

test("expired-token ETag mismatch preserves the local binding and blocks input", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path.endsWith("/lease/renew")) return Response.json({ error: { code: "lease_invalid" } }, { status: 423 });
    if (path.endsWith("/lease") && init.method === "POST") return responseForLease("new-token", "e2");
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: "old-fingerprint",
      leaseToken: "expired-token",
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    const before = await readFile(fake.sessionPath, "utf8");
    assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "handled" });
    assert.deepEqual(requests.map(({ path, method }) => `${method} ${path}`), [
      "POST /v1/sessions/session-1/lease/renew",
      "POST /v1/sessions/session-1/lease",
      "DELETE /v1/sessions/session-1/lease",
    ]);
    assert.equal((await readFile(fake.sessionPath, "utf8")), before);
    const blocked = await fake.binding();
    assert.equal(blocked.leaseToken, undefined);
    assert.equal(blocked.lastEtag, "e1");
    assert.equal(blocked.lastFingerprint, "old-fingerprint");
    assert.match(fake.notices.join(" "), /\/sync/);
  } finally {
    await fake.close();
  }
});

test("ETag conflict and active lease block without changing local state", async () => {
  for (const mode of ["etag", "lease"]) {
    const requests = [];
    const fake = await harness(async (url, init = {}) => {
      requests.push({ path: new URL(url).pathname, method: init.method });
      if (init.method === "POST" && new URL(url).pathname.endsWith("/lease")) {
        if (mode === "lease") return Response.json({ error: { code: "active_lease" } }, { status: 423 });
        return responseForLease("token-1", "e2");
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    });
    try {
      await fake.store.set({
        nativeSessionId: envelope.sessionId,
        serverUrl: "http://sync.test",
        canonicalSessionId: envelope.sessionId,
        lastEtag: "e1",
        materializedFile: fake.sessionPath,
        state: "ready",
      });
      await fake.handlers.get("session_start")({}, fake.ctx);
      const before = await readFile(fake.sessionPath, "utf8");
      assert.deepEqual(await fake.handlers.get("input")({}, fake.ctx), { action: "handled" });
      assert.equal((await readFile(fake.sessionPath, "utf8")), before);
      const blocked = await fake.binding();
      assert.equal(blocked.leaseToken, undefined);
      assert.equal(blocked.lastEtag, "e1");
      assert.match(fake.notices.join(" "), mode === "etag" ? /\/sync/ : /use/);
      assert.equal(requests.filter(({ method }) => method === "DELETE").length, mode === "etag" ? 1 : 0);
    } finally {
      await fake.close();
    }
  }
});

test("refresh replaces an unchanged local materialization with a newer canonical snapshot", async () => {
  const remote = {
    ...envelope,
    headEntryId: "b",
    title: "Remote update",
    entries: [
      ...envelope.entries,
      { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z" },
    ],
  };
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path.endsWith("/lease") && init.method === "POST") {
      const response = await responseForLease("refresh-token", "e2").json();
      return Response.json({ ...response, session: remote });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  let switchedTarget;
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: JSON.stringify(envelope),
      state: "ready",
    });
    fake.ctx.switchSession = async (target, options) => {
      switchedTarget = target;
      const replacement = {
        ...fake.ctx,
        ui: { ...fake.ctx.ui, notify: (message) => fake.notices.push(message) },
        sessionManager: {
          ...fake.ctx.sessionManager,
          getSessionFile: () => target,
          getLeafId: () => remote.headEntryId,
          getSessionName: () => remote.title,
        },
        navigateTree: async () => ({ cancelled: false }),
      };
      await fake.handlers.get("session_start")({}, replacement);
      await options.withSession(replacement);
      return { cancelled: false };
    };
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.handlers.get("command:sync")("refresh", fake.ctx);
    assert.ok(switchedTarget);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "DELETE"]);
    const refreshed = await fake.binding();
    assert.equal(refreshed.lastEtag, "e2");
    assert.equal(refreshed.materializedFile, switchedTarget);
    assert.match(await readFile(switchedTarget, "utf8"), /"id":"b"/);
    assert.match(fake.notices.join(" "), /refreshed/);
  } finally {
    await fake.close();
  }
});

test("automatically refreshes a newer remote snapshot during idle polling", async () => {
  const remote = {
    ...envelope,
    headEntryId: "b",
    title: "Remote update",
    entries: [
      ...envelope.entries,
      { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z" },
    ],
  };
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path === "/v1/sessions" && init.method === "GET") {
      return Response.json({
        formatVersion: 1,
        sessions: [{
          sessionId: envelope.sessionId,
          title: remote.title,
          createdAt: remote.createdAt,
          headEntryId: remote.headEntryId,
          etag: "e2",
          leaseHolder: null,
          leaseExpiresAt: null,
        }],
      });
    }
    if (path.endsWith("/lease") && init.method === "POST") {
      const response = await responseForLease("auto-refresh-token", "e2").json();
      return Response.json({ ...response, session: remote });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { captureIntervals: true });
  let switchedTarget;
  let refreshPromise;
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: JSON.stringify(envelope),
      state: "ready",
    });
    fake.pi.sendUserMessage = (text) => {
      assert.equal(text, "/sync refresh");
      refreshPromise = fake.handlers.get("command:sync")("refresh", fake.ctx);
    };
    fake.ctx.switchSession = async (target, options) => {
      switchedTarget = target;
      const replacement = {
        ...fake.ctx,
        ui: { ...fake.ctx.ui, notify: (message) => fake.notices.push(message) },
        sessionManager: {
          ...fake.ctx.sessionManager,
          getSessionFile: () => target,
          getLeafId: () => remote.headEntryId,
          getSessionName: () => remote.title,
        },
        navigateTree: async () => ({ cancelled: false }),
      };
      await fake.handlers.get("session_start")({}, replacement);
      await options.withSession(replacement);
      return { cancelled: false };
    };
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.tickIntervals();
    assert.ok(refreshPromise);
    await refreshPromise;
    assert.ok(switchedTarget);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "DELETE"]);
    const refreshed = await fake.binding();
    assert.equal(refreshed.lastEtag, "e2");
    assert.equal(refreshed.materializedFile, switchedTarget);
    assert.match(await readFile(switchedTarget, "utf8"), /"id":"b"/);
    assert.match(fake.notices.join(" "), /refreshed/);
    assert.equal(fake.intervals.size, 1);
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
    assert.equal(fake.intervals.size, 0);
  } finally {
    await fake.close();
  }
});

test("idle polling retries a failed automatic refresh", async () => {
  const remote = {
    ...envelope,
    headEntryId: "b",
    title: "Remote update",
    entries: [
      ...envelope.entries,
      { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z" },
    ],
  };
  const requests = [];
  let acquireCount = 0;
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path === "/v1/sessions" && init.method === "GET") {
      return Response.json({
        formatVersion: 1,
        sessions: [{
          sessionId: envelope.sessionId,
          title: remote.title,
          createdAt: remote.createdAt,
          headEntryId: remote.headEntryId,
          etag: "e2",
          leaseHolder: null,
          leaseExpiresAt: null,
        }],
      });
    }
    if (path.endsWith("/lease") && init.method === "POST") {
      acquireCount++;
      if (acquireCount === 1) return Response.json({ error: { code: "http_error" } }, { status: 500 });
      const response = await responseForLease("retry-token", "e2").json();
      return Response.json({ ...response, session: remote });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { captureIntervals: true });
  let refreshPromise;
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: JSON.stringify(envelope),
      state: "ready",
    });
    fake.pi.sendUserMessage = (text) => {
      assert.equal(text, "/sync refresh");
      refreshPromise = fake.handlers.get("command:sync")("refresh", fake.ctx);
    };
    fake.ctx.switchSession = async () => ({ cancelled: false });
    await fake.handlers.get("session_start")({}, fake.ctx);

    await fake.tickIntervals();
    assert.ok(refreshPromise);
    await refreshPromise;
    assert.equal(acquireCount, 1);

    refreshPromise = undefined;
    await fake.tickIntervals();
    assert.ok(refreshPromise);
    await refreshPromise;
    assert.equal(acquireCount, 2);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET", "POST", "DELETE"]);
  } finally {
    await fake.close();
  }
});

test("idle polling skips unsafe and overlapping checks", async () => {
  const requests = [];
  let currentEtag = "e1";
  let leaseHolder = "other-client";
  let delayNextList = false;
  let resolveListStarted;
  let resolveList;
  const listStarted = new Promise((resolve) => { resolveListStarted = resolve; });
  const delayedList = new Promise((resolve) => { resolveList = resolve; });
  const listResponse = () => Response.json({
    formatVersion: 1,
    sessions: [{
      sessionId: envelope.sessionId,
      title: envelope.title,
      createdAt: envelope.createdAt,
      headEntryId: envelope.headEntryId,
      etag: currentEtag,
      leaseHolder,
      leaseExpiresAt: leaseHolder ? "2026-01-01T00:02:00Z" : null,
    }],
  });
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path === "/v1/sessions" && init.method === "GET") {
      if (delayNextList) {
        delayNextList = false;
        resolveListStarted();
        return delayedList;
      }
      return listResponse();
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { captureIntervals: true });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      lastFingerprint: JSON.stringify(envelope),
      state: "ready",
    });
    fake.ctx.hasPendingMessages = () => true;
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.tickIntervals();
    assert.deepEqual(requests, []);

    fake.ctx.hasPendingMessages = () => false;
    fake.ctx.ui.getEditorText = () => "draft";
    await fake.tickIntervals();
    assert.deepEqual(requests, []);

    fake.ctx.ui.getEditorText = () => "";
    currentEtag = "e2";
    await fake.tickIntervals();
    assert.deepEqual(requests.map(({ method }) => method), ["GET"]);

    leaseHolder = null;
    currentEtag = "e1";
    delayNextList = true;
    const timer = [...fake.intervals][0];
    const first = timer.callback();
    await listStarted;
    const second = timer.callback();
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
    resolveList(await listResponse());
    await first;
    await second;
    await fake.handlers.get("session_shutdown")({}, fake.ctx);
    assert.equal(fake.intervals.size, 0);
  } finally {
    await fake.close();
  }
});

test("idle polling preserves local changes instead of auto-refreshing", async () => {
  const remote = {
    ...envelope,
    headEntryId: "b",
    title: "Remote update",
    entries: [
      ...envelope.entries,
      { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z" },
    ],
  };
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path === "/v1/sessions" && init.method === "GET") {
      return Response.json({
        formatVersion: 1,
        sessions: [{
          sessionId: envelope.sessionId,
          title: remote.title,
          createdAt: remote.createdAt,
          headEntryId: remote.headEntryId,
          etag: "e2",
          leaseHolder: null,
          leaseExpiresAt: null,
        }],
      });
    }
    if (path.endsWith("/lease") && init.method === "POST") {
      const response = await responseForLease("auto-refresh-token", "e2").json();
      return Response.json({ ...response, session: remote });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }, { captureIntervals: true });
  let switched = false;
  let refreshPromise;
  try {
    await writeFile(fake.sessionPath, `${JSON.stringify({ type: "session", version: 3, id: envelope.sessionId, timestamp: envelope.createdAt })}\n${JSON.stringify(envelope.entries[0])}\n${JSON.stringify(remote.entries[1])}\n`);
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      state: "ready",
    });
    fake.pi.sendUserMessage = (text) => {
      assert.equal(text, "/sync refresh");
      refreshPromise = fake.handlers.get("command:sync")("refresh", fake.ctx);
    };
    fake.ctx.switchSession = async () => {
      switched = true;
      return { cancelled: false };
    };
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.tickIntervals();
    assert.ok(refreshPromise);
    await refreshPromise;
    assert.equal(switched, false);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "DELETE"]);
    assert.match(fake.notices.join(" "), /unsynchronized changes/);
    assert.match(await readFile(fake.sessionPath, "utf8"), /"id":"b"/);
  } finally {
    await fake.close();
  }
});

test("detach removes only the local binding", async () => {
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    requests.push({ path: new URL(url).pathname, method: init.method });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  try {
    await fake.store.set({
      nativeSessionId: envelope.sessionId,
      serverUrl: "http://sync.test",
      canonicalSessionId: envelope.sessionId,
      lastEtag: "e1",
      materializedFile: fake.sessionPath,
      state: "ready",
    });
    await fake.handlers.get("session_start")({}, fake.ctx);
    await fake.handlers.get("command:sync")("detach", fake.ctx);
    assert.equal(await fake.binding(), undefined);
    assert.deepEqual(requests, []);
    assert.match(fake.notices.join(" "), /server copy was preserved/);
  } finally {
    await fake.close();
  }
});

test("opens a synchronized session without crashing on replacement errors", async () => {
  const previousUrl = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = "http://sync.test";
  const requests = [];
  const fake = await harness(async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (path === "/v1/sessions" && init.method === "GET") {
      return Response.json({
        formatVersion: 1,
        sessions: [{
          sessionId: envelope.sessionId,
          title: "Synced session",
          createdAt: envelope.createdAt,
          headEntryId: envelope.headEntryId,
          etag: "e1",
          leaseHolder: "pi-web",
          leaseExpiresAt: "2026-01-01T00:02:00Z",
          workspace,
        }],
      });
    }
    if (path.endsWith("/lease") && init.method === "POST") {
      const response = await responseForLease("picker-token").json();
      return Response.json({ ...response, session: { ...response.session, workspace } });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  const replacementNotices = [];
  const workspace = {
    gitRemote: "git@github.com:bry-guy/pi-sync.git",
    branch: "feature/sync-ui",
    commit: "abcdef1234567",
  };
  fake.pi.exec = async (_command, args) => {
    if (args.includes("--abbrev-ref")) return { stdout: `origin/${workspace.branch}\n`, code: 0 };
    if (args[0] === "remote" && args[1] === "get-url") return { stdout: `${workspace.gitRemote}\n`, code: 0 };
    return { stdout: "", code: 1 };
  };
  let switched = false;
  let guardCancelled;
  try {
    fake.ctx.ui.notify = (message) => {
      if (switched) throw new Error("stale command context used");
      fake.notices.push(message);
    };
    fake.ctx.ui.select = async (_title, items) => {
      assert.deepEqual(items, ["Synced session — feature/sync-ui — ● pi-web"]);
      return items[0];
    };
    fake.ctx.switchSession = async (target, options) => {
      switched = true;
      const replacement = {
        hasUI: true,
        cwd: fake.root,
        ui: {
          notify: (message) => replacementNotices.push(message),
          setStatus() {},
        },
        sessionManager: {
          getSessionId: () => envelope.sessionId,
          getSessionFile: () => target,
          getSessionDir: () => fake.root,
          getLeafId: () => envelope.headEntryId,
          getSessionName: () => envelope.title,
        },
        navigateTree: async (_id, navigateOptions) => {
          const result = await fake.handlers.get("session_before_tree")({
            preparation: { userWantsSummary: navigateOptions?.summarize === true },
            signal: new AbortController().signal,
          }, replacement);
          guardCancelled = result?.cancel === true;
          if (guardCancelled) return { cancelled: true };
          throw new Error("head restoration failed");
        },
      };
      await fake.handlers.get("session_start")({}, replacement);
      await options.withSession(replacement);
      return { cancelled: false };
    };
    await fake.handlers.get("command:sync")("", fake.ctx);
    assert.equal(guardCancelled, false);
    assert.match(replacementNotices.join(" "), /head restoration failed/);
    assert.equal(fake.notices.length, 0);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "DELETE"]);
  } finally {
    if (previousUrl === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previousUrl;
    await fake.close();
  }
});
