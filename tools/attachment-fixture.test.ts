import { expect, test } from "bun:test";
import { AttachmentFixture } from "./attachment-fixture";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const records = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown) => typeof value === "string" ? value : "";

function harness(environmentId = "fixture") {
  const frames: RecordValue[] = [];
  const closed: number[] = [];
  const socket = { send(data: string) { frames.push(JSON.parse(data)); }, close(code?: number) { closed.push(code ?? 0); } };
  const fixture = new AttachmentFixture(environmentId, "active", { now: 1_900_000_000_000 });
  let next = 0;
  function request(tag: string, payload: RecordValue) {
    const id = String(++next);
    expect(fixture.receive(socket, { _tag: "Request", id, tag, payload, headers: [] })).toBe(true);
    return id;
  }
  function reply(id: string) { return object(frames.findLast((frame) => frame._tag === "Exit" && frame.requestId === id)?.exit); }
  function rpc(tag: string, payload: RecordValue) {
    const result = reply(request(tag, payload));
    expect(result._tag).toBe("Success");
    return object(result.value);
  }
  return { fixture, socket, frames, closed, request, reply, rpc };
}

async function response(fixture: AttachmentFixture, path: string, init?: RequestInit) {
  const result = await fixture.http(new Request(`http://fixture${path}`, init));
  expect(result).toBeDefined();
  return result!;
}

