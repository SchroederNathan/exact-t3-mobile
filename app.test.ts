import { expect, spyOn, test } from "bun:test";
import { answer as sourceAnswer } from "./app";
import type { Answer, NativeModule, Storage, Store } from "./app.contract.d.ts";

test("native environments aggregate colliding IDs and keep commands and connection lifetimes scoped", async () => {
  let saved = JSON.stringify(["a", "b"].map((id) => ({
    id, label: `Mac ${id}`, url: `http://${id}.example`, enabled: true,
  })));
  const secrets = new Map([["t3-environment-tokens", JSON.stringify({ a: "token-a", b: "token-b" })]]);
  let readingStore = false;
  const answer: Answer = (...args) => {
    readingStore = true;
    try { return sourceAnswer(...args); }
    finally { readingStore = false; }
  };
  const store = {
    get: (key: string) => {
      if (!readingStore) throw new Error("Read the store before the answer's first await.");
      return secrets.get(key) ?? null;
    },
    set: (key: string, value: string) => {
      if (!readingStore) throw new Error("This continuation has no store.");
      secrets.set(key, value);
    },
  } as Store;
  const storage = { fs: {
    readFile: async () => new TextEncoder().encode(saved).buffer,
    atomicWriteFile: async (_path: string, data: Uint8Array) => {
      saved = new TextDecoder().decode(data);
    },
  } } as Storage;
  type Connection = { id: string; generation: number; origin: string; token: string };
  let connections: Connection[] = [];
  const events: Record<string, unknown>[] = [];
  const receipts = new Map<string, { finish?: () => void; finished: boolean }>();
  const delayedRegistrations: (() => void)[] = [];
  let delayRegistration = false;
  const sent: { environmentId: string; generation: number; frame: { _tag: string; id: string; requestId?: string; tag: string; payload: Record<string, unknown> } }[] = [];
  const measurements: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  const highlights: { code: string; resolve: (value: Record<string, unknown>) => void }[] = [];
  const native: NativeModule = {
    available: true,
    watch() {},
    later(request) {
      if (request.op === "markdown.measureTable") {
        if (!readingStore) throw new Error("Table measurement must be issued before the first await.");
        return new Promise((resolve, reject) => measurements.push({ resolve, reject }));
      }
      if (request.op === "markdown.highlight") {
        if (!readingStore) throw new Error("Highlight work must be issued before the first await.");
        return new Promise((resolve) => highlights.push({ code: String(request.code), resolve }));
      }
      if (request.op !== "connections.wait") throw new Error("Unexpected native.later");
      return new Promise((resolve) => {
        const register = () => {
          const id = String(request.receipt);
          const receipt = receipts.get(id);
          if (receipt?.finished) {
            receipts.delete(id);
            resolve({});
          } else {
            receipts.set(id, { finished: false, finish: () => resolve({}) });
          }
        };
        if (delayRegistration) delayedRegistrations.push(register);
        else register();
      });
    },
    call(request) {
      if (request.op === "connections.finish") {
        const receipt = String(request.receipt);
        const finish = receipts.get(receipt)?.finish;
        if (finish) {
          receipts.delete(receipt);
          finish();
        } else {
          receipts.set(receipt, { finished: true });
        }
        return {};
      }
      if (request.op === "connections.sync") {
        connections = request.connections as Connection[];
        return { events: events.splice(0) };
      }
      if (request.op === "connections.send") {
        const frame = JSON.parse(String(request.data));
        if (["runtime-request.respond", "thread.user-input.dismiss", "run.interrupt"].includes(frame.payload?.type) && !readingStore) throw new Error("Controls must send before the first await.");
        const connection = connections.find((entry) => entry.id === request.id && entry.generation === request.generation);
        if (!connection) throw new Error("Disconnected");
        sent.push({ environmentId: connection.id, generation: connection.generation, frame: JSON.parse(String(request.data)) });
        return {};
      }
      if (request.op === "connections.close") return {};
      throw new Error("Unexpected native operation");
    },
  };
  const idleNative: NativeModule = {
    ...native,
    get available() { throw new Error("No native answer is active."); },
    watch() { throw new Error("No native answer is active."); },
  };
  expect(await answer("loadToolPanels", ["", "", []], store, storage, idleNative)).toEqual({ viewKey: "", panels: [] });
  expect(await answer("loadCodeHighlights", ["", "", 0, []], store, storage, idleNative)).toEqual({ threadId: "", viewKey: "", highlights: [] });
  expect(await answer("loadTableLayouts", ["", "", 0, []], store, storage, idleNative)).toEqual({ threadId: "", viewKey: "", layouts: [] });
  expect(await answer("loadLinkedFile", ["", "", "0", "0"], store, storage, idleNative)).toEqual({ path: "", targetLine: "0", error: "", lines: [] });
  using _fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Use the native transport"));
  const catalogNative: NativeModule = {
    ...native,
    call(request) {
      if (!readingStore) throw new Error("native storage is unavailable during bake or in an unconfigured host");
      return native.call(request);
    },
  };
  let activeThread = "b:t";
  const load = async (selected = "") => {
    const environments = await answer("loadEnvironmentRecords", [], store, storage, native);
    return answer("loadCatalog", [selected, activeThread, environments, 0], store, storage, catalogNative);
  };
  const emit = (id: string, type: string, data = "", reason = "") => {
    events.push({ id, generation: connections.find((entry) => entry.id === id)?.generation ?? 1, type, data, reason });
  };
  const chunk = (id: string, requestId: string, value: object) => emit(id, "message", JSON.stringify({
    _tag: "Chunk", requestId, values: [value],
  }));
  const reply = (id: string, requestId: string, value: object) => emit(id, "message", JSON.stringify({
    _tag: "Exit", requestId, exit: { _tag: "Success", value },
  }));
  await load();
  for (const id of ["a", "b"]) {
    emit(id, "open");
    chunk(id, "1", { kind: "snapshot", snapshot: {
      projects: [{ id: "p", title: `Project ${id}`, workspaceRoot: `/${id}` }],
      threads: [{ id: "t", title: `Thread ${id}`, projectId: "p", updatedAt: "2026-11-10T00:00:00Z" }],
    } });
    chunk(id, "2", { type: "snapshot", config: { settings: { favorites: [] }, providers: [{
      instanceId: "provider", enabled: true, installed: true, models: [{ slug: "model" }],
    }] } });
  }
  const catalog = await load();
  const initialSubscriptions = sent.filter(({ frame }) => frame.tag === "orchestration.subscribeThread");
  expect(initialSubscriptions.map(({ environmentId, frame }) => ({ environmentId, threadId: frame.payload.threadId }))).toEqual([
    { environmentId: "b", threadId: "t" },
  ]);
  let bSubscription = initialSubscriptions[0]!.frame.id;
  chunk("b", bSubscription, { kind: "snapshot", projection: {
    messages: [{ id: "b-message", role: "user", text: "Opened by a cold link", createdAt: "2026-11-10T00:00:00Z" }],
  } });
  expect((await load()).threads.find(({ id }) => id === "b:t")?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["Opened by a cold link"]);
  expect(catalog.threads.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: "a:t", title: "Thread a" }, { id: "b:t", title: "Thread b" },
  ]);
  expect(catalog.projects).toEqual([
    { id: "a:p", title: "Project a", environmentId: "a" },
    { id: "b:p", title: "Project b", environmentId: "b" },
  ]);
  chunk("b", bSubscription, { kind: "snapshot", snapshotSequence: 30, projection: {
    turnItems: [{ id: "approval-item", type: "approval_request", requestId: "request", options: [{ decision: "acceptAlways", label: "Always" }] }],
    visibleTurnItems: [], runtimeRequests: [{ id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } }],
  } });
  const controls = (await load()).threads.find(({ id }) => id === "b:t")!.controls;
  _fetch.mockImplementationOnce(async (url, init) => {
    expect(String(url)).toBe("http://b.example/api/auth/session");
    expect(init?.headers).toEqual({ Authorization: "Bearer token-b" });
    return new Response(JSON.stringify({ authenticated: true, permissions: ["orchestration:operate"] }));
  });
  expect(await answer("loadControlAccess", ["b", controls.accessKey, 0], store, storage, idleNative)).toEqual({ key: controls.accessKey, allowed: true, error: "" });
  const beforeWrongTarget = sent.length;
  expect(await answer("submitControl", ["b:t", controls.accessKey, "approve", "request", '["a","t","request"]', "acceptAlways", []], store, storage, native)).toEqual({ ok: false, error: "This request belongs to a different thread.", key: '["a","t","request"]', threadId: "b:t", drafts: [] });
  expect(sent.length).toBe(beforeWrongTarget);
  const controlPromise = answer("submitControl", ["b:t", controls.accessKey, "approve", "request", '["b","t","request"]', "acceptAlways", []], store, storage, native);
  const controlRequest = sent.findLast((entry) => entry.frame.payload?.type === "runtime-request.respond")!;
  expect(controlRequest.environmentId).toBe("b");
  expect(controlRequest.frame.payload).toEqual({ type: "runtime-request.respond", commandId: expect.any(String), threadId: "t", requestId: "request", decision: "acceptAlways" });
  expect(receipts.size).toBe(1);
  activeThread = "a:t";
  await load();
  const aControlSubscription = sent.findLast((entry) => entry.environmentId === "a" && entry.frame.tag === "orchestration.subscribeThread")!.frame.id;
  chunk("a", aControlSubscription, { kind: "snapshot", projection: { runs: [{ id: "run-A", ordinal: 1, status: "running" }], runtimeRequests: [], turnItems: [], visibleTurnItems: [] } });
  const aControls = (await load()).threads.find(({ id }) => id === "a:t")!.controls;
  _fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ authenticated: true, permissions: ["orchestration:operate"] })));
  await answer("loadControlAccess", ["a", aControls.accessKey, 0], store, storage, idleNative);
  const stopPromise = answer("stopControl", ["a:t", aControls.accessKey, "run-A", "a:t:stop:run-A"], store, storage, native);
  const stopRequest = sent.findLast((entry) => entry.frame.payload?.type === "run.interrupt")!;
  expect(stopRequest.environmentId).toBe("a");
  expect(stopRequest.frame.payload).toEqual({ type: "run.interrupt", commandId: expect.any(String), threadId: "t", runId: "run-A", holdQueue: true });
  expect(receipts.size).toBe(2);
  reply("a", stopRequest.frame.id, { sequence: 1 });
  await load();
  expect(await stopPromise).toEqual({ ok: true, error: "", key: "a:t:stop:run-A", threadId: "a:t", drafts: [] });
  expect(receipts.size).toBe(1);
  reply("b", controlRequest.frame.id, { sequence: 31 });
  await load();
  expect(await controlPromise).toEqual({ ok: true, error: "", key: '["b","t","request"]', threadId: "b:t", drafts: [] });
  expect(receipts.size).toBe(0);
  activeThread = "b:t";
  await load();
  bSubscription = sent.findLast((entry) => entry.environmentId === "b" && entry.frame.tag === "orchestration.subscribeThread")!.frame.id;
  const codeSnapshot = async (body: string, streaming = false) => {
    chunk("b", bSubscription, { kind: "snapshot", projection: { messages: [{ id: "code-message", role: "assistant", text: body, streaming }] } });
    return (await load()).threads.find(({ id }) => id === "b:t")!;
  };
  const highlightArgs = (thread: typeof catalog.threads[number]) => [thread.id, thread.toolViewKey, thread.markdownRevision, [{
    threadId: thread.id, viewKey: thread.toolViewKey, messageId: "code-message", blockId: "code-message:block:0",
  }]] as [string, string, number, { threadId: string; viewKey: string; messageId: string; blockId: string }[]];
  const pendingCode = await codeSnapshot("```ts\nconst value = 1;", true);
  expect((await answer("loadCodeHighlights", highlightArgs(pendingCode), store, storage, native)).highlights).toEqual([]);
  expect(highlights).toHaveLength(0);
  const closedCode = await codeSnapshot("```ts\nconst value = 1;\n```", true);
  const firstHighlight = answer("loadCodeHighlights", highlightArgs(closedCode), store, storage, native);
  const duplicateHighlight = answer("loadCodeHighlights", highlightArgs(closedCode), store, storage, native);
  expect(highlights.map(({ code }) => code)).toEqual(["const value = 1;", "const value = 1;"]);
  const changedCode = await codeSnapshot("```ts\nconst value = 2;\n```");
  expect((await answer("loadCodeHighlights", highlightArgs(closedCode), store, storage, native)).highlights).toEqual([]);
  const changedHighlight = answer("loadCodeHighlights", highlightArgs(changedCode), store, storage, native);
  expect(highlights.map(({ code }) => code)).toEqual(["const value = 1;", "const value = 1;", "const value = 2;"]);
  highlights[2]!.resolve({ tokens: [{ start: 0, end: 5, kind: 0 }] });
  expect((await changedHighlight).highlights[0]).toMatchObject({ body: "const value = 2;", runs: [{ text: "const", kind: 0 }, { text: " value = 2;", kind: -1 }] });
  highlights[0]!.resolve({ tokens: [] });
  highlights[1]!.resolve({ tokens: [] });
  expect((await firstHighlight).viewKey).toBe(closedCode.toolViewKey);
  expect((await duplicateHighlight).highlights[0]?.body).toBe("const value = 1;");
  await answer("loadCodeHighlights", highlightArgs(changedCode), store, storage, native);
  expect(highlights).toHaveLength(3);
  const tableThread = await codeSnapshot("| One | Two |\n| --- | --- |\n| wide | cell |");
  const firstTable = answer("loadTableLayouts", highlightArgs(tableThread), store, storage, native);
  const secondTable = answer("loadTableLayouts", highlightArgs(tableThread), store, storage, native);
  expect(measurements).toHaveLength(2);
  measurements[0]!.reject(new Error("Superseded"));
  measurements[1]!.resolve({ widths: [120, 240] });
  expect((await firstTable).layouts).toEqual([]);
  expect((await secondTable).layouts).toMatchObject([{ widths: [120, 240] }]);
  await answer("loadTableLayouts", highlightArgs(tableThread), store, storage, native);
  expect(measurements).toHaveLength(2);
  const changedTable = await codeSnapshot("| One | Two |\n| --- | --- |\n| much wider | cell |");
  expect((await answer("loadTableLayouts", highlightArgs(tableThread), store, storage, native)).layouts).toEqual([]);
  const changedMeasurement = answer("loadTableLayouts", highlightArgs(changedTable), store, storage, native);
  expect(measurements).toHaveLength(3);
  measurements[2]!.resolve({ widths: [160, 240] });
  expect((await changedMeasurement).layouts).toMatchObject([{ widths: [160, 240] }]);
  chunk("b", bSubscription, { kind: "snapshot", projection: { messages: [{ id: "b-message", role: "user", text: "Opened by a cold link", createdAt: "2026-11-10T00:00:00Z" }] } });
  await load();
  const initialGenerations = connections.map(({ id, generation }) => ({ id, generation }));
  for (const selected of ["a", "b", ""]) {
    expect((await load(selected)).threads.map(({ id }) => id)).toEqual(["a:t", "b:t"]);
    expect(connections.map(({ id, generation }) => ({ id, generation }))).toEqual(initialGenerations);
  }
  expect(sent.filter(({ frame }) => frame.tag === "orchestration.subscribeThread").length).toBe(3);

  activeThread = "a:t";
  const beforeSwitch = sent.length;
  await load();
  expect(sent.slice(beforeSwitch).map(({ environmentId, frame }) => ({
    environmentId, type: frame._tag, threadId: frame.payload?.threadId, requestId: frame.requestId,
  }))).toEqual([
    { environmentId: "a", type: "Request", threadId: "t", requestId: undefined },
    { environmentId: "b", type: "Interrupt", threadId: undefined, requestId: bSubscription },
  ]);
  const aSubscription = sent.slice(beforeSwitch).find(({ environmentId }) => environmentId === "a")!.frame.id;
  chunk("b", bSubscription, { kind: "snapshot", projection: {
    messages: [{ id: "stale", role: "user", text: "Stale unsubscribed transcript" }],
  } });
  chunk("a", aSubscription, { kind: "snapshot", projection: {
    messages: [{ id: "a-message", role: "user", text: "Selected by the route", createdAt: "2026-11-10T00:00:00Z" }],
  } });
  const switched = await load();
  expect(switched.threads.find(({ id }) => id === "a:t")?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["Selected by the route"]);
  expect(switched.threads.find(({ id }) => id === "b:t")?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["Opened by a cold link"]);

  const visiting = answer("visitThread", ["b:t", "2026-11-10T01:00:00Z", true], store, storage, native);
  const visit = sent.at(-1)!;
  expect(visit).toMatchObject({ environmentId: "b", frame: { tag: "orchestration.dispatchCommand", payload: {
    type: "thread.visit", threadId: "t", visitedAt: "2026-11-10T01:00:00Z", opened: true,
  } } });
  expect(receipts.size).toBe(1);
  reply("b", visit.frame.id, { sequence: 3 });
  await load();
  expect(await visiting).toEqual({ ok: true, error: "" });
  expect(receipts.size).toBe(0);

  const updatingVisit = answer("visitThread", ["a:t", "2026-11-10T01:01:00Z", false], store, storage, native);
  const visitUpdate = sent.at(-1)!;
  expect(visitUpdate.environmentId).toBe("a");
  expect(visitUpdate.frame.payload.opened).toBeUndefined();
  emit("a", "message", JSON.stringify({ _tag: "Exit", requestId: visitUpdate.frame.id,
    exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Visit refused." } }] },
  }));
  await load();
  expect(await updatingVisit).toEqual({ ok: false, error: "Visit refused." });
  expect(receipts.size).toBe(0);
  expect(await answer("visitThread", ["missing:t", "2026-11-10T01:01:00Z", true], store, storage, native)).toEqual({ ok: false, error: "This environment is disconnected." });

  const historyRow = (id: string, ordinal: number) => ({
    position: ordinal, visibility: "local", sourceThreadId: "t", sourceItemId: id,
    item: { id, threadId: "t", type: "assistant_message", ordinal, text: id, status: "completed" },
  });
  chunk("a", aSubscription, { kind: "snapshot", snapshotSequence: 20,
    historyCursor: "older/opaque+cursor", hasMoreHistory: true, latestLocalTurnOrdinal: 10,
    projection: { thread: { id: "t" }, visibleTurnItems: [historyRow("recent", 10)] },
  });
  expect((await load()).threads.find(({ id }) => id === "a:t")?.history).toMatchObject({ ready: true, hasMore: true });
  _fetch.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
  expect(await answer("loadEarlierThread", ["a:t"], store, storage, native)).toEqual({ ok: false, error: "Earlier messages could not be loaded (503)." });
  expect((await load()).threads.find(({ id }) => id === "a:t")?.history).toMatchObject({ hasMore: true, loading: false, error: "Earlier messages could not be loaded (503)." });
  const page = Promise.withResolvers<Response>();
  _fetch.mockImplementationOnce(async (input, init) => {
    expect(String(input)).toBe("http://a.example/api/orchestration/threads/t/history?cursor=older%2Fopaque%2Bcursor");
    expect(init?.headers).toEqual({ Authorization: "Bearer token-a", "x-t3-orchestration-protocol": "2" });
    return page.promise;
  });
  const loadingHistory = answer("loadEarlierThread", ["a:t"], store, storage, native);
  expect((await load()).threads.find(({ id }) => id === "a:t")?.history).toMatchObject({ loading: true, error: "" });
  page.resolve(Response.json({ items: [historyRow("earlier", 1)], nextCursor: null, hasMoreHistory: false }));
  expect(await loadingHistory).toEqual({ ok: true, error: "" });
  const withHistory = (await load()).threads.find(({ id }) => id === "a:t");
  expect(withHistory?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["earlier", "recent"]);
  expect(withHistory?.history).toMatchObject({ hasMore: false, loading: false, error: "" });
  _fetch.mockClear();
  const afterSwitch = sent.length;
  await load();
  expect(sent.length).toBe(afterSwitch);

  activeThread = "";
  await load();
  expect(sent.slice(afterSwitch).map(({ environmentId, frame }) => ({ environmentId, type: frame._tag, requestId: frame.requestId }))).toEqual([
    { environmentId: "a", type: "Interrupt", requestId: aSubscription },
  ]);
  const afterLeaving = sent.length;
  await load();
  expect(sent.length).toBe(afterLeaving);

  const favoriting = answer("setModelFavorite", ["a:t", "provider:model", true], store, storage, native);
  const favorite = sent.at(-1)!;
  expect(favorite).toMatchObject({ environmentId: "a", frame: { tag: "server.updateSettings" } });
  reply("a", favorite.frame.id, { favorites: [{ provider: "provider", model: "model" }] });
  await answer("loadSettings", ["a:t"], store, storage, native);
  expect(events).toEqual([]);
  expect(await favoriting).toEqual({ ok: true, error: "" });
  const sheet = await answer("loadSettings", ["a:t"], store, storage, native);
  expect(sheet.groups[0]?.models[0]?.isFavorite).toBe(true);

  expect(await answer("command", ["open", "b:t", ""], store, storage, native)).toEqual({ ok: true, error: "" });
  expect(sent.at(-1)).toMatchObject({ environmentId: "b", frame: { tag: "orchestration.subscribeThread", payload: { threadId: "t" } } });
  const sending = answer("command", ["send", "a:t", "hello a"], store, storage, native);
  let sendState = "pending";
  void Promise.resolve(sending).then(() => { sendState = "accepted"; });
  const send = sent.at(-1)!;
  expect(send).toMatchObject({ environmentId: "a", frame: { payload: { type: "message.dispatch", threadId: "t", text: "hello a" } } });
  await load();
  expect(sendState).toBe("pending");
  expect(receipts.size).toBe(1);
  reply("a", String(send.frame.id), { sequence: 1 });
  await load();
  expect(await sending).toEqual({ ok: true, error: "" });
  expect(receipts.size).toBe(0);

  const rejected = answer("command", ["send", "a:t", "refused"], store, storage, native);
  const rejection = sent.at(-1)!;
  emit("a", "message", JSON.stringify({ _tag: "Exit", requestId: rejection.frame.id,
    exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Fixture rejected the message." } }] },
  }));
  await load();
  expect(await rejected).toEqual({ ok: false, error: "Fixture rejected the message." });
  expect(receipts.size).toBe(0);

  delayRegistration = true;
  const unsupported = answer("inspectThread", ["b:t", "unsupported", ""], store, storage, native);
  await load();
  expect([...receipts.values()].map(({ finished }) => finished)).toEqual([true]);
  delayedRegistrations.splice(0).forEach((register) => register());
  expect((await unsupported).error).toBe("This inspector is not available.");
  expect(receipts.size).toBe(0);
  delayRegistration = false;

  const inspection = answer("inspectThread", ["b:t", "files", ""], store, storage, native);
  const inspect = sent.at(-1)!;
  expect(inspect).toMatchObject({ environmentId: "b", frame: { tag: "projects.listEntries", payload: { cwd: "/b" } } });
  reply("b", String(inspect.frame.id), { entries: [{ path: "file.ts", kind: "file" }], truncated: false });
  await load();
  expect((await inspection).items).toEqual([{ id: "file.ts", label: "file.ts", detail: "file.ts", kind: "file" }]);

  expect(await answer("resolveMarkdownLink", ["b:t", "t3-thread://v2/a/t", "source-route"], store, storage, native)).toMatchObject({ kind: "thread", threadId: "a:t", originRoute: "source-route", error: "" });
  const fileLink = await answer("resolveMarkdownLink", ["b:t", "file:///b/My%20File.ts#L2C2", "source-route"], store, storage, native);
  expect(fileLink).toMatchObject({ kind: "file", threadId: "b:t", path: "/b/My File.ts", line: 2, column: 2 });
  const preview = answer("loadLinkedFile", ["b:t", fileLink.path, "2", "2"], store, storage, native);
  const previewRequest = sent.at(-1)!;
  expect(previewRequest.frame).toMatchObject({ tag: "projects.readFile", payload: { cwd: "/b", relativePath: "/b/My File.ts" } });
  reply("b", previewRequest.frame.id, { contents: "first\nA😀B\nthird", relativePath: fileLink.path });
  await load();
  expect(await preview).toMatchObject({ targetLine: "2", lines: [
    { text: "first", prefix: "first", focus: "", suffix: "" },
    { text: "A😀B", prefix: "A", focus: "😀", suffix: "B" },
    { text: "third", prefix: "third", focus: "", suffix: "" },
  ] });

  const creating = answer("createThread", ["b:p", "Created in b"], store, storage, native);
  const create = sent.at(-1)!;
  expect(create).toMatchObject({ environmentId: "b", frame: { payload: { type: "thread.create", projectId: "p", title: "Created in b" } } });
  reply("b", String(create.frame.id), { sequence: 2 });
  await load();
  expect(await creating).toEqual({ ok: true, error: "", threadId: `b:${create.frame.payload.threadId}` });

  const oldA = connections.find(({ id }) => id === "a")!;
  await answer("command", ["toggle", "a", "false"], store, storage, native);
  const disabled = await load();
  expect(disabled.threads.map(({ id }) => id)).toEqual(["b:t"]);
  expect(connections.map(({ id, generation }) => ({ id, generation }))).toEqual(initialGenerations.filter(({ id }) => id === "b"));
  expect(await answer("command", ["send", "a:t", "must not send"], store, storage, native)).toEqual({ ok: false, error: "This environment is disconnected." });

  await answer("command", ["toggle", "a", "true"], store, storage, native);
  await load();
  expect(connections.find(({ id }) => id === "a")?.generation).not.toBe(oldA.generation);
  events.push({ id: "a", generation: oldA.generation, type: "message", data: "invalid stale frame" });
  const afterStale = await load();
  expect(afterStale.environments.find(({ id }) => id === "a")?.status).toBe("Connecting");
  expect(afterStale.threads.map(({ id }) => id)).toEqual(["b:t"]);

  const beforeRotation = connections.find(({ id }) => id === "a")!.generation;
  secrets.set("t3-environment-tokens", JSON.stringify({ a: "replacement-token", b: "token-b" }));
  await load();
  expect(connections.find(({ id }) => id === "a")!.generation).not.toBe(beforeRotation);
  expect(connections.find(({ id }) => id === "b")!.generation).toBe(initialGenerations.find(({ id }) => id === "b")!.generation);

  activeThread = "b:t";
  await load();
  const retainedSubscription = sent.findLast(({ environmentId, frame }) => environmentId === "b" && frame.tag === "orchestration.subscribeThread")!;
  chunk("b", retainedSubscription.frame.id, { kind: "snapshot", snapshotSequence: 30,
    historyCursor: "older-b", hasMoreHistory: true, latestLocalTurnOrdinal: 10,
    projection: { thread: { id: "t" }, visibleTurnItems: [historyRow("recent-b", 10)] },
  });
  await load();
  _fetch.mockResolvedValueOnce(Response.json({ items: [historyRow("earlier-b", 1)], nextCursor: null, hasMoreHistory: false }));
  expect(await answer("loadEarlierThread", ["b:t"], store, storage, native)).toEqual({ ok: true, error: "" });
  _fetch.mockClear();
  const interrupted = answer("command", ["send", "b:t", "pending message"], store, storage, native);
  emit("b", "close", "", "Connection lost");
  const disconnected = await load();
  expect(await interrupted).toEqual({ ok: false, error: "Connection lost" });
  expect(receipts.size).toBe(0);
  expect(disconnected.environments.find(({ id }) => id === "b")?.status).toBe("Connection lost");
  const reconnecting = connections.find(({ id }) => id === "b")!.generation;
  await answer("command", ["reconnect", "b", ""], store, storage, native);
  activeThread = "b:t";
  const reconnected = await load();
  expect(connections.find(({ id }) => id === "b")!.generation).not.toBe(reconnecting);
  expect(reconnected.threads.find(({ id }) => id === "b:t")?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["earlier-b", "recent-b"]);
  expect(reconnected.environments.find(({ id }) => id === "b")?.status).toBe("Reconnecting");
  const beforeReopen = sent.length;
  emit("b", "open");
  await load();
  const reopenedConfig = sent.slice(beforeReopen).find(({ frame }) => frame.tag === "subscribeServerConfig")!;
  chunk("b", reopenedConfig.frame.id, { type: "snapshot", config: { threadSnapshotPagination: true, threadResumeCompletionMarker: true } });
  await load();
  const resumedSubscriptions = sent.slice(beforeReopen).filter(({ frame }) => frame.tag === "orchestration.subscribeThread");
  expect(resumedSubscriptions.map(({ environmentId, frame }) => ({ environmentId, ...frame.payload }))).toEqual([
    { environmentId: "b", threadId: "t", afterSequence: 30, acceptBoundedSnapshot: true, requestCompletionMarker: true },
  ]);
  chunk("b", resumedSubscriptions[0]!.frame.id, { kind: "event", sequence: 31,
    event: { threadId: "t", type: "turn-item.updated", payload: { ...historyRow("recent-b", 10).item, text: "resumed-b" } },
  });
  chunk("b", resumedSubscriptions[0]!.frame.id, { kind: "synchronized" });
  const resumed = (await load()).threads.find(({ id }) => id === "b:t");
  expect(resumed?.rows.flatMap((row) => row.message ? [row.message] : []).map(({ body }) => body)).toEqual(["earlier-b", "resumed-b"]);
  expect(resumed?.history).toMatchObject({ synchronized: true, hasMore: false });

  chunk("b", reopenedConfig.frame.id, { type: "snapshot", config: {
    threadSnapshotPagination: true, threadResumeCompletionMarker: true,
    environment: { capabilities: { commandOutputStreaming: true } },
  } });
  const tool = { ...historyRow("command", 11), item: {
    id: "command", threadId: "t", type: "command_execution", ordinal: 11, input: "bun test", outputOmitted: true,
    status: "running", updatedAt: "2026-11-10T12:00:00Z",
  } };
  chunk("b", resumedSubscriptions[0]!.frame.id, { kind: "event", sequence: 32,
    event: { threadId: "t", type: "turn-item.updated", payload: tool.item },
  });
  const toolThread = (await load()).threads.find(({ id }) => id === "b:t")!;
  const wanted = [{ rowId: JSON.stringify(["t", "command"]), revision: "live", retry: 1 }];
  const openingTool = answer("loadToolPanels", ["b:t", toolThread.toolViewKey, wanted], store, storage, native);
  const stream = sent.at(-1)!;
  expect(stream).toMatchObject({ environmentId: "b", frame: { tag: "orchestration.subscribeCommandOutput", payload: { threadId: "t", itemId: "command" } } });
  chunk("b", stream.frame.id, { kind: "replace", text: "Initial output", truncated: false, running: true });
  const firstPanels = await answer("loadToolPanels", ["b:t", toolThread.toolViewKey, wanted], store, storage, native);
  expect(firstPanels.panels[0]).toMatchObject({ state: "ready", output: "Initial output" });
  expect(await openingTool).toEqual(firstPanels);
  chunk("b", stream.frame.id, { kind: "append", text: "\nFinished", truncated: false, running: false });
  expect((await answer("loadToolPanels", ["b:t", toolThread.toolViewKey, wanted], store, storage, native)).panels[0]?.output).toBe("Initial output\nFinished");
  expect(await answer("loadToolPanels", ["", "", []], store, storage, native)).toEqual({ viewKey: "", panels: [] });
  expect(sent.at(-1)).toMatchObject({ environmentId: "b", frame: { _tag: "Interrupt", requestId: stream.frame.id } });
  expect(receipts.size).toBe(0);

  const beforeEdit = connections.map(({ id, generation }) => ({ id, generation }));
  expect(await answer("updateEnvironment", ["a", " Renamed Mac ", "http://a.example/"], store, storage, native)).toEqual({ ok: true, error: "" });
  const renamed = await load();
  expect(renamed.environments.find(({ id }) => id === "a")).toMatchObject({ label: "Renamed Mac", url: "http://a.example" });
  expect(connections.map(({ id, generation }) => ({ id, generation }))).toEqual(beforeEdit);

  const beforeInvalid = saved;
  expect(await answer("updateEnvironment", ["a", " ", "http://changed.example"], store, storage, native)).toEqual({ ok: false, error: "Enter an environment name." });
  expect(saved).toBe(beforeInvalid);
  expect(await answer("updateEnvironment", ["missing", "Mac", "http://changed.example"], store, storage, native)).toEqual({ ok: false, error: "This environment is no longer available." });
  expect(saved).toBe(beforeInvalid);

  expect(await answer("updateEnvironment", ["a", "Renamed Mac", "https://changed.example/"], store, storage, native)).toEqual({ ok: true, error: "" });
  const moved = await load();
  expect(moved.environments.find(({ id }) => id === "a")).toMatchObject({ label: "Renamed Mac", url: "https://changed.example", status: "Connecting" });
  expect(connections.find(({ id }) => id === "a")!.generation).not.toBe(beforeEdit.find(({ id }) => id === "a")!.generation);
  expect(connections.find(({ id }) => id === "b")!.generation).toBe(beforeEdit.find(({ id }) => id === "b")!.generation);

  expect(await answer("command", ["remove", "a", ""], store, storage, native)).toEqual({ ok: true, error: "" });
  expect((await load()).environments.map(({ id }) => id)).toEqual(["b"]);
  expect(JSON.parse(secrets.get("t3-environment-tokens")!)).toEqual({ b: "token-b" });
  expect(connections.map(({ id, generation }) => ({ id, generation }))).toEqual(beforeEdit.filter(({ id }) => id === "b"));

  const environments = await answer("loadEnvironmentRecords", [], store, storage, native);
  const fallback = await answer("loadCatalog", ["b", "b:t", environments, 0], store, storage, null);
  expect(fallback.environments.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "b", status: "Use the native transport" }]);
});
