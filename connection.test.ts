import { describe, expect, test } from "bun:test";
import { DirectSession, pair, parsePairingAddress, scopedThreadId } from "./connection";

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
              projects: [{ id: "p", title: "T3 Code" }],
              threads: [
                {
                  id: "t",
                  projectId: "p",
                  title: "Fix startup",
                  status: "idle",
                  updatedAt: "2026-11-08T12:00:00Z",
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
    expect(session.threads()).toEqual([
      {
        id: scopedThreadId("env", "t"),
        environmentId: "env",
        title: "Fix startup",
        project: "T3 Code",
        status: "Done",
        updatedAt: "2026-11-08T12:00:00Z",
        messages: [],
      },
    ]);
    expect(JSON.parse(sent.at(-1)!)).toEqual({ _tag: "Ack", requestId: "1" });
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
            thread: { id: "t", projectId: "p", title: "Fixed startup", status: "completed" },
          },
        ],
      }),
    );
    expect(session.threads()[0]?.title).toBe("Fixed startup");
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "1",
        values: [{ kind: "thread.removed", location: "active", threadId: "t" }],
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
    session.disconnected("Connection lost");
    await expect(interrupted).resolves.toEqual({ ok: false, error: "Connection lost" });
    expect(session.threads()).toEqual([]);
  });
});
