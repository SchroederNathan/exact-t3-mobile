import { describe, expect, test } from "bun:test";
import {
  DirectSession,
  normalizeEnvironmentUrl,
  pair,
  parsePairingAddress,
  scopedThreadId,
  threadIdFromUrl,
  threadIdentity,
} from "./connection";

type SettingsRequest = {
  _tag: string;
  id: string;
  tag: string;
  payload: Record<string, unknown>;
};

function settingsSession(initializeShell = true) {
  const requests: SettingsRequest[] = [];
  const dispatched = Promise.withResolvers<SettingsRequest>();
  const session = new DirectSession({
    id: "env", label: "Mac", url: "http://localhost:13773",
    enabled: true, status: "Connecting", machineSymbol: "server.rack",
  });
  const open = () => session.open({
    readyState: 1, bufferedAmount: 0,
    send(frame) {
      const request = JSON.parse(String(frame)) as SettingsRequest;
      if (request._tag !== "Request") return;
      requests.push(request);
      if (request.payload.type === "message.dispatch") dispatched.resolve(request);
    },
    close() {},
  });
  open();
  const provider = {
    instanceId: "codex", driver: "codex", enabled: true, installed: true,
    auth: { status: "authenticated" },
    models: [
      { slug: "gpt-6", name: "GPT-6", capabilities: null },
      {
        slug: "gpt-6-mini", name: "GPT-6 Mini",
        capabilities: { optionDescriptors: [
          { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
        ] },
      },
    ],
  };
  const updateProviders = (providers: unknown[]) => session.receive(JSON.stringify({
    _tag: "Chunk", requestId: "2",
    values: [{ type: "snapshot", config: { providers } }],
  }));
  const thread = {
    id: "thread", projectId: "project", runtimeMode: "full-access",
    modelSelection: { instanceId: "codex", model: "gpt-6" },
  };
  const updateThread = (fields: Record<string, unknown>) => session.receive(JSON.stringify({
    _tag: "Chunk", requestId: "1",
    values: [{ kind: "thread.updated", location: "active", thread: { ...thread, ...fields } }],
  }));
  if (initializeShell) session.receive(JSON.stringify({
    _tag: "Chunk", requestId: "1", values: [{
      kind: "snapshot", snapshot: {
        projects: [], threads: [thread],
      },
    }],
  }));
  updateProviders([provider]);
  const accept = (request: SettingsRequest) => session.receive(JSON.stringify({
    _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: { sequence: 2 } },
  }));
  const commands = () => requests.filter((request) => request.tag === "orchestration.dispatchCommand");
  return { session, provider, updateProviders, updateThread, requests, commands, dispatched: dispatched.promise, accept, open };
}

function historySession() {
  const fixture = settingsSession();
  const configure = () => fixture.session.receive(JSON.stringify({
    _tag: "Chunk", requestId: fixture.requests.findLast((request) => request.tag === "subscribeServerConfig")!.id,
    values: [{ type: "snapshot", config: { threadSnapshotPagination: true, threadResumeCompletionMarker: true } }],
  }));
  configure();
  fixture.session.select("thread");
  const request = () => fixture.requests.findLast((value) => value.tag === "orchestration.subscribeThread")!;
  const receive = (...values: unknown[]) => fixture.session.receive(JSON.stringify({
    _tag: "Chunk", requestId: request().id, values,
  }));
  const snapshot = (fields: Record<string, unknown> = {}) => receive({
    kind: "snapshot", snapshotSequence: 20, historyCursor: "older/opaque+cursor", hasMoreHistory: true,
    latestLocalTurnOrdinal: 10, projection: {
      thread: { id: "thread" }, messages: [], runs: [], attempts: [],
      turnItems: [historyRow("recent", 10).item], visibleTurnItems: [historyRow("recent", 10)],
    }, ...fields,
  });
  const event = (sequence: number, type: string, payload: unknown) => receive({
    kind: "event", sequence, event: { threadId: "thread", type, payload },
  });
  return { ...fixture, configure, request, receive, snapshot, event,
    bodies: () => fixture.session.threads()[0]!.messages.map((message) => message.body) };
}

function historyRow(id: string, ordinal: number, fields: Record<string, unknown> = {}) {
  return { position: ordinal, visibility: "local", sourceThreadId: "thread", sourceItemId: id, item: {
    id, threadId: "thread", type: "assistant_message", messageId: `message-${id}`,
    ordinal, runId: null, nodeId: null, status: "completed", text: id,
    updatedAt: "2026-11-10T12:00:00Z", ...fields,
  } };
}

