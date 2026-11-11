type RecordValue = Record<string, unknown>;
type Socket = { send(data: string): unknown };
type Decision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
type Capability =
  | { type: "live"; providerSessionId: string; supportsFeedback?: boolean }
  | { type: "message" }
  | { type: "not_resumable"; reason: string };
type RuntimeRequest = {
  id: string;
  nodeId: string;
  providerTurnId: string | null;
  nativeRequestRef: null;
  kind: "command" | "user_input" | "auth_refresh" | "dynamic_tool_call";
  status: "pending" | "resolved" | "expired" | "cancelled";
  responseCapability: Capability;
  createdAt: string;
  resolvedAt: string | null;
  decision?: Decision;
  answers?: RecordValue;
};
type RunStatus =
  | "queued"
  | "preparing"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled";
type Run = {
  id: string;
  threadId: string;
  ordinal: number;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};
type Item = RecordValue & {
  id: string;
  threadId: string;
  runId: string;
  type: string;
  ordinal: number;
  status: string;
};
type Scenario = {
  id: string;
  title: string;
  scenario: string;
  runs: Run[];
  requests: Map<string, RuntimeRequest>;
  items: Map<string, Item>;
  windowStart: number;
};
type AuthSession = { authenticated: boolean; scopes: string[]; permissions?: string[] };
type CommandLog = {
  environmentId: string;
  command: RecordValue;
  outcome: "accepted" | "rejected";
  error?: string;
};
type HeldReceipt = { socket: Socket; requestId: string; value: unknown };
type HeldAuth = { finish(response: Response): void; session: AuthSession; status: number };
type FixtureEvent = { threadId: string; sequence: number; type: string; payload: RecordValue };

const timestamp = "2026-11-10T14:00:00.000Z";
const threadIds = [
  "controls-stop",
  "controls-approvals",
  "controls-questions",
  "controls-boundaries",
] as const;
const decisions: Decision[] = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"];
const runStatuses: RunStatus[] = [
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
];
const interruptible = new Set<RunStatus>(["preparing", "starting", "running", "waiting"]);
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
const live: Capability = {
  type: "live",
  providerSessionId: "fixture-session",
  supportsFeedback: true,
};
const blocked: Capability = {
  type: "not_resumable",
  reason: "The provider session ended. Start a new turn to continue.",
};
const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "fixture-session",
};
const approvalOptions = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow this session" },
  {
    decision: "acceptAlways",
    label: "Always allow this command",
    warning: "Future matching commands will run without asking.",
  },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel turn" },
];
const questions = [
  {
    id: "destination",
    header: "Destination",
    question: "Where should **this change** go?",
    allowCustomAnswer: true,
    options: [
      { label: "Preview", description: "Use the preview environment.", value: " preview " },
      { label: "Production", description: "Use the production environment." },
    ],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Which checks should run?",
    multiSelect: true,
    allowCustomAnswer: false,
    options: [
      { label: "Types", description: "Check TypeScript.", value: "types" },
      { label: "Tests", description: "Run focused tests.", value: "tests" },
    ],
  },
  {
    id: "release-note",
    header: "Release note",
    question: "Edit the note, or **clear it deliberately**.",
    initialAnswer: "Keep this note",
    options: [],
    allowCustomAnswer: true,
  },
  {
    id: "__proto__",
    header: "Owner",
    question: "Who should review?",
    required: false,
    allowCustomAnswer: true,
    options: [
      { label: "Maintainer", description: "Ask the current maintainer.", value: "maintainer" },
    ],
  },
];
const variants: Record<string, string[]> = {
  "controls-stop": runStatuses,
  "controls-approvals": ["options", "default", "empty", "blocked"],
  "controls-questions": ["form", "message", "blocked"],
  "controls-boundaries": ["offscreen"],
};

