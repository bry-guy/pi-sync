import http from "node:http";
const port = Number(process.env.FAKE_LLM_PORT || 18081);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let last = "", system = "", afterTool = false;
    try {
      const j = JSON.parse(body);
      const u = [...j.messages].reverse().find((m) => m.role === "user");
      const sys = j.messages.find((m) => m.role === "system" || m.role === "developer");
      system = typeof sys?.content === "string" ? sys.content : (sys?.content || []).map((p) => p.text || "").join("");
      afterTool = j.messages.at(-1)?.role === "tool";
      last = typeof u?.content === "string" ? u.content : (u?.content || []).map((p) => p.text || "").join("");
    } catch {}
    const delay = Number((last.match(/sleep(\d+)/) || [])[1] || 0);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "echo" };
    // "bashtool:<command>;" runs the command through Pi's bash tool first, then answers as usual.
    const command = (last.match(/bashtool:([^;]*);/) || [])[1];
    if (command && !afterTool) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      return res.end("data: [DONE]\n\n");
    }
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "echo: " } }] });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    send({ ...base, choices: [{ index: 0, delta: { content: /whereami/.test(last) ? system.split("\n").filter((line) => /^(Location|The previous turn)/.test(line)).join(" | ") : last.slice(-200) } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Number((last.match(/usage(\d+)/) || [])[1] || 1), completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1");
