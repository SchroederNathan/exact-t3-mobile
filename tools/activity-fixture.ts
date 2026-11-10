type Socket = { send(data: string): unknown };
type RecordValue = Record<string, unknown>;
type Item = RecordValue & {
  id: string;
  threadId: string;
  type: string;
  status: string;
  ordinal: number;
  updatedAt: string;
};
type Subscription =
  | { kind: "thread"; threadId: string }
  | { kind: "output"; threadId: string; itemId: string };
type HeldReply = { socket: Socket; requestId: string; item: Item };

const timestamp = "2026-11-10T12:00:00.000Z";
const threadIds = ["activity-mixed", "activity-only"];
const object = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const send = (socket: Socket, value: unknown) => socket.send(JSON.stringify(value));
const chunk = (socket: Socket, requestId: string, value: unknown) =>
  send(socket, { _tag: "Chunk", requestId, values: [value] });
const success = (socket: Socket, requestId: string, value: unknown) =>
  send(socket, { _tag: "Exit", requestId, exit: { _tag: "Success", value } });
const failure = (socket: Socket, requestId: string, message: string) =>
  send(socket, { _tag: "Exit", requestId, exit: {
    _tag: "Failure", cause: [{ _tag: "Fail", error: { message } }],
  } });
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  "access-control-allow-origin": "*",
} });

export class ActivityFixture {
  readonly threads = threadIds.map((id) => ({
    id, projectId: "active",
    title: id === "activity-mixed" ? "Tool activity showcase" : "Tools without messages",
    status: "running", runtimeMode: "full-access", updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
  }));
  readonly config: RecordValue;
  private sequence = 20;
  private subscriptions = new Map<Socket, Map<string, Subscription>>();
  private reads = new Map<string, number>();
  private streamStarts = new Map<string, number>();
  private held: HeldReply[] = [];
  private finished = new Set<string>();
  private output = "Starting deterministic command.\n";
  private interruptedStreams = 0;

  constructor(streaming = true) {
    this.config = { commandOutputStreaming: streaming };
  }

  private item(threadId: string, id: string, type: string, ordinal: number, fields: RecordValue): Item {
    const running = (id === "command-live" || id === "mcp-held") && !this.finished.has(id);
    return {
      id, threadId, type, ordinal, runId: `${threadId}-run`, nodeId: null,
      providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
      title: null, status: running ? "running" : "completed", startedAt: timestamp,
      completedAt: running ? null : timestamp,
      updatedAt: this.finished.has(id) ? "2026-11-10T12:01:00.000Z" : timestamp,
      ...fields,
    };
  }

  private items(threadId: string): Item[] {
    const tool = (id: string, type: string, fields: RecordValue) => this.item(threadId, id, type, 0, fields);
    const items = [
      tool("command-ok", "command_execution", { input: "rg -n ENOENT src", outputOmitted: true, exitCode: 0 }),
      tool("command-failed", "command_execution", { input: "bun run missing-script", outputOmitted: true, exitCode: 2 }),
      tool("file-change", "file_change", {
        fileName: "src/thread-feed.ts", additions: 3, deletions: 1,
        changes: [{ operation: "modify", path: "src/thread-feed.ts" }],
      }),
      tool("file-search", "file_search", {
        pattern: "loadEarlier", results: [{ fileName: "src/history.ts", line: 72, preview: "await loadEarlier(threadId);" }],
      }),
      tool("web-search", "web_search", {
        patterns: ["SwiftUI DisclosureGroup"], results: [{
          title: "DisclosureGroup", url: "https://developer.apple.com/documentation/swiftui/disclosuregroup",
          snippet: "A view that shows or hides content based on a disclosure control.",
        }],
      }),
      tool("mcp-ok", "dynamic_tool", {
        toolName: "mcp__t3_code__t3_thread_read", input: { truncated: true, summary: "Read the fixture thread" }, outputOmitted: true,
      }),
      tool("mcp-error", "dynamic_tool", {
        toolName: "mcp__fixture__read_file", input: { path: "missing.txt" }, output: { isError: true }, outputOmitted: true,
      }),
      tool("mcp-empty", "dynamic_tool", { toolName: "mcp__fixture__empty", input: {}, outputOmitted: true }),
      tool("mcp-missing", "dynamic_tool", { toolName: "mcp__fixture__removed_output", input: {}, outputOmitted: true }),
      tool("mcp-retry", "dynamic_tool", { toolName: "mcp__fixture__retry_output", input: {}, outputOmitted: true }),
      tool("mcp-large", "dynamic_tool", { toolName: "mcp__fixture__large_output", input: { lines: 4096 }, outputOmitted: true }),
      tool("mcp-held", "dynamic_tool", { toolName: "mcp__fixture__held_output", input: { hold: true }, outputOmitted: true }),
      tool("command-live", "command_execution", {
        input: "bun run fixture:stream", outputOmitted: true,
        ...(this.finished.has("command-live") ? { exitCode: 0 } : {}),
      }),
      this.item("ancestor-tool-thread", "ancestor-mcp", "dynamic_tool", 0, {
        toolName: "mcp__fixture__inherited_output", input: { source: "ancestor-tool-thread" }, outputOmitted: true,
      }),
    ];
    if (threadId === "activity-mixed") {
      items.unshift(tool("user-message", "user_message", { text: "Show commands, edits, searches, and MCP calls.", attachments: [] }));
      items.push(tool("assistant-message", "assistant_message", { text: "The tool results above belong to this conversation.", attachments: [] }));
    }
    return items.map((item, ordinal) => ({ ...item, ordinal }));
  }