export class ControlsFixture {
  readonly config = { threadForceStop: true };
  private sequence = 300;
  private scenarios = new Map<string, Scenario>();
  private subscriptions = new Map<Socket, Map<string, string>>();
  private commands: CommandLog[] = [];
  private receipts: HeldReceipt[] = [];
  private receiptMode: "immediate" | "held" | "failure" = "immediate";
  private receiptError = "Fixture rejected this command. Try again.";
  private eventsHeld = false;
  private events: FixtureEvent[] = [];
  private auth: AuthSession = {
    authenticated: true,
    scopes: ["orchestration:operate"],
    permissions: ["orchestration:operate"],
  };
  private authStatus = 200;
  private holdAuth = false;
  private authReads = 0;
  private authReplies: HeldAuth[] = [];
  private online = true;
  private forceStopResult = { outcome: "killed", sharedWithThreadIds: [] as string[] };

  constructor(
    readonly environmentId: string,
    readonly projectId: string,
    private readonly threadChanged: (thread: RecordValue, sequence: number) => void = () => {},
    private readonly disconnect: () => number = () => 0,
  ) {
    for (const id of threadIds)
      this.scenarios.set(id, this.create(id, variants[id]![id === "controls-stop" ? 3 : 0]!));
  }

  get threads() {
    return [...this.scenarios.values()].map((scenario) => this.thread(scenario));
  }

  private thread(scenario: Scenario) {
    return {
      id: scenario.id,
      projectId: this.projectId,
      title: scenario.title,
      status: scenario.runs.some((run) => interruptible.has(run.status)) ? "running" : "idle",
      runtimeMode: "full-access",
      updatedAt: this.now(),
      latestUserMessageAt: timestamp,
      modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
    };
  }

  private now() {
    return new Date(Date.parse(timestamp) + this.sequence * 1000).toISOString();
  }

  private item(
    threadId: string,
    id: string,
    type: string,
    ordinal: number,
    fields: RecordValue,
  ): Item {
    return {
      id,
      threadId,
      type,
      ordinal,
      runId: "run-shared",
      nodeId: "node-shared",
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed",
      title: null,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: this.now(),
      ...fields,
    };
  }

  private request(
    kind: RuntimeRequest["kind"],
    capability: Capability = live,
    id = "request-shared",
  ): RuntimeRequest {
    return {
      id,
      nodeId: "node-shared",
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: capability,
      createdAt: timestamp,
      resolvedAt: null,
    };
  }

  private create(id: string, variant: string): Scenario {
    const title =
      {
        "controls-stop": "Stop a running turn",
        "controls-approvals": "Approval decisions",
        "controls-questions": "Agent questions",
        "controls-boundaries": "Long thread with pending question",
      }[id] ?? id;
    const scenario: Scenario = {
      id,
      title,
      scenario: variant,
      items: new Map(),
      requests: new Map(),
      windowStart: 0,
      runs: [
        {
          id: "run-shared",
          threadId: id,
          ordinal: 1,
          status:
            id === "controls-stop"
              ? (variant as RunStatus)
              : id === "controls-boundaries"
                ? "completed"
                : "running",
          createdAt: timestamp,
          updatedAt: this.now(),
        },
      ],
    };
    const add = (item: Item) => scenario.items.set(item.id, item);
    add(
      this.item(id, "intro", "assistant_message", 0, {
        messageId: "intro-message",
        streaming: false,
        text: `${this.environmentId}: ${title}. Use the fixture controls to advance each state.`,
        attachments: [],
      }),
    );
    if (id === "controls-stop") {
      scenario.runs.push({
        id: "queued-followup",
        threadId: id,
        ordinal: 2,
        status: "queued",
        createdAt: timestamp,
        updatedAt: this.now(),
      });
      add(
        this.item(id, "running-message", "assistant_message", 1, {
          messageId: "running-message",
          text: "Working on the current turn. A queued follow-up must not become the Stop target.",
          streaming: true,
          status: "running",
          completedAt: null,
        }),
      );
    } else if (id === "controls-approvals") {
      scenario.requests.set(
        "request-shared",
        this.request("command", variant === "blocked" ? blocked : live),
      );
      add(
        this.item(id, "approval-item", "approval_request", 1, {
          requestId: "request-shared",
          requestKind: "command",
          status: "running",
          completedAt: null,
          prompt: "git status --short",
          reason: "Inspect the working tree before continuing.",
          appName: "Fixture provider",
          fullAccessOverride: "ask_rule",
          ...(variant === "default" ? {} : { options: variant === "empty" ? [] : approvalOptions }),
        }),
      );
    } else {
      const messageMode = variant === "message" || id === "controls-boundaries";
      scenario.requests.set(
        "request-shared",
        this.request(
          "user_input",
          variant === "blocked" ? blocked : messageMode ? { type: "message" } : live,
        ),
      );
      add(
        this.item(id, "question-item", "user_input_request", 1, {
          requestId: "request-shared",
          questions,
          ...(messageMode ? { responseMode: "message" } : {}),
          status: "running",
          completedAt: null,
        }),
      );
      if (id === "controls-boundaries") {
        scenario.windowStart = 221;
        for (let ordinal = 2; ordinal <= 240; ordinal++)
          add(
            this.item(id, `history-${ordinal}`, "assistant_message", ordinal, {
              messageId: `history-message-${ordinal}`,
              streaming: false,
              text: `History item ${ordinal}. The pending request remains available outside the visible window.`,
            }),
          );
        scenario.requests.set("ignored-auth", this.request("auth_refresh", live, "ignored-auth"));
        scenario.requests.set(
          "ignored-tool",
          this.request("dynamic_tool_call", live, "ignored-tool"),
        );
      }
    }
    return scenario;
  }

