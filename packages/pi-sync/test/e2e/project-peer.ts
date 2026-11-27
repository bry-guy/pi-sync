// Stand-in for pi-projects in the e2e checks: links each session to project "eco" as pi-projects does, and exposes
// pi-sync's public handle as commands.
export default function projectPeer(pi: any) {
  const handle = () => (globalThis as any)[Symbol.for("pi-sync.v1")];
  pi.on("session_start", (_event: unknown, ctx: any) => {
    const linked = ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "pi-project");
    if (!linked) pi.appendEntry("pi-project", { projectId: "eco-id", name: "eco", rel: "" });
  });
  pi.registerCommand("handle-list", {
    description: "Print pi-sync's list()",
    handler: async (_args: string, ctx: any) => {
      const result = await handle().list().then((list: unknown) => JSON.stringify(list), () => "rejected");
      ctx.ui.notify(`handle-list ${result}`, "info");
    },
  });
  pi.registerCommand("handle-open", {
    description: "Call pi-sync's open()",
    handler: async (args: string, ctx: any) => handle().open(ctx, args.trim()),
  });
}