  private find(threadId: string, itemId: string): Item | undefined {
    if (threadId === "ancestor-tool-thread" && itemId === "ancestor-mcp")
      return this.items("activity-only").find((item) => item.id === itemId);
    if (!threadIds.includes(threadId) || itemId === "ancestor-mcp") return;
    return this.items(threadId).find((item) => item.id === itemId);
  }

  private full(item: Item): Item {
    const { outputOmitted: _omitted, ...base } = item;
    const content = (value: string) => ({ content: [{ type: "text", text: value }] });
    switch (item.id) {
      case "command-ok": return { ...base, output: "src/errors.ts:4: const text = 'ENOENT';\nSearch succeeded.\n" };
      case "command-failed": return { ...base, output: "error: Script not found: missing-script\n" };
      case "command-live": return { ...base, output: this.output };
      case "file-change": return { ...base, diffStr: "--- a/src/thread-feed.ts\n+++ b/src/thread-feed.ts\n@@ -1 +1,3 @@\n-export const rows = [];\n+export const rows = history.feed();\n+const tools = rows.filter(row => row.kind === 'activity');\n+render(tools);" };
      case "mcp-ok": return { ...base, input: { threadId: item.threadId, limit: 20, empty: "", nullable: null }, output: content("Read 20 items from the fixture thread.") };
      case "mcp-error": return { ...base, output: { ...content("File missing.txt was not found."), isError: true } };
      case "mcp-empty": return { ...base, output: {} };
      case "mcp-retry": return { ...base, output: content("Output loaded after the retry.") };
      case "mcp-large": return { ...base, output: content(Array.from({ length: 4096 }, (_, index) => `Line ${String(index + 1).padStart(4, "0")}: bounded output remains inside its expandable row.`).join("\n").slice(0, 240 * 1024) + "\n… output truncated for transport") };
      case "mcp-held": return { ...base, output: content(this.finished.has(item.id) ? "Final completed output." : "Earlier running output.") };
      case "ancestor-mcp": return { ...base, output: content("Fetched from ancestor-tool-thread using the source item identity.") };
      default: return base;
    }
  }

  private watch(socket: Socket, requestId: string, subscription: Subscription) {
    let entries = this.subscriptions.get(socket);
    if (!entries) this.subscriptions.set(socket, entries = new Map());
    entries.set(requestId, subscription);
  }