  private row(item: Item, position: number) {
    return {
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    };
  }

  private snapshot(scenario: Scenario, socket: Socket, requestId: string) {
    const visible = [...scenario.items.values()]
      .filter((item) => item.ordinal >= scenario.windowStart)
      .sort((a, b) => a.ordinal - b.ordinal);
    const controls = [...scenario.items.values()].filter(
      (item) =>
        ["approval_request", "user_input_request"].includes(item.type) &&
        scenario.requests.get(text(item.requestId))?.status === "pending",
    );
    const rows: RecordValue[] = visible.map((item, position) => this.row(item, position));
    if (scenario.id === "controls-boundaries") {
      const inherited = this.item(
        "ancestor-thread",
        "inherited-question",
        "user_input_request",
        241,
        {
          requestId: "request-shared",
          questions: [
            {
              id: "wrong",
              header: "Inherited",
              question: "Never answer this inherited request.",
              options: [],
            },
          ],
        },
      );
      rows.push({
        position: rows.length,
        visibility: "inherited",
        sourceThreadId: inherited.threadId,
        sourceItemId: inherited.id,
        item: inherited,
      });
    }
    chunk(socket, requestId, {
      kind: "snapshot",
      snapshotSequence: this.sequence,
      historyCursor: scenario.windowStart ? `before:${scenario.windowStart}` : null,
      hasMoreHistory: scenario.windowStart > 0,
      latestLocalTurnOrdinal: Math.max(...visible.map((item) => item.ordinal)),
      projection: {
        thread: this.thread(scenario),
        messages: [],
        runs: scenario.runs,
        attempts: [],
        runtimeRequests: [...scenario.requests.values()].filter(
          (request) => request.status === "pending",
        ),
        turnItems: [...new Map([...visible, ...controls].map((item) => [item.id, item])).values()],
        visibleTurnItems: rows,
      },
    });
    chunk(socket, requestId, { kind: "synchronized" });
  }

  private emit(scenario: Scenario, type: string, payload: RecordValue) {
    const event = {
      threadId: scenario.id,
      sequence: ++this.sequence,
      type,
      payload: structuredClone(payload),
    };
    if (this.eventsHeld) this.events.push(event);
    else this.publish(event);
  }

  private publish(event: FixtureEvent) {
    for (const [socket, entries] of this.subscriptions)
      for (const [requestId, threadId] of entries) {
        if (threadId === event.threadId)
          chunk(socket, requestId, {
            kind: "event",
            sequence: event.sequence,
            event: { type: event.type, threadId, payload: event.payload },
          });
      }
  }

  private put(scenario: Scenario, item: Item) {
    scenario.items.set(item.id, item);
    this.emit(scenario, "turn-item.updated", item);
  }

  private resolve(
    scenario: Scenario,
    request: RuntimeRequest,
    status: RuntimeRequest["status"],
    fields: RecordValue = {},
  ) {
    const updated = { ...request, ...fields, status, resolvedAt: this.now() };
    scenario.requests.set(request.id, updated);
    this.emit(scenario, "runtime-request.updated", updated);
  }

