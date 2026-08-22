import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BindingStore } from "../dist/src/bindings.js";
import { SyncClient, SyncClientError } from "../dist/src/client/client.js";

test("persists setup-required bindings without retaining a lease token", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-recovery-"));
  try {
    const store = new BindingStore(root);
    await store.set({
      nativeSessionId: "session-1",
      serverUrl: "http://sync.test",
      canonicalSessionId: "session-1",
      lastEtag: "etag-1",
      materializedFile: "/tmp/session-1.jsonl",
      state: "setup_required",
    });

    const reloaded = new BindingStore(root);
    await reloaded.load();
    const binding = await reloaded.get("session-1");
    assert.equal(binding?.state, "setup_required");
    assert.equal(binding?.leaseToken, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exposes session-not-found as a repairable protocol error", async () => {
  const client = new SyncClient({
    baseUrl: "http://sync.test",
    fetch: async () => Response.json({ error: { code: "session_not_found", message: "internal detail" } }, { status: 404 }),
  });
  await assert.rejects(() => client.acquire("session-1", "device"), (error) => {
    assert.ok(error instanceof SyncClientError);
    assert.equal(error.code, "session_not_found");
    assert.equal(error.message, "The synchronized session no longer exists.");
    return true;
  });
});
