import type { Answer, NativeModule, Result, Sources, Storage, Store } from "./app.contract.d.ts";
import { regroupNavigation } from "./navigation";
import {
  DirectSession,
  normalizeEnvironmentUrl,
  object,
  pair,
  socketUrl,
  scopedThreadId,
  string,
  threadIdentity,
  threadIdFromUrl,
  type Catalog,
  type Environment,
} from "./connection";

export const grants =
  "fs.read app:/data/environments-v1.json\nfs.write app:/data/environments-v1.json\nsecret.keep t3-environment-tokens\nnet.fetch http:\nnet.fetch https:\nnet.websocket ws:\nnet.websocket wss:";

const FILE = "app:/data/environments-v1.json";
const SECRET = "t3-environment-tokens";
let current: DirectSession | undefined;
let savedEnvironments: Promise<Environment[]> | undefined;
let nextGeneration = 0;
const connections = new Map<string, {
  origin: string;
  token: string;
  generation: number;
  session: DirectSession;
  open: boolean;
}>();

function credentials(store: Store): Record<string, string> {
  const saved: unknown = JSON.parse(store.get(SECRET) || "{}");
  return Object.fromEntries(
    Object.entries(object(saved)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function loadEnvironments(storage: Storage): Promise<Environment[]> {
  return savedEnvironments ??= readEnvironments(storage).catch((error) => {
    savedEnvironments = undefined;
    throw error;
  });
}

async function readEnvironments(storage: Storage): Promise<Environment[]> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.fs.readFile(FILE);
  } catch (error) {
    if (object(error).code === "ENOENT") return [];
    throw error;
  }
  const saved: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(saved)) throw new Error("The saved environment list could not be read.");
  return saved.map((value: unknown) => {
    const environment = object(value);
    if (!string(environment.id) || !string(environment.url))
      throw new Error("A saved environment is missing its address.");
    return {
      id: string(environment.id),
      label: string(environment.label),
      url: string(environment.url),
      enabled: environment.enabled === true,
      status: environment.enabled === true ? "Disconnected" : "Off",
      machineSymbol: string(environment.machineSymbol) || "server.rack",
    };
  });
}

async function saveEnvironments(storage: Storage, environments: Environment[]): Promise<void> {
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(environments)));
  savedEnvironments = undefined;
}

function sessionFor(environmentId: string): DirectSession {
  const session = connections.get(environmentId)?.session ??
    (current?.environment.id === environmentId ? current : undefined);
  if (!session) throw new Error("This environment is disconnected.");
  return session;
}

function awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T> {
  if (!native?.available) return operation;
  const receipt = crypto.randomUUID();
  // Exact must own pending native work until the watched catalog delivers the protocol reply.
  const waiting = native.later({ op: "connections.wait", receipt });
  const settled = operation.then(
    (value) => {
      native.call({ op: "connections.finish", receipt });
      return value;
    },
    (error) => {
      native.call({ op: "connections.finish", receipt });
      throw error;
    },
  );
  return Promise.all([settled, waiting]).then(([value]) => value);
}

