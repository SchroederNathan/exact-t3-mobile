import { expect, test } from "bun:test";
import { DirectSession } from "./connection";

function fixture() {
  const requests: { id: string; tag: string; payload: Record<string, unknown> }[] = [];
  const session = new DirectSession({ id: "env", label: "Mac", url: "http://localhost:13773", enabled: true, status: "Connecting", machineSymbol: "server.rack" });
  const open = () => session.open({ readyState: 1, bufferedAmount: 0, send(value) {
    const frame = JSON.parse(String(value));
    if (frame._tag === "Request") requests.push(frame);
  }, close() {} });
  const chunk = (tag: string, values: unknown[]) => session.receive(JSON.stringify({ _tag: "Chunk", requestId: requests.findLast((request) => request.tag === tag)!.id, values }));
  const configure = () => chunk("subscribeServerConfig", [{ type: "snapshot", config: {} }]);
  open(); configure(); session.select("thread");
  let sequence = 10;
  const snapshot = (fields: Record<string, unknown> = {}) => chunk("orchestration.subscribeThread", [{ kind: "snapshot", snapshotSequence: sequence++, projection: { thread: { id: "thread" }, turnItems: [], visibleTurnItems: [], runtimeRequests: [], runs: [], ...fields } }]);
  const event = (type: string, payload: unknown) => chunk("orchestration.subscribeThread", [{ kind: "event", sequence: sequence++, event: { threadId: "thread", type, payload } }]);
  const command = () => requests.findLast((request) => request.tag === "orchestration.dispatchCommand")!;
  const accept = () => session.receive(JSON.stringify({ _tag: "Exit", requestId: command().id, exit: { _tag: "Success", value: { sequence } } }));
  const authorize = () => session.installControlAccess(session.controlAccessKey(), { authenticated: true, permissions: ["orchestration:operate"] });
  return { session, open, configure, requests, snapshot, event, command, accept, authorize };
}

test("reconnect rejects an old HTTP grant even though the session owner survives", () => {
  const f = fixture();
  const key = f.session.controlAccessKey();
  f.session.disconnected("Disconnected"); f.open(); f.configure();
  expect(f.session.installControlAccess(key, { authenticated: true, permissions: ["orchestration:operate"] })).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
  expect(f.authorize()).toBe(true);
});

test("stop owns the displayed run and stays stopping after acceptance until an event", async () => {
  const f = fixture(); f.authorize();
  f.snapshot({ runs: [{ id: "A", ordinal: 1, status: "running" }, { id: "queued", ordinal: 99, status: "queued" }] });
  const key = f.session.controlAccessKey();
  const pending = f.session.control("thread", key, "stop", "A", "", [], "command-A");
  expect(f.command().payload).toEqual({ type: "run.interrupt", commandId: "command-A", threadId: "thread", runId: "A", holdQueue: true });
  expect(f.session.controls("thread").stop.state).toBe("stopping");
  f.accept(); expect(await pending).toEqual({ ok: true, error: "" });
  expect(f.session.controls("thread").stop.state).toBe("stopping");
  f.event("turn-item.updated", { id: "interrupt-request", type: "run_interrupt_request", runId: "A", ordinal: 1, unresponsiveAt: "2026-11-10T00:00:00Z" });
  expect(f.session.controls("thread").stop.state).toBe("unresponsive");
  f.event("turn-item.updated", { id: "interrupt-result", type: "run_interrupt_result", runId: "A", ordinal: 2 });
  expect(f.session.controls("thread").stop.state).toBe("available");
  f.event("run.updated", { id: "A", ordinal: 1, status: "completed" });
  f.event("run.created", { id: "B", ordinal: 2, status: "running" });
  await expect(f.session.control("thread", key, "stop", "A", "", [], "late-A")).rejects.toThrow("no longer");
  expect(f.session.controls("thread").stop).toEqual({ runId: "B", state: "available", error: "" });
});

