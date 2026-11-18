import { expect, test } from "bun:test";
import { projectComposerQueue } from "../composer-queue";
import { DirectSession } from "../connection";

const queued = (id: string, position = 1) => ({ id, status: "queued", userMessageId: `message-${id}`, ordinal: position + 10, queuePosition: position });
const message = (id: string) => ({ id: `message-${id}`, text: `Message ${id}`, attachments: [] });

test("queue projection orders only user queued runs and preserves message context and files", () => {
  const context = { version: 1, records: [{ version: 1, kind: "thread", contextId: "related", label: "Related", environmentId: "env", threadId: "related" }] };
  const attachment = { id: "file", type: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 10 };
  const result = projectComposerQueue([
    queued("later", 2), { ...queued("first"), queueHeld: true },
    { ...queued("delegated"), delegatedTaskId: "task" }, { ...queued("done"), status: "completed" },
  ], [message("later"), { ...message("first"), context, attachments: [attachment] }], [], true);
  expect(result.items.map((entry) => entry.id)).toEqual(["first", "later"]);
  expect(result.items[0]).toEqual({ id: "first", messageId: "message-first", text: "Message first", context: JSON.stringify(context), attachments: [attachment], position: 1 });
  expect(result).toMatchObject({ held: true, ready: true, canSendNow: true, activeRunId: "" });
});

test("active queue steering follows the active provider thread's session capability", () => {
  const active = { id: "active", status: "running", providerThreadId: "provider-thread", activeAttemptId: "attempt" };
  const thread = { id: "provider-thread", providerSessionId: "session" };
  for (const capability of ["supportsActiveSteering", "supportsSteeringByInterruptRestart"]) {
    const sessions = [{ id: "session", capabilities: { turns: { [capability]: true } } }];
    expect(projectComposerQueue([active, queued("next")], [message("next")], sessions, true, [thread]).canSendNow).toBe(true);
    expect(projectComposerQueue([{ ...active, status: "waiting" }, queued("next")], [], sessions, true, [thread]).canSendNow).toBe(false);
    expect(projectComposerQueue([{ ...active, activeAttemptId: null }, queued("next")], [], sessions, true, [thread]).canSendNow).toBe(false);
    expect(projectComposerQueue([active, queued("next")], [], sessions, true, [{ ...thread, providerSessionId: "unrelated" }]).canSendNow).toBe(false);
  }
});

function fixture(active = false) {
  const requests: Array<{ id: string; tag: string; payload: Record<string, unknown> }> = [];
  const session = new DirectSession({ id: "env", label: "Mac", url: "http://localhost:13773", enabled: true, status: "Connecting", machineSymbol: "server.rack" });
  session.open({ readyState: 1, bufferedAmount: 0, send(raw) { const frame = JSON.parse(String(raw)); if (frame._tag === "Request") requests.push(frame); }, close() {} });
  const receive = (requestId: string, values: unknown[]) => session.receive(JSON.stringify({ _tag: "Chunk", requestId, values }));
  receive(requests.find((entry) => entry.tag === "subscribeServerConfig")!.id, [{ type: "snapshot", config: { threadResumeCompletionMarker: true } }]);
  session.installControlAccess(session.controlAccessKey(), { authenticated: true, scopes: ["orchestration:operate"] });
  session.select("thread");
  const requestId = requests.find((entry) => entry.tag === "orchestration.subscribeThread")!.id;
  receive(requestId, [{ kind: "snapshot", projection: {
    thread: { id: "thread" }, messages: [message("next")],
    runs: [...(active ? [{ id: "active", status: "running", activeAttemptId: "attempt", providerThreadId: "provider-thread" }] : []), queued("next")],
    providerThreads: [{ id: "provider-thread", providerSessionId: "session" }],
    providerSessions: [{ id: "session", capabilities: { turns: { supportsActiveSteering: true } } }],
  } }]);
  const synchronize = () => receive(requestId, [{ kind: "synchronized" }]);
  const commands = () => requests.filter((entry) => entry.tag === "orchestration.dispatchCommand");
  const accept = () => session.receive(JSON.stringify({ _tag: "Exit", requestId: commands().at(-1)!.id, exit: { _tag: "Success", value: {} } }));
  return { session, synchronize, commands, accept };
}

test("queue edits require synchronized data and current permission before dispatch", async () => {
  const f = fixture();
  const key = f.session.controlAccessKey();
  const operation = { type: "cancel" as const, runId: "next" };
  expect(await f.session.operateComposerQueue("thread", key, operation)).toMatchObject({ ok: false });
  f.synchronize();
  expect(await f.session.operateComposerQueue("thread", "stale", operation)).toMatchObject({ ok: false });
  expect(await f.session.operateComposerQueue("thread", key, { ...operation, runId: "gone" })).toMatchObject({ ok: false });
  expect(f.commands()).toHaveLength(0);
});

test("server queue edit preserves attachment references and structured context on the wire", async () => {
  const f = fixture(); f.synchronize();
  const context = { version: 1, records: [{ version: 1, kind: "thread", contextId: "related", label: "Related", environmentId: "env", threadId: "related" }] };
  const attachment = { id: "file", type: "file" as const, name: "report.pdf", mimeType: "application/pdf", sizeBytes: 10 };
  const pending = f.session.operateComposerQueue("thread", f.session.controlAccessKey(), { type: "edit", runId: "next", text: "Edited message", context: JSON.stringify(context), attachments: [attachment] });
  expect(f.commands().at(-1)?.payload).toMatchObject({ type: "queued-run.edit", threadId: "thread", runId: "next", text: "Edited message", context, attachments: [attachment] });
  f.accept(); await expect(pending).resolves.toEqual({ ok: true, error: "" });
});

test("Send now starts an idle queue and promotes a queued message to active steering", async () => {
  for (const active of [false, true]) {
    const f = fixture(active); f.synchronize();
    const pending = f.session.operateComposerQueue("thread", f.session.controlAccessKey(), { type: "start", runId: "next" });
    expect(f.commands().at(-1)?.payload).toMatchObject(active
      ? { type: "queued-message.promote-to-steer", threadId: "thread", queuedRunId: "next", targetRunId: "active" }
      : { type: "queued-run.start", threadId: "thread", runId: "next" });
    f.accept(); await expect(pending).resolves.toMatchObject({ ok: true });
  }
});

test("queue resume and remove dispatch server commands and retain server rejection", async () => {
  const f = fixture(); f.synchronize();
  const resuming = f.session.operateComposerQueue("thread", f.session.controlAccessKey(), { type: "resume" });
  expect(f.commands().at(-1)?.payload).toMatchObject({ type: "queue.resume", threadId: "thread" });
  f.accept(); await expect(resuming).resolves.toMatchObject({ ok: true });
  const cancelling = f.session.operateComposerQueue("thread", f.session.controlAccessKey(), { type: "cancel", runId: "next" });
  const request = f.commands().at(-1)!;
  expect(request.payload).toMatchObject({ type: "queued-run.cancel", threadId: "thread", runId: "next" });
  f.session.receive(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Queue changed on another client" } }] } }));
  await expect(cancelling).resolves.toEqual({ ok: false, error: "Queue changed on another client" });
});