  private validate(scenario: Scenario, command: RecordValue): string {
    if (
      !this.auth.authenticated ||
      !(this.auth.permissions ?? this.auth.scopes).includes("orchestration:operate")
    )
      return "Permission denied: orchestration:operate is required.";
    if (!text(command.commandId)) return "A commandId is required.";
    if (command.type === "run.interrupt") {
      const run = scenario.runs
        .filter((run) => interruptible.has(run.status))
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      return run?.id === command.runId && command.holdQueue === true
        ? ""
        : "The displayed run is no longer interruptible, or holdQueue was omitted.";
    }
    if (command.type !== "runtime-request.respond" && command.type !== "thread.user-input.dismiss")
      return "Unsupported controls fixture command.";
    const request = scenario.requests.get(text(command.requestId));
    if (!request || request.status !== "pending")
      return "The runtime request is no longer pending.";
    const item = [...scenario.items.values()]
      .filter((item) => item.requestId === request.id)
      .at(-1);
    if (command.type === "thread.user-input.dismiss")
      return request.kind === "user_input" && request.responseCapability.type === "message"
        ? ""
        : "This question needs an answer. Answer it or stop the turn.";
    if (request.responseCapability.type === "not_resumable")
      return request.responseCapability.reason;
    if (request.kind === "command") {
      if (request.responseCapability.type !== "live")
        return "Approval requires a live provider session.";
      const allowed = Array.isArray(item?.options)
        ? item.options.map((option) => object(option).decision)
        : ["accept", "acceptForSession", "decline"];
      return decisions.includes(command.decision as Decision) && allowed.includes(command.decision)
        ? ""
        : "The supplied decision is not one of this approval's options.";
    }
    if (request.kind !== "user_input") return "This runtime request is not a user control.";
    const answers = object(command.answers);
    if (request.responseCapability.type === "message") {
      const answered = (answer: unknown) =>
        typeof answer === "string"
          ? answer.trim() !== ""
          : Array.isArray(answer) &&
            answer.length > 0 &&
            answer.every((value) => typeof value === "string" && value.trim() !== "");
      const questions = Array.isArray(item?.questions) ? item.questions.map(object) : [];
      if (
        !questions.every(
          (question) => question.required === false || answered(answers[text(question.id)]),
        )
      )
        return "Answer each question before sending.";
      return questions.some((question) => answered(answers[text(question.id)]))
        ? ""
        : "Enter an answer before sending.";
    }
    return Array.isArray(item?.questions) &&
      item.questions.every((question) => {
        const id = text(object(question).id);
        return Object.hasOwn(answers, id) && answers[id] !== null && answers[id] !== undefined;
      })
      ? ""
      : "Every question requires an answer, including a deliberate empty initial answer.";
  }

