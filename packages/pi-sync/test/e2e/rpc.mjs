import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
const EXT = process.env.SYNC_EXT || fileURLToPath(new URL("../../extensions/sync.ts", import.meta.url));
// npm puts the package's dev-dependency Pi first on PATH; e2e runs against the installed CLI.
const PI_BIN = process.env.PI_BIN || (process.env.PATH || "").split(delimiter).filter((dir) => !dir.includes("node_modules")).map((dir) => join(dir, "pi")).find(existsSync) || "pi";
export class Pi {
  constructor(name, { cwd, agentDir, args = [], env = {} }) {
    this.name = name; this.events = []; this.notes = []; this.status = {}; this.waiters = []; this.answers = []; this.pending = new Map(); this.seq = 0;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(`${agentDir}/models.json`, JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${process.env.FAKE_LLM_PORT || 18081}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "echo" }] } } }));
    writeFileSync(`${agentDir}/settings.json`, JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    this.proc = spawn(PI_BIN, ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--no-prompt-templates", "--no-themes", "-e", EXT, "--provider", "fake", "--model", "echo", ...args], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SYNC_SERVER_URL: process.env.SYNC_URL || "http://127.0.0.1:18080", PI_SYNC_HEARTBEAT_MS: "1000", PI_SYNC_DEVICE_LABEL: name, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    this.proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) this.onRecord(JSON.parse(l)); } });
    this.stderr = ""; this.proc.stderr.on("data", (d) => { this.stderr += d; });
  }
  log(...a) { if (process.env.PI_SYNC_E2E_VERBOSE) console.log(`[${this.name}]`, ...a); }
  onRecord(r) {
    if (r.type === "response" && this.pending.has(r.id)) { this.pending.get(r.id)(r); this.pending.delete(r.id); return; }
    if (r.type === "extension_ui_request") {
      if (r.method === "set_editor_text") { this.editorText = r.text; }
      else if (r.method === "notify") { this.notes.push(r.message); this.log("NOTIFY", r.notifyType || "", r.message); }
      else if (r.method === "setStatus") { this.status[r.statusKey] = r.statusText; }
      else if (["select", "confirm", "input", "editor"].includes(r.method)) {
        const a = this.answers.shift();
        this.log("UI", r.method, r.title, JSON.stringify(r.options || r.message || ""), "->", JSON.stringify(a));
        let resp = { type: "extension_ui_response", id: r.id };
        if (a === undefined) resp.cancelled = true;
        else if (r.method === "confirm") resp.confirmed = !!a;
        else if (typeof a === "function") resp.value = a(r.options);
        else resp.value = a;
        this.send(resp);
      }
      return;
    }
    this.events.push(r);
    for (const w of [...this.waiters]) if (w.pred(r)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(r); }
  }
  send(o) { this.proc.stdin.write(JSON.stringify(o) + "\n"); }
  cmd(o) { const id = `r${++this.seq}`; return new Promise((res) => { this.pending.set(id, res); this.send({ ...o, id }); }); }
  waitEvent(pred, ms = 30000) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${this.name}: timeout waiting event`)), ms); this.waiters.push({ pred, res: (r) => { clearTimeout(t); res(r); } }); }); }
  async prompt(message, extra = {}) {
    const settled = this.waitEvent((r) => r.type === "agent_settled", 60000);
    const r = await this.cmd({ type: "prompt", message, ...extra });
    const disp = r.data?.disposition; this.log("prompt", JSON.stringify(message), "->", r.success ? disp : r.error);
    if (disp === "started") await settled;
    else if (this.notes.at(-1)?.startsWith("Catching up")) await settled.catch(() => this.log("replay never settled"));
    else settled.catch(() => {});
    return disp;
  }
  async state() { return (await this.cmd({ type: "get_state" })).data; }
  async messages() { return (await this.cmd({ type: "get_messages" })).data.messages; }
  async texts() { return (await this.messages()).map((m) => `${m.role}:${typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("")}`); }
  stop(signal = "SIGTERM") {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve();
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.kill(signal);
    return exited;
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
