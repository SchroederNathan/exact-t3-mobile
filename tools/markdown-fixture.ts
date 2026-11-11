type RecordValue = Record<string, unknown>;
type Socket = { send(data: string): unknown };
type Message = { id: string; role: "user" | "assistant"; text: string; streaming?: boolean };
type Subscription = { requestId: string; threadId: string };

const timestamp = "2026-11-10T13:00:00.000Z";
const object = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const chunk = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const success = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));
const failure = (socket: Socket, requestId: string, message: string) =>
  socket.send(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message } }] },
    }),
  );
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "access-control-allow-origin": "*" } });
const fence = (language: string, source: string) => `\`\`\`${language}\n${source}\n\`\`\``;
const sampleCode = [
  'const greeting: string = "Hello 🙂, café, 東京";',
  'const literal = "&amp; <tag> \\n";',
  "\tconst indented = { count: 42, ready: true };",
  `const longLine = "${"horizontal-content-".repeat(18)}RIGHT EDGE";`,
  "export function clamp(value: number, min = 0, max = 100) {",
  "  // Preserve indentation and the final result.",
  "  return Math.min(max, Math.max(min, value));",
  "}",
].join("\n");
const inline = [
  "**Strong**, *italic*, ***both***, ~~removed~~, and `a < b && café🙂`.",
  "First soft line.",
  "Second soft line.",
  "Hard break follows.  ",
  "After hard break.",
  "",
  "Escapes: \\*literal asterisks\\* and \\[literal brackets\\]. Entities: &amp; &#x1F642; &NotEqualTilde;.",
  "",
  "[Reference guide][guide] and [inline website](https://example.com/inline).",
  "",
  '[guide]: https://example.com/reference "Reference title"',
].join("\n");
const table = [
  "| Left label | Center value | Right count | Wide description |",
  "| :--- | :---: | ---: | :--- |",
  "| **Alpha** | `A\\|B` | 12 | A deliberately wide sentence with several words, **strong text**, and a [link](https://example.com/table). |",
  "| *Beta* | café 🙂 | 24000 | Second row wraps within its column while every header stays aligned. |",
  "| Gamma | ~~old~~ new | -3 | Final table row. |",
].join("\n");
const streamStart = [
  "The closed fence below stays usable while the next fence streams.",
  "",
  fence("json", '{"ready": true, "count": 2}'),
  "",
  "This TypeScript fence is still open:",
  "",
  '```typescript\nconst greeting = "Hello 🙂";\n',
].join("\n");

export class MarkdownFixture {
  readonly workspaceRoot: string;
  private sequence = 100;
  private streamText = streamStart;
  private streamClosed = false;
  private streamFinished = false;
  private subscriptions = new Map<Socket, Subscription[]>();
  private fileReads: RecordValue[] = [];
  private searches: RecordValue[] = [];
  private detailReads: string[] = [];
  private readonly files: Map<string, string>;

  constructor(
    readonly environmentId: string,
    readonly projectId: string,
    private readonly threadChanged: (thread: RecordValue, sequence: number) => void = () => {},
  ) {
    this.workspaceRoot = `/workspace/${environmentId}`;
    const names = [
      "src/fixture.ts",
      "docs/My File.ts",
      "docs/literal%20name.ts",
      "docs/é space.md",
      "src/deep/needle.ts",
      "src/first/duplicate.ts",
      "src/second/duplicate.ts",
      "/tmp/fixture-outside.ts",
    ];
    this.files = new Map(
      names.map((path) => [
        path,
        Array.from(
          { length: 80 },
          (_, index) =>
            `export const line${String(index + 1).padStart(3, "0")} = ${JSON.stringify(`${environmentId}:${path}:LINE ${index + 1}`)};`,
        ).join("\n") + "\n",
      ]),
    );
  }

  get threads() {
    const rows =
      this.environmentId === "fixture"
        ? [
            ["markdown-showcase", "Markdown showcase"],
            ["markdown-stream", "Markdown streaming fence"],
            ["markdown-offscreen", "Markdown offscreen fences"],
            ["markdown-large", "Markdown large single message"],
            ["markdown-limits", "Markdown highlight limits"],
            ["markdown-target", "Primary Markdown target"],
            ["markdown-duplicate", "Primary duplicate thread"],
          ]
        : this.environmentId === "secondary"
          ? [
              ["markdown-target", "Secondary Markdown target"],
              ["markdown-duplicate", "Secondary duplicate thread"],
              ["remote-unique", "Unique remote thread"],
              ["remote-shared", "Secondary ambiguous thread"],
              ["markdown-encoded%2Fid", "Literal percent thread"],
            ]
          : [["remote-shared", "Third ambiguous thread"]];
    return rows.map(([id, title]) => ({
      id: id!,
      title: title!,
      projectId: this.projectId,
      worktreePath: this.workspaceRoot,
      status: id === "markdown-stream" && !this.streamFinished ? "running" : "idle",
      runtimeMode: "full-access",
      updatedAt: timestamp,
      latestUserMessageAt: timestamp,
      modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
    }));
  }