describe("long thread history", () => {
  test.each([undefined, false])("refreshes idle threads when completion markers are %s", (completion) => {
    const f = historySession();
    const thread = {
      id: "thread", projectId: "project", runtimeMode: "full-access", status: "idle",
      latestRunId: "completed", activeProviderThreadId: "provider-thread",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
    };
    f.updateThread(thread);
    const configure = () => f.session.receive(JSON.stringify({
      _tag: "Chunk", requestId: f.requests.findLast((request) => request.tag === "subscribeServerConfig")!.id,
      values: [{ type: "snapshot", config: {
        threadSnapshotPagination: true,
        ...(completion === undefined ? {} : { threadResumeCompletionMarker: completion }),
        providers: [f.provider, { ...f.provider, instanceId: "claude", driver: "claudeAgent" }],
      } }],
    }));
    const snapshot = () => f.snapshot({ projection: {
      thread, messages: [], visibleTurnItems: [historyRow("recent", 10)],
      runs: [{ id: "completed", status: "completed" }],
      providerThreads: [{ id: "provider-thread", appThreadId: "thread", providerInstanceId: "codex", providerSessionId: "session", nativeThreadRef: "native" }],
      providerSessions: [{ id: "session", status: "ready", capabilities: { sessions: { supportsProviderSwitchingViaHandoff: true } } }],
    } });
    snapshot();
    f.receive({ kind: "synchronized" });
    f.session.select("");
    configure();
    f.session.select("thread");
    expect(f.request().payload).toEqual({ threadId: "thread", acceptBoundedSnapshot: true });
    snapshot();
    expect(f.session.history("thread").synchronized).toBe(true);
    expect(f.session.settings("thread").groups.some((group) => group.id === "claude")).toBe(true);
    f.session.disconnected("Disconnected");
    f.open();
    configure();
    expect(f.request().payload).toEqual({ threadId: "thread", acceptBoundedSnapshot: true });
    snapshot();
    expect(f.session.history("thread").synchronized).toBe(true);
    expect(f.session.settings("thread").groups.some((group) => group.id === "claude")).toBe(true);
  });

  test("uses bounded snapshots and resumes the matching projection after replay and reconnect", () => {
    const f = historySession();
    expect(f.request().payload).toEqual({ threadId: "thread", acceptBoundedSnapshot: true, requestCompletionMarker: true });
    f.snapshot();
    expect(f.session.history("thread")).toMatchObject({ ready: true, synchronized: false, hasMore: true });
    f.event(27, "turn-item.updated", historyRow("recent", 10, { text: "live" }).item);
    f.event(27, "turn-item.updated", historyRow("recent", 10, { text: "duplicate" }).item);
    f.receive({ kind: "synchronized" });
    expect(f.bodies()).toEqual(["live"]);
    expect(f.session.history("thread").synchronized).toBe(true);
    f.session.select("");
    f.session.select("thread");
    expect(f.request().payload.afterSequence).toBe(27);
    f.event(31, "future.event", {});
    f.session.disconnected("Disconnected");
    const subscriptions = f.requests.filter((request) => request.tag === "orchestration.subscribeThread").length;
    f.open();
    expect(f.requests.filter((request) => request.tag === "orchestration.subscribeThread")).toHaveLength(subscriptions);
    f.configure();
    expect(f.request().payload.afterSequence).toBe(31);
    expect(f.bodies()).toEqual(["live"]);
  });

  test("treats visible timeline as authoritative including inherited content and empty history", () => {
    const f = historySession();
    const raw = { id: "raw", role: "user", text: "hidden raw", createdAt: "2026-11-10T12:00:00Z" };
    const inherited = { ...historyRow("ancestor", 2, { attachments: [{ id: "image", type: "image", url: "relative" }] }), visibility: "inherited", sourceThreadId: "parent" };
    f.snapshot({ projection: { thread: { id: "thread" }, messages: [raw], visibleTurnItems: [inherited] } });
    expect(f.bodies()).toEqual(["ancestor"]);
    expect(f.session.timeline("thread")[0]?.item.attachments).toEqual(inherited.item.attachments);
    f.snapshot({ projection: { thread: { id: "thread" }, messages: [raw], visibleTurnItems: [] } });
    expect(f.bodies()).toEqual([]);
    f.snapshot({ projection: { thread: { id: "thread" }, messages: [raw] } });
    expect(f.bodies()).toEqual(["hidden raw"]);
  });

  test("prepends older pages without replacing live rows or the resume cursor", async () => {
    const f = historySession();
    f.snapshot();
    const page = Promise.withResolvers<unknown>();
    let requestedPath = "";
    const loading = f.session.loadEarlier("thread", (path) => { requestedPath = path; return page.promise; });
    expect(new URL(requestedPath, "http://local").searchParams.get("cursor")).toBe("older/opaque+cursor");
    expect(f.session.history("thread").loading).toBe(true);
    f.event(24, "turn-item.updated", historyRow("recent", 10, { text: "newest" }).item);
    page.resolve({ snapshotSequence: 900, items: [historyRow("old", 1), historyRow("recent", 10)], nextCursor: null, hasMoreHistory: false });
    expect(await loading).toEqual({ ok: true, error: "" });
    expect(f.bodies()).toEqual(["old", "newest"]);
    expect(f.session.history("thread")).toMatchObject({ loading: false, hasMore: false, error: "" });
    f.session.select(""); f.session.select("thread");
    expect(f.request().payload.afterSequence).toBe(24);
  });

  test("discards pages overtaken by replacement snapshots and keeps failures thread-local", async () => {
    const f = historySession();
    f.snapshot();
    const page = Promise.withResolvers<unknown>();
    const loading = f.session.loadEarlier("thread", () => page.promise);
    f.snapshot({ snapshotSequence: 40, historyCursor: "replacement" });
    page.resolve({ items: [historyRow("stale", 1)], nextCursor: null, hasMoreHistory: false });
    await loading;
    expect(f.bodies()).toEqual(["recent"]);
    expect(f.session.history("thread").hasMore).toBe(true);
    expect(await f.session.loadEarlier("thread", async () => { throw new Error("History unavailable"); })).toEqual({ ok: false, error: "History unavailable" });
    expect(f.session.history("thread").error).toBe("History unavailable");
    expect(f.session.environment.status).toBe("Connected");
    expect(await f.session.loadEarlier("thread", async () => ({ items: [], nextCursor: "replacement", hasMoreHistory: true }))).toEqual({ ok: false, error: "History did not advance. Retry loading it." });
    const deletedPage = Promise.withResolvers<unknown>();
    const deletedLoad = f.session.loadEarlier("thread", () => deletedPage.promise);
    f.event(45, "thread.deleted", { threadId: "thread" });
    deletedPage.resolve({ items: [historyRow("deleted", 1)], nextCursor: null, hasMoreHistory: false });
    await deletedLoad;
    expect(f.bodies()).toEqual([]);
    expect(f.session.history("thread")).toMatchObject({ ready: false, loading: false, hasMore: false });
  });

  test("does not resurrect rolled-back rows or unloaded old updates", async () => {
    const f = historySession();
    f.snapshot();
    f.event(21, "turn-item.updated", historyRow("unloaded", 2).item);
    f.event(22, "run.created", { id: "active", status: "running" });
    f.event(23, "turn-item.updated", historyRow("active-old-ordinal", 3, { runId: "active" }).item);
    expect(f.bodies()).toEqual(["active-old-ordinal", "recent"]);
    f.event(24, "run.updated", { id: "active", status: "rolled_back" });
    await f.session.loadEarlier("thread", async () => ({ items: [historyRow("active-old-ordinal", 3, { runId: "active" }), historyRow("earlier", 1)], nextCursor: null, hasMoreHistory: false }));
    expect(f.bodies()).toEqual(["earlier", "recent"]);
  });
});

