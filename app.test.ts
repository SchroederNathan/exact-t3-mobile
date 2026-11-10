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
  const native: NativeModule = {
    available: true,
    watch() {},
    later(request) {
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
        const connection = connections.find((entry) => entry.id === request.id && entry.generation === request.generation);
        if (!connection) throw new Error("Disconnected");
        sent.push({ environmentId: connection.id, generation: connection.generation, frame: JSON.parse(String(request.data)) });
        return {};
      }
      if (request.op === "connections.close") return {};
      throw new Error("Unexpected native operation");
    },
  };
  using _fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Use the native transport"));
  let activeThread = "b:t";
  const load = (selected = "") => answer("loadCatalog", [selected, activeThread, 0], store, storage, native);
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
  const bSubscription = initialSubscriptions[0]!.frame.id;
  chunk("b", bSubscription, { kind: "snapshot", projection: {
    messages: [{ id: "b-message", role: "user", text: "Opened by a cold link", createdAt: "2026-11-10T00:00:00Z" }],
  } });
  expect((await load()).threads.find(({ id }) => id === "b:t")?.messages.map(({ body }) => body)).toEqual(["Opened by a cold link"]);
  expect(catalog.threads.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: "a:t", title: "Thread a" }, { id: "b:t", title: "Thread b" },
  ]);
  expect(catalog.projects).toEqual([
    { id: "a:p", title: "Project a", environmentId: "a" },
    { id: "b:p", title: "Project b", environmentId: "b" },
  ]);
  const initialGenerations = connections.map(({ id, generation }) => ({ id, generation }));
  for (const selected of ["a", "b", ""]) {
    expect((await load(selected)).threads.map(({ id }) => id)).toEqual(["a:t", "b:t"]);
    expect(connections.map(({ id, generation }) => ({ id, generation }))).toEqual(initialGenerations);
  }
  expect(sent.filter(({ frame }) => frame.tag === "orchestration.subscribeThread").length).toBe(1);

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
  expect(switched.threads.find(({ id }) => id === "a:t")?.messages.map(({ body }) => body)).toEqual(["Selected by the route"]);
  expect(switched.threads.find(({ id }) => id === "b:t")?.messages.map(({ body }) => body)).toEqual(["Opened by a cold link"]);
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
  expect(reconnected.environments.find(({ id }) => id === "b")?.status).toBe("Connecting");
  const beforeReopen = sent.length;
  emit("b", "open");
  await load();
  const reopenedConfig = sent.slice(beforeReopen).find(({ frame }) => frame.tag === "subscribeServerConfig")!;
  chunk("b", reopenedConfig.frame.id, { type: "snapshot", config: {} });
  await load();
  expect(sent.slice(beforeReopen).filter(({ frame }) => frame.tag === "orchestration.subscribeThread").map(({ environmentId, frame }) => ({ environmentId, threadId: frame.payload.threadId }))).toEqual([
    { environmentId: "b", threadId: "t" },
  ]);

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

  const fallback = await answer("loadCatalog", ["b", "b:t", 0], store, storage, null);
  expect(fallback.environments.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "b", status: "Use the native transport" }]);
});
