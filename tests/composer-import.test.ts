import { expect, spyOn, test } from "bun:test";
import type { Storage } from "../app.contract.d.ts";
import type { AttachmentSession } from "../attachment-session";
import { FILE_LIMIT, ownedAttachmentPath, type DraftAttachment } from "../attachments";
import { appendComposerAttachmentReferences, bindComposerAttachmentContext, materializeComposerImport, prepareComposerImport, type ComposerImportBoundary, type ComposerImportInput } from "../composer-import";
import { composerDocument } from "../composer-context";
import { DirectSession } from "../connection";

const copied = { version: 1, kind: "file", contextId: "copied", label: "notes.txt", attachmentId: "remote_attachment", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 };
const reference = "[notes.txt](t3-context://v1/file/copied)";
const input = (): ComposerImportInput => ({ draft: { id: "target-draft", revision: 4, text: "👋 replace tail", context: JSON.stringify({ version: 1, records: [{ version: 1, kind: "environment", contextId: "existing", label: "Machine", environmentId: "target" }] }), attachments: [] }, environmentId: "target", fragment: JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [copied] }), pastedText: reference, start: 3, end: 10 });

function harness() {
  const files = new Map<string, number>();
  const removed: string[] = [];
  const reads: string[] = [];
  const copies: Array<[string, string]> = [];
  const keys = { source: "source-access", target: "target-access" };
  let uploads = true;
  let readableEnvironments = ["target"];
  const scopeReads: string[] = [];
  const storage = { fs: {
    mkdir: async () => {},
    copyFile: async (from: string, to: string) => { if (!files.has(from)) throw new Error("Missing file"); copies.push([from, to]); files.set(to, files.get(from)!); },
    stat: async (path: string) => { if (!files.has(path)) throw new Error("Missing file"); return { size: files.get(path)! }; },
    rm: async (path: string) => { removed.push(path); files.delete(path); },
  } } as unknown as Storage;
  const boundary: ComposerImportBoundary = {
    async readableEnvironmentIds(environmentId) { scopeReads.push(environmentId); return readableEnvironments; },
    sessionFor(environmentId) {
      if (environmentId !== "source" && environmentId !== "target") throw new Error("Disconnected");
      const metadata = () => ({ accessKey: keys[environmentId], origin: `https://${environmentId}.example`, allowed: true, uploads, maxFileBytes: FILE_LIMIT });
      return { attachments: {
        metadata,
        assertAccess(key: string, origin?: string) { const current = metadata(); if (key !== current.accessKey || (origin && origin !== current.origin)) throw new Error("Connection changed"); return current; },
        async read(item: { id: string }) { reads.push(item.id); return { url: `https://${environmentId}.example/api/assets/${item.id}`, expiresAt: Date.now() + 60000 }; },
      } as unknown as AttachmentSession };
    },
    async awaitReply(operation) { return operation; },
  };
  return { storage, boundary, files, removed, reads, copies, keys, scopeReads, setReadableEnvironments: (ids: string[]) => { readableEnvironments = ids; }, setUploads: (value: boolean) => { uploads = value; } };
}

test("remote context imports owned bytes and rebinds both context and upload identities", async () => {
  const h = harness();
  const request = input();
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  expect(prepared.error).toBe("");
  expect(h.reads).toEqual(["remote_attachment"]);
  let ownedEntry = true;
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    expect(ownedEntry).toBe(true);
    expect(options?.headers).toBeUndefined();
    expect(options?.exactIndependentHttp?.maxResponseBytes).toBe(12);
    h.files.set(options!.exactBodyTo!, 11);
    return new Response("", { status: 200 });
  });
  const pending = materializeComposerImport(prepared.plan, h.storage, h.boundary);
  ownedEntry = false;
  const result = await pending;
  expect(result.error).toBe("");
  expect(result.attachments).toHaveLength(1);
  const attachment = result.attachments[0]!;
  expect(ownedAttachmentPath(attachment.path)).toBe(true);
  expect(attachment).toMatchObject({ id: "", state: "local", sizeBytes: 11, insertionRevision: 5 });
  const records = JSON.parse(result.context).records;
  expect(records[0].contextId).toBe("existing");
  expect(records[1]).toMatchObject({ attachmentId: attachment.localId, sizeBytes: 11 });
  expect(records[1].contextId).not.toBe("copied");
  expect(result.text).toBe(`👋 [notes.txt](t3-context://v1/file/${records[1].contextId}) tail`);
  expect(result.cursor).toBe(result.text.length - " tail".length);
  expect(request.draft.text).toBe("👋 replace tail");
  expect(() => bindComposerAttachmentContext(result.context, result.attachments)).toThrow("finish uploading");
  const bound = bindComposerAttachmentContext(result.context, [{ ...attachment, id: "new_uploaded_id", state: "uploaded" }]);
  expect(JSON.parse(bound).records[1].attachmentId).toBe("new_uploaded_id");
  expect(bound).not.toContain("remote_attachment");
});