describe("direct T3 connection", () => {
  test("visits send the raw watermark and clear Done only after the shell echo", async () => {
    const { session, commands, accept, updateThread } = settingsSession();
    const completed = {
      status: "completed", updatedAt: "1970-01-01T00:00:20.000Z",
      latestRunId: "run", latestRunCompletedAt: "1970-01-01T00:00:20.000Z",
    };
    updateThread({ ...completed, lastVisitedAt: "1970-01-01T00:00:10.000Z" });
    expect(session.threads(30000)[0]?.status).toBe("Done");
    const visiting = session.visit("thread", "1970-01-01T00:00:20.000Z", true, "first-open");
    expect(commands().map(({ tag, payload }) => ({ tag, payload }))).toEqual([{
      tag: "orchestration.dispatchCommand",
      payload: {
        type: "thread.visit", commandId: "first-open", threadId: "thread",
        visitedAt: "1970-01-01T00:00:20.000Z", opened: true,
      },
    }]);
    accept(commands()[0]!);
    expect(await visiting).toEqual({ ok: true, error: "" });
    expect(session.threads(30000)[0]?.status).toBe("Done");
    updateThread({ ...completed, lastVisitedAt: "1970-01-01T00:00:20.000Z" });
    expect(session.threads(30000)[0]?.status).toBe("");
  });

  test("visit failures retain unread status and allow an explicit retry of the same watermark", async () => {
    const { session, commands, updateThread } = settingsSession();
    updateThread({
      status: "completed", updatedAt: "1970-01-01T00:00:20.000Z",
      latestRunId: "run", latestRunCompletedAt: "1970-01-01T00:00:20.000Z",
      lastVisitedAt: "1970-01-01T00:00:10.000Z",
    });
    const first = session.visit("thread", "1970-01-01T00:00:20.000Z", false, "visit-attempt");
    session.receive(JSON.stringify({ _tag: "Exit", requestId: commands()[0]!.id, exit: {
      _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Visits are not permitted." } }],
    } }));
    expect(await first).toEqual({ ok: false, error: "Visits are not permitted." });
    expect(session.threads(30000)[0]?.status).toBe("Done");
    const retried = session.visit("thread", "1970-01-01T00:00:20.000Z", false, "visit-retry");
    expect(commands().map(({ payload }) => payload)).toEqual([
      { type: "thread.visit", commandId: "visit-attempt", threadId: "thread", visitedAt: "1970-01-01T00:00:20.000Z" },
      { type: "thread.visit", commandId: "visit-retry", threadId: "thread", visitedAt: "1970-01-01T00:00:20.000Z" },
    ]);
    session.disconnected("Connection lost");
    expect(await retried).toEqual({ ok: false, error: "Connection lost" });
    expect(session.threads(30000)[0]?.status).toBe("Done");
  });

  test("visit metadata keeps raw completion and read times independent of display time", () => {
    const { session, updateThread } = settingsSession();
    const completed = {
      status: "completed", updatedAt: "1970-01-01T00:00:20.000Z",
      latestRunId: "run", latestRunCompletedAt: "1970-01-01T00:00:20.000Z",
    };
    updateThread({ ...completed, lastVisitedAt: "1970-01-01T00:00:10.000Z" });
    expect(session.threads(30000)[0]).toMatchObject({
      id: "env:thread", status: "Done", updatedAt: "<1m",
      visit: {
        ready: true, supported: true, at: "1970-01-01T00:00:20.000Z",
        watermark: 20000, seen: 10000, urgent: true,
      },
    });
    updateThread({ ...completed, lastVisitedAt: "1970-01-01T00:00:20.000Z" });
    expect(session.threads(30000)[0]).toMatchObject({
      status: "", visit: { watermark: 20000, seen: 20000, urgent: false },
    });
    updateThread({ ...completed, lastVisitedAt: "1970-01-01T00:00:05.000Z" });
    expect(session.threads(30000)[0]).toMatchObject({
      status: "Done", visit: { watermark: 20000, seen: 5000, urgent: true },
    });
    updateThread({ updatedAt: "invalid" });
    expect(session.threads(30000)[0]).toMatchObject({
      visit: { ready: false, supported: false, at: "", watermark: -1 },
    });
  });

  test("normalizes pairing links without retaining a credential in the origin", () => {
    expect(parsePairingAddress("127.0.0.1:13773", "test-code")).toEqual({
      origin: "http://127.0.0.1:13773",
      credential: "test-code",
    });
    expect(
      parsePairingAddress(
        "https://app.t3.codes/?host=http%3A%2F%2F127.0.0.1%3A13773#token=from-link",
        "",
      ),
    ).toEqual({ origin: "http://127.0.0.1:13773", credential: "from-link" });
    expect(
      parsePairingAddress(
        "t3code://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A13773%2F%23token%3Dnested",
        "",
      ),
    ).toEqual({ origin: "http://127.0.0.1:13773", credential: "nested" });
    expect(() => parsePairingAddress("file:///etc/passwd#token=x", "")).toThrow("HTTP");
    expect(() => parsePairingAddress("https://example.test", "")).toThrow("pairing code");
    expect(normalizeEnvironmentUrl("localhost:13773/path#token=discarded")).toBe(
      "http://localhost:13773",
    );
    expect(normalizeEnvironmentUrl("https://remote.example:444/path")).toBe(
      "https://remote.example:444",
    );
    expect(() => normalizeEnvironmentUrl("file:///workspace")).toThrow("HTTP");
    expect(() => normalizeEnvironmentUrl("https://user:password@example.test")).toThrow(
      "credentials",
    );
    const scopedId = scopedThreadId("env:one", "thread/100%");
    const routedId = threadIdFromUrl(`/threads/${encodeURIComponent(scopedId)}`);
    expect(routedId).toBe(scopedId);
    expect(threadIdentity(routedId)).toEqual({ environmentId: "env:one", threadId: "thread/100%" });
    expect(() => threadIdFromUrl("/threads/new")).toThrow("associated");
  });

  test("exchanges the pairing credential with the OAuth form encoding", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/.well-known/t3/environment")
          return Response.json({
            environmentId: "environment",
            label: "Mac",
            orchestrationProtocolVersion: 2,
          });
        if (request.headers.get("content-type") !== "application/x-www-form-urlencoded")
          return new Response("Unsupported Media Type", { status: 415 });
        const form = new URLSearchParams(await request.text());
        if (
          form.get("subject_token") !== "credential" ||
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange"
        )
          return new Response("Bad Request", { status: 400 });
        return Response.json({ access_token: "returned-token" });
      },
    });
    try {
      await expect(pair(`http://127.0.0.1:${server.port}`, "credential")).resolves.toEqual({
        environment: {
          id: "environment",
          label: "Mac",
          url: `http://127.0.0.1:${server.port}`,
          enabled: true,
          status: "Connecting",
          machineSymbol: "server.rack",
        },
        token: "returned-token",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("maps shell snapshots, updates, transcript events, and acknowledges stream chunks", () => {
    const sent: string[] = [];
    const session = new DirectSession({
      id: "env",
      label: "Mac",
      url: "http://localhost:13773",
      enabled: true,
      status: "Connecting",
      machineSymbol: "server.rack",
    });
    session.open({
      readyState: 1,
      bufferedAmount: 0,
      send: (frame) => sent.push(String(frame)),
      close() {},
    });
    expect(JSON.parse(sent[0]!)).toEqual({
      _tag: "Request",
      id: "1",
      tag: "orchestration.subscribeShell",
      payload: {},
      headers: [],
    });
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "snapshot",
            snapshot: {
              projects: [{ id: "p", title: "T3 Code", workspaceRoot: "/workspace" }],
              threads: [
                {
                  id: "t",
                  projectId: "p",
                  title: "Fix startup",
                  status: "idle",
                  updatedAt: "2026-11-08T12:00:00Z",
                  latestUserMessageAt: "2026-11-08T11:58:00Z",
                  modelSelection: { instanceId: "provider-instance", model: "model-slug" },
                  settledOverride: "settled",
                  settledAt: "2026-11-08T11:59:00Z",
                  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" },
                },
                {
                  id: "child",
                  projectId: "p",
                  title: "Subagent",
                  lineage: {
                    parentThreadId: "t",
                    relationshipToParent: "subagent",
                    rootThreadId: "t",
                  },
                },
                {
                  id: "side",
                  projectId: "p",
                  title: "Side chat",
                  lineage: {
                    parentThreadId: "t",
                    relationshipToParent: "fork",
                    rootThreadId: "t",
                    sideChat: true,
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const configRequest = sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.tag === "subscribeServerConfig");
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: configRequest.id,
        values: [
          {
            type: "snapshot",
            config: {
              environment: { platform: { machine: "mac-mini" } },
              providers: [
                {
                  instanceId: "provider-instance",
                  driver: "codex",
                  models: [{ slug: "model-slug", shortName: "GPT Test" }],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(session.environment.machineSymbol).toBe("macmini");
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: configRequest.id,
        values: [{ type: "settingsUpdated", payload: { settings: { environmentIcon: "cloud" } } }],
      }),
    );
    expect(session.environment.machineSymbol).toBe("cloud");
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: configRequest.id,
        values: [{ type: "settingsUpdated", payload: { settings: { environmentIcon: null } } }],
      }),
    );
    expect(session.environment.machineSymbol).toBe("macmini");
    expect(session.projectList()).toEqual([
      { id: "env:p", title: "T3 Code", environmentId: "env" },
    ]);
    expect(session.threads(Date.parse("2026-11-08T12:00:00Z"))).toEqual([
      {
        id: scopedThreadId("env", "t"),
        environmentId: "env",
        title: "Fix startup",
        project: "T3 Code",
        projectId: "env:p",
        projectIcon: "",
        projectInitials: "T3",
        projectIconColor: "#f6339a",
        provider: "codex",
        model: "GPT Test",
        activityAt: Date.parse("2026-11-08T11:59:00Z"),
        settled: true,
        status: "",
        visit: {
          ready: true,
          supported: false,
          at: "2026-11-08T12:00:00Z",
          watermark: Date.parse("2026-11-08T12:00:00Z"),
          seen: -1,
          urgent: false,
        },
        updatedAt: "1m",
        lastError: "",
        lastErrorTime: expect.any(String),
        messages: [],
        history: { ready: false, synchronized: false, hasMore: false, loading: false, error: "" },
      },
    ]);
    expect(sent.map((frame) => JSON.parse(frame))).toContainEqual({ _tag: "Ack", requestId: "1" });
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "snapshot",
            resolvedRepositoryIdentityRoots: ["/workspace"],
            snapshot: {
              projects: [{ id: "p", title: "Enriched T3 Code", workspaceRoot: "/workspace" }],
              threads: [],
              archivedThreads: [],
            },
          },
        ],
      }),
    );
    expect(session.threads()).toHaveLength(1);
    expect(session.threads()[0]?.project).toBe("Enriched T3 Code");
    const faviconRequest = sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.tag === "assets.createUrl");
    expect(faviconRequest.payload).toEqual({
      resource: { _tag: "project-favicon", cwd: "/workspace" },
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: faviconRequest.id,
        exit: { _tag: "Success", value: { relativeUrl: "/api/assets/favicon?token=test" } },
      }),
    );
    expect(session.threads()[0]?.projectIcon).toBe(
      "http://localhost:13773/api/assets/favicon?token=test",
    );
    session.select("t");
    const request = JSON.parse(sent.at(-1)!);
    expect(request.tag).toBe("orchestration.subscribeThread");
    session.receive(
      JSON.stringify([
        {
          _tag: "Chunk",
          requestId: request.id,
          values: [
            {
              kind: "snapshot",
              projection: {
                messages: [{ id: "m", role: "user", text: "Hello", createdAt: "now" }],
              },
            },
            {
              kind: "event",
              event: {
                type: "message.updated",
                payload: {
                  id: "a",
                  role: "assistant",
                  text: "Actual server response",
                  createdAt: "later",
                },
              },
            },
          ],
        },
      ]),
    );
    expect(session.threads()[0]?.messages.map((message) => message.body)).toEqual([
      "Hello",
      "Actual server response",
    ]);
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "thread.updated",
            location: "active",
            thread: {
              id: "t",
              projectId: "p",
              title: "Fixed startup",
              status: "completed",
              updatedAt: "2026-11-08T13:00:00Z",
              latestUserMessageAt: "2026-11-08T12:00:00Z",
            },
          },
          {
            kind: "thread.updated",
            location: "active",
            thread: {
              id: "older",
              projectId: "p",
              title: "Older activity",
              status: "completed",
              updatedAt: "2026-11-08T14:00:00Z",
              latestUserMessageAt: "2026-11-08T11:00:00Z",
            },
          },
        ],
      }),
    );
    expect(session.threads()[0]?.title).toBe("Fixed startup");
    expect(session.threads().map((thread) => thread.title)).toEqual([
      "Fixed startup",
      "Older activity",
    ]);
    for (const [fields, expected] of [
      [{ status: "completed", latestRunId: "run", latestRunCompletedAt: "2026-11-08T13:00:00Z", lastVisitedAt: "2026-11-08T12:00:00Z" }, "Done"],
      [{ status: "completed", latestRunId: "run", latestRunCompletedAt: "2026-11-08T13:00:00Z", lastVisitedAt: "2026-11-08T14:00:00Z" }, ""],
      [{ status: "completed", latestRunId: "run", latestRunCompletedAt: "2026-11-08T13:00:00Z", lastVisitedAt: null }, ""],
      [{ status: "running", pendingRuntimeRequest: { kind: "command_execution" } }, "Approval"],
      [{ status: "running", pendingRuntimeRequest: { kind: "user_input", blocking: false } }, "Input"],
      [{ status: "running", pendingRuntimeRequest: { kind: "auth_refresh" } }, "Working"],
      [{ status: "running", pendingGuestMessageCount: 1 }, "Request"],
      [{ status: "running", blockedOnThreadWait: true }, "Waiting"],
      [{ status: "queued" }, "Working"],
      [{ status: "running", goal: { status: "active" } }, "Goal"],
      [{ status: "failed", lastErrorClass: "usage_limit" }, "Limited"],
      [{ status: "failed", lastError: "Provider failed" }, "Failed"],
      [{ status: "completed", pendingBackgroundTasks: [{ kind: "subagent" }] }, "Waiting"],
      [{ status: "completed", pendingBackgroundTasks: [{ kind: "command", awaited: false }] }, ""],
    ] as const) {
      session.receive(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{
        kind: "thread.updated", location: "active", thread: {
          id: "t", projectId: "p", title: "Fixed startup", latestUserMessageAt: "2026-11-08T12:00:00Z", ...fields,
        },
      }] }));
      expect(session.threads().find((thread) => thread.id === "env:t")?.status).toBe(expected);
    }
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          { kind: "thread.removed", location: "active", threadId: "t" },
          { kind: "thread.removed", location: "active", threadId: "older" },
        ],
      }),
    );
    expect(session.threads()).toEqual([]);
  });

  test("a send waits for server acceptance and rejects failures or disconnects without fabricating messages", async () => {
    const sent: string[] = [];
    const session = new DirectSession({
      id: "env",
      label: "Mac",
      url: "http://localhost:13773",
      enabled: true,
      status: "Connecting",
      machineSymbol: "server.rack",
    });
    session.open({
      readyState: 1,
      bufferedAmount: 0,
      send: (frame) => sent.push(String(frame)),
      close() {},
    });
    const reply = session.send("thread", "Hi", "command", "message");
    const request = JSON.parse(sent.at(-1)!);
    expect(request.payload).toEqual({
      type: "message.dispatch",
      commandId: "command",
      threadId: "thread",
      messageId: "message",
      text: "Hi",
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
      dispatchMode: { type: "start_immediately" },
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: { sequence: 2 } },
      }),
    );
    await expect(reply).resolves.toEqual({ ok: true, error: "" });
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "snapshot",
            snapshot: {
              projects: [
                {
                  id: "p",
                  title: "Project",
                  defaultModelSelection: { instanceId: "test", model: "model" },
                },
              ],
              threads: [],
            },
          },
        ],
      }),
    );
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "2",
        values: [
          {
            type: "snapshot",
            config: {
              providers: [
                {
                  instanceId: "test",
                  driver: "codex",
                  enabled: true,
                  installed: true,
                  models: [{ slug: "model" }],
                },
              ],
            },
          },
        ],
      }),
    );
    const created = session.create("p", "New thread", "create-command", "new-thread");
    const createRequest = JSON.parse(sent.at(-1)!);
    expect(createRequest.payload).toEqual({
      type: "thread.create",
      commandId: "create-command",
      threadId: "new-thread",
      projectId: "p",
      title: "New thread",
      createdBy: "user",
      creationSource: "mobile",
      modelSelection: { instanceId: "test", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: createRequest.id,
        exit: { _tag: "Success", value: { sequence: 3 } },
      }),
    );
    await expect(created).resolves.toEqual({ ok: true, error: "" });
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "project.updated",
            project: { id: "p", title: "Project", workspaceRoot: "/project" },
          },
          {
            kind: "thread.updated",
            location: "active",
            thread: { id: "thread", projectId: "p", worktreePath: "/worktree" },
          },
        ],
      }),
    );
    const files = session.inspect("thread", "files", "src");
    const filesRequest = JSON.parse(sent.at(-1)!);
    expect(filesRequest).toMatchObject({
      tag: "projects.listEntries",
      payload: { cwd: "/worktree", directoryPath: "src" },
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: filesRequest.id,
        exit: {
          _tag: "Success",
          value: {
            entries: [
              { path: "src/nested", kind: "directory" },
              { path: "src/app.ts", kind: "file" },
            ],
            truncated: true,
          },
        },
      }),
    );
    await expect(files).resolves.toMatchObject({
      ok: true,
      title: "Files",
      items: [
        { id: "src/nested", label: "nested", kind: "directory" },
        { id: "src/app.ts", label: "app.ts", kind: "file" },
      ],
    });
    expect((await files).body).toContain("truncated");
    const file = session.inspect("thread", "file", "src/app.ts");
    const fileRequest = JSON.parse(sent.at(-1)!);
    expect(fileRequest).toMatchObject({
      tag: "projects.readFile",
      payload: { cwd: "/worktree", relativePath: "src/app.ts" },
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: fileRequest.id,
        exit: {
          _tag: "Success",
          value: { relativePath: "src/app.ts", contents: "const answer = 42;", truncated: false },
        },
      }),
    );
    await expect(file).resolves.toMatchObject({
      title: "src/app.ts",
      body: "const answer = 42;",
      items: [],
    });
    const git = session.inspect("thread", "git", "");
    const gitRequest = JSON.parse(sent.at(-1)!);
    expect(gitRequest).toMatchObject({
      tag: "vcs.refreshStatus",
      payload: { cwd: "/worktree", localOnly: true },
    });
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: gitRequest.id,
        exit: {
          _tag: "Success",
          value: {
            isRepo: true,
            refName: "feature",
            hasWorkingTreeChanges: true,
            hasUpstream: true,
            aheadCount: 2,
            behindCount: 1,
            workingTree: {
              files: [{ path: "src/app.ts", insertions: 3, deletions: 1 }],
              insertions: 3,
              deletions: 1,
            },
          },
        },
      }),
    );
    await expect(git).resolves.toMatchObject({
      ok: true,
      title: "Source Control",
      items: [
        { id: "branch", label: "feature", kind: "info" },
        { id: "upstream", detail: "2 ahead · 1 behind", kind: "info" },
        { id: "src/app.ts", label: "src/app.ts", detail: "+3 −1", kind: "file" },
      ],
    });
    const deniedFiles = session.inspect("thread", "files", "");
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: JSON.parse(sent.at(-1)!).id,
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Fail", error: { message: "Read access denied" } }],
        },
      }),
    );
    await expect(deniedFiles).rejects.toThrow("Read access denied");
    const denied = session.send("thread", "Again", "c2", "m2");
    const deniedId = JSON.parse(sent.at(-1)!).id;
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: deniedId,
        exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Access denied" } }] },
      }),
    );
    await expect(denied).resolves.toEqual({ ok: false, error: "Access denied" });
    const interrupted = session.send("thread", "Again", "c3", "m3");
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            kind: "thread.updated",
            location: "active",
            thread: { id: "thread", projectId: "p", worktreePath: null },
          },
        ],
      }),
    );
    const interruptedFiles = session.inspect("thread", "files", "");
    expect(JSON.parse(sent.at(-1)!).payload).toEqual({ cwd: "/project", directoryPath: "" });
    const remainingQueries = Promise.allSettled(
      Array.from({ length: 31 }, () => session.inspect("thread", "files", "")),
    );
    await expect(session.inspect("thread", "files", "")).rejects.toThrow("Too many requests");
    session.disconnected("Connection lost");
    await expect(interrupted).resolves.toEqual({ ok: false, error: "Connection lost" });
    await expect(interruptedFiles).rejects.toThrow("Connection lost");
    expect((await remainingQueries).every((result) => result.status === "rejected")).toBe(true);
    expect(session.threads()[0]?.messages).toEqual([]);
  });
});

