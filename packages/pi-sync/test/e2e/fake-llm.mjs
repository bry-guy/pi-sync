import http from "node:http";
const port = Number(process.env.FAKE_LLM_PORT || 18081);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let last = "";
    try {
      const j = JSON.parse(body);
      const u = [...j.messages].reverse().find((m) => m.role === "user");
      last = typeof u?.content === "string" ? u.content : (u?.content || []).map((p) => p.text || "").join("");
    } catch {}
    const delay = Number((last.match(/sleep(\d+)/) || [])[1] || 0);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "echo" };
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "echo: " } }] });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    send({ ...base, choices: [{ index: 0, delta: { content: last.slice(-200) } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1");