test("responses target the runtime request, suppress duplicate taps, and reject resolved requests", async () => {
  const f = fixture(); f.authorize();
  f.snapshot({ runtimeRequests: [{ id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } }], turnItems: [{ id: "different-item", type: "approval_request", requestId: "request", options: [{ decision: "acceptAlways", label: "Always" }] }] });
  const key = f.session.controlAccessKey();
  const pending = f.session.control("thread", key, "approve", "request", "acceptAlways", [], "command");
  expect(f.command().payload).toEqual({ type: "runtime-request.respond", commandId: "command", threadId: "thread", requestId: "request", decision: "acceptAlways" });
  await expect(f.session.control("thread", key, "approve", "request", "acceptAlways", [], "duplicate")).rejects.toThrow("already");
  f.accept(); await pending;
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand").length).toBe(1);
  f.event("runtime-request.updated", { id: "request", status: "resolved" });
  await expect(f.session.control("thread", key, "approve", "request", "acceptAlways", [], "late")).rejects.toThrow("no longer");
});

test("question answers preserve exact values and resolved delivery failures remain in the feed", async () => {
  const f = fixture(); f.authorize();
  f.snapshot({ runtimeRequests: [{ id: "question", kind: "user_input", status: "pending", responseCapability: { type: "message" } }], turnItems: [{ id: "item", type: "user_input_request", requestId: "question", questions: [
    { id: "__proto__", question: "Which?", options: [{ label: "First", value: " first " }], multiSelect: true },
  ] }] });
  const drafts = [{ key: '["env","thread","question"]', questionId: "__proto__", selected: [" first ", " first "], custom: "", hasCustom: true, revision: 8 }];
  const pending = f.session.control("thread", f.session.controlAccessKey(), "answer", "question", "", drafts, "reply");
  expect(f.command().payload).toEqual({ type: "runtime-request.respond", commandId: "reply", threadId: "thread", requestId: "question", answers: JSON.parse('{"__proto__":[" first "]}') });
  f.accept(); await pending;
  f.event("runtime-request.updated", { id: "question", status: "resolved" });
  f.event("turn-item.updated", { id: "delivery-failure", type: "error", ordinal: 3, title: "Answer delivery not confirmed", failure: { message: "Stop the turn and retry." } });
  expect(f.session.controls("thread").requests).toEqual([]);
  expect(f.session.timeline("thread").map((row) => row.item.title)).toEqual(["Answer delivery not confirmed"]);
  expect(drafts).toEqual([{ key: '["env","thread","question"]', questionId: "__proto__", selected: [" first ", " first "], custom: "", hasCustom: true, revision: 8 }]);
});

test("message-mode requests can be dismissed even when answering is no longer resumable", async () => {
  const f = fixture(); f.authorize();
  f.snapshot({ runtimeRequests: [{ id: "question", kind: "user_input", status: "pending", responseCapability: { type: "not_resumable", reason: "Provider restarted." } }], turnItems: [{ id: "item", type: "user_input_request", requestId: "question", responseMode: "message", questions: [] }] });
  await expect(f.session.control("thread", f.session.controlAccessKey(), "answer", "question", "", [], "answer")).rejects.toThrow("Provider restarted.");
  const pending = f.session.control("thread", f.session.controlAccessKey(), "dismiss", "question", "", [], "dismiss");
  expect(f.command().payload).toEqual({ type: "thread.user-input.dismiss", commandId: "dismiss", threadId: "thread", requestId: "question" });
  f.accept(); expect(await pending).toEqual({ ok: true, error: "" });
});

test("permission rejection invalidates access and retains the authoritative pending request", async () => {
  const f = fixture(); f.authorize();
  f.snapshot({ runtimeRequests: [{ id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } }] });
  const key = f.session.controlAccessKey();
  const pending = f.session.control("thread", key, "approve", "request", "decline", [], "decline");
  f.session.receive(JSON.stringify({ _tag: "Exit", requestId: f.command().id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Permission denied for orchestration:operate" } }] } }));
  expect((await pending).ok).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
  expect(f.session.installControlAccess(key, { authenticated: true, permissions: ["orchestration:operate"] })).toBe(false);
  expect(f.session.controls("thread").requests.map(({ id, pending }) => ({ id, pending }))).toEqual([{ id: "request", pending: false }]);
});