function nativeCatalog(
  environments: Environment[],
  tokens: Record<string, string>,
  activeThread: ReturnType<typeof threadIdentity> | undefined,
  now: number,
  native: NativeModule,
): Catalog {
  const enabled = environments.filter((environment) => environment.enabled && tokens[environment.id]);
  for (const [id, connection] of connections) {
    const environment = enabled.find((entry) => entry.id === id);
    if (!environment || connection.origin !== environment.url || connection.token !== tokens[id]) {
      connection.open = false;
      connection.session.disconnected("Disconnected");
      connections.delete(id);
    }
  }
  for (const environment of enabled) {
    if (!connections.has(environment.id)) {
      const session = new DirectSession(environment);
      connections.set(environment.id, {
        origin: environment.url, token: tokens[environment.id]!,
        generation: ++nextGeneration, session, open: false,
      });
    }
    const session = connections.get(environment.id)!.session;
    session.environment.label = environment.label;
    session.select(activeThread?.environmentId === environment.id ? activeThread.threadId : "");
  }
  const result = native.call({ op: "connections.sync", connections: [...connections].map(([id, connection]) => ({
    id, generation: connection.generation, origin: connection.origin, token: connection.token,
  })) });
  const events = Array.isArray(result.events) ? result.events : [];
  for (const value of events) {
    const event = object(value);
    const id = string(event.id);
    const connection = connections.get(id);
    if (!connection || event.generation !== connection.generation) continue;
    const { session, generation } = connection;
    try {
      if (event.type === "open") {
        connection.open = true;
        session.open({
          get readyState() { return connection.open ? 1 : 3; },
          bufferedAmount: 0,
          send(data) {
            if (typeof data !== "string") throw new Error("T3 sends JSON text frames.");
            native.call({ op: "connections.send", id, generation, data });
          },
          close() { native.call({ op: "connections.close", id, generation }); },
        });
      } else if (event.type === "message") {
        session.receive(string(event.data));
      } else if (event.type === "close" || event.type === "error") {
        connection.open = false;
        session.disconnected(string(event.reason) || "Disconnected");
      }
    } catch (error) {
      connection.open = false;
      session.disconnected(error instanceof Error ? error.message : "The server sent an invalid response.");
      native.call({ op: "connections.close", id, generation });
    }
  }
  return {
    environments: environments.map((environment) => {
      if (!environment.enabled) return { ...environment, status: "Off" };
      if (!tokens[environment.id]) return { ...environment, status: "Pairing required" };
      return { ...connections.get(environment.id)!.session.environment };
    }),
    projects: [...connections.values()].flatMap(({ session }) => session.projectList()),
    threads: [...connections.values()].flatMap(({ session }) => session.threads(now)).sort((left, right) =>
      Number(left.settled) - Number(right.settled) || right.activityAt - left.activityAt || left.id.localeCompare(right.id)),
  };
}

async function loadCatalog(
  selected: string,
  activeThreadId: string,
  now: number,
  store: Store,
  storage: Storage,
  native?: NativeModule | null,
): Promise<Catalog> {
  const tokens = credentials(store);
  const activeThread = activeThreadId ? threadIdentity(activeThreadId) : undefined;
  if (native?.available) {
    native.watch("connections");
    return nativeCatalog(await loadEnvironments(storage), tokens, activeThread, now, native);
  }
  current?.disconnected("Disconnected");
  current = undefined;
  const environments = await loadEnvironments(storage);
  const environmentId = activeThread?.environmentId || selected;
  const environment = environmentId
    ? environments.find((entry) => entry.id === environmentId && entry.enabled)
    : environments.find((entry) => entry.enabled);
  if (!environment) return { environments, threads: [], projects: [] };
  const token = tokens[environment.id];
  if (!token)
    return {
      environments: environments.map((entry) =>
        entry.id === environment.id ? { ...entry, status: "Pairing required" } : entry,
      ),
      threads: [],
      projects: [],
    };
  const session = new DirectSession(environment);
  current = session;
  if (activeThread?.environmentId === environment.id) session.select(activeThread.threadId);
  const snapshot = (): Catalog => ({
    environments: environments.map((entry) =>
      entry.id === environment.id ? { ...session.environment } : entry,
    ),
    threads: session.threads(now),
    projects: session.projectList(),
  });
  try {
    const url = await socketUrl(environment, token);
    return fetch(url, {
      exactStream(event, socket) {
        if (event.type === "open" && socket) session.open(socket);
        else if (event.type === "message") {
          try {
            const data =
              typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
            session.receive(data);
          } catch (error) {
            session.disconnected(
              error instanceof Error ? error.message : "The server sent an invalid response.",
            );
          }
        } else if (event.type === "close" || event.type === "error") {
          session.disconnected(event.message || event.reason || "Disconnected");
        }
        return snapshot();
      },
    });
  } catch (error) {
    session.disconnected(
      error instanceof Error ? error.message : "Could not connect to the environment.",
    );
    return snapshot();
  }
}

