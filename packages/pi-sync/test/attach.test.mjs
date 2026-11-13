import assert from "node:assert/strict";
import { test } from "node:test";
import { extendsCanonical, inBatches } from "../dist/extensions/sync.js";

const chain = (...ids) => ids.map((id, index) => ({ id, parentId: index ? ids[index - 1] : null }));

test("a copy that only adds entries onto the canonical one extends it", () => {
  const server = chain("a", "b", "c");
  assert.equal(extendsCanonical(server, server), true, "identical");
  assert.equal(extendsCanonical([...server, { id: "d", parentId: "c" }, { id: "e", parentId: "d" }], server), true, "ahead by a chain from the head");
  assert.equal(extendsCanonical([...server, { id: "d", parentId: "b" }, { id: "e", parentId: "c" }], server), true, "a /tree branch is still only ahead");
});

test("anything else is not an extension", () => {
  const server = chain("a", "b", "c");
  assert.equal(extendsCanonical(chain("a", "b"), server), false, "server ahead");
  assert.equal(extendsCanonical([...chain("a", "b"), { id: "x", parentId: "b" }], server), false, "diverged");
  assert.equal(extendsCanonical([...chain("a", "c", "b")], server), false, "different order");
  assert.equal(extendsCanonical([...server, { id: "d", parentId: "zz" }], server), false, "tail hangs off an unknown entry");
  assert.equal(extendsCanonical([...server, { id: "d", parentId: null }], server), false, "second root");
  assert.equal(extendsCanonical(chain("a"), []), false, "empty canonical");
});

test("batches stay under the byte limit and keep order", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: String(i), pad: "x".repeat(90) }));
  const batches = inBatches(entries, 350);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), entries);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 350 + batch.length + 2);
  assert.deepEqual(inBatches([], 10), [[]], "nothing to send still makes one (header-only) request");
  assert.deepEqual(inBatches([{ big: "y".repeat(100) }], 10).length, 1, "an oversized entry goes alone");
});
