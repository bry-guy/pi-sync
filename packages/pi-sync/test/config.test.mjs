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
  writeFileSync(configPath(d), JSON.stringify({ code: "always", allSessions: "maybe", serverUrl: "pi-sync.local", heartbeatMs: 500_000 }));
  const config = loadConfig(configPath(d), {});
  assert.equal(config.code, "ask");
  assert.equal(config.allSessions, false);
  assert.equal(config.serverUrl, undefined);
  assert.equal(config.heartbeatMs, 20_000);
  assert.equal(config.problems.length, 3, "heartbeatMs is not a file setting");
  writeFileSync(configPath(d), "{not json");
  assert.match(loadConfig(configPath(d), {}).problems[0], /could not be read/);
});

test("the test heartbeat stays inside the lease expiry", () => {
  assert.equal(loadConfig(configPath(dir()), { PI_SYNC_HEARTBEAT_MS: "500000" }).heartbeatMs, 30_000);
  assert.equal(loadConfig(configPath(dir()), { PI_SYNC_HEARTBEAT_MS: "1000" }).heartbeatMs, 1000);
});

test("the agent dir's file overrides the dotfiles one per key, and env overrides both", async () => {
  const { configPaths } = await import("../dist/src/index.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "pi-sync.json"), JSON.stringify({ code: "auto", allSessions: "on" }));
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  writeFileSync(join(agent, "pi-sync.json"), JSON.stringify({ allSessions: "off" }));
  const paths = configPaths(agent, home);
  const merged = loadConfig(paths, {});
  assert.equal(merged.code, "auto");
  assert.equal(merged.allSessions, false);
  assert.equal(loadConfig(paths, { PI_SYNC_ALL_SESSIONS: "on" }).allSessions, true);
  assert.equal(configPaths(join(home, ".pi", "agent"), home).length, 1);
});