describe("direct thread settings", () => {
  test("persists favorites with the server settings patch and reflects authoritative settings", async () => {
    const { session, provider, requests } = settingsSession();
    session.receive(JSON.stringify({ _tag: "Chunk", requestId: "2", values: [{ type: "snapshot", config: {
      providers: [provider], settings: { favorites: null },
    } }] }));
    const favorite = () => session.settings("thread").groups[0]?.models.find((model) => model.slug === "gpt-6-mini")?.isFavorite;
    const adding = session.setModelFavorite("thread", "codex:gpt-6-mini", true);
    const addRequest = requests.at(-1)!;
    expect(addRequest.tag).toBe("server.updateSettings");
    expect(addRequest.payload).toEqual({ patch: {
      setModelFavorites: [{ provider: "codex", model: "gpt-6-mini", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    } });
    expect(favorite()).toBe(false);
    session.receive(JSON.stringify({ _tag: "Exit", requestId: addRequest.id, exit: { _tag: "Success", value: {
      favorites: [{ provider: "codex", model: "gpt-6-mini" }],
    } } }));
    await expect(adding).resolves.toEqual({ ok: true, error: "" });
    expect(favorite()).toBe(true);
    const removing = session.setModelFavorite("thread", "codex:gpt-6-mini", false);
    const removeRequest = requests.at(-1)!;
    expect(removeRequest.payload).toEqual({ patch: { setModelFavorites: [{ provider: "codex", model: "gpt-6-mini", favorite: false }] } });
    session.receive(JSON.stringify({ _tag: "Exit", requestId: removeRequest.id, exit: { _tag: "Success", value: { favorites: [] } } }));
    await expect(removing).resolves.toEqual({ ok: true, error: "" });
    expect(favorite()).toBe(false);
    const lateReply = session.setModelFavorite("thread", "codex:gpt-6-mini", true);
    const lateRequest = requests.at(-1)!;
    session.receive(JSON.stringify({ _tag: "Chunk", requestId: "2", values: [{ type: "settingsUpdated", payload: { settings: { favorites: [] } } }] }));
    session.receive(JSON.stringify({ _tag: "Exit", requestId: lateRequest.id, exit: { _tag: "Success", value: { favorites: [{ provider: "codex", model: "gpt-6-mini" }] } } }));
    await expect(lateReply).resolves.toEqual({ ok: true, error: "" });
    expect(favorite()).toBe(false);
  });

  test("validates favorite identity independently of availability and keeps server-rejected favorites unchanged", async () => {
    const { session, provider, requests } = settingsSession();
    const update = (providers: unknown[], favorites: Array<{ provider: string; model: string }> = []) => session.receive(JSON.stringify({
      _tag: "Chunk", requestId: "2", values: [{ type: "snapshot", config: { providers, settings: { favorites } } }],
    }));
    update([provider]);
    const count = requests.length;
    await expect(session.setModelFavorite("missing", "codex:gpt-6", true)).resolves.toMatchObject({ ok: false });
    await expect(session.setModelFavorite("thread", "codex:unknown", true)).resolves.toMatchObject({ ok: false });
    await expect(session.setModelFavorite("thread", "codex:unknown", false)).resolves.toMatchObject({ ok: false });
    expect(requests.length).toBe(count);
    for (const providers of [
      [{ ...provider, enabled: false }],
      [{ ...provider, installed: false }],
      [{ ...provider, availability: "unavailable" }],
      [{ ...provider, auth: { status: "unauthenticated" } }],
      [{ ...provider, models: [] }],
      [],
    ]) {
      update(providers);
      for (const favorite of [true, false]) {
        const before = requests.length;
        const changing = session.setModelFavorite("thread", "codex:gpt-6", favorite);
        expect(requests.length).toBe(before + 1);
        const request = requests.at(-1)!;
        expect(request.payload).toEqual({ patch: { setModelFavorites: [{ provider: "codex", model: "gpt-6", favorite }] } });
        session.receive(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: {
          _tag: "Success", value: { favorites: favorite ? [{ provider: "codex", model: "gpt-6" }] : [] },
        } }));
        await expect(changing).resolves.toEqual({ ok: true, error: "" });
        expect(session.settings("thread").selectedModel?.isFavorite).toBe(favorite);
      }
    }
    const retired = { provider: "retired-account", model: "retired:model" };
    update([], [retired]);
    const retiredId = `${retired.provider}:${retired.model}`;
    const before = requests.length;
    await expect(session.setModelFavorite("thread", retiredId, true)).resolves.toMatchObject({ ok: false });
    expect(requests.length).toBe(before);
    const removing = session.setModelFavorite("thread", retiredId, false);
    expect(requests.length).toBe(before + 1);
    const removal = requests.at(-1)!;
    expect(removal.payload).toEqual({ patch: { setModelFavorites: [{ ...retired, favorite: false }] } });
    session.receive(JSON.stringify({ _tag: "Exit", requestId: removal.id, exit: { _tag: "Success", value: { favorites: [] } } }));
    await expect(removing).resolves.toEqual({ ok: true, error: "" });
    await expect(session.setModelFavorite("thread", retiredId, false)).resolves.toMatchObject({ ok: false });
    expect(requests.length).toBe(before + 1);
    update([provider]);
    const rejected = session.setModelFavorite("thread", "codex:gpt-6-mini", true);
    const request = requests.at(-1)!;
    session.receive(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: {
      _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Settings access denied" } }],
    } }));
    await expect(rejected).resolves.toEqual({ ok: false, error: "Settings access denied" });
    expect(session.settings("thread").groups[0]?.models.every((model) => !model.isFavorite)).toBe(true);
  });

  test("uses shell start markers until the selected thread supplies provider handoff capabilities", () => {
    const { session, provider, updateProviders, requests } = settingsSession();
    updateProviders([provider, { ...provider, instanceId: "claude", driver: "claudeAgent" }]);
    const thread = {
      id: "thread", projectId: "project", runtimeMode: "full-access", status: "idle",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      latestRunId: null, latestUserMessageAt: null, activeProviderThreadId: null,
    };
    const updateThread = (fields: Record<string, unknown>) => session.receive(JSON.stringify({
      _tag: "Chunk", requestId: "1", values: [{ kind: "thread.updated", location: "active", thread: { ...thread, ...fields } }],
    }));
    const canSwitch = () => session.settings("thread").groups.some((group) => group.id === "claude");
    updateThread({});
    expect(canSwitch()).toBe(true);
    for (const fields of [
      { latestRunId: "run" },
      { latestUserMessageAt: "2026-11-10T13:00:00Z" },
      { activeProviderThreadId: "provider-thread" },
      { pendingBackgroundTasks: [{ kind: "subagent" }] },
      { pendingBackgroundTasks: [{ kind: "command", awaited: true }] },
    ]) {
      updateThread(fields);
      expect(canSwitch()).toBe(false);
      expect(session.stageSettings("thread", undefined, { type: "model", id: "claude:gpt-6" }).ok).toBe(false);
    }
    updateThread({ pendingBackgroundTasks: [{ kind: "command", awaited: false }] });
    expect(canSwitch()).toBe(true);
    updateThread({ latestRunId: "completed-run", activeProviderThreadId: "provider-thread" });
    session.select("thread");
    const requestId = requests.at(-1)!.id;
    const providerThread = {
      id: "provider-thread", appThreadId: "thread", providerInstanceId: "codex",
      providerSessionId: "session", nativeThreadRef: "native-thread",
    };
    const providerSession = (id: string, allowed: boolean) => ({
      id, status: "ready", capabilities: { sessions: { supportsProviderSwitchingViaHandoff: allowed } },
    });
    const base = {
      thread: { ...thread, activeProviderThreadId: "provider-thread" },
      runs: [{ id: "completed-run", status: "completed", providerThreadId: "provider-thread" }],
      providerThreads: [providerThread], providerSessions: [], messages: [],
    };
    const cases = [
      { expected: true, fields: { providerSessions: [providerSession("session", true)] } },
      { expected: false, fields: { providerSessions: [providerSession("session", false), providerSession("other-session", true)] } },
      { expected: true, fields: { providerThreads: [], providerSessions: [providerSession("fallback", true)] } },
      { expected: false, fields: { runs: [{ id: "active", status: "running", providerThreadId: "provider-thread" }] } },
      { expected: true, fields: { runs: [], providerThreads: [] } },
      { expected: true, fields: { thread: { ...base.thread, historyOrigin: "v1_import" }, providerThreads: [] } },
      { expected: true, fields: {} },
      { expected: false, fields: { providerThreads: [{ ...providerThread, nativeThreadRef: null }] } },
      { expected: false, fields: { providerThreads: [{ ...providerThread, providerInstanceId: "different" }] } },
    ];
    for (const { expected, fields } of cases) {
      session.receive(JSON.stringify({ _tag: "Chunk", requestId, values: [{ kind: "snapshot", projection: { ...base, ...fields } }] }));
      expect(canSwitch()).toBe(expected);
    }
  });

  test("updates provider-switch permission from stream events and clears it when subscription state is lost", async () => {
    const { session, provider, updateProviders, requests, commands, open } = settingsSession(false);
    expect(session.liveSettings("thread")).toBeNull();
    updateProviders([
      { ...provider, models: provider.models.map((model) => ({ ...model, capabilities: { optionDescriptors: [] } })) },
      { ...provider, instanceId: "claude", driver: "claudeAgent" },
    ]);
    const thread = {
      id: "thread", projectId: "project", runtimeMode: "full-access", status: "idle",
      latestRunId: "completed", latestUserMessageAt: null, activeProviderThreadId: "provider-thread",
      modelSelection: {
        instanceId: "codex", model: "gpt-6",
        options: [{ id: "effort", value: "ultracode" }, { id: "fastMode", value: false }],
      },
    };
    const authoritative = { threadId: thread.id, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode };
    const shell = () => session.receive(JSON.stringify({
      _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { projects: [], threads: [thread] } }],
    }));
    const partialShell = (id: string) => session.receive(JSON.stringify({
      _tag: "Chunk", requestId: id, values: [
        { kind: "snapshot", resolvedRepositoryIdentityRoots: [], snapshot: { projects: [] } },
        { kind: "thread.updated", location: "active", thread },
      ],
    }));
    partialShell("1");
    expect(session.liveSettings("thread")).toBeNull();
    shell();
    expect(session.liveSettings("thread")).toEqual(authoritative);
    expect(session.liveSettings("missing")).toBeNull();
    expect(session.settings("thread").selection?.modelSelection.options).toBeUndefined();
    session.select("thread");
    let requestId = requests.at(-1)!.id;
    const providerThread = {
      id: "provider-thread", appThreadId: "thread", providerInstanceId: "codex",
      providerSessionId: "session", nativeThreadRef: "native-thread",
    };
    const providerSession = (allowed: boolean) => ({
      id: "session", status: "ready", capabilities: { sessions: { supportsProviderSwitchingViaHandoff: allowed } },
    });
    const snapshot = () => session.receive(JSON.stringify({
      _tag: "Chunk", requestId, values: [{ kind: "snapshot", projection: {
        thread, messages: [], runs: [{ id: "completed", status: "completed" }],
        providerThreads: [providerThread], providerSessions: [providerSession(true)],
      } }],
    }));
    const event = (type: string, payload: unknown) => session.receive(JSON.stringify({
      _tag: "Chunk", requestId, values: [{ kind: "event", event: { type, threadId: "thread", payload } }],
    }));
    const canSwitch = () => session.settings("thread").groups.some((group) => group.id === "claude");
    snapshot();
    const staged = session.stageSettings("thread", undefined, { type: "model", id: "claude:gpt-6" });
    expect(staged.ok).toBe(true);
    event("provider-session.updated", providerSession(false));
    expect(canSwitch()).toBe(false);
    expect(session.validateSettings("thread", staged.selection).ok).toBe(false);
    await expect(session.send("thread", "Hi", "command", "message", staged.selection)).resolves.toMatchObject({ ok: false });
    expect(commands()).toEqual([]);
    event("provider-session.updated", providerSession(true));
    event("provider-thread.updated", { ...providerThread, id: "active-provider-thread", providerSessionId: "active-session" });
    event("provider-session.attached", { ...providerSession(false), id: "active-session" });
    event("run.created", { id: "active", status: "running", providerThreadId: "active-provider-thread" });
    expect(canSwitch()).toBe(false);
    event("run.updated", { id: "active", status: "completed", providerThreadId: "active-provider-thread" });
    expect(canSwitch()).toBe(true);
    event("provider-session.detached", { providerSessionId: "session" });
    expect(canSwitch()).toBe(true);
    event("provider-thread.updated", { ...providerThread, nativeThreadRef: null });
    expect(canSwitch()).toBe(false);
    snapshot();
    event("provider-session.detached", { providerSessionId: "session" });
    event("thread.model-selection-updated", { ...thread, modelSelection: { instanceId: "claude", model: "gpt-6" } });
    expect(canSwitch()).toBe(false);
    event("thread.model-selection-updated", thread);
    expect(canSwitch()).toBe(true);
    session.receive(JSON.stringify({
      _tag: "Chunk", requestId, values: [{ kind: "event", event: { type: "run.created", threadId: "different-thread", payload: { id: "foreign", status: "running" } } }],
    }));
    expect(canSwitch()).toBe(true);
    session.select("");
    expect(canSwitch()).toBe(false);
    snapshot();
    expect(canSwitch()).toBe(false);
    session.select("thread");
    requestId = requests.at(-1)!.id;
    snapshot();
    expect(canSwitch()).toBe(true);
    session.receive(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{ kind: "thread.removed", location: "active", threadId: "thread" }] }));
    expect(session.liveSettings("thread")).toBeNull();
    shell();
    expect(canSwitch()).toBe(false);
    snapshot();
    session.receive(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { projects: [], threads: [] } }] }));
    expect(session.liveSettings("thread")).toBeNull();
    shell();
    expect(canSwitch()).toBe(false);
    snapshot();
    session.receive(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Thread stream ended" } }] } }));
    snapshot();
    expect(canSwitch()).toBe(false);
    expect(session.liveSettings("thread")).toEqual(authoritative);
    session.select("thread");
    requestId = requests.at(-1)!.id;
    snapshot();
    session.disconnected("Connection lost");
    snapshot();
    expect(canSwitch()).toBe(false);
    expect(session.liveSettings("thread")).toBeNull();
    shell();
    expect(session.liveSettings("thread")).toBeNull();
    open();
    const shellRequestId = requests.findLast((request) => request.tag === "orchestration.subscribeShell")!.id;
    expect(session.liveSettings("thread")).toBeNull();
    shell();
    partialShell(shellRequestId);
    expect(session.liveSettings("thread")).toBeNull();
    session.receive(JSON.stringify({
      _tag: "Chunk", requestId: shellRequestId, values: [{ kind: "snapshot", snapshot: { projects: [], threads: [thread] } }],
    }));
    expect(session.liveSettings("thread")).toEqual(authoritative);
    session.receive(JSON.stringify({ _tag: "Exit", requestId: shellRequestId, exit: { _tag: "Success", value: {} } }));
    expect(session.liveSettings("thread")).toBeNull();
  });

  test("dispatches the selected model and typed options without an unchanged runtime command", async () => {
    const { session, commands, accept } = settingsSession();
    const model = session.stageSettings("thread", undefined, { type: "model", id: "codex:gpt-6-mini" });
    const options = session.stageSettings("thread", model.selection, { type: "option", id: "fastMode", value: "false" });
    expect(options.ok).toBe(true);
    expect(session.settings("thread", options.selection).selectedModelId).toBe("codex:gpt-6-mini");
    expect(session.settings("thread").selectedModelId).toBe("codex:gpt-6");
    const reply = session.send("thread", "Hi", "command", "message", options.selection);
    expect(commands().map((request) => request.payload.type)).toEqual(["message.dispatch"]);
    expect(commands()[0]?.payload).toMatchObject({
      commandId: "command", messageId: "message",
      modelSelection: { instanceId: "codex", model: "gpt-6-mini", options: [{ id: "fastMode", value: false }] },
    });
    expect(commands()[0]?.payload).not.toHaveProperty("runtimeMode");
    accept(commands()[0]!);
    await expect(reply).resolves.toEqual({ ok: true, error: "" });
  });

  test("refuses missing threads and stale model settings before dispatch", async () => {
    const { session, provider, updateProviders, commands } = settingsSession();
    expect(session.settings("missing").error).toBe("This thread is no longer available.");
    expect(session.stageSettings("missing", undefined, { type: "runtime", id: "auto" }).ok).toBe(false);
    expect(session.validateSettings("missing").ok).toBe(false);
    const model = session.stageSettings("thread", undefined, { type: "model", id: "codex:gpt-6-mini" });
    updateProviders([{ ...provider, models: [provider.models[0]] }]);
    await expect(session.send("thread", "Hi", "command", "message", model.selection)).resolves.toEqual({
      ok: false, error: "This model is no longer available.",
    });
    expect(commands()).toEqual([]);
  });

  test("stops before message dispatch when the runtime command is rejected", async () => {
    const { session, commands } = settingsSession();
    const settings = session.stageSettings("thread", undefined, { type: "runtime", id: "approval-required" });
    const reply = session.send("thread", "Hi", "command", "message", settings.selection);
    expect(commands()[0]?.payload).toEqual({
      type: "thread.runtime-mode.set", commandId: "command:runtime-mode", threadId: "thread", runtimeMode: "approval-required",
    });
    session.receive(JSON.stringify({
      _tag: "Exit", requestId: commands()[0]!.id,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Runtime change denied" } }] },
    }));
    await expect(reply).resolves.toEqual({ ok: false, error: "Runtime change denied" });
    expect(commands().map((request) => request.payload.type)).toEqual(["thread.runtime-mode.set"]);
  });

  test("waits for runtime acceptance then dispatches with a separate command id", async () => {
    const { session, commands, dispatched, accept } = settingsSession();
    const settings = session.stageSettings("thread", undefined, { type: "runtime", id: "auto" });
    const reply = session.send("thread", "Hi", "command", "message", settings.selection);
    expect(commands().map((request) => request.payload.type)).toEqual(["thread.runtime-mode.set"]);
    accept(commands()[0]!);
    const message = await dispatched;
    expect(commands().map((request) => request.payload.type)).toEqual(["thread.runtime-mode.set", "message.dispatch"]);
    expect(message.payload).toMatchObject({
      commandId: "command", messageId: "message", modelSelection: { instanceId: "codex", model: "gpt-6" },
    });
    expect(message.payload).not.toHaveProperty("runtimeMode");
    accept(message);
    await expect(reply).resolves.toEqual({ ok: true, error: "" });
  });

  test("rechecks settings changed while waiting for runtime acceptance", async () => {
    const { session, provider, updateProviders, commands, accept } = settingsSession();
    const model = session.stageSettings("thread", undefined, { type: "model", id: "codex:gpt-6-mini" });
    const settings = session.stageSettings("thread", model.selection, { type: "runtime", id: "auto" });
    const reply = session.send("thread", "Hi", "command", "message", settings.selection);
    updateProviders([{ ...provider, enabled: false }]);
    accept(commands()[0]!);
    await expect(reply).resolves.toEqual({ ok: false, error: "Model turned off for this project." });
    expect(commands().map((request) => request.payload.type)).toEqual(["thread.runtime-mode.set"]);
  });
});