test("local clipboard attachments are copied into a fresh owned file without a remote request", async () => {
  const h = harness();
  const local: DraftAttachment = { type: "file", id: "remote_attachment", localId: "original", path: "app:/data/composer-attachments/original/content.txt", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12, width: 0, height: 0, state: "uploaded", attempt: 1, error: "", insertionRevision: 2 };
  h.files.set(local.path, 12);
  const request = input();
  request.localDrafts = [{ ...request.draft, id: "source-draft", task: { environmentId: "source" }, attachments: [local] }];
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected remote fetch"); });
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(h.reads).toEqual([]);
  expect(h.copies).toEqual([[local.path, result.attachments[0]!.path]]);
  expect(h.files.has(local.path)).toBe(true);
  expect(result.attachments[0]!.localId).not.toBe(local.localId);
  expect(result.attachments[0]!.id).toBe("");
});

test("a failed transfer keeps sibling downloads and marks only the unavailable context", async () => {
  const h = harness();
  const request = input();
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [copied, { ...copied, contextId: "second", attachmentId: "second_remote" }] });
  request.pastedText += " [other](t3-context://v1/file/second)";
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  let downloads = 0;
  using _fetch = spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
    h.files.set(options!.exactBodyTo!, 1);
    downloads += 1;
    if (downloads === 1) return Promise.resolve(new Response("", { status: 500 }));
    return Promise.resolve(new Response("", { status: 200 }));
  });
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(result.failures).toEqual(["notes.txt"]);
  expect(result.attachments).toHaveLength(1);
  expect(JSON.parse(result.context).records).toEqual([
    expect.objectContaining({ kind: "environment", contextId: "existing" }),
    expect.objectContaining({ kind: "file", attachmentId: expect.any(String) }),
  ]);
  expect(result.text).toContain("t3-context://v1/file/");
  expect(h.files.size).toBe(1);
  expect(h.removed.filter(ownedAttachmentPath)).toHaveLength(1);
  expect(request.draft.text).toBe("👋 replace tail");
});

test("a source read failure leaves the plain reference and imports remaining context", async () => {
  const h = harness();
  const request = input();
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [copied, { version: 1, kind: "thread", contextId: "thread_source", label: "Build", environmentId: "target", threadId: "thread-1", title: "Build" }] });
  request.pastedText += " [Build](t3-context://v1/thread/thread_source)";
  const original = h.boundary.sessionFor;
  h.boundary.sessionFor = (environmentId) => {
    const session = original(environmentId);
    if (environmentId === "source") session.attachments.read = async () => { throw new Error("source disconnected"); };
    return session;
  };
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  expect(prepared.error).toBe("");
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(result.failures).toEqual(["notes.txt"]);
  expect(JSON.parse(result.context).records).toEqual([
    expect.objectContaining({ kind: "environment", contextId: "existing" }),
    expect.objectContaining({ kind: "thread", label: "Build" }),
  ]);
  expect(result.text).toContain("notes.txt");
  expect(result.text).toContain("Build");
});