  private links() {
    return [
      "## File links",
      "",
      "[Relative line 12](src/fixture.ts:12:4) · [Absolute line 24](file:///workspace/fixture/src/fixture.ts#L24C3)",
      "",
      "[Absolute colon line 30](/workspace/fixture/src/fixture.ts:30:2) · [Encoded space line 12](docs/My%20File.ts#L12C4)",
      "",
      "[Decode percent once](docs/literal%2520name.ts:7:2) · [Unicode path](docs/%C3%A9%20space.md#L18)",
      "",
      "[Unique basename](needle.ts:11) · [Ambiguous basename](duplicate.ts:4)",
      "",
      "[Permission error](src/denied.ts:5) · [Missing file](src/missing.ts:5) · [Absolute outside workspace](/tmp/fixture-outside.ts:9)",
      "",
      "## Thread links",
      "",
      "[Local v1 target](t3-thread://v1/markdown-target) · [Local duplicate wins](t3-thread://v1/markdown-duplicate)",
      "",
      "[Explicit secondary target](t3-thread://v2/secondary/markdown-target) · [Unique remote fallback](t3-thread://v1/remote-unique)",
      "",
      "[Ambiguous when third environment is paired](t3-thread://v1/remote-shared)",
      "",
      "[Literal percent ID](t3-thread://v2/secondary/markdown-encoded%2Fid) · [Hosted percent ID](https://app.t3.codes/threads/secondary/markdown-encoded%252Fid)",
      "",
      "[Missing thread](t3-thread://v2/fixture/markdown-missing) · [Unavailable environment](t3-thread://v2/unavailable/markdown-target)",
      "",
      "Literal code must stay inert: `t3-thread://v2/secondary/markdown-target` and `src/fixture.ts:12`.",
    ].join("\n");
  }

  private messages(threadId: string): Message[] {
    const assistant = (id: string, source: string): Message => ({
      id,
      role: "assistant",
      text: source,
    });
    if (threadId === "markdown-showcase")
      return [
        { id: "user-rich", role: "user", text: inline },
        assistant("assistant-rich", inline),
        assistant(
          "headings-lists",
          [
            "# Heading one",
            "## Heading two",
            "### Heading three",
            "#### Heading four",
            "##### Heading five",
            "###### Heading six",
            "",
            "> Quoted **strong** text.",
            ">",
            "> - A quoted list item",
            ">   - Nested *emphasis*",
            "",
            "1. Ordered first",
            "   - Nested bullet with `code`",
            "2. Ordered second",
            "",
            "---",
            "",
            "Unknown HTML stays visible: <custom>literal text</custom>. Image fallback: ![Fixture image alt](https://example.com/image.png)",
          ].join("\n"),
        ),
        assistant("code-copy", fence("typescript", sampleCode)),
        assistant("wide-table", table),
        {
          id: "user-code-table",
          role: "user",
          text: [
            "A user can format code and tables too.",
            "",
            fence("json", '{"user": true, "unicode": "🙂"}'),
            "",
            "| User | Value |",
            "| --- | ---: |",
            "| **Enabled** | 7 |",
          ].join("\n"),
        },
        assistant("scoped-links", this.links()),
      ];
    if (threadId === "markdown-stream")
      return [
        {
          id: "stream-request",
          role: "user",
          text: "Keep the closed code usable while the final fence streams.",
        },
        {
          id: "stream-answer",
          role: "assistant",
          text: this.streamText,
          streaming: !this.streamFinished,
        },
      ];
    if (threadId === "markdown-offscreen")
      return Array.from({ length: 96 }, (_, index) =>
        assistant(
          `offscreen-${index}`,
          [
            `## Fence ${index + 1} of 96`,
            "",
            fence(
              "typescript",
              `export const visibleFence${index + 1}: number = ${index + 1};\n// OFFSCREEN FENCE ${index + 1}`,
            ),
          ].join("\n"),
        ),
      );
    if (threadId === "markdown-large")
      return [
        assistant(
          "large-answer",
          Array.from({ length: 100 }, (_, index) =>
            [
              `## Large message section ${index + 1}`,
              "",
              "This single message keeps **inline formatting**, *emphasis*, and `code` readable while the transcript scrolls. ".repeat(
                8,
              ),
              "",
              ...(index % 10 === 0
                ? [fence("typescript", `const largeSection${index + 1} = ${index + 1};`), ""]
                : []),
            ].join("\n"),
          ).join("\n"),
        ),
      ];
    if (threadId === "markdown-limits")
      return [
        assistant(
          "over-byte-limit",
          fence("typescript", `const overByteLimit = "${"x".repeat(51 * 1024)}";`),
        ),
        assistant(
          "over-line-limit",
          fence(
            "typescript",
            Array.from({ length: 2001 }, (_, index) => `// ${index + 1}`).join("\n"),
          ),
        ),
        assistant(
          "limit-footer",
          "Both preceding fences are complete and selectable; the highlighter uses its plain-text fallback.",
        ),
      ];
    return [
      assistant(
        "target-answer",
        `# ${this.environmentId.toUpperCase()} TARGET\n\nOpened **${threadId}** on **${this.environmentId}**. Back should return to the source message.\n\n[Local file line 12](src/fixture.ts:12:4)`,
      ),
    ];
  }

