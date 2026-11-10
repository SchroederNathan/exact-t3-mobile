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
        status: "Done",
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