async function control(fixture: AttachmentFixture, action: string, fields: RecordValue = {}) {
  const result = await response(fixture, "/attachments/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...fields }) });
  expect(result.status).toBe(200);
  return object(await result.json());
}

function awaitMilestone(fixture: AttachmentFixture, milestone: string, fields: RecordValue = {}, signal?: AbortSignal) {
  return response(fixture, "/attachments/await", { method: "POST", body: JSON.stringify({ milestone, ...fields }), signal });
}

function upload(fixture: AttachmentFixture, relativeUrl: string, bytes = "note", mime = "text/plain", extra: RequestInit = {}) {
  return response(fixture, relativeUrl, { method: "POST", headers: { "content-type": mime }, body: bytes, ...extra });
}

function metadata(fields: RecordValue = {}) { return { type: "file", name: "note.txt", mimeType: "text/plain", sizeBytes: 4, ...fields }; }
function dispatch(attachments: RecordValue[], fields: RecordValue = {}) {
  return { type: "message.dispatch", commandId: "command-1", messageId: "message-1", threadId: "attachments-compose", text: "", attachments,
    createdBy: "user", creationSource: "mobile", dispatchMode: { type: "start_immediately" }, modelSelection: { instanceId: "fixture-provider", model: "fixture-model" }, ...fields };
}
function error(reply: RecordValue) { return object(records(reply.cause)[0]?.error); }

test("raw attachment upload validates bytes, MIME, signed credentials, and idempotency", async () => {
  const h = harness(), minted = h.rpc("attachments.createUploadUrl", metadata());
  expect(minted).toEqual({ attachmentId: "pending-1", relativeUrl: "/api/attachments/upload/fixture-upload-1", expiresAt: 1_900_000_600_000 });
  const url = string(minted.relativeUrl);
  expect((await upload(h.fixture, url, "note", "multipart/form-data")).status).toBe(400);
  expect((await upload(h.fixture, url, "too long")).status).toBe(400);
  expect((await upload(h.fixture, url, "note", "text/plain", { headers: { "content-type": "text/plain", authorization: "Bearer fixture-access" } })).status).toBe(400);
  expect((await upload(h.fixture, url, "note", "text/plain", { headers: { "content-type": "text/plain", "content-length": "9" } })).status).toBe(400);
  expect((await upload(h.fixture, url)).status).toBe(204);
  expect((await upload(h.fixture, url)).status).toBe(204);
  expect((await upload(h.fixture, url, "edit")).status).toBe(409);
  const state = h.fixture.state();
  expect(state.uploadBodies.map((entry) => entry.bytes)).toEqual([4, 8, 4, 4, 4, 4, 4]);
  expect(state.uploadBodies.filter((entry) => entry.leakedCredentials)).toHaveLength(1);
  expect(state.stored[0]).toMatchObject({ id: "pending-1", uploaded: true, sizeBytes: 4 });
  expect(state.stored[0]?.sha256).toBe("edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8");
  await control(h.fixture, "expire-upload", { attachmentId: "pending-1" });
  expect((await upload(h.fixture, url)).status).toBe(404);
  expect((await upload(h.fixture, "/api/attachments/upload/unminted-ticket")).status).toBe(404);
});

test("mint enforces advertised upload limits and read-only access without blocking previews", async () => {
  const h = harness();
  for (const candidate of [
    metadata({ sizeBytes: 0 }), metadata({ sizeBytes: 51 * 1024 * 1024 }), metadata({ sizeBytes: 1.5 }),
    metadata({ type: "image", mimeType: "image/heic" }), metadata({ type: "image", mimeType: "image/png", sizeBytes: 11 * 1024 * 1024 }),
    metadata({ name: " " }), metadata({ name: "x".repeat(256) }), metadata({ dataUrl: "data:text/plain;base64,bm90ZQ==" }),
  ]) {
    expect(h.reply(h.request("attachments.createUploadUrl", candidate))._tag).toBe("Failure");
  }
  await control(h.fixture, "set-capabilities", { maxUploadBytes: 3 });
  expect(h.reply(h.request("attachments.createUploadUrl", metadata()))._tag).toBe("Failure");
  await control(h.fixture, "set-capabilities", { fileAttachments: false });
  expect(h.reply(h.request("attachments.createUploadUrl", metadata({ sizeBytes: 1 })))._tag).toBe("Failure");
  h.rpc("attachments.createUploadUrl", metadata({ type: "image", mimeType: "image/png", sizeBytes: 1 }));
  await control(h.fixture, "set-capabilities", { attachmentUploads: false });
  expect(h.reply(h.request("attachments.createUploadUrl", metadata({ type: "image", mimeType: "image/png", sizeBytes: 1 })))._tag).toBe("Failure");
  await control(h.fixture, "set-operate", { allowed: false });
  expect(error(h.reply(h.request("attachments.createUploadUrl", metadata())))._tag).toBe("RpcPermissionDeniedError");
  expect(error(h.reply(h.request("attachments.delete", { attachmentId: "pending-1" })))._tag).toBe("RpcPermissionDeniedError");
  const session = object(await (await response(h.fixture, "/api/auth/session", { headers: { authorization: "Bearer fixture-access" } })).json());
  expect(session.permissions).toEqual(["orchestration:read"]);
  expect(string(h.rpc("assets.createUrl", { resource: { _tag: "attachment", attachmentId: "shared-image" } }).relativeUrl)).toContain("/api/attachments/fixture-read-1/");
});

test("held uploads expose body barriers, cancellation, deletion races, and explicit retry", async () => {
  const h = harness();
  await control(h.fixture, "hold-upload");
  const jobs = [1, 2, 3].map(() => h.rpc("attachments.createUploadUrl", metadata()));
  const abort = new AbortController();
  const transfers = jobs.map((job, index) => upload(h.fixture, string(job.relativeUrl), "note", "text/plain", index === 0 ? { signal: abort.signal } : {}));
  expect((await awaitMilestone(h.fixture, "body-received", { count: 3 })).status).toBe(200);
  expect(h.fixture.state()).toMatchObject({ activeUploads: 3, heldUploads: 3, maximumUploads: 3 });
  abort.abort();
  expect((await transfers[0]!).status).toBe(499);
  h.rpc("attachments.delete", { attachmentId: "pending-2" });
  await control(h.fixture, "fail-upload-once", { attachmentId: "pending-3" });
  await control(h.fixture, "release-upload");
  expect((await transfers[1]!).status).toBe(404);
  expect((await transfers[2]!).status).toBe(503);
  expect(h.fixture.state()).toMatchObject({ activeUploads: 0, heldUploads: 0 });
  const retry = h.rpc("attachments.createUploadUrl", metadata());
  expect(retry.attachmentId).toBe("pending-4");
  expect((await upload(h.fixture, string(retry.relativeUrl))).status).toBe(204);
  expect(h.fixture.state().stored.filter((asset) => asset.uploaded).map((asset) => asset.id)).toEqual(["pending-4"]);
});

test("signed previews retain environment isolation, expiry, typed missing errors, and cancelled demand", async () => {
  const a = harness(), b = harness("secondary");
  const resource = { _tag: "attachment", attachmentId: "shared-text", fileName: "Preview notes.txt", mimeType: "text/plain", disposition: "inline" };
  const first = a.rpc("assets.createUrl", { resource }), second = b.rpc("assets.createUrl", { resource });
  const aBytes = await response(a.fixture, string(first.relativeUrl)), bBytes = await response(b.fixture, string(second.relativeUrl));
  expect(await aBytes.text()).toBe("Attachment bytes from fixture.\n");
  expect(await bBytes.text()).toBe("Attachment bytes from secondary.\n");
  expect(aBytes.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''Preview%20notes.txt");
  expect((await response(b.fixture, string(first.relativeUrl))).status).toBe(404);
  await control(a.fixture, "expire-read", { attachmentId: "shared-text" });
  expect((await response(a.fixture, string(first.relativeUrl))).status).toBe(404);
  const refreshed = a.rpc("assets.createUrl", { resource });
  expect(refreshed.relativeUrl).not.toBe(first.relativeUrl);
  expect((await response(a.fixture, string(refreshed.relativeUrl))).status).toBe(200);
  const missing = a.reply(a.request("assets.createUrl", { resource: { ...resource, attachmentId: "missing-file" } }));
  expect(error(missing)).toMatchObject({ _tag: "AssetAttachmentNotFoundError", message: "Attachment was not found.", resource: { attachmentId: "missing-file" } });
  await control(a.fixture, "hold-previews");
  const pending = ["shared-image", "shared-pdf", "shared-text"].map((attachmentId) => a.request("assets.createUrl", { resource: { _tag: "attachment", attachmentId } }));
  expect((await awaitMilestone(a.fixture, "active-previews", { count: 3 })).status).toBe(200);
  expect(a.fixture.receive(a.socket, { _tag: "Interrupt", requestId: pending[0] })).toBe(true);
  await control(a.fixture, "release-previews");
  expect(a.reply(pending[0]!)).toEqual({});
  expect(a.reply(pending[1]!)._tag).toBe("Success");
  expect(a.reply(pending[2]!)._tag).toBe("Success");
  expect(a.fixture.state()).toMatchObject({ activePreviews: 0, maximumPreviews: 3, cancelledPreviews: 1 });
});

test("attachment-only dispatch promotes stored IDs and deduplicates a lost receipt", async () => {
  const h = harness(), minted = h.rpc("attachments.createUploadUrl", metadata());
  expect((await upload(h.fixture, string(minted.relativeUrl))).status).toBe(204);
  const reference = { ...metadata(), id: minted.attachmentId }, command = dispatch([reference]);
  h.request("orchestration.subscribeThread", { threadId: "attachments-compose" });
  await control(h.fixture, "drop-next-dispatch-receipt");
  const request = h.request("orchestration.dispatchCommand", command);
  expect(h.reply(request)).toEqual({});
  expect(h.closed).toEqual([1012]);
  expect((await awaitMilestone(h.fixture, "command-committed")).status).toBe(200);
  const committed = h.fixture.state();
  expect(committed.committedMessages).toBe(1);
  expect(committed.dispatches).toHaveLength(1);
  const attachments = records(committed.dispatches[0]?.attachments);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({ type: "file", name: "note.txt", mimeType: "text/plain", sizeBytes: 4 });
  expect(string(attachments[0]?.id)).toMatch(/^final-[a-f0-9]{32}$/);
  expect(attachments[0]?.id).not.toBe(minted.attachmentId);
  const acknowledged = h.rpc("orchestration.dispatchCommand", command);
  expect(acknowledged.sequence).toBe(501);
  h.rpc("orchestration.dispatchCommand", { ...command, commandId: "retry-command" });
  expect(h.fixture.state().committedMessages).toBe(1);
  expect(h.fixture.state().dispatches).toHaveLength(1);
  expect(error(h.reply(h.request("orchestration.dispatchCommand", { ...command, text: "changed after send" })))._tag).toBe("CommandIdempotencyConflictError");
  h.rpc("attachments.delete", { attachmentId: attachments[0]!.id });
  const preview = h.rpc("assets.createUrl", { resource: { _tag: "attachment", attachmentId: attachments[0]!.id } });
  expect(await (await response(h.fixture, string(preview.relativeUrl))).text()).toBe("note");
  expect(h.fixture.state().stored[0]?.uploaded).toBe(true);
  const events = h.frames.flatMap((frame) => records(frame.values)).filter((value) => value.kind === "event");
  expect(events).toHaveLength(1);
  expect(object(object(events[0]?.event).payload)).toMatchObject({ messageId: "message-1", text: "", attachments });
});

test("dispatch rejects unuploaded references, changed metadata, duplicate IDs, and empty messages", async () => {
  const h = harness(), minted = h.rpc("attachments.createUploadUrl", metadata());
  const reference = { ...metadata(), id: minted.attachmentId };
  expect(h.reply(h.request("orchestration.dispatchCommand", dispatch([reference])))._tag).toBe("Failure");
  expect((await upload(h.fixture, string(minted.relativeUrl))).status).toBe(204);
  for (const references of [[{ ...reference, name: "wrong.txt" }], [reference, reference], [{ ...reference, dataUrl: "data:text/plain,wrong" }], []]) {
    expect(h.reply(h.request("orchestration.dispatchCommand", dispatch(references)))._tag).toBe("Failure");
  }
  expect(h.fixture.state().committedMessages).toBe(0);
  h.rpc("orchestration.dispatchCommand", dispatch([], { text: "Text-only still works" }));
  expect(h.fixture.state().committedMessages).toBe(1);
});

test("history fixtures expose bounded metadata pages, inherited images, legacy messages, and ID promotion", async () => {
  const h = harness();
  const longId = h.request("orchestration.subscribeThread", { threadId: "attachments-long" });
  const snapshot = h.frames.filter((frame) => frame.requestId === longId).flatMap((frame) => records(frame.values)).find((entry) => entry.kind === "snapshot")!;
  expect(snapshot).toMatchObject({ historyCursor: "before:220", hasMoreHistory: true, latestLocalTurnOrdinal: 239 });
  expect(records(object(snapshot.projection).visibleTurnItems)).toHaveLength(20);
  expect(h.fixture.state().readRequests).toEqual([]);
  const history = object(await (await response(h.fixture, "/api/orchestration/threads/attachments-long/history?cursor=before%3A220", { headers: { authorization: "Bearer fixture-access" } })).json());
  expect(records(history.items)).toHaveLength(40);
  expect(history.nextCursor).toBe("before:180");
  expect(object(records(history.items)[0]?.item)).toMatchObject({ ordinal: 180, attachments: [{ id: "history-image-180", type: "image", name: "History image 181.png", mimeType: "image/png" }] });
  const showcaseId = h.request("orchestration.subscribeThread", { threadId: "attachments-showcase" });
  const showcase = h.frames.filter((frame) => frame.requestId === showcaseId).flatMap((frame) => records(frame.values)).find((entry) => entry.kind === "snapshot")!;
  const visible = records(object(showcase.projection).visibleTurnItems);
  expect(visible.at(-1)).toMatchObject({ visibility: "inherited", sourceThreadId: "attachment-ancestor" });
  expect(records(object(visible[0]?.item).attachments)[0]?.id).toBe("shared-image");
  const legacyId = h.request("orchestration.subscribeThread", { threadId: "attachments-legacy" });
  const legacy = h.frames.filter((frame) => frame.requestId === legacyId).flatMap((frame) => records(frame.values)).find((entry) => entry.kind === "snapshot")!;
  expect(records(object(legacy.projection).messages)[0]).toMatchObject({ role: "user", text: "", attachments: [{ id: "shared-image" }] });
  expect(object(legacy.projection).visibleTurnItems).toBeUndefined();
  await control(h.fixture, "promote-id", { attachmentId: "shared-image", nextId: "revised-image", threadId: "attachments-showcase" });
  const changed = h.frames.filter((frame) => frame.requestId === showcaseId).flatMap((frame) => records(frame.values)).findLast((entry) => entry.kind === "event")!;
  expect(object(object(changed.event).payload)).toMatchObject({ messageId: "image-only", text: "", attachments: [{ id: "revised-image" }] });
  const image = h.rpc("assets.createUrl", { resource: { _tag: "attachment", attachmentId: "revised-image" } });
  expect(image.imageDimensions).toEqual({ width: 320, height: 180 });
  const bytes = new Uint8Array(await (await response(h.fixture, string(image.relativeUrl))).arrayBuffer());
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

test("control barriers cancel without timers and capability changes notify the shared environment", async () => {
  let operate = true, configChanges = 0;
  const fixture = new AttachmentFixture("fixture", "active", {
    now: 1_900_000_000_000, authorization: { get: () => operate, async set(value) { operate = value; } }, configChanged() { configChanges++; },
  });
  const abort = new AbortController(), waiting = awaitMilestone(fixture, "command-committed", {}, abort.signal);
  abort.abort();
  expect((await waiting).status).toBe(499);
  await control(fixture, "set-operate", { allowed: false });
  expect(fixture.state().operate).toBe(false);
  expect(await fixture.http(new Request("http://fixture/api/auth/session"))).toBeUndefined();
  await control(fixture, "set-capabilities", { attachmentUploads: false, fileAttachments: false });
  expect(fixture.config).toEqual({ attachmentUploads: false });
  expect(configChanges).toBe(1);
  expect((await response(fixture, "/attachments/control", { method: "POST", body: JSON.stringify({ action: "hold-upload", environmentId: "secondary" }) })).status).toBe(409);
  expect((await response(fixture, "/attachments/await", { method: "POST", body: JSON.stringify({ milestone: "unknown" }) })).status).toBe(400);
  await control(fixture, "disconnect");
  expect((await response(fixture, "/api/auth/websocket-ticket/rpc", { method: "POST" })).status).toBe(503);
  await control(fixture, "reconnect");
  expect(await fixture.http(new Request("http://fixture/api/auth/websocket-ticket/rpc", { method: "POST" }))).toBeUndefined();
});
