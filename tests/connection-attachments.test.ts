import { expect, test } from "bun:test";
import { AttachmentSession, RpcFailure } from "../attachment-session";
import { DirectSession } from "../connection";
import type { AttachmentDemand, DisplayAttachment } from "../attachments";

function fixture() {
  let next = 0;
  const queries: {
    id: string;
    tag: string;
    payload: unknown;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
  }[] = [];
  const pending = new Set<string>();
  const cancelled: string[] = [];
  let accessKey = "epoch-1";
  let maximum = 0;
  const session = new AttachmentSession({
    metadata: () => ({
      accessKey,
      origin: "https://fixture.example",
      allowed: true,
      uploads: true,
      maxFileBytes: 50 * 1024 * 1024,
    }),
    query(tag, payload) {
      const result = Promise.withResolvers<Record<string, unknown>>();
      const id = String(++next);
      pending.add(id);
      maximum = Math.max(maximum, pending.size);
      queries.push({
        id,
        tag,
        payload,
        resolve: (value) => {
          pending.delete(id);
          result.resolve(value);
        },
        reject: (error) => {
          pending.delete(id);
          result.reject(error);
        },
      });
      return { id, promise: result.promise };
    },
    cancel(id) {
      cancelled.push(id);
      queries.find((query) => query.id === id)!.reject(new Error("Cancelled"));
    },
    resolve(threadId, viewKey, demand): DisplayAttachment | undefined {
      if (threadId !== "thread" || viewKey !== "view" || demand.messageId !== demand.attachmentId)
        return;
      return {
        id: demand.attachmentId,
        type: "image",
        name: `${demand.attachmentId}.png`,
        mimeType: "image/png",
        sizeBytes: 100,
        width: 10,
        height: 10,
      };
    },
  });
  const demand = (id: number): AttachmentDemand => ({
    threadId: "env:thread",
    viewKey: "view",
    messageId: `image-${id}`,
    attachmentId: `image-${id}`,
    attempt: 0,
  });
  const accept = (
    query: (typeof queries)[number],
    expiresAt: number | string = Date.parse("2026-11-10T02:00:00Z"),
  ) => query.resolve({ relativeUrl: `/api/assets/token/${query.id}.png`, expiresAt });
  return {
    session,
    queries,
    pending,
    cancelled,
    demand,
    accept,
    maximum: () => maximum,
    rotate: () => {
      accessKey = "epoch-2";
    },
  };
}

