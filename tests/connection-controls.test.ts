import { expect, test } from "bun:test";
import { DirectSession } from "../connection";

function fixture() {
  const requests: { id: string; tag: string; payload: Record<string, unknown> }[] = [];
  const commandWaiters: ((payload: Record<string, unknown>) => void)[] = [];
  const session = new DirectSession({
    id: "env",
    label: "Mac",
    url: "http://localhost:13773",
    enabled: true,
    status: "Connecting",
    machineSymbol: "server.rack",
  });
  const open = () =>
    session.open({
      readyState: 1,
      bufferedAmount: 0,
      send(value) {
        const frame = JSON.parse(String(value));
        if (frame._tag === "Request") {
          requests.push(frame);
          if (frame.tag === "orchestration.dispatchCommand")
            commandWaiters.shift()?.(frame.payload);
        }
      },
      close() {},
    });
  const chunk = (tag: string, values: unknown[]) =>
    session.receive(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requests.findLast((request) => request.tag === tag)!.id,
        values,
      }),
    );
  const configure = (config: Record<string, unknown> = {}) =>
    chunk("subscribeServerConfig", [{ type: "snapshot", config }]);
  const shell = (fields: Record<string, unknown>) =>
    chunk("orchestration.subscribeShell", [
      { kind: "snapshot", snapshot: { projects: [], threads: [{ id: "thread", ...fields }] } },
    ]);
  open();
  configure();
  session.select("thread");
  let sequence = 10;
  const snapshot = (fields: Record<string, unknown> = {}) =>
    chunk("orchestration.subscribeThread", [
      {
        kind: "snapshot",
        snapshotSequence: sequence++,
        projection: {
          thread: { id: "thread" },
          turnItems: [],
          visibleTurnItems: [],
          runtimeRequests: [],
          runs: [],
          ...fields,
        },
      },
    ]);
  const event = (type: string, payload: unknown) =>
    chunk("orchestration.subscribeThread", [
      { kind: "event", sequence: sequence++, event: { threadId: "thread", type, payload } },
    ]);
  const command = () =>
    requests.findLast((request) => request.tag === "orchestration.dispatchCommand")!;
  const reply = (tag: string, exit: Record<string, unknown>) =>
    session.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: requests.findLast((request) => request.tag === tag)!.id,
        exit,
      }),
    );
  const accept = () =>
    reply("orchestration.dispatchCommand", { _tag: "Success", value: { sequence } });
  const authorize = () =>
    session.installControlAccess(session.controlAccessKey(), {
      authenticated: true,
      permissions: ["orchestration:operate"],
    });
  return {
    session,
    open,
    configure,
    shell,
    requests,
    snapshot,
    event,
    command,
    accept,
    authorize,
    reply,
    nextCommand: () =>
      new Promise<Record<string, unknown>>((resolve) => commandWaiters.push(resolve)),
  };
}

const approval = (id: string, supportsFeedback = false, type = "live") => ({
  id,
  kind: "command",
  status: "pending",
  responseCapability: { type, supportsFeedback },
});

test("composer feedback declines the captured request with trimmed text and never dispatches a message", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({ runtimeRequests: [approval("A", true)] });
  const pending = f.session.send("thread", "  Use a safer command  ", "send-A", "message-A");
  expect(f.command().payload).toEqual({
    type: "runtime-request.respond",
    commandId: "send-A:approval:A",
    threadId: "thread",
    requestId: "A",
    decision: "decline",
    feedback: "Use a safer command",
  });
  f.accept();
  expect(await pending).toEqual({ ok: true, error: "", state: "accepted" });
  expect(f.requests.filter((request) => request.payload.type === "message.dispatch")).toEqual([]);
});

test("approval feedback rejects empty text and attachments before responding", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({ runtimeRequests: [approval("A", true)] });
  expect(await f.session.send("thread", " ", "empty", "empty")).toMatchObject({
    ok: false,
    state: "rejected",
  });
  expect(
    await f.session.send("thread", "Feedback", "file", "file", null, [
      { type: "file", id: "file", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 },
    ]),
  ).toMatchObject({
    ok: false,
    error: "Send approval feedback without attachments or added context.",
  });
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand")).toEqual(
    [],
  );
});

