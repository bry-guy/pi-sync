import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { RemoteHost } from "../dist/src/index.js";

function startMockRelay() {
  let registered = null;
  let unregistered = false;
  const receivedEvents = [];
  const replies = new Map();
  let pendingCommands = [];
  let waitResolve = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;

    if (req.headers.authorization !== "Bearer sync-tok") {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/remote/host/register") {
      registered = body;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/v1/remote/host/sessions/")) {
      unregistered = true;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/remote/host/events") {
      receivedEvents.push(...(body.events || []));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/remote/host/reply") {
      replies.set(body.reqId, body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/remote/host/poll") {
      if (pendingCommands.length > 0) {
        const cmds = pendingCommands;
        pendingCommands = [];
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commands: cmds }));
        return;
      }
      await new Promise((resolve) => {
        waitResolve = resolve;
        const timer = setTimeout(resolve, 250);
        req.on("close", () => { clearTimeout(timer); resolve(); });
      });
      waitResolve = null;
      const cmds = pendingCommands;
      pendingCommands = [];
      if (!res.writableEnded) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commands: cmds }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        get registered() { return registered; },
        get unregistered() { return unregistered; },
        receivedEvents,
        replies,
        enqueue(cmd) {
          pendingCommands.push(cmd);
          if (waitResolve) waitResolve();
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("RemoteHost registers, deduplicates messages by clientMessageId, streams events, and unregisters on stop", async () => {
  const relay = await startMockRelay();
  const messages = [];
  let stopped = 0;
  const statuses = [];

  const host = new RemoteHost({
    baseUrl: relay.url,
    token: "sync-tok",
    pollWaitSec: 1,
    flushMs: 15,
    meta: { sessionId: "s-local", device: "macbook", cwd: "/Users/brain", title: "Home", streaming: false },
    onStatus: (s) => statuses.push(s),
    handlers: {
      onTranscript: () => ({ status: 200, body: { entries: [{ id: "e1" }] } }),
      onMessage: (payload) => { messages.push(payload); return { status: 200, body: { ok: true } }; },
      onStop: () => { stopped++; return { status: 200, body: { ok: true } }; },
      onAnswerQuestion: (payload) => ({ status: 200, body: { ok: true, id: payload.requestId } }),
    },
  });

  host.start();
  try {
    // Wait for registration.
    for (let i = 0; i < 40 && !relay.registered; i++) await new Promise((r) => setTimeout(r, 15));
    assert.equal(relay.registered?.sessionId, "s-local");
    assert.equal(statuses.at(-1), "online");

    // Enqueue transcript, duplicate messages, and stop.
    relay.enqueue({ reqId: "r1", sessionId: "s-local", type: "transcript" });
    relay.enqueue({ reqId: "r2", sessionId: "s-local", type: "message", payload: { text: "hi", clientMessageId: "c1" } });
    relay.enqueue({ reqId: "r3", sessionId: "s-local", type: "message", payload: { text: "hi", clientMessageId: "c1" } });
    relay.enqueue({ reqId: "r4", sessionId: "s-local", type: "stop" });

    for (let i = 0; i < 50 && relay.replies.size < 4; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(relay.replies.get("r1")?.status, 200);
    assert.deepEqual(relay.replies.get("r1")?.body, { entries: [{ id: "e1" }] });
    assert.equal(messages.length, 1, "duplicate clientMessageId must only dispatch once");
    assert.equal(relay.replies.get("r3")?.body?.duplicate, true);
    assert.equal(stopped, 1);

    // Push live events and confirm batch flush.
    host.pushEvent({ type: "text_delta", delta: "hello" });
    host.pushEvent({ type: "turn_end", ok: true });
    for (let i = 0; i < 40 && relay.receivedEvents.length < 2; i++) await new Promise((r) => setTimeout(r, 15));
    assert.equal(relay.receivedEvents.length, 2);
  } finally {
    await host.stop();
    await relay.close();
  }
  assert.equal(relay.unregistered, true);
});