test("connection changes between preparation and download cannot import stale asset URLs", async () => {
  const h = harness();
  const prepared = await prepareComposerImport(input(), h.storage, h.boundary);
  h.keys.source = "replacement-connection";
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected remote fetch"); });
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toContain("source connection changed");
  expect(result.attachments).toEqual([]);
  expect(h.removed.filter(ownedAttachmentPath)).toHaveLength(1);
});

test("cancellation after a completed download cleans its file and returns no draft replacement", async () => {
  const h = harness();
  const prepared = await prepareComposerImport(input(), h.storage, h.boundary);
  const controller = new AbortController();
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    h.files.set(options!.exactBodyTo!, 12);
    controller.abort();
    return new Response("", { status: 200 });
  });
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary, controller.signal);
  expect(result.error).toContain("cancelled");
  expect(result.text).toBe("");
  expect(h.files.size).toBe(0);
});

test("invalid attachment metadata fails without changing the draft or leaking prepared files", async () => {
  const h = harness();
  const request = input();
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [{ ...copied, attachmentId: "../bad" }] });
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  expect(prepared.error).toBe("");
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(result.failures).toEqual(["notes.txt"]);
  expect(result.attachments).toEqual([]);
  expect(h.files.size).toBe(0);
});

test("raw picked files and images insert inline references at the captured UTF16 selection", () => {
  const file: DraftAttachment = { type: "file", id: "", localId: "new-file", path: "app:/data/composer-attachments/new-file/content.txt", name: "notes[1].txt", mimeType: "text/plain", sizeBytes: 12, width: 0, height: 0, state: "local", attempt: 0, error: "", insertionRevision: 1 };
  const image = { ...file, type: "image" as const, localId: "new-image", name: "photo.png", mimeType: "image/png" };
  const result = appendComposerAttachmentReferences("👋 replace tail", "", [file, image], 3, 10);
  expect(result.text).toContain("👋 [notes 1 .txt](t3-context://v1/file/attachment_new-file) ![photo.png](t3-context://v1/image/attachment_new-image)  tail");
  expect(JSON.parse(result.context).records.map((entry: Record<string, unknown>) => entry.attachmentId)).toEqual(["new-file", "new-image"]);
  expect(result.cursor).toBe(result.text.length - " tail".length);
});

test("a legacy thread link is converted to a context chip without an attachment transfer", async () => {
  const h = harness();
  const request = input();
  request.fragment = "";
  request.pastedText = "Open https://app.t3.codes/threads/target/thread-1";
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  expect(prepared.error).toBe("");
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(result.failures).toEqual([]);
  expect(result.attachments).toEqual([]);
  expect(result.text).toContain("t3-context://v1/thread/");
  expect(JSON.parse(result.context).records.find((record: Record<string, unknown>) => record.kind === "thread")).toMatchObject({ kind: "thread", environmentId: "target", threadId: "thread-1" });
  expect(h.reads).toEqual([]);
});

test("thread-only context imports when the target cannot upload attachments", async () => {
  const h = harness();
  h.setUploads(false);
  const request = input();
  request.fragment = "";
  request.pastedText = "Open t3-thread://v2/target/thread-1";
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  expect(prepared.error).toBe("");
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(result.attachments).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.text).toContain("t3-context://v1/thread/");
});

test("legacy thread URLs become one valid context chip without surplus punctuation", async () => {
  for (const [pastedText, label] of [
    ["https://app.t3.codes/threads/target/thread-hosted", "Thread"],
    ["[Build](https://app.t3.codes/threads/target/thread-markdown)", "Build"],
    ["t3-thread://v2/target/thread-v2", "Thread"],
  ] as const) {
    const h = harness();
    const request = input();
    request.fragment = "";
    request.draft.text = "";
    request.pastedText = pastedText;
    request.start = 0;
    request.end = 0;
    const prepared = await prepareComposerImport(request, h.storage, h.boundary);
    const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
    expect(result.error).toBe("");
    expect(result.text).not.toContain(")\)");
    const tokens = JSON.parse(composerDocument(result.text, result.context).tokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: "context", kind: "thread", label });
  }
});