test("redirect declines captured live approvals sequentially before steering the active run", async () => {
  const f = fixture();
  f.authorize();
  f.shell({ activeRunId: "run-A" });
  f.snapshot({
    runtimeRequests: [approval("stale", false, "not_resumable"), approval("A"), approval("B")],
  });
  const pending = f.session.send("thread", "Try something else", "redirect", "message");
  expect(f.command().payload).toMatchObject({
    type: "runtime-request.respond",
    requestId: "A",
    decision: "decline",
  });
  const next = f.nextCommand();
  f.accept();
  expect(await next).toMatchObject({
    type: "runtime-request.respond",
    requestId: "B",
    decision: "decline",
  });
  const message = f.nextCommand();
  f.accept();
  expect(await message).toMatchObject({
    type: "message.dispatch",
    dispatchMode: { type: "steer_active", targetRunId: "run-A" },
    deliveryIntent: "steer",
  });
  f.accept();
  expect(await pending).toEqual({ ok: true, error: "", state: "accepted" });
});

test.each(["failure", "new approval", "navigation", "draft edit"])(
  "approval redirect retains the draft after %s",
  async (cause) => {
    const f = fixture();
    f.authorize();
    f.snapshot({ runtimeRequests: [approval("A")] });
    let current = true;
    const pending = f.session.send("thread", "Redirect", "redirect", "message", null, [], false, {
      isCurrent: () => current,
    });
    expect(f.command().payload.type).toBe("runtime-request.respond");
    if (cause === "failure")
      f.reply("orchestration.dispatchCommand", {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { message: "Provider rejected response" } }],
      });
    else {
      if (cause === "new approval") f.event("runtime-request.updated", approval("B"));
      if (cause === "navigation") f.session.select("other");
      if (cause === "draft edit") current = false;
      f.accept();
    }
    expect(await pending).toMatchObject({ ok: false, state: "rejected" });
    expect(f.requests.filter((request) => request.payload.type === "message.dispatch")).toEqual([]);
  },
);

test("unknown feedback replay keeps its original response identity after resolution and reconnect", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({ runtimeRequests: [approval("A", true)] });
  const approvalSend = f.session.approvalSend("thread");
  const pending = f.session.send("thread", "Feedback", "feedback", "message", null, [], false, {
    approval: approvalSend,
  });
  const original = f.command().payload;
  f.session.disconnected("Disconnected");
  expect(await pending).toMatchObject({ ok: false, state: "unknown" });
  f.open();
  f.configure();
  f.authorize();
  f.snapshot();
  const retried = f.session.send("thread", "Feedback", "feedback", "message", null, [], true, {
    approval: approvalSend,
  });
  expect(f.command().payload).toEqual(original);
  f.accept();
  expect(await retried).toEqual({ ok: true, error: "", state: "accepted" });
  expect(f.requests.filter((request) => request.payload.type === "message.dispatch")).toEqual([]);
});

test("an active question bypasses approval redirect and a stale captured draft sends no responses", async () => {
  const f = fixture();
  f.authorize();
  f.shell({ activeRunId: "run-A" });
  f.snapshot({ runtimeRequests: [approval("A")] });
  expect(
    await f.session.send("thread", "Old draft", "old", "old", null, [], false, {
      isCurrent: () => false,
    }),
  ).toMatchObject({ ok: false, state: "rejected" });
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand")).toEqual(
    [],
  );
  f.snapshot({
    runtimeRequests: [
      approval("A"),
      {
        id: "question",
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    turnItems: [
      { id: "question-item", type: "user_input_request", requestId: "question", questions: [] },
    ],
  });
  const pending = f.session.send("thread", "Message", "send", "message");
  expect(f.command().payload).toMatchObject({
    type: "message.dispatch",
    dispatchMode: { type: "queue_after_active" },
  });
  f.accept();
  expect((await pending).ok).toBe(true);
});

test("unknown redirect replay reuses approval command receipts and the original message identity", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({ runtimeRequests: [approval("A")] });
  const plan = f.session.approvalSend("thread");
  const pending = f.session.send("thread", "Redirect", "redirect", "message", null, [], false, {
    approval: plan,
  });
  const response = f.command().payload;
  const dispatch = f.nextCommand();
  f.accept();
  const originalMessage = await dispatch;
  f.session.disconnected("Lost receipt");
  expect(await pending).toMatchObject({ ok: false, state: "unknown" });
  f.open();
  f.configure();
  f.authorize();
  f.snapshot();
  const retry = f.session.send("thread", "Redirect", "redirect", "message", null, [], true, {
    approval: plan,
  });
  expect(f.command().payload).toEqual(response);
  const resent = f.nextCommand();
  f.accept();
  expect(await resent).toEqual(originalMessage);
  f.accept();
  expect(await retry).toEqual({ ok: true, error: "", state: "accepted" });
});

