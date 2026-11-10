import type { Answer, Result, Sources, Storage, Store } from "./app.contract.d.ts";
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
let selectedThread = "";

function credentials(store: Store): Record<string, string> {
  const saved: unknown = JSON.parse(store.get(SECRET) || "{}");
  return Object.fromEntries(
    Object.entries(object(saved)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function loadEnvironments(storage: Storage): Promise<Environment[]> {
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
}

async function loadCatalog(
  selected: string,
  now: number,
  store: Store,
  storage: Storage,
): Promise<Catalog> {
  current?.disconnected("Disconnected");
  current = undefined;
  const environments = await loadEnvironments(storage);
  const environment = selected
    ? environments.find((entry) => entry.id === selected && entry.enabled)
    : environments.find((entry) => entry.enabled);
  if (!environment) return { environments, threads: [], projects: [] };
  const token = credentials(store)[environment.id];
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
  if (selectedThread) {
    const identity = threadIdentity(selectedThread);
    if (identity.environmentId === environment.id) session.select(identity.threadId);
  }
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
  deviceTraits: (_args, _store, _storage, native) => {
    if (!native?.available) return { kind: "phone", rail: false, split: false };
    native.watch("device");
    try {
      return native.call({ op: "device" }) as Result<"deviceTraits">;
    } catch {
      return { kind: "phone", rail: false, split: false };
    }
  },
  loadCatalog: (args, store, storage) =>
    loadCatalog(String(args[0] ?? ""), Number(args[1] ?? 0), store, storage),
  inspectThread: async ([id, kind, path]) => {
    try {
      const identity = threadIdentity(id);
      if (current?.environment.id !== identity.environmentId)
        throw new Error("Select this thread’s environment to connect.");
      return await current.inspect(identity.threadId, kind, path);
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
  createThread: async ([projectId, title]) => {
    try {
      const identity = threadIdentity(projectId);
      if (current?.environment.id !== identity.environmentId)
        throw new Error("Select this project’s environment to connect.");
      const threadId = crypto.randomUUID();
      const reply = await current.create(identity.threadId, title, crypto.randomUUID(), threadId);
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
  command: async ([operation, id, value], store, storage): Promise<Result<"command">> => {
    try {
      if (operation === "open" || operation === "open-url") {
        const threadId = operation === "open-url" ? threadIdFromUrl(id) : id;
        const identity = threadIdentity(threadId);
        selectedThread = threadId;
        if (current?.environment.id !== identity.environmentId)
          throw new Error("Select this thread’s environment to connect.");
        current.select(identity.threadId);
        return { ok: true, error: "" };
      }
      if (operation === "send") {
        const identity = threadIdentity(id);
        if (!value.trim()) return { ok: false, error: "Write a message first." };
        if (current?.environment.id !== identity.environmentId)
          throw new Error("This environment is disconnected.");
        return current.send(
          identity.threadId,
          value.trim(),
          crypto.randomUUID(),
          crypto.randomUUID(),
        );
      }
      const environments = await loadEnvironments(storage);
      if (operation === "pair") {
        const paired = await pair(id, value);
        const tokens = credentials(store);
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
                    current?.environment.id === id
                      ? current.environment.machineSymbol
                      : entry.machineSymbol,
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
        const tokens = credentials(store);
        delete tokens[id];
        store.set(SECRET, JSON.stringify(tokens));
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
