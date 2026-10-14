import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, loadConfig } from "../dist/src/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "pi-sync-config-"));

test("defaults without a file or environment", () => {
  const config = loadConfig(configPath(dir()), {});
  assert.deepEqual(config, { serverUrl: undefined, deviceLabel: undefined, code: "ask", allSessions: false, heartbeatMs: 20_000, problems: [] });
});

test("the file sets values and the environment overrides them", () => {
  const d = dir();
  writeFileSync(configPath(d), JSON.stringify({ serverUrl: "https://file", code: "auto", allSessions: true, deviceLabel: "laptop" }));
  assert.deepEqual(loadConfig(configPath(d), {}), { serverUrl: "https://file", deviceLabel: "laptop", code: "auto", allSessions: true, heartbeatMs: 20_000, problems: [] });
  const env = loadConfig(configPath(d), { PI_SYNC_SERVER_URL: "https://env", PI_SYNC_CODE: "off", PI_SYNC_ALL_SESSIONS: "off" });
  assert.equal(env.serverUrl, "https://env");
  assert.equal(env.code, "off");
  assert.equal(env.allSessions, false);
});

test("bad values fall back to defaults and are reported", () => {
  const d = dir();
  writeFileSync(configPath(d), JSON.stringify({ code: "always", allSessions: "maybe", serverUrl: "pi-sync.local", heartbeatMs: 5 }));
  const config = loadConfig(configPath(d), {});
  assert.equal(config.code, "ask");
  assert.equal(config.allSessions, false);
  assert.equal(config.serverUrl, undefined);
  assert.equal(config.heartbeatMs, 20_000);
  assert.equal(config.problems.length, 4);
  writeFileSync(configPath(d), "{not json");
  assert.match(loadConfig(configPath(d), {}).problems[0], /could not be read/);
});