function unresponsiveRun(runId = "A") {
  return {
    runs: [
      { id: runId, ordinal: 1, status: "waiting" },
      { id: "queued", ordinal: 99, status: "queued" },
    ],
    turnItems: [
      {
        id: `interrupt-${runId}`,
        type: "run_interrupt_request",
        runId,
        ordinal: 1,
        unresponsiveAt: "2026-11-10T00:00:00Z",
      },
    ],
  };
}

test("reconnect rejects an old HTTP grant even though the session owner survives", () => {
  const f = fixture();
  const key = f.session.controlAccessKey();
  f.session.disconnected("Disconnected");
  f.open();
  f.configure();
  expect(
    f.session.installControlAccess(key, {
      authenticated: true,
      permissions: ["orchestration:operate"],
    }),
  ).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
  expect(f.authorize()).toBe(true);
});

test("lifecycle actions use the displayed state and reject stale or unauthorized changes", async () => {
  const f = fixture();
  const now = "2026-11-11T10:00:00.000Z";
  const nowMs = Date.parse(now);
  const key = f.session.controlAccessKey();
  f.shell({ settledOverride: "settled" });
  await expect(f.session.lifecycle("thread", key, "unsettle", "no-access", nowMs)).rejects.toThrow(
    "permission",
  );
  f.authorize();
  await expect(f.session.lifecycle("thread", key, "unsettle", "not-loaded", nowMs)).rejects.toThrow(
    "reconnecting",
  );
  f.snapshot();
  expect(f.session.threadStatus("thread", nowMs, false)?.label).toBe("Settled");
  await expect(
    f.session.lifecycle("thread", "stale-key", "unsettle", "old-key", nowMs),
  ).rejects.toThrow("permission");
  await expect(
    f.session.lifecycle("other", key, "unsettle", "other-thread", nowMs),
  ).rejects.toThrow("reconnecting");
  await expect(f.session.lifecycle("thread", key, "wake", "stale", nowMs)).rejects.toThrow(
    "no longer",
  );
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand")).toEqual(
    [],
  );
  for (const [fields, action, payload] of [
    [{ settledOverride: "settled" }, "unsettle", { type: "thread.unsettle", reason: "user" }],
    [
      { snoozedUntil: "2026-11-11T11:00:00.000Z" },
      "wake",
      { type: "thread.unsnooze", reason: "user" },
    ],
    [{ snoozedUntil: now }, "dismiss", { type: "thread.visit", visitedAt: now }],
  ] as const) {
    f.shell(fields);
    const pending = f.session.lifecycle("thread", key, action, `command-${action}`, nowMs);
    expect(f.command().payload).toEqual({
      ...payload,
      commandId: `command-${action}`,
      threadId: "thread",
    });
    f.accept();
    expect(await pending).toEqual({ ok: true, error: "" });
  }
  f.shell({ settledOverride: "active" });
  await expect(f.session.lifecycle("thread", key, "unsettle", "now-active", nowMs)).rejects.toThrow(
    "no longer",
  );
  f.shell({ settledOverride: "settled", activityRunStartedAt: now });
  await expect(
    f.session.lifecycle("thread", key, "unsettle", "now-running", nowMs),
  ).rejects.toThrow("no longer");
  f.shell({ settledOverride: "settled" });
  const denied = f.session.lifecycle("thread", key, "unsettle", "denied", nowMs);
  f.session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: f.command().id,
      exit: {
        _tag: "Failure",
        cause: [
          { _tag: "Fail", error: { message: "Permission denied for orchestration:operate" } },
        ],
      },
    }),
  );
  expect((await denied).ok).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
});