  receive(socket: Socket, input: unknown): boolean {
    const frame = object(input),
      requestId = text(frame.id),
      payload = object(frame.payload);
    if (frame._tag === "Interrupt")
      return this.subscriptions.get(socket)?.delete(text(frame.requestId)) ?? false;
    if (frame._tag !== "Request") return false;
    const scenario = this.scenarios.get(text(payload.threadId));
    if (!scenario) return false;
    if (frame.tag === "orchestration.subscribeThread") {
      let entries = this.subscriptions.get(socket);
      if (!entries) this.subscriptions.set(socket, (entries = new Map()));
      entries.set(requestId, scenario.id);
      this.snapshot(scenario, socket, requestId);
      return true;
    }
    if (frame.tag === "orchestration.forceStopThread") {
      const latest = scenario.runs
        .filter((run) => run.status !== "queued")
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      const error =
        !this.auth.authenticated ||
        !(this.auth.permissions ?? this.auth.scopes).includes("orchestration:operate")
          ? "Permission denied: orchestration:operate is required."
          : text(payload.runId) && latest?.id !== payload.runId
            ? "A new turn started, so nothing was force stopped."
            : this.receiptMode === "failure"
              ? this.receiptError
              : "";
      this.commands.push({
        environmentId: this.environmentId,
        command: { type: "thread.force-stop", ...structuredClone(payload) },
        outcome: error ? "rejected" : "accepted",
        ...(error ? { error } : {}),
      });
      if (error) failure(socket, requestId, error);
      else {
        if (latest) {
          latest.status = "interrupted";
          latest.updatedAt = this.now();
          this.emit(scenario, "run.updated", { ...latest });
          this.threadChanged(this.thread(scenario), this.sequence);
        }
        const value = structuredClone(this.forceStopResult);
        if (this.receiptMode === "held") this.receipts.push({ socket, requestId, value });
        else success(socket, requestId, value);
      }
      return true;
    }
    if (frame.tag !== "orchestration.dispatchCommand") return false;
    const error =
      this.validate(scenario, payload) || (this.receiptMode === "failure" ? this.receiptError : "");
    this.commands.push({
      environmentId: this.environmentId,
      command: structuredClone(payload),
      outcome: error ? "rejected" : "accepted",
      ...(error ? { error } : {}),
    });
    if (error) {
      failure(socket, requestId, error);
      return true;
    }
    if (payload.type === "run.interrupt") {
      this.put(
        scenario,
        this.item(
          scenario.id,
          `interrupt-${text(payload.runId)}`,
          "run_interrupt_request",
          this.nextOrdinal(scenario),
          {
            runId: payload.runId,
            status: "running",
            completedAt: null,
            message: "Waiting for the provider to stop.",
          },
        ),
      );
    } else {
      this.resolve(
        scenario,
        scenario.requests.get(text(payload.requestId))!,
        "resolved",
        payload.type === "thread.user-input.dismiss"
          ? { decision: "cancel" }
          : payload.decision !== undefined
            ? { decision: payload.decision }
            : { answers: object(payload.answers) },
      );
    }
    if (this.receiptMode === "held")
      this.receipts.push({ socket, requestId, value: { sequence: this.sequence } });
    else success(socket, requestId, { sequence: this.sequence });
    return true;
  }

  private nextOrdinal(scenario: Scenario) {
    return Math.max(...[...scenario.items.values()].map((item) => item.ordinal)) + 1;
  }

  close(socket: Socket) {
    this.subscriptions.delete(socket);
    this.receipts = this.receipts.filter((reply) => reply.socket !== socket);
  }

  state() {
    return {
      environmentId: this.environmentId,
      online: this.online,
      auth: this.auth,
      authStatus: this.authStatus,
      authReads: this.authReads,
      heldAuth: this.authReplies.length,
      heldReceipts: this.receipts.length,
      receiptMode: this.receiptMode,
      forceStopResult: this.forceStopResult,
      heldEvents: this.events.length,
      eventsHeld: this.eventsHeld,
      commands: this.commands,
      variants,
      threads: [...this.scenarios.values()].map((scenario) => ({
        id: scenario.id,
        scenario: scenario.scenario,
        runs: scenario.runs,
        requests: [...scenario.requests.values()],
        itemCount: scenario.items.size,
        windowStart: scenario.windowStart,
      })),
    };
  }

