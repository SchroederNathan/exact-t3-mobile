type RecordValue = Record<string, unknown>;
type Socket = { send(data: string): unknown };
const timestamp = "2026-11-18T12:00:00Z";
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const chunk = (socket: Socket, requestId: string, value: unknown) => socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const success = (socket: Socket, requestId: string, value: unknown) => socket.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));

export class ComposerFixture {
  readonly cwd = "/fixture/project";
  readonly commands: RecordValue[] = [];
  readonly provider = {
    slashCommands: [{ name: "goal", description: "Set a goal" }],
    skills: [{ name: "review", path: "/fixture/skills/review/SKILL.md", displayName: "Review", description: "Review the current changes", enabled: true }],
  };
  readonly threads = [{ id: "composer", projectId: "active", title: "Composer parity", status: "idle", runtimeMode: "full-access", updatedAt: timestamp, modelSelection: { instanceId: "fixture-provider", model: "fixture-model" } }];
  private subscriptions = new Map<Socket, string>();
  private sequence = 1;
  private runs: RecordValue[] = [];
  private messages: RecordValue[] = [];

  constructor() { this.reset(); }

  reset() {
    this.commands.length = 0;
    this.runs = [1, 2].map((index) => ({ id: `queued-${index}`, threadId: "composer", userMessageId: `message-${index}`, status: "queued", ordinal: index, queuePosition: index, queueHeld: true, createdAt: timestamp }));
    this.messages = [1, 2].map((index) => ({ id: `message-${index}`, threadId: "composer", role: "user", text: `Queued message ${index}`, attachments: [], createdAt: timestamp }));
    this.publish();
  }

  http(request: Request): Response | undefined {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/composer/reset") { this.reset(); return Response.json({ ok: true }); }
    if (path === "/fixture/composer/assert-queue") {
      const edited = this.commands.find((command) => command.type === "queued-run.edit");
      const cancelled = this.commands.find((command) => command.type === "queued-run.cancel");
      const resumed = this.commands.some((command) => command.type === "queue.resume");
      const started = this.commands.find((command) => command.type === "queued-run.start");
      const ok = edited?.runId === "queued-1" && edited?.text === "Edited server message" && cancelled?.runId === "queued-2" && started?.runId === "queued-1" && resumed;
      return Response.json({ ok, commands: this.commands }, { status: ok ? 200 : 409 });
    }
  }

  receive(socket: Socket, input: unknown): boolean {
    const frame = record(input);
    if (frame._tag === "Interrupt") {
      if (this.subscriptions.get(socket) !== frame.requestId) return false;
      this.subscriptions.delete(socket);
      return true;
    }
    if (frame._tag !== "Request") return false;
    const payload = record(frame.payload);
    const requestId = String(frame.id);
    if (frame.tag === "server.refreshProviders") {
      success(socket, requestId, { providers: [{ ...this.provider, instanceId: "fixture-provider", driver: "codex", installed: true, enabled: true, auth: { status: "authenticated" }, models: [{ slug: "fixture-model", name: "Fixture model" }] }] });
      return true;
    }
    if (frame.tag === "projects.searchEntries") {
      const query = String(payload.query ?? "").toLowerCase();
      success(socket, requestId, { entries: [{ path: "src/App.ts", kind: "file" }, { path: "src/components", kind: "directory" }].filter((entry) => entry.path.toLowerCase().includes(query)), truncated: false });
      return true;
    }
    if (frame.tag === "projects.readFile") {
      const path = String(payload.relativePath ?? "");
      success(socket, requestId, { relativePath: path, contents: path === "src/App.ts" ? "export const composerParity = true;\n" : "# Review\nReview the current changes.\n", truncated: false });
      return true;
    }
    if (payload.threadId !== "composer") return false;
    if (frame.tag === "orchestration.subscribeThread") {
      this.subscriptions.set(socket, requestId);
      this.publish(socket);
      return true;
    }
    if (frame.tag !== "orchestration.dispatchCommand") return false;
    const type = String(payload.type);
    if (!["queued-run.edit", "queued-run.cancel", "queued-run.start", "queue.resume"].includes(type)) return false;
    const run = this.runs.find((candidate) => candidate.id === payload.runId && candidate.status === "queued");
    if (type !== "queue.resume" && !run) {
      socket.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Queued run no longer exists" } }] } }));
      return true;
    }
    this.commands.push(payload);
    if (type === "queue.resume") this.runs = this.runs.map((entry) => ({ ...entry, queueHeld: false }));
    if (type === "queued-run.edit") this.messages = this.messages.map((entry) => entry.id === run!.userMessageId ? { ...entry, text: payload.text, attachments: payload.attachments, context: payload.context } : entry);
    if (type === "queued-run.cancel") run!.status = "cancelled";
    if (type === "queued-run.start") run!.status = "running";
    this.sequence++;
    this.publish();
    success(socket, requestId, { sequence: this.sequence });
    return true;
  }

  close(socket: Socket) { this.subscriptions.delete(socket); }

  private publish(only?: Socket) {
    for (const [socket, requestId] of this.subscriptions) {
      if (only && socket !== only) continue;
      chunk(socket, requestId, { kind: "snapshot", snapshotSequence: this.sequence, projection: { thread: this.threads[0], messages: this.messages, runs: this.runs, providerThreads: [], providerSessions: [], turnItems: [] } });
      chunk(socket, requestId, { kind: "synchronized" });
    }
  }
}