test("stop owns the displayed run and stays stopping after acceptance until an event", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({
    runs: [
      { id: "A", ordinal: 1, status: "running" },
      { id: "queued", ordinal: 99, status: "queued" },
    ],
  });
  const key = f.session.controlAccessKey();
  const pending = f.session.control("thread", key, "stop", "A", "", [], "command-A");
  expect(f.command().payload).toEqual({
    type: "run.interrupt",
    commandId: "command-A",
    threadId: "thread",
    runId: "A",
    holdQueue: true,
  });
  expect(f.session.controls("thread").stop.state).toBe("stopping");
  f.accept();
  expect(await pending).toEqual({ ok: true, error: "" });
  expect(f.session.controls("thread").stop.state).toBe("stopping");
  f.event("turn-item.updated", {
    id: "interrupt-request",
    type: "run_interrupt_request",
    runId: "A",
    ordinal: 1,
    unresponsiveAt: "2026-11-10T00:00:00Z",
  });
  expect(f.session.controls("thread").stop.state).toBe("unresponsive");
  f.event("turn-item.updated", {
    id: "interrupt-result",
    type: "run_interrupt_result",
    runId: "A",
    ordinal: 2,
  });
  expect(f.session.controls("thread").stop.state).toBe("available");
  f.event("run.updated", { id: "A", ordinal: 1, status: "completed" });
  f.event("run.created", { id: "B", ordinal: 2, status: "running" });
  await expect(f.session.control("thread", key, "stop", "A", "", [], "late-A")).rejects.toThrow(
    "no longer",
  );
  expect(f.session.controls("thread").stop).toEqual({ runId: "B", state: "available", error: "" });
});

test("force stop requires access, capability, and the displayed unresponsive run", async () => {
  const f = fixture();
  const key = f.session.controlAccessKey();
  expect(f.session.canForceStop()).toBe(false);
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("permission");
  f.authorize();
  expect(f.session.canForceStop()).toBe(false);
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("support");
  f.configure({ environment: { capabilities: { threadForceStop: false } } });
  expect(f.session.canForceStop()).toBe(false);
  f.configure({ environment: { capabilities: { threadForceStop: true } } });
  expect(f.session.canForceStop()).toBe(true);
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("reconnecting");
  f.snapshot({ runs: [{ id: "A", ordinal: 1, status: "running" }] });
  await expect(f.session.forceStop("thread", "old-key", "A")).rejects.toThrow("permission");
  await expect(f.session.forceStop("other", key, "A")).rejects.toThrow("reconnecting");
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("unresponsive");
  f.snapshot(unresponsiveRun());
  await expect(f.session.forceStop("thread", key, "stale-run")).rejects.toThrow("no longer");
  expect(f.requests.filter((request) => request.tag === "orchestration.forceStopThread")).toEqual(
    [],
  );
  const pending = f.session.forceStop("thread", key, "A");
  expect(f.session.forceStopPending("thread")).toBe(true);
  expect(f.session.forceStopPending("other")).toBe(false);
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("already");
  expect(
    f.requests.filter((request) => request.tag === "orchestration.forceStopThread"),
  ).toMatchObject([{ payload: { threadId: "thread", runId: "A" } }]);
  f.reply("orchestration.forceStopThread", {
    _tag: "Failure",
    cause: [
      {
        _tag: "Fail",
        error: { _tag: "OrchestrationV2ForceStopThreadError", reason: "superseded" },
      },
    ],
  });
  await expect(pending).rejects.toThrow("A new turn started, so nothing was force stopped.");
  expect(f.session.forceStopPending("thread")).toBe(false);
  f.event("run.created", { id: "B", ordinal: 2, status: "running" });
  await expect(f.session.forceStop("thread", key, "A")).rejects.toThrow("no longer");
  expect(
    f.requests.filter((request) => request.tag === "orchestration.forceStopThread"),
  ).toHaveLength(1);
});