  async http(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url),
      path = url.pathname;
    const historyMatch = /^\/api\/orchestration\/threads\/([^/]+)\/history$/.exec(path);
    if (historyMatch) {
      const scenario = this.scenarios.get(decodeURIComponent(historyMatch[1]!));
      if (!scenario) return;
      if (request.method !== "GET") return json({ error: "Use GET for history." }, 405);
      if (request.headers.get("authorization") !== "Bearer fixture-access")
        return json({ error: "Invalid fixture access." }, 401);
      const cursor = url.searchParams.get("cursor") ?? "";
      if (!/^before:\d+$/.test(cursor))
        return json({ error: "Unknown controls history cursor." }, 400);
      const before = Number(cursor.slice(7));
      if (before <= 0 || before > 241)
        return json({ error: "Unknown controls history cursor." }, 400);
      const start = Math.max(0, before - 40);
      return json({
        items: [...scenario.items.values()]
          .filter((item) => item.ordinal >= start && item.ordinal < before)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((item, position) => this.row(item, position)),
        nextCursor: start ? `before:${start}` : null,
        hasMoreHistory: start > 0,
      });
    }
    if (!this.online && ["/ws", "/api/auth/websocket-ticket/rpc"].includes(path))
      return json({ error: "Fixture is disconnected." }, 503);
    if (path === "/api/auth/session") {
      if (request.method !== "GET") return json({ error: "Use GET for session state." }, 405);
      if (request.headers.get("authorization") !== "Bearer fixture-access")
        return json({ error: "Invalid fixture access." }, 401);
      this.authReads++;
      const session = {
          ...structuredClone(this.auth),
          auth: authDescriptor,
          sessionMethod: "bearer-access-token",
        },
        status = this.authStatus;
      if (!this.holdAuth) return json(session, status);
      return new Promise<Response>((resolve) => {
        const pending: HeldAuth = {
          session,
          status,
          finish: (response) => {
            request.signal.removeEventListener("abort", abort);
            this.authReplies = this.authReplies.filter((reply) => reply !== pending);
            resolve(response);
          },
        };
        const abort = () => pending.finish(json({ error: "Auth read cancelled." }, 499));
        this.authReplies.push(pending);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    }
    if (!path.startsWith("/fixture/controls")) return;
    if (path === "/fixture/controls" && request.method === "GET") return json(this.state());
    if (request.method !== "POST")
      return json({ error: "Use POST for controls fixture transitions." }, 405);
    let payload: RecordValue;
    try {
      const raw = await request.text();
      payload = object(raw ? JSON.parse(raw) : {});
    } catch {
      return json({ error: "Expected a JSON object." }, 400);
    }
    if (path === "/fixture/controls/auth") {
      if (Object.hasOwn(payload, "session")) {
        const session = object(payload.session);
        if (
          typeof session.authenticated !== "boolean" ||
          !Array.isArray(session.scopes) ||
          !session.scopes.every((scope) => typeof scope === "string") ||
          (Object.hasOwn(session, "permissions") &&
            (!Array.isArray(session.permissions) ||
              !session.permissions.every((scope) => typeof scope === "string")))
        )
          return json({ error: "Expected authenticated, scopes, and optional permissions." }, 400);
        this.auth = session as AuthSession;
      }
      if (typeof payload.hold === "boolean") this.holdAuth = payload.hold;
      if (
        payload.status === 200 ||
        payload.status === 401 ||
        payload.status === 403 ||
        payload.status === 503
      )
        this.authStatus = payload.status;
    } else if (path === "/fixture/controls/auth/release") {
      for (const reply of this.authReplies.slice()) reply.finish(json(reply.session, reply.status));
    } else if (path === "/fixture/controls/receipts") {
      if (!["immediate", "held", "failure"].includes(text(payload.mode)))
        return json({ error: "Expected immediate, held, or failure receipt mode." }, 400);
      this.receiptMode = payload.mode as typeof this.receiptMode;
      if (text(payload.error)) this.receiptError = text(payload.error);
      if (typeof payload.holdEvents === "boolean") this.eventsHeld = payload.holdEvents;
    } else if (path === "/fixture/controls/receipts/release") {
      for (const reply of this.receipts.splice(0))
        success(reply.socket, reply.requestId, reply.value);
    } else if (path === "/fixture/controls/force-stop") {
      if (
        !["killed", "released", "releasing", "shared"].includes(text(payload.outcome)) ||
        !Array.isArray(payload.sharedWithThreadIds) ||
        !payload.sharedWithThreadIds.every((id): id is string => typeof id === "string")
      )
        return json({ error: "Expected a force-stop outcome and sharedWithThreadIds array." }, 400);
      this.forceStopResult = {
        outcome: text(payload.outcome),
        sharedWithThreadIds: payload.sharedWithThreadIds,
      };
    } else if (path === "/fixture/controls/events/release") {
      this.eventsHeld = false;
      for (const event of this.events.splice(0)) this.publish(event);
    } else if (path === "/fixture/controls/disconnect") {
      this.online = false;
      return json({ disconnectedSockets: this.disconnect(), ...this.state() });
    } else if (path === "/fixture/controls/reconnect") {
      this.online = true;
    } else {
      const scenario = this.scenarios.get(text(payload.threadId));
      if (!scenario) return json({ error: "Supply a controls threadId.", threadIds }, 400);
      const runtimeRequest = scenario.requests.get(text(payload.requestId) || "request-shared");
      if (path === "/fixture/controls/reset") {
        const variant =
          text(payload.scenario) ||
          variants[scenario.id]![scenario.id === "controls-stop" ? 3 : 0]!;
        if (!variants[scenario.id]?.includes(variant))
          return json({ error: "Unknown scenario.", variants: variants[scenario.id] }, 400);
        const fresh = this.create(scenario.id, variant);
        this.scenarios.set(scenario.id, fresh);
        this.events = this.events.filter((event) => event.threadId !== scenario.id);
        this.sequence++;
        for (const [socket, entries] of this.subscriptions)
          for (const [requestId, threadId] of entries)
            if (threadId === scenario.id) this.snapshot(fresh, socket, requestId);
        this.threadChanged(this.thread(fresh), this.sequence);
      } else if (path === "/fixture/controls/run") {
        if (!runStatuses.includes(payload.status as RunStatus))
          return json({ error: "Unknown run status.", runStatuses }, 400);
        const runId = text(payload.runId) || "run-shared";
        let run = scenario.runs.find((run) => run.id === runId);
        if (!run) {
          run = {
            id: runId,
            threadId: scenario.id,
            ordinal: Math.max(...scenario.runs.map((run) => run.ordinal)) + 1,
            status: payload.status as RunStatus,
            createdAt: this.now(),
            updatedAt: this.now(),
          };
          scenario.runs.push(run);
        }
        run.status = payload.status as RunStatus;
        run.updatedAt = this.now();
        this.emit(scenario, "run.updated", { ...run });
        this.threadChanged(this.thread(scenario), this.sequence);
      } else if (path === "/fixture/controls/stop") {
        const runId = text(payload.runId) || "run-shared";
        const prior = scenario.items.get(`interrupt-${runId}`);
        if (!prior) return json({ error: "Dispatch Stop before advancing its event." }, 409);
        if (payload.state === "unresponsive")
          this.put(scenario, { ...prior, unresponsiveAt: this.now(), updatedAt: this.now() });
        else if (payload.state === "result")
          this.put(
            scenario,
            this.item(
              scenario.id,
              `interrupt-result-${runId}`,
              "run_interrupt_result",
              this.nextOrdinal(scenario),
              { runId, message: "Provider acknowledged the interrupt." },
            ),
          );
        else
          return json(
            { error: "Expected unresponsive or result. Use /run for terminal status." },
            400,
          );
      } else if (path === "/fixture/controls/late-question") {
        const request = this.request("user_input", { type: "message" }, "late-request");
        scenario.requests.set(request.id, request);
        this.emit(scenario, "runtime-request.updated", request);
        this.put(
          scenario,
          this.item(scenario.id, "late-question-item", "user_input_request", 2, {
            requestId: request.id,
            questions: [questions[0]],
            responseMode: "message",
            status: "running",
            completedAt: null,
          }),
        );
      } else if (
        [
          "/fixture/controls/resolve",
          "/fixture/controls/expire",
          "/fixture/controls/cancel",
        ].includes(path)
      ) {
        if (!runtimeRequest || runtimeRequest.status !== "pending")
          return json({ error: "The runtime request is not pending." }, 409);
        this.resolve(
          scenario,
          runtimeRequest,
          path.endsWith("/expire")
            ? "expired"
            : path.endsWith("/cancel")
              ? "cancelled"
              : "resolved",
        );
      } else if (path === "/fixture/controls/delivery-failure") {
        if (!runtimeRequest || runtimeRequest.status !== "resolved")
          return json({ error: "Resolve or answer the request before delivery failure." }, 409);
        this.put(
          scenario,
          this.item(
            scenario.id,
            `delivery-error-${runtimeRequest.id}`,
            "error",
            this.nextOrdinal(scenario),
            {
              status: "failed",
              title: "Answer delivery not confirmed",
              failure: {
                class: "provider_error",
                code: null,
                retryable: null,
                message:
                  "Your answer was recorded, but delivery to the provider was not confirmed. If the turn stays stuck, stop it and retry.",
              },
            },
          ),
        );
      } else return json({ error: "Unknown controls fixture transition." }, 404);
    }
    return json(this.state());
  }
}
