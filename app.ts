import type { Answer, NativeModule, Result, Sources, Storage, Store } from "./app.contract.d.ts";
import { TableLayouts } from "./table-layout";
import { CodeHighlights } from "./code-highlight";
import { parseFileLink, parseThreadLink, resolveThreadLink } from "./markdown-links";
import { regroupNavigation } from "./navigation";
import { loadDrafts, saveDraft, restoreDrafts, parseSendSelection } from "./drafts";
import { RpcFailure } from "./attachment-session";
import { freezeGallery, galleryWorkKey, GalleryDownloads } from "./attachment-gallery";
import { FILE_LIMIT, PREVIEW_DIRECTORY, ATTACHMENT_DIRECTORY, ownedAttachmentPath, ownedPreviewPath, parseDraftAttachment, stageAttachments, storedReference, uploadEvent, validateAttachments } from "./attachments";
import { ComposerSettings } from "./composer-settings";
import { loadModelDrafts, saveModelDrafts } from "./model-drafts";
import { controlKey } from "./thread-controls";
import {
  DirectSession,
  normalizeEnvironmentUrl,
  object,
  pair,
  readJson,
  socketUrl,
  scopedThreadId,
  string,
  threadIdentity,
  threadIdFromUrl,
  type Catalog,
  type Environment,
} from "./connection";

export const grants =
  "fs.read app:/tmp/picked\nfs.read app:/data/composer-attachments\nfs.write app:/data/composer-attachments\nfs.read app:/cache/attachment-previews\nfs.write app:/cache/attachment-previews\nfs.read app:/data/environments-v1.json\nfs.write app:/data/environments-v1.json\nfs.read app:/data/drafts-v1.json\nfs.write app:/data/drafts-v1.json\nfs.read app:/data/model-drafts-v1.json\nfs.write app:/data/model-drafts-v1.json\nsecret.keep t3-environment-tokens\nnet.fetch http:\nnet.fetch https:\nnet.websocket ws:\nnet.websocket wss:";

const FILE = "app:/data/environments-v1.json";
const SECRET = "t3-environment-tokens";
const composerSettings = new ComposerSettings();
const codeHighlights = new CodeHighlights();
const tableLayouts = new TableLayouts();
const galleryDownloads = new GalleryDownloads();
let modelDraftRevision = 0;
let current: DirectSession | undefined;
let attachmentFilesCleaned = false;
let savedEnvironments: Promise<Environment[]> | undefined;
let nextGeneration = 0;
const connections = new Map<string, {
  origin: string;
  token: string;
  generation: number;
  session: DirectSession;
  open: boolean;
}>();

async function removeOwnedAttachmentFile(storage: Storage, path: string) {
  if (!ownedAttachmentPath(path) && !ownedPreviewPath(path)) return;
  await storage.fs.rm(path).catch(() => {});
  if (!ownedPreviewPath(path)) return;
  const directory = path.slice(0, path.lastIndexOf("/"));
  try {
    if ((await storage.fs.readdir(directory)).length === 0) await storage.fs.rm(directory);
  } catch {}
}

async function cleanPreviewDirectories(storage: Storage) {
  try {
    for (const directory of await storage.fs.readdir(PREVIEW_DIRECTORY)) {
      if (!/^[A-Za-z0-9_-]+$/.test(directory)) continue;
      const path = `${PREVIEW_DIRECTORY}${directory}`;
      for (const name of await storage.fs.readdir(path)) {
        const file = `${path}/${name}`;
        if (ownedPreviewPath(file)) await storage.fs.rm(file).catch(() => {});
      }
      try {
        if ((await storage.fs.readdir(path)).length === 0) await storage.fs.rm(path);
      } catch {}
    }
  } catch {}
}

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

async function awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T> {
  if (!native?.available) return operation;
  const receipt = crypto.randomUUID();
  // Exact must own pending native work until the watched catalog delivers the protocol reply.
  const waiting = native.later({ op: "connections.wait", receipt });
  try {
    return await operation;
  } finally {
    native.call({ op: "connections.finish", receipt });
    await waiting;
  }
}