test("preview demand bounds pending work, cancels departed rows, and preserves completed cache entries", async () => {
  const visible = fixture();
  const demands = Array.from({ length: 25 }, (_, index) => visible.demand(index));
  const initial = visible.session.previews("thread", "view", demands, 0);
  expect(visible.queries).toHaveLength(12);
  for (const query of visible.queries) visible.accept(query);
  const queued = await initial;
  expect(queued.previews).toHaveLength(25);
  expect(queued.previews.filter((preview) => preview.state === "ready")).toHaveLength(12);
  const next = visible.session.previews("thread", "view", demands, 0);
  expect(visible.queries).toHaveLength(24);
  for (const query of visible.queries.slice(12)) visible.accept(query);
  await next;
  const final = visible.session.previews("thread", "view", demands, 0);
  expect(visible.queries).toHaveLength(25);
  visible.accept(visible.queries.at(-1)!);
  await final;
  const loaded = await visible.session.previews("thread", "view", demands, 0);
  expect(loaded.previews.map((preview) => preview.attachmentId)).toEqual(
    demands.map((demand) => demand.attachmentId),
  );
  expect(loaded.previews.every((preview) => preview.state === "ready")).toBe(true);
  expect(visible.maximum()).toBe(12);

  const f = fixture();
  const now = Date.parse("2026-11-10T00:00:00Z");
  const first = f.session.previews(
    "thread",
    "view",
    Array.from({ length: 100 }, (_, index) => f.demand(index)),
    now,
  );
  expect(f.queries).toHaveLength(12);
  expect(f.maximum()).toBe(12);
  const second = f.session.previews("thread", "view", [f.demand(101)], now);
  expect(f.cancelled).toHaveLength(12);
  expect(f.pending.size).toBe(1);
  f.accept(f.queries.at(-1)!);
  expect((await first).previews).toEqual([]);
  const shown = await second;
  expect(shown.previews).toEqual([
    {
      attachmentId: "image-101",
      attempt: 0,
      url: "https://fixture.example/api/assets/token/13.png",
      expiresAt: Date.parse("2026-11-10T02:00:00Z"),
      state: "ready",
      error: "",
      width: 10,
      height: 10,
    },
  ]);
  expect(await f.session.previews("thread", "view", [f.demand(101)], now + 60000)).toEqual(shown);
  expect(f.queries).toHaveLength(13);
  const expiresAt = shown.previews[0]!.expiresAt;
  expect(await f.session.previews("thread", "view", [f.demand(101)], expiresAt - 5001)).toEqual(
    shown,
  );
  expect(f.queries).toHaveLength(13);
  const refreshed = f.session.previews("thread", "view", [f.demand(101)], expiresAt - 5000);
  expect(f.queries).toHaveLength(14);
  f.accept(f.queries.at(-1)!, Date.parse("2026-11-10T03:00:00Z"));
  expect((await refreshed).previews[0]).toMatchObject({
    url: "https://fixture.example/api/assets/token/14.png",
    expiresAt: Date.parse("2026-11-10T03:00:00Z"),
    state: "ready",
  });
  expect((await f.session.previews("thread", "stale", [f.demand(101)], now)).previews).toEqual([]);
  f.rotate();
  const rotated = f.session.previews("thread", "view", [f.demand(101)], now);
  expect(f.queries).toHaveLength(15);
  f.queries.at(-1)!.resolve({
    relativeUrl: "/api/assets/token/15.png",
    expiresAt: "2026-11-10T02:00:00Z",
    imageDimensions: { width: 800, height: 400 },
  });
  expect((await rotated).previews[0]).toMatchObject({
    url: "https://fixture.example/api/assets/token/15.png",
    width: 800,
    height: 400,
  });
});

test("preview errors preserve missing tags, explicit retries remint, and settled cache stays bounded", async () => {
  const f = fixture();
  const now = Date.parse("2026-11-10T00:00:00Z");
  const missing = f.session.previews("thread", "view", [f.demand(0)], now);
  f.queries.at(-1)!.reject(new RpcFailure("Gone", "AssetAttachmentNotFoundError"));
  expect((await missing).previews[0]).toMatchObject({ state: "missing", error: "Gone" });
  const retry = f.session.previews("thread", "view", [{ ...f.demand(0), attempt: 1 }], now);
  f.accept(f.queries.at(-1)!);
  expect((await retry).previews[0]).toMatchObject({ state: "ready", attempt: 1 });
  for (let index = 1; index <= 70; index++) {
    const pending = f.session.previews("thread", "view", [f.demand(index)], now);
    f.accept(f.queries.at(-1)!);
    await pending;
  }
  const before = f.queries.length;
  const evicted = f.session.previews("thread", "view", [f.demand(1)], now);
  expect(f.queries).toHaveLength(before + 1);
  f.accept(f.queries.at(-1)!);
  await evicted;
  const expired = f.session.previews(
    "thread",
    "view",
    [f.demand(70)],
    Date.parse("2026-11-10T02:00:01Z"),
  );
  expect(f.queries).toHaveLength(before + 2);
  f.accept(f.queries.at(-1)!, "2026-11-10T03:00:00Z");
  await expired;
  expect(f.maximum()).toBe(1);
});