test("legacy thread IDs avoid copied context ID collisions", async () => {
  const h = harness();
  const request = input();
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [{ version: 1, kind: "thread", contextId: "legacy_thread_0", label: "Copied", environmentId: "target", threadId: "copied", title: "Copied" }] });
  request.draft.text = "";
  request.pastedText = "[Copied](t3-context://v1/thread/legacy_thread_0) https://app.t3.codes/threads/target/legacy";
  request.start = 0;
  request.end = 0;
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  const imported = JSON.parse(result.context).records.filter((record: Record<string, unknown>) => record.kind === "thread");
  expect(imported).toHaveLength(2);
  expect(imported[0].contextId).not.toBe(imported[1].contextId);
  expect(imported.map((record: Record<string, unknown>) => record.label)).toEqual(["Copied", "Thread"]);
  expect(result.text.match(/t3-context:\/\/v1\/thread\/[^\s)]+\)/gu)).toHaveLength(2);
});

test("raw foreign thread links stay plain while structured foreign references become unavailable", async () => {
  const h = harness();
  const request = input();
  request.draft.text = "";
  request.draft.context = "";
  request.start = 0;
  request.end = 0;
  request.fragment = "";
  request.pastedText = "[Remote](https://app.t3.codes/threads/source/remote) t3-thread://v2/unknown/other";
  const plainPlan = await prepareComposerImport(request, h.storage, h.boundary);
  const plain = await materializeComposerImport(plainPlan.plan, h.storage, h.boundary);
  expect(plain.error).toBe("");
  expect(plain.text).toBe(request.pastedText);
  expect(plain.skippedThreads).toEqual([]);
  expect(JSON.parse(plain.context).records).toEqual([]);

  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [
    { version: 1, kind: "thread", contextId: "remote", label: "Remote", environmentId: "source", threadId: "remote", title: "Remote discussion" },
    { version: 1, kind: "thread", contextId: "local", label: "Local", environmentId: "target", threadId: "local", title: "Local discussion" },
  ] });
  request.pastedText = "Compare [Remote](t3-context://v1/thread/remote) and [Local](t3-context://v1/thread/local).";
  const structuredPlan = await prepareComposerImport(request, h.storage, h.boundary);
  const structured = await materializeComposerImport(structuredPlan.plan, h.storage, h.boundary);
  expect(structured.error).toBe("");
  expect(structured.skippedThreads).toEqual(["Remote discussion"]);
  const retained = JSON.parse(structured.context).records;
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ kind: "thread", environmentId: "target" });
  const tokens = JSON.parse(composerDocument(structured.text, structured.context).tokens);
  expect(tokens).toHaveLength(2);
  expect(tokens[0].contextId).not.toBe("remote");
  expect(retained.some((record: Record<string, unknown>) => record.contextId === tokens[0].contextId)).toBe(false);
  expect(h.scopeReads).toEqual(["target", "target"]);
});

function peerSession(capability: boolean, enabled: boolean) {
  const requests: Array<{ id: string; tag: string; payload: Record<string, unknown> }> = [];
  const session = new DirectSession({ id: "target", label: "Destination", url: "https://target.example", enabled: true, status: "Connecting", machineSymbol: "server.rack" });
  session.open({ readyState: 1, bufferedAmount: 0, send(frame) { requests.push(JSON.parse(String(frame))); }, close() {} });
  const configRequest = requests.find((request) => request.tag === "subscribeServerConfig")!;
  session.receive(JSON.stringify({ _tag: "Chunk", requestId: configRequest.id, values: [{ type: "snapshot", config: { environment: { capabilities: { peerLinks: capability } }, settings: { linkedEnvironmentsEnabled: enabled } } }] }));
  return { session, requests };
}