const sources: Sources = {
  regroupNavigation: ([nav, split]) => regroupNavigation(nav, split),
  deviceTraits: (_args, _store, _storage, native) => {
    if (!native?.available) return { kind: "web", rail: false, split: false };
    native.watch("device");
    try {
      return native.call({ op: "device" }) as Result<"deviceTraits">;
    } catch {
      return { kind: "phone", rail: false, split: false };
    }
  },
  loadCatalog: ([selected, activeThreadId, now], store, storage, native) =>
    loadCatalog(selected, activeThreadId, now, store, storage, native),
  updateEnvironment: ([id, label, url], store, storage, native) =>
    sources.command(["update-environment", id, JSON.stringify({ label, url })], store, storage, native),
  inspectThread: async ([id, kind, path], _store, _storage, native) => {
    try {
      const identity = threadIdentity(id);
      return await awaitReply(sessionFor(identity.environmentId).inspect(identity.threadId, kind, path), native);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The workspace could not be inspected.",
        title: kind === "git" ? "Source Control" : "Files",
        body: "",
        items: [],
      };
    }
  },
  createThread: async ([projectId, title], _store, _storage, native) => {
    try {
      const identity = threadIdentity(projectId);
      const threadId = crypto.randomUUID();
      const reply = await awaitReply(sessionFor(identity.environmentId).create(identity.threadId, title, crypto.randomUUID(), threadId), native);
      return {
        ...reply,
        threadId: reply.ok ? scopedThreadId(identity.environmentId, threadId) : "",
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The thread could not be created.",
        threadId: "",
      };
    }
  },
  command: async ([operation, id, value], store, storage, native): Promise<Result<"command">> => {
    try {
      if (operation === "open" || operation === "open-url") {
        const threadId = operation === "open-url" ? threadIdFromUrl(id) : id;
        const identity = threadIdentity(threadId);
        sessionFor(identity.environmentId).select(identity.threadId);
        return { ok: true, error: "" };
      }
      if (operation === "send") {
        const identity = threadIdentity(id);
        if (!value.trim()) return { ok: false, error: "Write a message first." };
        return await awaitReply(sessionFor(identity.environmentId).send(
          identity.threadId,
          value.trim(),
          crypto.randomUUID(),
          crypto.randomUUID(),
        ), native);
      }
      const tokens = operation === "pair" || operation === "remove" ? credentials(store) : {};
      if (operation === "remove") {
        delete tokens[id];
        store.set(SECRET, JSON.stringify(tokens));
      }
      const environments = await loadEnvironments(storage);
      if (operation === "pair") {
        const paired = await pair(id, value);
        store.set(SECRET, JSON.stringify({ ...tokens, [paired.environment.id]: paired.token }));
        await saveEnvironments(
          storage,
          environments
            .filter((entry) => entry.id !== paired.environment.id)
            .concat(paired.environment),
        );
      } else if (operation === "reconnect") {
        const environment = environments.find((entry) => entry.id === id);
        if (!environment) throw new Error("This environment is no longer available.");
        if (!environment.enabled) throw new Error("Turn on this environment before reconnecting.");
        connections.get(id)?.session.disconnected("Reconnecting");
        connections.delete(id);
      } else if (operation === "update-environment") {
        const environment = environments.find((entry) => entry.id === id);
        if (!environment) throw new Error("This environment is no longer available.");
        const input: unknown = JSON.parse(value);
        const fields = object(input);
        const label = string(fields.label).trim();
        if (!label) throw new Error("Enter an environment name.");
        const url = normalizeEnvironmentUrl(string(fields.url));
        await saveEnvironments(
          storage,
          environments.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  label,
                  url,
                  machineSymbol:
                    connections.get(id)?.session.environment.machineSymbol ??
                    (current?.environment.id === id ? current.environment.machineSymbol : entry.machineSymbol),
                }
              : entry,
          ),
        );
      } else if (operation === "toggle") {
        await saveEnvironments(
          storage,
          environments.map((entry) =>
            entry.id === id ? { ...entry, enabled: value === "true" } : entry,
          ),
        );
      } else if (operation === "remove") {
        await saveEnvironments(
          storage,
          environments.filter((entry) => entry.id !== id),
        );
      } else {
        return { ok: false, error: "The requested change is not available." };
      }
      return { ok: true, error: "" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The requested change failed.",
      };
    }
  },
};

export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