test("an unknown attachment send retains its identity through changed capabilities and denied retries", async () => {
  const requests: { id: string; tag: string; payload: Record<string, unknown> }[] = [];
  const session = new DirectSession({
    id: "env",
    label: "Mac",
    url: "http://localhost:13773",
    enabled: true,
    status: "Connecting",
    machineSymbol: "server.rack",
  });
  const open = (changed = false) => {
    session.open({
      readyState: 1,
      bufferedAmount: 0,
      send(value) {
        const frame = JSON.parse(String(value));
        if (frame._tag === "Request") requests.push(frame);
      },
      close() {},
    });
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requests.findLast((request) => request.tag === "orchestration.subscribeShell")!
          .id,
        values: [
          {
            kind: "snapshot",
            snapshot: {
              projects: [{ id: "project" }],
              threads: [
                {
                  id: "thread",
                  projectId: "project",
                  runtimeMode: changed ? "approval-required" : "full-access",
                  modelSelection: { instanceId: "provider", model: "model" },
                },
              ],
            },
          },
        ],
      }),
    );
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requests.findLast((request) => request.tag === "subscribeServerConfig")!.id,
        values: [
          {
            type: "snapshot",
            config: {
              environment: {
                capabilities: {
                  attachmentUploads: !changed,
                  fileAttachments: { maxUploadBytes: changed ? 0 : 50 * 1024 * 1024 },
                },
              },
              providers: changed
                ? []
                : [
                    {
                      instanceId: "provider",
                      driver: "codex",
                      enabled: true,
                      installed: true,
                      auth: { status: "authenticated" },
                      models: [{ slug: "model", name: "Model" }],
                    },
                  ],
            },
          },
        ],
      }),
    );
  };
  const selection = {
    threadId: "thread",
    modelSelection: { instanceId: "provider", model: "model" },
    runtimeMode: "full-access",
  };
  const attachments = [
    {
      type: "file",
      id: "pending-asset",
      name: "proof.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
    },
  ];
  const commands = () =>
    requests.filter((request) => request.tag === "orchestration.dispatchCommand");
  open();
  const original = session.send(
    "thread",
    "Receipt may be lost",
    "stable-command",
    "stable-message",
    selection,
    attachments,
  );
  expect(commands()).toHaveLength(1);
  const payload = {
    type: "message.dispatch",
    threadId: "thread",
    text: "Receipt may be lost",
    commandId: "stable-command",
    messageId: "stable-message",
    attachments: [
      {
        type: "file",
        id: "pending-asset",
        name: "proof.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
      },
    ],
    modelSelection: { instanceId: "provider", model: "model" },
    createdBy: "user",
    creationSource: "mobile",
    dispatchMode: { type: "start_immediately" },
  };
  expect(commands()[0]!.payload).toEqual(payload);
  session.disconnected("Connection lost after dispatch");
  expect(await original).toEqual({
    ok: false,
    error: "Connection lost after dispatch",
    state: "unknown",
  });

  open(true);
  const unavailableRetry = await session.send(
    "thread",
    "Receipt may be lost",
    "stable-command",
    "stable-message",
    selection,
    attachments,
    true,
  );
  expect(unavailableRetry).toEqual({
    ok: false,
    error: "proof.pdf exceeds the 0 MB attachment limit.",
    state: "unknown",
  });
  expect(commands()).toHaveLength(1);
  session.disconnected("Restoring connection");
  open();
  const refusedRetry = session.send(
    "thread",
    "Receipt may be lost",
    "stable-command",
    "stable-message",
    selection,
    attachments,
    true,
  );
  expect(commands()).toHaveLength(2);
  expect(commands()[1]!.payload).toEqual(payload);
  session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: commands()[1]!.id,
      exit: {
        _tag: "Failure",
        cause: [
          { _tag: "Fail", error: { _tag: "RpcForbiddenError", message: "Permission was revoked" } },
        ],
      },
    }),
  );
  expect(await refusedRetry).toEqual({
    ok: false,
    error: "Permission was revoked",
    state: "unknown",
  });

  const acceptedRetry = session.send(
    "thread",
    "Receipt may be lost",
    "stable-command",
    "stable-message",
    selection,
    attachments,
    true,
  );
  expect(commands()).toHaveLength(3);
  expect(commands()[2]!.payload).toEqual(payload);
  session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: commands()[2]!.id,
      exit: { _tag: "Success", value: { sequence: 1 } },
    }),
  );
  expect(await acceptedRetry).toEqual({ ok: true, error: "", state: "accepted" });
});