test("peer scope accepts unreachable linked threads and excludes expired links", async () => {
  const peer = peerSession(true, true);
  const h = harness();
  h.boundary.readableEnvironmentIds = () => peer.session.readableComposerEnvironmentIds();
  const request = input();
  request.draft.text = "";
  request.draft.context = "";
  request.start = 0;
  request.end = 0;
  request.fragment = "";
  request.pastedText = "https://app.t3.codes/threads/source/linked https://app.t3.codes/threads/expired/old";
  const preparing = prepareComposerImport(request, h.storage, h.boundary);
  const lookup = peer.requests.filter((request) => request.tag === "peerLinks.list");
  expect(lookup).toHaveLength(1);
  expect(lookup[0]!.payload).toEqual({});
  peer.session.receive(JSON.stringify({ _tag: "Exit", requestId: lookup[0]!.id, exit: { _tag: "Success", value: { links: [{ environmentId: "source", status: "unreachable" }, { environmentId: "expired", status: "expired" }] } } }));
  const prepared = await preparing;
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(JSON.parse(result.context).records).toEqual([expect.objectContaining({ environmentId: "source", threadId: "linked" })]);
  expect(result.text).toContain("https://app.t3.codes/threads/expired/old");
  expect(JSON.parse(composerDocument(result.text, result.context).tokens)).toHaveLength(1);
});

test("disabled peer capability or setting performs no peer lookup", async () => {
  for (const [capability, enabled] of [[false, true], [true, false], [false, false]]) {
    const peer = peerSession(capability!, enabled!);
    await expect(peer.session.readableComposerEnvironmentIds()).resolves.toEqual(["target"]);
    expect(peer.requests.filter((request) => request.tag === "peerLinks.list")).toEqual([]);
  }
});

test("a rejected peer lookup still pastes local context and leaves foreign context unavailable", async () => {
  const peer = peerSession(true, true);
  const h = harness();
  h.boundary.readableEnvironmentIds = () => peer.session.readableComposerEnvironmentIds();
  const request = input();
  request.draft.text = "";
  request.draft.context = "";
  request.start = 0;
  request.end = 0;
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [
    { version: 1, kind: "thread", contextId: "remote", label: "Remote", environmentId: "source", threadId: "remote", title: "Remote" },
    { version: 1, kind: "thread", contextId: "local", label: "Local", environmentId: "target", threadId: "local", title: "Local" },
  ] });
  request.pastedText = "Keep [Local](t3-context://v1/thread/local), [Remote](t3-context://v1/thread/remote), and https://app.t3.codes/threads/source/raw";
  const preparing = prepareComposerImport(request, h.storage, h.boundary);
  const lookup = peer.requests.find((request) => request.tag === "peerLinks.list")!;
  peer.session.receive(JSON.stringify({ _tag: "Exit", requestId: lookup.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "PeerLinkError", message: "Peer links unavailable" } }] } }));
  const prepared = await preparing;
  expect(prepared.error).toBe("");
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary);
  expect(result.error).toBe("");
  expect(JSON.parse(result.context).records).toEqual([expect.objectContaining({ environmentId: "target", threadId: "local" })]);
  expect(result.skippedThreads).toEqual(["Remote"]);
  expect(result.text).toContain("https://app.t3.codes/threads/source/raw");
  expect(JSON.parse(composerDocument(result.text, result.context).tokens).map((token: Record<string, unknown>) => token.label)).toEqual(["Local", "Remote · unavailable"]);
});

test("cancellation waits for every download before cleaning imported files", async () => {
  const h = harness();
  const request = input();
  request.fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [copied, { ...copied, contextId: "second", attachmentId: "second_remote", name: "second.txt" }] });
  request.pastedText += " [second.txt](t3-context://v1/file/second)";
  const prepared = await prepareComposerImport(request, h.storage, h.boundary);
  const controller = new AbortController();
  let downloads = 0;
  using _fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    h.files.set(options!.exactBodyTo!, 12);
    downloads += 1;
    if (downloads === 1) {
      controller.abort();
      return new Response("", { status: 200 });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response("", { status: 200 });
  });
  const result = await materializeComposerImport(prepared.plan, h.storage, h.boundary, controller.signal);
  expect(result.error).toContain("cancelled");
  expect(h.files.size).toBe(0);
  expect(h.removed.filter(ownedAttachmentPath)).toHaveLength(2);
});