  private items(threadId: string) {
    return this.messages(threadId).map((message, ordinal) => ({
      id: `${threadId}:${message.id}`,
      messageId: message.id,
      threadId,
      ordinal,
      runId: `${threadId}-run`,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      type: `${message.role}_message`,
      status: message.streaming ? "running" : "completed",
      streaming: message.streaming === true,
      title: null,
      text: message.text,
      attachments: [],
      ...(message.role === "user" ? { inputIntent: "turn_start" } : {}),
      startedAt: timestamp,
      completedAt: message.streaming ? null : timestamp,
      updatedAt: new Date(Date.parse(timestamp) + this.sequence * 1000).toISOString(),
    }));
  }

  receive(socket: Socket, input: unknown): boolean {
    const frame = object(input);
    const entries = this.subscriptions.get(socket);
    if (frame._tag === "Interrupt") {
      const retained = entries?.filter((entry) => entry.requestId !== frame.requestId);
      if (!entries || retained?.length === entries.length) return false;
      this.subscriptions.set(socket, retained!);
      return true;
    }
    if (frame._tag !== "Request") return false;
    const payload = object(frame.payload),
      requestId = text(frame.id),
      threadId = text(payload.threadId);
    if (
      ["projects.readFile", "projects.searchEntries", "projects.listEntries"].includes(
        text(frame.tag),
      )
    ) {
      const cwd = text(payload.cwd);
      if (frame.tag === "projects.readFile")
        this.fileReads.push({ cwd, relativePath: text(payload.relativePath) });
      else
        this.searches.push({
          method: frame.tag,
          cwd,
          query: payload.query,
          directoryPath: payload.directoryPath,
          limit: payload.limit,
        });
      if (cwd !== this.workspaceRoot) {
        failure(socket, requestId, `Fixture workspace mismatch on ${this.environmentId}: ${cwd}`);
        return true;
      }
      if (frame.tag === "projects.readFile") {
        const requested = text(payload.relativePath);
        const path = requested.startsWith(`${cwd}/`)
          ? requested.slice(cwd.length + 1)
          : requested.replace(/^\.\//, "");
        if (path === "src/denied.ts")
          failure(socket, requestId, `Fixture permission denied on ${this.environmentId}: ${path}`);
        else if (this.files.has(path)) {
          const contents = this.files.get(path)!;
          success(socket, requestId, {
            relativePath: requested,
            contents,
            byteLength: new TextEncoder().encode(contents).length,
            truncated: false,
            exists: true,
          });
        } else if (payload.allowMissing === true)
          success(socket, requestId, {
            relativePath: requested,
            contents: "",
            byteLength: 0,
            truncated: false,
            exists: false,
          });
        else failure(socket, requestId, `Fixture file not found on ${this.environmentId}: ${path}`);
      } else if (frame.tag === "projects.searchEntries") {
        const query = text(payload.query).toLowerCase();
        const matches = [...this.files.keys()].filter(
          (path) => !path.startsWith("/") && path.toLowerCase().includes(query),
        );
        const limit =
          typeof payload.limit === "number" ? Math.max(1, Math.floor(payload.limit)) : 100;
        success(socket, requestId, {
          entries:
            payload.kind === "directory"
              ? []
              : matches.slice(0, limit).map((path) => ({ path, kind: "file" })),
          truncated: matches.length > limit,
        });
      } else {
        const prefix = text(payload.directoryPath).replace(/\/$/, "");
        const children = new Map<string, string>();
        for (const path of this.files.keys()) {
          if (path.startsWith("/") || (prefix && !path.startsWith(`${prefix}/`))) continue;
          const rest = prefix ? path.slice(prefix.length + 1) : path;
          const part = rest.split("/")[0]!;
          children.set(
            prefix ? `${prefix}/${part}` : part,
            rest.includes("/") ? "directory" : "file",
          );
        }
        success(socket, requestId, {
          entries: [...children].map(([path, kind]) => ({ path, kind })),
          truncated: false,
        });
      }
      return true;
    }
    if (frame.tag !== "orchestration.subscribeThread" && frame.tag !== "orchestration.getTurnItem")
      return false;
    const thread = this.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      if (!/^(markdown-|remote-)/.test(threadId)) return false;
      failure(socket, requestId, `Fixture thread not found on ${this.environmentId}: ${threadId}`);
      return true;
    }
    const items = this.items(threadId);
    if (frame.tag === "orchestration.getTurnItem") {
      this.detailReads.push(`${threadId}/${text(payload.itemId)}`);
      success(socket, requestId, {
        item: items.find((item) => item.id === payload.itemId) ?? null,
      });
      return true;
    }
    this.subscriptions.set(socket, [...(entries ?? []), { requestId, threadId }]);
    chunk(socket, requestId, {
      kind: "snapshot",
      snapshotSequence: this.sequence,
      historyCursor: null,
      hasMoreHistory: false,
      latestLocalTurnOrdinal: items.length - 1,
      projection: {
        thread,
        messages: [],
        turnItems: items,
        runs: [
          { id: `${threadId}-run`, status: thread.status === "running" ? "running" : "completed" },
        ],
        attempts: [],
        visibleTurnItems: items.map((item, position) => ({
          position,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
      },
    });
    chunk(socket, requestId, { kind: "synchronized" });
    return true;
  }

  close(socket: Socket) {
    this.subscriptions.delete(socket);
  }

  private emitStream() {
    const itemSequence = ++this.sequence;
    const item = this.items("markdown-stream").find(
      (entry) => entry.messageId === "stream-answer",
    )!;
    const runSequence = ++this.sequence;
    const thread = this.threads.find((entry) => entry.id === "markdown-stream")!;
    for (const [socket, entries] of this.subscriptions)
      for (const { requestId, threadId } of entries) {
        if (threadId !== "markdown-stream") continue;
        chunk(socket, requestId, {
          kind: "event",
          sequence: itemSequence,
          event: { type: "turn-item.updated", threadId, payload: item },
        });
        chunk(socket, requestId, {
          kind: "event",
          sequence: runSequence,
          event: {
            type: "run.updated",
            threadId,
            payload: {
              id: `${threadId}-run`,
              status: this.streamFinished ? "completed" : "running",
            },
          },
        });
      }
    this.threadChanged(thread, this.sequence);
  }

  state() {
    return {
      environmentId: this.environmentId,
      workspaceRoot: this.workspaceRoot,
      fileReads: this.fileReads,
      searches: this.searches,
      detailReads: this.detailReads,
      subscriptions: [...this.subscriptions.values()].flat().map(({ threadId }) => threadId),
      stream: {
        closed: this.streamClosed,
        finished: this.streamFinished,
        characters: this.streamText.length,
        revision: this.sequence,
      },
      threads: this.threads.map(({ id, title }) => ({ id, title })),
    };
  }

  async http(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/markdown")) return;
    if (path === "/fixture/markdown" && request.method === "GET") return json(this.state());
    if (path === "/fixture/markdown/copy" && request.method === "GET") return json({ sampleCode });
    if (request.method !== "POST")
      return json({ error: "Use POST for Markdown fixture controls." }, 405);
    if (this.environmentId !== "fixture")
      return json({ error: "Streaming controls belong to the primary fixture." }, 409);
    let payload: RecordValue;
    try {
      const body = await request.text();
      payload = object(body ? JSON.parse(body) : {});
    } catch {
      return json({ error: "Expected a JSON object." }, 400);
    }
    if (path === "/fixture/markdown/append") {
      if (this.streamFinished)
        return json({ error: "The message is finished; reset it first." }, 409);
      const addition =
        typeof payload.text === "string" ? payload.text : "\nconst appended: number = 42;\n";
      if (this.streamText.length + addition.length > 128 * 1024)
        return json({ error: "Fixture stream limit exceeded." }, 413);
      this.streamText += addition;
    } else if (path === "/fixture/markdown/close") {
      if (this.streamFinished)
        return json({ error: "The message is finished; reset it first." }, 409);
      if (!this.streamClosed)
        this.streamText += "\n```\n\nThe fence is closed while the assistant remains streaming.\n";
      this.streamClosed = true;
    } else if (path === "/fixture/markdown/finish") {
      this.streamFinished = true;
    } else if (path === "/fixture/markdown/reset") {
      this.streamText = streamStart;
      this.streamClosed = false;
      this.streamFinished = false;
      this.fileReads = [];
      this.searches = [];
      this.detailReads = [];
    } else return json({ error: "Unknown Markdown fixture control." }, 404);
    this.emitStream();
    return json(this.state());
  }
}
