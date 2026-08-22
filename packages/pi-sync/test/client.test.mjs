import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncClient, SyncClientError } from "../dist/src/client/client.js";

const envelope = {
  formatVersion: 1,
  sessionId: "session-1",
  piSessionVersion: 3,
  createdAt: "2026-01-01T00:00:00Z",
  parentSessionId: null,
  headEntryId: "a",
  title: "test",
  entries: [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z" }],
};

function responder() {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (path === "/v1/sessions" && init.method === "GET") {
      return Response.json({ formatVersion: 1, sessions: [{ sessionId: "session-1", title: "test", createdAt: envelope.createdAt, headEntryId: "a", etag: "e1", leaseHolder: null, leaseExpiresAt: null }] });
    }
    if (path.endsWith("/lease") && init.method === "POST") {
      return Response.json({ formatVersion: 1, session: envelope, etag: "e1", lease: { token: "secret-token", holder: "device", acquiredAt: envelope.createdAt, expiresAt: "2026-01-01T00:02:00Z" } });
    }
    if (path.endsWith("/lease") && init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: { code: "stale_etag", message: "internal detail" } }, { status: 412 });
  };
  return { fetch, requests };
}

test("client validates responses and sends lease/CAS headers", async () => {
  const fake = responder();
  const client = new SyncClient({ baseUrl: "http://sync.test/", fetch: fake.fetch });
  const list = await client.list();
  assert.equal(list.sessions[0].sessionId, "session-1");
  const acquired = await client.acquire("session-1", "device");
  assert.equal(acquired.lease.token, "secret-token");
  await client.release("session-1", acquired.lease.token);
  const acquireRequest = fake.requests.find((entry) => entry.init.method === "POST");
  assert.match(acquireRequest.init.body, /device/);
  assert.equal(fake.requests.at(-1).init.headers["X-Pi-Sync-Lease"], "secret-token");
});

test("client sanitizes protocol errors", async () => {
  const client = new SyncClient({
    baseUrl: "http://sync.test",
    fetch: async () => Response.json({ error: { code: "stale_etag", message: "do not leak this" } }, { status: 412 }),
  });
  await assert.rejects(() => client.update("session-1", envelope, "secret", "old"), (error) => {
    assert.ok(error instanceof SyncClientError);
    assert.equal(error.code, "stale_etag");
    assert.equal(error.message, "The synchronized session changed on another client.");
    return true;
  });
});
