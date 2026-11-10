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

function settingsSession() {
  const requests: SettingsRequest[] = [];
  const dispatched = Promise.withResolvers<SettingsRequest>();
  const session = new DirectSession({
    id: "env", label: "Mac", url: "http://localhost:13773",
    enabled: true, status: "Connecting", machineSymbol: "server.rack",
  });
  session.open({
    readyState: 1, bufferedAmount: 0,
    send(frame) {
      const request = JSON.parse(String(frame)) as SettingsRequest;
      if (request._tag !== "Request") return;
      requests.push(request);
      if (request.payload.type === "message.dispatch") dispatched.resolve(request);
    },
    close() {},
  });
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
  session.receive(JSON.stringify({
    _tag: "Chunk", requestId: "1", values: [{
      kind: "snapshot", snapshot: {
        projects: [], threads: [{
          id: "thread", projectId: "project", runtimeMode: "full-access",
          modelSelection: { instanceId: "codex", model: "gpt-6" },
        }],
      },
    }],
  }));
  updateProviders([provider]);
  const accept = (request: SettingsRequest) => session.receive(JSON.stringify({
    _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: { sequence: 2 } },
  }));
  const commands = () => requests.filter((request) => request.tag === "orchestration.dispatchCommand");
  return { session, provider, updateProviders, requests, commands, dispatched: dispatched.promise, accept };
}

describe("direct T3 connection", () => {
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
        updatedAt: "1m",
        lastError: "",
        lastErrorTime: expect.any(String),
        messages: [],
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
    const { session, provider, updateProviders, requests, commands } = settingsSession();
    updateProviders([provider, { ...provider, instanceId: "claude", driver: "claudeAgent" }]);
    const thread = {
      id: "thread", projectId: "project", runtimeMode: "full-access", status: "idle",
      latestRunId: "completed", latestUserMessageAt: null, activeProviderThreadId: "provider-thread",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
    };
    const shell = () => session.receive(JSON.stringify({
      _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { projects: [], threads: [thread] } }],
    }));
    shell();
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
    shell();
    expect(canSwitch()).toBe(false);
    snapshot();
    session.receive(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { projects: [], threads: [] } }] }));
    shell();
    expect(canSwitch()).toBe(false);
    snapshot();
    session.receive(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Thread stream ended" } }] } }));
    snapshot();
    expect(canSwitch()).toBe(false);
    session.select("thread");
    requestId = requests.at(-1)!.id;
    snapshot();
    session.disconnected("Connection lost");
    snapshot();
    expect(canSwitch()).toBe(false);
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