test.each(["killed", "released", "releasing", "shared"] as const)(
  "force stop preserves the %s result and shared thread IDs",
  async (outcome) => {
    const f = fixture();
    f.authorize();
    f.configure({ environment: { capabilities: { threadForceStop: true } } });
    f.snapshot(unresponsiveRun());
    const pending = f.session.forceStop("thread", f.session.controlAccessKey(), "A");
    const result = { outcome, sharedWithThreadIds: outcome === "shared" ? ["other"] : [] };
    f.reply("orchestration.forceStopThread", { _tag: "Success", value: result });
    await expect(pending).resolves.toEqual(result);
    expect(f.session.forceStopPending("thread")).toBe(false);
  },
);

test("force stop failures release pending state and revoke denied access without crossing reconnects", async () => {
  const f = fixture();
  f.authorize();
  f.configure({ environment: { capabilities: { threadForceStop: true } } });
  f.snapshot(unresponsiveRun());
  const denied = f.session.forceStop("thread", f.session.controlAccessKey(), "A");
  f.reply("orchestration.forceStopThread", {
    _tag: "Failure",
    cause: [{ _tag: "Fail", error: { message: "Permission denied for orchestration:operate" } }],
  });
  await expect(denied).rejects.toThrow("Permission denied");
  expect(f.session.forceStopPending("thread")).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
  expect(f.session.canForceStop()).toBe(false);
  f.authorize();
  const disconnected = f.session.forceStop("thread", f.session.controlAccessKey(), "A");
  f.session.disconnected("Disconnected");
  f.open();
  f.authorize();
  expect(f.session.canForceStop()).toBe(false);
  f.configure({ environment: { capabilities: { threadForceStop: true } } });
  f.snapshot(unresponsiveRun());
  const current = f.session.forceStop("thread", f.session.controlAccessKey(), "A");
  await expect(disconnected).rejects.toThrow("Disconnected");
  expect(f.session.forceStopPending("thread")).toBe(true);
  expect(f.session.canForceStop()).toBe(true);
  f.reply("orchestration.forceStopThread", { _tag: "Success", value: { outcome: "unexpected" } });
  await expect(current).rejects.toThrow("invalid force-stop response");
  expect(f.session.forceStopPending("thread")).toBe(false);
});

test("responses target the runtime request, suppress duplicate taps, and reject resolved requests", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({
    runtimeRequests: [
      { id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } },
    ],
    turnItems: [
      {
        id: "different-item",
        type: "approval_request",
        requestId: "request",
        options: [{ decision: "acceptAlways", label: "Always" }],
      },
    ],
  });
  const key = f.session.controlAccessKey();
  const pending = f.session.control(
    "thread",
    key,
    "approve",
    "request",
    "acceptAlways",
    [],
    "command",
  );
  expect(f.command().payload).toEqual({
    type: "runtime-request.respond",
    commandId: "command",
    threadId: "thread",
    requestId: "request",
    decision: "acceptAlways",
  });
  await expect(
    f.session.control("thread", key, "approve", "request", "acceptAlways", [], "duplicate"),
  ).rejects.toThrow("already");
  f.accept();
  await pending;
  expect(
    f.requests.filter((request) => request.tag === "orchestration.dispatchCommand").length,
  ).toBe(1);
  f.event("runtime-request.updated", { id: "request", status: "resolved" });
  await expect(
    f.session.control("thread", key, "approve", "request", "acceptAlways", [], "late"),
  ).rejects.toThrow("no longer");
});