function syncNativeConnections(native: NativeModule) {
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
  syncNativeConnections(native);
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
  environments: Environment[],
  now: number,
  store: Store,
  native?: NativeModule | null,
): Promise<Catalog> {
  const tokens = credentials(store);
  const activeThread = activeThreadId ? threadIdentity(activeThreadId) : undefined;
  if (native?.available) {
    native.watch("connections");
    return nativeCatalog(environments, tokens, activeThread, now, native);
  }
  current?.disconnected("Disconnected");
  current = undefined;
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
  restoreModelSettings: async (_args, _store, storage) => {
    composerSettings.restore(await loadModelDrafts(storage));
    return { ok: true, error: "" };
  },
  persistModelSettings: async (_args, _store, storage) => {
    await saveModelDrafts(storage, composerSettings.snapshot());
    return { ok: true, error: "" };
  },
  loadSettings: ([id], _store, _storage, native) => {
    if (!id) return { groups: [], options: [], selectedModelId: "", appliedModelId: "", runtimeMode: "", runtimeLabel: "", runtimeChoices: [], saveLabel: "Done", error: "" };
    native?.watch("connections");
    if (native?.available) syncNativeConnections(native);
    const identity = threadIdentity(id);
    return composerSettings.project(id, identity.threadId, sessionFor(identity.environmentId));
  },
  beginSettings: ([id]) => {
    const identity = threadIdentity(id);
    return composerSettings.begin(id, identity.threadId, sessionFor(identity.environmentId));
  },
  setModelFavorite: async ([id, modelId, favorite], _store, _storage, native) => {
    try {
      const identity = threadIdentity(id);
      return await awaitReply(sessionFor(identity.environmentId).setModelFavorite(identity.threadId, modelId, favorite), native);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The favorite could not be updated." };
    }
  },
  changeSettings: ([id, kind, option, value]) => {
    const identity = threadIdentity(id);
    return composerSettings.change(id, identity.threadId, sessionFor(identity.environmentId),
      kind === "model" ? { type: "model", id: option }
        : kind === "runtime" ? { type: "runtime", id: value }
          : { type: "option", id: option, value });
  },
  closeSettings: ([id, save]) => {
    const identity = threadIdentity(id);
    return composerSettings.close(id, identity.threadId, sessionFor(identity.environmentId), save);
  },
  loadDrafts: async (_args, _store, storage) => {
    const drafts = await loadDrafts(storage);
    const referenced = new Set(drafts.flatMap((draft) => [...draft.attachments.map((item) => item.path), ...(draft.pendingSend?.paths ?? [])]));
    try {
      if (attachmentFilesCleaned) return restoreDrafts(drafts);
      attachmentFilesCleaned = true;
      await cleanPreviewDirectories(storage);
      const directories = await storage.fs.readdir(ATTACHMENT_DIRECTORY);
      for (const directory of directories) {
        if (!/^[A-Za-z0-9_-]+$/.test(directory)) continue;
        for (const name of await storage.fs.readdir(`${ATTACHMENT_DIRECTORY}${directory}`)) {
          const path = `${ATTACHMENT_DIRECTORY}${directory}/${name}`;
          if (ownedAttachmentPath(path) && !referenced.has(path)) await storage.fs.rm(path).catch(() => {});
        }
      }
    } catch {}
    return restoreDrafts(drafts);
  },
  saveDraft: async ([draft], _store, storage) => {
    const result = { id: draft.id, revision: draft.revision, commandId: draft.pendingSend?.commandId ?? "" };
    try { const saved = await saveDraft(storage, draft); return { id: saved.id, revision: saved.revision, commandId: saved.pendingSend?.commandId ?? "", ok: true, error: "" }; }
    catch (error) { return { ...result, ok: false, error: error instanceof Error ? error.message : "The draft could not be saved." }; }
  },
  loadAttachmentAccess: ([threadId], _store, _storage, native) => {
    native?.watch("connections");
    if (native?.available) syncNativeConnections(native);
    try { return { threadId, ...sessionFor(threadIdentity(threadId).environmentId).attachments.metadata() }; }
    catch { return { threadId, accessKey: "", origin: "", allowed: false, uploads: false, maxFileBytes: 0 }; }
  },
  attachmentConnections: ([slots], _store, _storage, native) => {
    native?.watch("connections");
    return slots.map((slot) => {
      let valid = false;
      try { sessionFor(threadIdentity(slot.threadId).environmentId).attachments.assertAccess(slot.accessKey, slot.origin); valid = true; } catch {}
      return { key: `${slot.threadId}:${slot.localId}:${slot.attempt}`, valid };
    });
  },
  stagePickedAttachments: async ([intent, files, existing, revision, maxFileBytes], _store, storage) => ({
    intent, ...await stageAttachments(storage, files, intent.photos, maxFileBytes, existing.map(parseDraftAttachment), revision),
  }),
  mintAttachment: async ([slot], _store, _storage, native) => {
    try {
      const session = sessionFor(threadIdentity(slot.threadId).environmentId);
      const ticket = await awaitReply(session.attachments.createUpload(slot.accessKey, parseDraftAttachment(slot.item)), native);
      return { slot: { ...slot, ...ticket }, error: "" };
    } catch (error) { return { slot, error: error instanceof Error ? error.message : "The upload could not be started." }; }
  },
  uploadAttachment: ([slot]) => {
    const idle = { threadId: "", localId: "", attempt: 0, state: "idle", progress: 0, error: "" };
    if (!slot) return idle;
    try {
      sessionFor(threadIdentity(slot.threadId).environmentId).attachments.assertAccess(slot.accessKey, slot.origin);
      const ticket = { ...slot, path: slot.item.path, mimeType: slot.item.mimeType };
      if (!ownedAttachmentPath(ticket.path)) throw new Error("This attachment file is no longer available.");
      return fetch(slot.url, { method: "POST", headers: { "content-type": slot.item.mimeType }, exactBodyFrom: slot.item.path,
        exactUploadProgress: true, exactTimeout: 300000, exactStream: (event) => uploadEvent(ticket, event) });
    } catch (error) { return { ...idle, threadId: slot.threadId, localId: slot.localId, attempt: slot.attempt, state: "failed", error: error instanceof Error ? error.message : "Upload failed." }; }
  },
  verifyAttachment: async ([threadId, accessKey, item], _store, _storage, native) => {
    const result = { threadId, localId: item.localId, attachmentId: item.id, attempt: item.attempt, accessKey };
    try {
      const session = sessionFor(threadIdentity(threadId).environmentId);
      session.attachments.assertAccess(accessKey);
      await awaitReply(session.attachments.read(item), native);
      return { ...result, state: "ready", error: "" };
    } catch (error) { return { ...result, state: error instanceof RpcFailure && error.tag === "AssetAttachmentNotFoundError" ? "missing" : "error", error: error instanceof Error ? error.message : "This attachment could not be checked." }; }
  },
  cleanupAttachment: async ([item], _store, storage, native) => {
    let deletion: Promise<unknown> | undefined;
    try {
      if (item.attachmentId) deletion = awaitReply(sessionFor(threadIdentity(item.threadId).environmentId).attachments.remove(item.accessKey, item.attachmentId), native);
    } catch {}
    if (deletion) await deletion.catch(() => {});
    await removeOwnedAttachmentFile(storage, item.path);
    return { ok: true, error: "" };
  },
  cleanupStagedAttachments: async ([items], _store, storage) => {
    for (const item of items) await removeOwnedAttachmentFile(storage, item.path);
    return { ok: true, error: "" };
  },
  prepareSend: ([draft]) => {
    try {
      const identity = threadIdentity(draft.id);
      const session = sessionFor(identity.environmentId);
      const items = draft.attachments.map(parseDraftAttachment);
      if (!draft.text.trim() && !items.length) throw new Error("Write a message or add an attachment first.");
      if (items.some((item) => item.state !== "uploaded")) throw new Error("Wait for attachments to upload, or retry or remove failed attachments.");
      validateAttachments(items, session.attachments.metadata().maxFileBytes, true);
      const selection = composerSettings.resolve(draft.id, identity.threadId, session);
      return { id: draft.id, revision: draft.revision, pending: { commandId: crypto.randomUUID(), messageId: crypto.randomUUID(),
        revision: draft.revision + 1, text: draft.text.trim(), attachments: items.map(storedReference), paths: items.map((item) => item.path), selection: selection ? JSON.stringify(selection) : "", state: "prepared" }, error: "" };
    } catch (error) { return { id: draft.id, revision: draft.revision, pending: null, error: error instanceof Error ? error.message : "The message could not be prepared." }; }
  },
  sendDraft: async ([id, snapshot], _store, _storage, native) => {
    try {
      const identity = threadIdentity(id);
      const selection = parseSendSelection(snapshot.selection);
      if (snapshot.selection && !selection) throw new Error("The saved message settings are invalid.");
      const reply = await awaitReply(sessionFor(identity.environmentId).send(identity.threadId, snapshot.text, snapshot.commandId, snapshot.messageId, selection, snapshot.attachments, snapshot.state === "unknown"), native);
      return { id, commandId: snapshot.commandId, ...reply };
    } catch (error) { return { id, commandId: snapshot.commandId, state: "unknown", ok: false, error: error instanceof Error ? error.message : "Delivery could not be confirmed. Retry this message." }; }
  },
  loadAttachmentPreviews: async ([id, viewKey, refs, _retry, now], _store, _storage, native) => {
    native?.watch("connections");
    if (native?.available) syncNativeConnections(native);
    if (!id) {
      for (const connection of connections.values()) connection.session.attachments.clear();
      current?.attachments.clear();
      return { threadId: id, viewKey, previews: [] };
    }
    try {
      const identity = threadIdentity(id);
      const batch = await awaitReply(sessionFor(identity.environmentId).attachments.previews(identity.threadId, viewKey, refs.filter((ref) => ref.threadId === id && ref.viewKey === viewKey), now), native);
      return { ...batch, threadId: id };
    } catch { return { threadId: id, viewKey, previews: [] }; }
  },
  prepareAttachmentViewer: async ([threadId, routeId, selected, candidates], _store, storage) => {
    const presentationId = crypto.randomUUID();
    const gallery = freezeGallery(presentationId, selected, candidates);
    const remote = gallery.items.some((item) => !item.localPath);
    const metadata = remote ? sessionFor(threadIdentity(threadId).environmentId).attachments.metadata() : { accessKey: "", origin: "" };
    if (remote && !metadata.accessKey) throw new Error("This environment is disconnected.");
    if (remote) await storage.fs.mkdir(`${PREVIEW_DIRECTORY}${presentationId}`);
    return { viewer: { presentationId, threadId, routeId, accessKey: metadata.accessKey, origin: metadata.origin, ...gallery, state: "loading", error: "" } };
  },
  loadGallerySelection: ([viewer], _store, _storage, native) => {
    if (!viewer) return { presentationId: "", selectedIndex: -1, valid: true };
    native?.watch("attachment-preview");
    native?.watch("connections");
    let valid = true;
    if (viewer.accessKey) {
      try {
        const metadata = sessionFor(threadIdentity(viewer.threadId).environmentId).attachments.metadata();
        valid = metadata.accessKey === viewer.accessKey && metadata.origin === viewer.origin;
      } catch { valid = false; }
    }
    const selection = native?.available ? object(native.call({ op: "attachments.selection", presentationId: viewer.presentationId })) : {};
    const index = selection.selectedIndex;
    return { presentationId: viewer.presentationId, selectedIndex: typeof index === "number" && Number.isInteger(index) && index >= 0 && index < viewer.items.length ? index : viewer.selectedIndex, valid };
  },
  attachmentViewerUrl: async ([work], _store, _storage, native) => {
    try {
      const session = sessionFor(threadIdentity(work.threadId).environmentId);
      const metadata = session.attachments.metadata();
      if (metadata.accessKey !== work.accessKey || metadata.origin !== work.origin) throw new Error("The attachment connection changed.");
      const result = await awaitReply(session.attachments.read(work.item.item, galleryWorkKey(work)), native);
      return { work: { ...work, item: { ...work.item, url: result.url } } };
    } catch (error) { return { work: { ...work, item: { ...work.item, state: "error", error: error instanceof Error ? error.message : "This attachment could not be opened." } } }; }
  },
  downloadAttachment: ([work]) => {
    try {
      const metadata = sessionFor(threadIdentity(work.threadId).environmentId).attachments.metadata();
      if (metadata.accessKey !== work.accessKey || metadata.origin !== work.origin) throw new Error("The attachment connection changed.");
      return galleryDownloads.download(work);
    } catch (error) { return { work: { ...work, item: { ...work.item, state: "error", error: error instanceof Error ? error.message : "This attachment could not be downloaded." } } }; }
  },
  cancelGalleryWork: ([work]) => {
    galleryDownloads.cancel(galleryWorkKey(work));
    try { sessionFor(threadIdentity(work.threadId).environmentId).attachments.cancelRead(galleryWorkKey(work)); } catch {}
    return { ok: true, error: "" };
  },
  updateGalleryItem: ([work], _store, _storage, native) => {
    try {
      native?.call({ op: "attachments.update", presentationId: work.presentationId, index: work.index, path: work.item.state === "ready" ? work.item.path : "", state: work.item.state });
      return { work };
    } catch (error) {
      try { native?.call({ op: "attachments.update", presentationId: work.presentationId, index: work.index, path: "", state: "error" }); } catch {}
      return { work: { ...work, item: { ...work.item, state: "error", error: error instanceof Error ? error.message : "This file could not be previewed." } } };
    }
  },
  presentAttachment: ([viewer], _store, _storage, native) => {
    if (!native?.available) return { viewer: { ...viewer, state: "error", error: "Native file preview is unavailable." } };
    return native.later({ op: "attachments.preview", presentationId: viewer.presentationId,
      items: viewer.items.map((item) => ({ path: item.state === "ready" ? item.path : "", name: item.item.name, state: item.state, sourceId: item.sourceId })),
      selectedIndex: viewer.selectedIndex, imageGallery: viewer.imageGallery })
      .then(() => ({ viewer: { ...viewer, state: "dismissed" } }))
      .catch((error: unknown) => ({ viewer: { ...viewer, state: "error", error: error instanceof Error ? error.message : "This file could not be previewed." } }));
  },
  dismissAttachment: ([presentationId], _store, _storage, native) => {
    native?.call({ op: "attachments.dismiss", presentationId });
    return { ok: true, error: "" };
  },
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
  loadEnvironmentRecords: (_args, _store, storage) => loadEnvironments(storage),
  loadControlAccess: async ([environmentId, key, _retry], store) => {
    if (!environmentId || !key) return { key, allowed: false, error: "" };
    try {
      const session = sessionFor(environmentId);
      const token = credentials(store)[environmentId];
      if (!token || key !== session.controlAccessKey()) return { key, allowed: false, error: "Reconnect to respond." };
      session.installControlAccess(key, {});
      const response = await readJson(`${session.environment.url}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      const allowed = session.installControlAccess(key, response);
      return { key, allowed, error: allowed ? "" : "This connection does not have permission to control turns." };
    } catch (error) {
      return { key, allowed: false, error: error instanceof Error ? error.message : "Could not check your permission." };
    }
  },
  submitControl: async ([threadId, accessKey, kind, targetId, key, value, drafts], _store, _storage, native) => {
    try {
      const identity = threadIdentity(threadId);
      if (kind !== "stop" && key !== controlKey(identity.environmentId, identity.threadId, targetId)) throw new Error("This request belongs to a different thread.");
      const reply = await awaitReply(sessionFor(identity.environmentId).control(identity.threadId, accessKey, kind, targetId, value, drafts, crypto.randomUUID()), native);
      return { ...reply, key, threadId, drafts };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The response could not be sent.", key, threadId, drafts };
    }
  },
  stopControl: ([threadId, accessKey, runId, key], store, storage, native) =>
    sources.submitControl([threadId, accessKey, "stop", runId, key, "", []], store, storage, native),
  loadCatalog: async ([selected, activeThreadId, environments, now], store, _storage, native) => {
    const catalog = await loadCatalog(selected, activeThreadId, environments, now, store, native);
    for (const { id } of composerSettings.snapshot()) {
      const identity = threadIdentity(id);
      const session = connections.get(identity.environmentId)?.session
        ?? (current?.environment.id === identity.environmentId ? current : undefined);
      const live = session?.liveSettings(identity.threadId);
      if (composerSettings.reconcile(id, live, live != null)) modelDraftRevision++;
    }
    return { ...catalog, modelDraftRevision };
  },
  updateEnvironment: ([id, label, url], store, storage, native) =>
    sources.command(["update-environment", id, JSON.stringify({ label, url })], store, storage, native),
  visitThread: async ([id, visitedAt, opened], _store, _storage, native) => {
    try {
      const identity = threadIdentity(id);
      return await awaitReply(sessionFor(identity.environmentId).visit(identity.threadId, visitedAt, opened, crypto.randomUUID()), native);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The thread visit could not be saved." };
    }
  },
  loadEarlierThread: async ([id], store) => {
    try {
      const identity = threadIdentity(id);
      const token = credentials(store)[identity.environmentId];
      const session = sessionFor(identity.environmentId);
      if (!token) throw new Error("Pair this environment to load earlier messages.");
      const origin = session.environment.url;
      return await session.loadEarlier(identity.threadId, async (relativePath) => {
        const response = await fetch(new URL(relativePath, origin), {
          headers: { Authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
        });
        if (!response.ok) throw new Error(`Earlier messages could not be loaded (${response.status}).`);
        return response.json();
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Earlier messages could not be loaded." };
    }
  },
  loadToolPanels: async ([id, viewKey, wanted], _store, _storage, native) => {
    if (!id) {
      for (const connection of connections.values()) connection.session.clearToolPanels();
      current?.clearToolPanels();
      return { viewKey, panels: [] };
    }
    native?.watch("connections");
    if (native?.available) syncNativeConnections(native);
    try {
      const identity = threadIdentity(id);
      return await awaitReply(sessionFor(identity.environmentId).toolPanels(identity.threadId, viewKey, wanted), native);
    } catch (error) {
      return {
        viewKey,
        panels: wanted.map((request) => ({
          ...request, state: "error", input: "", output: "", truncated: false,
          error: error instanceof Error ? error.message : "Could not load this activity.",
        })),
      };
    }
  },
  loadCodeHighlights: ([id, viewKey, _revision, refs], _store, _storage, native) => {
    const empty = { threadId: id, viewKey, highlights: [] };
    if (!id || refs.length === 0) return empty;
    try {
      const identity = threadIdentity(id);
      const inputs = sessionFor(identity.environmentId).markdownBlocks(identity.threadId, viewKey, refs.filter((ref) => ref.threadId === id && ref.viewKey === viewKey), "code").filter((block) => !block.pending);
      if (!inputs.length || !native?.available) return empty;
      return codeHighlights.load(inputs, (code, language) => native.later({ op: "markdown.highlight", code, language }))
        .then((highlights) => ({ threadId: id, viewKey, highlights }));
    } catch { return empty; }
  },
  loadTableLayouts: ([id, viewKey, _revision, refs], _store, _storage, native) => {
    const empty = { threadId: id, viewKey, layouts: [] };
    if (!id || refs.length === 0) return empty;
    try {
      const identity = threadIdentity(id);
      const inputs = sessionFor(identity.environmentId).markdownBlocks(identity.threadId, viewKey, refs.filter((ref) => ref.threadId === id && ref.viewKey === viewKey), "table");
      if (!inputs.length || !native?.available) return empty;
      return tableLayouts.load(inputs, (block) => native.later({ op: "markdown.measureTable", columns: block.columns, cells: block.cells }))
        .then((layouts) => ({ threadId: id, viewKey, layouts }));
    } catch { return empty; }
  },
  resolveMarkdownLink: async ([originThreadId, href, originRoute], _store, _storage, native) => {
    const result = { originThreadId, originRoute, kind: "", threadId: "", path: "", line: 0, column: 0, error: "" };
    try {
      const origin = threadIdentity(originThreadId);
      const link = parseThreadLink(href);
      if (link) {
        const sessions = new Map([...connections].map(([id, entry]) => [id, entry.session]));
        if (current) sessions.set(current.environment.id, current);
        const target = resolveThreadLink(link, origin.environmentId, [...sessions.values()].flatMap((session) => session.threadRefs()));
        if (sessions.get(target.environmentId)?.environment.status !== "Connected") throw new Error("This environment is disconnected.");
        return { ...result, kind: "thread", threadId: scopedThreadId(target.environmentId, target.threadId) };
      }
      const file = parseFileLink(href);
      if (!file) throw new Error("This link cannot be opened.");
      const path = await awaitReply(sessionFor(origin.environmentId).fileLinkPath(origin.threadId, file.path), native);
      return { ...result, kind: "file", threadId: originThreadId, ...file, path };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : "This link could not be opened." };
    }
  },
  loadLinkedFile: async ([id, path, line, column], _store, _storage, native) => {
    if (!id || !path) return { path, targetLine: "0", error: "", lines: [] };
    try {
      const identity = threadIdentity(id);
      const inspection = await awaitReply(sessionFor(identity.environmentId).inspect(identity.threadId, "file", path), native);
      const rows = inspection.body.split("\n");
      const target = Math.max(0, Math.min(rows.length, Number(line) || 0));
      return { path, targetLine: String(target), error: "", lines: rows.map((body, index) => {
        const text = body || " ";
        let offset = index + 1 === target ? Math.min(text.length - 1, Math.max(0, Number(column) - 1 || 0)) : text.length;
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]!) && /[\uD800-\uDBFF]/.test(text[offset - 1]!)) offset--;
        const focus = index + 1 === target && Number(column) > 0 ? String.fromCodePoint(text.codePointAt(offset)!) : "";
        return { id: String(index + 1), number: index + 1, text, prefix: text.slice(0, offset), focus, suffix: text.slice(offset + focus.length) };
      }) };
    } catch (error) {
      return { path, targetLine: "0", lines: [], error: error instanceof Error ? error.message : "This file could not be opened." };
    }
  },
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
        const connection = connections.get(id);
        if (connection) {
          connection.open = false;
          connection.generation = ++nextGeneration;
          connection.session.disconnected("Reconnecting");
        }
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