  receive(socket: Socket, input: unknown): boolean {
    const frame = object(input);
    if (frame._tag === "Interrupt") {
      const entries = this.subscriptions.get(socket);
      const id = text(frame.requestId);
      if (entries?.get(id)?.kind === "output") this.interruptedStreams++;
      return entries?.delete(id) ?? false;
    }
    if (frame._tag !== "Request") return false;
    const requestId = text(frame.id), payload = object(frame.payload);
    const threadId = text(payload.threadId), itemId = text(payload.itemId);
    if (frame.tag === "orchestration.subscribeThread" && threadIds.includes(threadId)) {
      this.watch(socket, requestId, { kind: "thread", threadId });
      const items = this.items(threadId);
      chunk(socket, requestId, {
        kind: "snapshot", snapshotSequence: this.sequence, historyCursor: null, hasMoreHistory: false,
        latestLocalTurnOrdinal: items.length - 1,
        projection: {
          thread: this.threads.find((thread) => thread.id === threadId), messages: [],
          turnItems: items.filter((item) => item.threadId === threadId),
          runs: [{ id: `${threadId}-run`, status: "running" }], attempts: [],
          visibleTurnItems: items.map((item, position) => ({
            position, visibility: item.threadId === threadId ? "local" : "inherited",
            sourceThreadId: item.threadId, sourceItemId: item.id, item,
          })),
        },
      });
      chunk(socket, requestId, { kind: "synchronized" });
      return true;
    }
    if (frame.tag !== "orchestration.getTurnItem" && frame.tag !== "orchestration.subscribeCommandOutput") return false;
    const item = this.find(threadId, itemId);
    if (!item) {
      failure(socket, requestId, "No fixture item at this source thread and item identity.");
      return true;
    }
    const key = `${threadId}/${itemId}`;
    if (frame.tag === "orchestration.getTurnItem") {
      const count = (this.reads.get(key) ?? 0) + 1;
      this.reads.set(key, count);
      if (itemId === "mcp-retry" && count === 1) failure(socket, requestId, "Fixture output temporarily unavailable.");
      else if (itemId === "mcp-held" && !this.finished.has(itemId)) this.held.push({ socket, requestId, item: this.full(item) });
      else success(socket, requestId, { item: itemId === "mcp-missing" ? null : this.full(item) });
      return true;
    }
    if (!this.config.commandOutputStreaming || item.type !== "command_execution") {
      failure(socket, requestId, "No such command.");
      return true;
    }
    this.streamStarts.set(key, (this.streamStarts.get(key) ?? 0) + 1);
    const running = item.status === "running";
    chunk(socket, requestId, { kind: "replace", text: this.full(item).output, truncated: false, running });
    if (running) this.watch(socket, requestId, { kind: "output", threadId, itemId });
    else success(socket, requestId, null);
    return true;
  }

  close(socket: Socket) {
    this.subscriptions.delete(socket);
    this.held = this.held.filter((reply) => reply.socket !== socket);
  }

  private emitItem(itemId: string) {
    this.sequence++;
    for (const [socket, entries] of this.subscriptions) {
      for (const [requestId, entry] of entries) {
        if (entry.kind !== "thread") continue;
        chunk(socket, requestId, { kind: "event", sequence: this.sequence, event: {
          type: "turn-item.updated", threadId: entry.threadId, payload: this.find(entry.threadId, itemId),
        } });
      }
    }
  }

  state() {
    return {
      reads: Object.fromEntries(this.reads), streams: Object.fromEntries(this.streamStarts),
      activeStreams: [...this.subscriptions.values()].flatMap((entries) => [...entries.values()]).filter((entry) => entry.kind === "output").length,
      interruptedStreams: this.interruptedStreams, heldReplies: this.held.length,
      completedItems: [...this.finished], outputCharacters: this.output.length,
    };
  }

  async http(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/activities")) return;
    if (path === "/fixture/activities" && request.method === "GET") return json(this.state());
    if (request.method !== "POST") return json({ error: "Use POST for activity fixture controls." }, 405);
    if (path === "/fixture/activities/release") {
      const replies = this.held.splice(0);
      for (const reply of replies) success(reply.socket, reply.requestId, { item: reply.item });
      return json({ released: replies.length, ...this.state() });
    }
    const raw = await request.text();
    let payload: RecordValue;
    try { payload = object(raw ? JSON.parse(raw) : {}); }
    catch { return json({ error: "Expected a JSON object." }, 400); }
    if (path === "/fixture/activities/append") {
      if (this.finished.has("command-live")) return json({ error: "Command already completed." }, 409);
      const appended = text(payload.text) || "Appended output from the fixture control.\n";
      this.output += appended;
      for (const [socket, entries] of this.subscriptions) for (const [requestId, entry] of entries) {
        if (entry.kind === "output" && entry.itemId === "command-live")
          chunk(socket, requestId, { kind: "append", text: appended, truncated: false, running: true });
      }
      return json(this.state());
    }
    if (path === "/fixture/activities/finish") {
      const itemId = text(payload.itemId) || "command-live";
      if (itemId !== "command-live" && itemId !== "mcp-held") return json({ error: "Only command-live and mcp-held can finish." }, 400);
      if (this.finished.has(itemId)) return json(this.state());
      this.finished.add(itemId);
      this.emitItem(itemId);
      for (const [socket, entries] of this.subscriptions) for (const [requestId, entry] of entries) {
        if (entry.kind === "output" && entry.itemId === itemId) {
          chunk(socket, requestId, { kind: "append", text: "", truncated: false, running: false });
          success(socket, requestId, null);
          entries.delete(requestId);
        }
      }
      return json(this.state());
    }
    return json({ error: "Unknown activity fixture control." }, 404);
  }
}