test("question answers preserve exact values and resolved delivery failures remain in the feed", async () => {
  const f = fixture();
  f.configure({ environment: { capabilities: { fileAttachments: { maxUploadBytes: 1000 } } } });
  f.authorize();
  f.snapshot({
    runtimeRequests: [
      {
        id: "question",
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
      },
    ],
    turnItems: [
      {
        id: "item",
        type: "user_input_request",
        requestId: "question",
        questions: [
          {
            id: "__proto__",
            question: "Which?",
            options: [{ label: "First", value: " first " }],
            multiSelect: true,
          },
        ],
      },
    ],
  });
  const drafts = [
    {
      key: '["env","thread","question"]',
      questionId: "__proto__",
      selected: [" first ", " first "],
      custom: "",
      hasCustom: true,
      revision: 8,
    },
  ];
  const attachment = {
    type: "file",
    id: "file",
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
  };
  const attachmentsByQuestionId = Object.fromEntries([["__proto__", [attachment]]]);
  for (const invalid of [
    { missing: [attachment] },
    Object.fromEntries([["__proto__", [{ ...attachment, id: "" }]]]),
    Object.fromEntries([["__proto__", [{ ...attachment, sizeBytes: 1001 }]]]),
  ]) {
    await expect(
      f.session.control(
        "thread",
        f.session.controlAccessKey(),
        "answer",
        "question",
        "",
        drafts,
        "invalid",
        { attachmentsByQuestionId: invalid },
      ),
    ).rejects.toThrow();
  }
  const pending = f.session.control(
    "thread",
    f.session.controlAccessKey(),
    "answer",
    "question",
    "",
    drafts,
    "reply",
    { attachmentsByQuestionId },
  );
  expect(f.command().payload).toEqual({
    type: "runtime-request.respond",
    commandId: "reply",
    threadId: "thread",
    requestId: "question",
    answers: JSON.parse('{"__proto__":[" first "]}'),
    attachmentsByQuestionId,
  });
  f.accept();
  await pending;
  f.event("runtime-request.updated", { id: "question", status: "resolved" });
  f.event("turn-item.updated", {
    id: "delivery-failure",
    type: "error",
    ordinal: 3,
    title: "Answer delivery not confirmed",
    failure: { message: "Stop the turn and retry." },
  });
  expect(f.session.controls("thread").requests).toEqual([]);
  expect(f.session.timeline("thread").map((row) => row.item.title)).toEqual([
    "Answer delivery not confirmed",
  ]);
  expect(drafts).toEqual([
    {
      key: '["env","thread","question"]',
      questionId: "__proto__",
      selected: [" first ", " first "],
      custom: "",
      hasCustom: true,
      revision: 8,
    },
  ]);
});

test("message-mode requests can be dismissed even when answering is no longer resumable", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({
    runtimeRequests: [
      {
        id: "question",
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Provider restarted." },
      },
    ],
    turnItems: [
      {
        id: "item",
        type: "user_input_request",
        requestId: "question",
        responseMode: "message",
        questions: [],
      },
    ],
  });
  await expect(
    f.session.control(
      "thread",
      f.session.controlAccessKey(),
      "answer",
      "question",
      "",
      [],
      "answer",
    ),
  ).rejects.toThrow("Provider restarted.");
  const pending = f.session.control(
    "thread",
    f.session.controlAccessKey(),
    "dismiss",
    "question",
    "",
    [],
    "dismiss",
  );
  expect(f.command().payload).toEqual({
    type: "thread.user-input.dismiss",
    commandId: "dismiss",
    threadId: "thread",
    requestId: "question",
  });
  f.accept();
  expect(await pending).toEqual({ ok: true, error: "" });
});

test("permission rejection invalidates access and retains the authoritative pending request", async () => {
  const f = fixture();
  f.authorize();
  f.snapshot({
    runtimeRequests: [
      { id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } },
    ],
  });
  const key = f.session.controlAccessKey();
  const pending = f.session.control("thread", key, "approve", "request", "decline", [], "decline");
  f.session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: f.command().id,
      exit: {
        _tag: "Failure",
        cause: [
          { _tag: "Fail", error: { message: "Permission denied for orchestration:operate" } },
        ],
      },
    }),
  );
  expect((await pending).ok).toBe(false);
  expect(f.session.hasControlAccess()).toBe(false);
  expect(
    f.session.installControlAccess(key, {
      authenticated: true,
      permissions: ["orchestration:operate"],
    }),
  ).toBe(false);
  expect(f.session.controls("thread").requests.map(({ id, pending }) => ({ id, pending }))).toEqual(
    [{ id: "request", pending: false }],
  );
});

test("forks an inherited assistant response using its source identity and current control grant", async () => {
  const f = fixture();
  f.shell({ title: "Displayed child" });
  const rowId = JSON.stringify(["ancestor", "answer"]);
  const response = {
    position: 0,
    visibility: "inherited",
    sourceThreadId: "ancestor",
    sourceItemId: "answer",
    item: {
      id: "answer",
      threadId: "ancestor",
      type: "assistant_message",
      status: "completed",
      runId: "source-run",
      text: "Done",
      updatedAt: "2026-11-11T08:00:00Z",
    },
  };
  f.snapshot({ visibleTurnItems: [response] });
  const key = f.session.controlAccessKey();
  await expect(f.session.fork("thread", rowId, key, "no-access", "target")).rejects.toThrow(
    "permission",
  );
  f.authorize();
  await expect(f.session.fork("thread", rowId, "old-key", "old-access", "target")).rejects.toThrow(
    "permission",
  );
  await expect(f.session.fork("other", rowId, key, "wrong-thread", "target")).rejects.toThrow(
    "reconnecting",
  );
  await expect(
    f.session.fork("thread", JSON.stringify(["thread", "answer"]), key, "wrong-row", "target"),
  ).rejects.toThrow("no longer");
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand")).toEqual(
    [],
  );
  const fork = f.session.fork("thread", rowId, key, "fork-command", "target");
  expect(f.command().payload).toEqual({
    type: "thread.fork",
    commandId: "fork-command",
    createdBy: "user",
    creationSource: "mobile",
    sourceThreadId: "ancestor",
    targetThreadId: "target",
    sourcePoint: { type: "run", runId: "source-run" },
    title: "Displayed child fork",
  });
  f.accept();
  await expect(fork).resolves.toEqual({ ok: true, error: "" });
  f.snapshot({
    visibleTurnItems: [{ ...response, item: { ...response.item, status: "running" } }],
  });
  await expect(f.session.fork("thread", rowId, key, "stale-row", "next")).rejects.toThrow(
    "no longer",
  );
  f.snapshot({ visibleTurnItems: [response] });
  const denied = f.session.fork("thread", rowId, key, "denied", "next");
  f.session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: f.command().id,
      exit: {
        _tag: "Failure",
        cause: [
          { _tag: "Fail", error: { message: "Permission denied for orchestration:operate" } },
        ],
      },
    }),
  );
  await expect(denied).resolves.toEqual({
    ok: false,
    error: "Permission denied for orchestration:operate",
  });
  expect(f.session.hasControlAccess()).toBe(false);
});

test("uses cached source capability evidence for inherited fork availability and execution", async () => {
  const f = fixture();
  f.shell({ title: "Child" });
  f.authorize();
  const source = {
    position: 0,
    visibility: "local",
    sourceThreadId: "ancestor",
    sourceItemId: "answer",
    item: {
      id: "answer",
      threadId: "ancestor",
      type: "assistant_message",
      status: "completed",
      runId: "run",
      providerThreadId: "provider-thread",
      text: "Done",
      updatedAt: "2026-11-11T08:00:00Z",
    },
  };
  f.session.select("ancestor");
  f.snapshot({
    thread: { id: "ancestor" },
    visibleTurnItems: [source],
    providerThreads: [{ id: "provider-thread", providerSessionId: "provider-session" }],
    providerSessions: [
      {
        id: "provider-session",
        capabilities: {
          threads: { canForkThread: false, canForkFromTurn: false },
          identity: { nativeThreadIds: "weak" },
          context: { supportsFullThreadHandoff: false },
        },
      },
    ],
  });
  f.session.select("thread");
  f.snapshot({ visibleTurnItems: [{ ...source, visibility: "inherited" }] });
  expect(f.session.threads()[0]?.rows.find((row) => row.message)?.message?.canFork).toBe(false);
  await expect(
    f.session.fork(
      "thread",
      JSON.stringify(["ancestor", "answer"]),
      f.session.controlAccessKey(),
      "unsupported",
      "target",
    ),
  ).rejects.toThrow("no longer");
  expect(f.requests.filter((request) => request.tag === "orchestration.dispatchCommand")).toEqual(
    [],
  );
});
