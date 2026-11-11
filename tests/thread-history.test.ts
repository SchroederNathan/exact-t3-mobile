import { expect, test } from "bun:test";
import {
  ThreadHistory,
  type HistoryRecord,
  type TimelineRow,
} from "../thread-history";

const stamp = (seconds: number) => `2026-11-10T12:00:${String(seconds).padStart(2, "0")}Z`;
const key = (id: string, source = "thread") => JSON.stringify([source, id]);
function row(id: string, type: string, fields: HistoryRecord = {}, source = "thread"): TimelineRow {
  return {
    position: 0,
    visibility: source === "thread" ? "local" : "inherited",
    sourceThreadId: source,
    sourceItemId: id,
    item: {
      id,
      threadId: source,
      type,
      runId: "run",
      nodeId: null,
      status: "completed",
      text: id,
      input: "pwd",
      updatedAt: stamp(5),
      ...fields,
    },
  };
}
function history(rows: TimelineRow[], runs: HistoryRecord[] = [], extra: HistoryRecord = {}) {
  const result = new ThreadHistory("thread");
  result.install({ snapshotSequence: 1, projection: { visibleTurnItems: rows, runs, ...extra } });
  return result;
}
const running = { id: "run", status: "running", startedAt: stamp(0), completedAt: null };
const completed = { ...running, status: "completed", completedAt: stamp(20) };

test("groups only within the same source, run, attempt and visible activity segment", () => {
  const h = history(
    [
      row("a", "command_execution", { nodeId: "child-a" }),
      row("b", "command_execution", { nodeId: "root-a" }),
      row("thought", "reasoning", { nodeId: "child-a" }),
      row("c", "command_execution", { nodeId: "root-b" }),
      row("d", "command_execution", { runId: "other" }),
      row("e", "command_execution", { runId: "other" }, "ancestor"),
      row("notice", "notification", { runId: "other" }, "ancestor"),
      row("f", "command_execution", { runId: "other" }, "ancestor"),
    ],
    [running, { ...running, id: "other" }],
    {
      attempts: [
        { id: "attempt-a", runId: "run", rootNodeId: "root-a" },
        { id: "attempt-b", runId: "run", rootNodeId: "root-b" },
      ],
      nodes: [{ id: "child-a", rootNodeId: "root-a", parentNodeId: "root-a" }],
    },
  );
  expect(
    h
      .feed()
      .filter((entry) => entry.activity?.category !== "run-fold")
      .map((entry) => entry.activity?.groupCount),
  ).toEqual([3, 1, 1, 1, 1]);
  expect(h.feed()[0]?.activity?.grouped.map((child) => child.id)).toEqual([
    key("a"),
    key("b"),
    key("thought"),
  ]);
  expect(h.feed()[0]?.activity?.grouped[0]).toEqual({
    id: key("a"),
    category: "command",
    status: "completed",
    title: "pwd",
    displayTitle: "pwd",
    live: false,
    symbol: "terminal",
    revision: stamp(5),
    exitLabel: "",
  });
});

test("inherited grouped children retain their source keys for lazy output requests", () => {
  const h = history([
    row("a", "command_execution", {}, "ancestor"),
    row("b", "command_execution", {}, "ancestor"),
  ]);
  const activity = h.feed().find((entry) => entry.activity?.groupCount === 2)?.activity;
  expect(activity?.grouped.map((child) => child.id)).toEqual([
    key("a", "ancestor"),
    key("b", "ancestor"),
  ]);
  expect(activity?.grouped.every((child) => h.row(child.id)?.sourceThreadId === "ancestor")).toBe(
    true,
  );
});

test.each([
  {
    types: ["command_execution", "command_execution"],
    title: "Ran 2 commands",
    symbol: "terminal",
  },
  {
    types: ["file_change", "file_change"],
    title: "Changed 1 file",
    symbol: "square.and.pencil",
  },
  {
    types: ["file_search", "file_search"],
    title: "Searched code 2 times",
    symbol: "magnifyingglass",
  },
  {
    types: ["web_search", "web_search"],
    title: "Searched the web 2 times",
    symbol: "globe",
  },
  {
    types: ["command_execution", "file_change"],
    title: "Ran 1 command and changed 1 file",
    symbol: "hammer",
  },
  {
    types: ["dynamic_tool", "dynamic_tool"],
    title: "Used 2 tools",
    symbol: "hammer",
  },
  { types: ["file_change"], title: "Changed 1 file", symbol: "square.and.pencil" },
  { types: ["command_execution"], title: "pwd", symbol: "terminal" },
  { types: ["reasoning"], title: "Thought", symbol: "brain" },
  { types: ["reasoning", "reasoning"], title: "Thought (×2)", symbol: "brain" },
  {
    types: ["reasoning", "command_execution", "reasoning"],
    title: "Ran 1 command",
    symbol: "terminal",
  },
])("completed tool summaries match Expo: $types", ({ types, title, symbol }) => {
  const h = history(
    types.map((type, index) => row(String(index), type, { runId: null, fileName: "app.ts" })),
  );
  expect(h.feed()[0]?.activity).toMatchObject({ displayTitle: title, symbol, live: false });
  expect(h.feed()[0]?.activity?.groupCount).toBe(types.length);
  if (types.length > 1)
    expect(h.feed()[0]?.activity?.grouped.map((child) => child.id)).toEqual(
      types.map((_, index) => key(String(index))),
    );
});

test("folds completed commentary and tools while retaining the final answer and user steering", () => {
  const h = history(
    [
      row("prompt", "user_message", { updatedAt: stamp(0) }),
      row("commentary", "assistant_message", { updatedAt: stamp(2) }),
      row("a", "command_execution"),
      row("steer", "user_message", { inputIntent: "steer", updatedAt: stamp(6) }),
      row("b", "command_execution"),
      row("answer", "assistant_message", { updatedAt: stamp(20) }),
    ],
    [completed],
  );
  const feed = h.feed();
  const fold = feed.find((entry) => entry.activity?.category === "run-fold");
  expect(fold?.activity?.displayTitle).toBe("Worked for 20s");
  expect(feed.filter((entry) => entry.foldId === "").map((entry) => entry.id)).toEqual([
    key("prompt"),
    fold!.id,
    key("steer"),
    key("answer"),
  ]);
  expect(feed.filter((entry) => entry.foldId === fold?.id).map((entry) => entry.id)).toEqual([
    key("commentary"),
    key("a"),
    key("b"),
  ]);
  expect(feed.filter((entry) => entry.message?.showAssistantMeta).map((entry) => entry.id)).toEqual(
    [key("answer")],
  );
  expect(feed.filter((entry) => entry.message?.canFork).map((entry) => entry.id)).toEqual([
    key("answer"),
  ]);
});

test.each([
  { run: running, end: {} },
  { run: { ...completed, status: "failed" }, end: {} },
  { run: completed, end: { type: "error", status: "failed", parentItemId: null } },
  { run: completed, end: { type: "run_interrupt_result" } },
  { run: completed, end: { streaming: true } },
])("keeps active, failed, interrupted and streaming response work unfolded: %j", ({ run, end }) => {
  const h = history(
    [
      row("prompt", "user_message"),
      row("a", "command_execution"),
      row("b", "command_execution"),
      row("answer", "assistant_message", end),
    ],
    [run],
  );
  expect(h.feed().some((entry) => entry.activity?.category === "run-fold")).toBe(false);
  expect(h.feed().every((entry) => entry.foldId === "")).toBe(true);
  expect(
    h
      .feed()
      .filter((entry) => entry.message?.showAssistantMeta)
      .map((entry) => entry.id),
  ).toEqual(run.status === "failed" ? [key("answer")] : []);
});

test("a run completion invalidates the cached feed and folds prior work", () => {
  const h = history([row("a", "command_execution"), row("answer", "assistant_message")], [running]);
  expect(h.feed().some((entry) => entry.activity?.category === "run-fold")).toBe(false);
  expect(h.feed().find((entry) => entry.id === key("answer"))?.message?.showAssistantMeta).toBe(
    false,
  );
  expect(h.feed().find((entry) => entry.id === key("answer"))?.message?.canFork).toBe(false);
  h.apply({
    kind: "event",
    sequence: 2,
    event: { type: "run.updated", threadId: "thread", payload: completed },
  });
  expect(h.feed().some((entry) => entry.activity?.category === "run-fold")).toBe(true);
  expect(h.feed().find((entry) => entry.id === key("answer"))?.message?.showAssistantMeta).toBe(
    true,
  );
});

test("live group uses the latest active command and successful retries clear old failures", () => {
  const h = history(
    [
      row("edit", "file_change", { fileName: "app.ts" }),
      row("failed", "command_execution", { status: "failed", exitCode: 1 }),
      row("active", "command_execution", { status: "running", input: "pwd" }),
    ],
    [running],
  );
  expect(h.feed()[0]?.activity).toMatchObject({
    status: "running",
    live: true,
    displayTitle: "Running pwd",
    symbol: "terminal",
  });
  const settled = history([
    row("failed", "command_execution", { status: "failed", exitCode: 1, runId: null }),
    row("success", "command_execution", { runId: null }),
    row("thought", "reasoning", { runId: null }),
  ]);
  expect(settled.feed()[0]?.activity).toMatchObject({
    status: "completed",
    live: false,
    displayTitle: "Ran 2 commands",
  });
  const failed = history([
    row("failed", "command_execution", { status: "failed", exitCode: 1, runId: null }),
    row("thought", "reasoning", { runId: null }),
  ]);
  expect(failed.feed()[0]?.activity).toMatchObject({
    status: "error",
    live: false,
    displayTitle: "Ran 1 command",
    symbol: "terminal",
    groupCount: 2,
  });
});

test("empty assistant placeholders preserve contiguous work while failed runs reveal individual calls", () => {
  const rows = [
    row("a", "command_execution"),
    row("empty", "assistant_message", { text: "" }),
    row("b", "command_execution"),
  ];
  expect(
    history(rows, [running])
      .feed()
      .map((entry) => entry.activity?.groupCount),
  ).toEqual([2]);
  expect(
    history(rows, [{ ...completed, status: "failed" }])
      .feed()
      .map((entry) => entry.activity?.groupCount),
  ).toEqual([1, 1]);
});

test("runless history folds each response but never hides unfinished calls", () => {
  const prompt = row("prompt", "user_message", { runId: null, updatedAt: stamp(0) });
  const active = history([
    prompt,
    row("a", "command_execution", { runId: null, status: "running" }),
  ]);
  expect(active.feed().some((entry) => entry.activity?.category === "run-fold")).toBe(false);
  const settled = history([
    prompt,
    row("a", "command_execution", { runId: null }),
    row("answer", "assistant_message", { runId: null }),
  ]);
  expect(
    settled
      .feed()
      .filter((entry) => entry.foldId === "")
      .map((entry) => entry.message?.role ?? entry.activity?.category),
  ).toEqual(["user", "run-fold", "assistant"]);
  expect(
    settled.feed().find((entry) => entry.message?.role === "assistant")?.message?.showAssistantMeta,
  ).toBe(false);
});

test("assistant metadata follows terminal source messages and their final update time", () => {
  const earlier = "2026-11-10T12:00:00";
  const later = "2026-11-10T12:01:00";
  const h = history(
    [
      row("prompt", "user_message", { startedAt: earlier, updatedAt: later }),
      row("inherited", "assistant_message", {}, "ancestor"),
      row("commentary", "assistant_message"),
      row("answer", "assistant_message", { startedAt: earlier, updatedAt: later }),
      row("stream", "assistant_message", { runId: "stream", streaming: true }),
    ],
    [completed],
  );
  expect(
    h
      .feed()
      .filter((entry) => entry.message?.showAssistantMeta)
      .map((entry) => entry.id),
  ).toEqual([key("inherited", "ancestor"), key("answer")]);
  expect(h.feed().find((entry) => entry.id === key("prompt"))?.message?.timeLabel).toMatch(
    /^12:00/,
  );
  expect(h.feed().find((entry) => entry.id === key("answer"))?.message?.timeLabel).toMatch(
    /^12:01/,
  );
});

test("attaches ready checkpoints once and updates them after delayed checkpoint and message events", () => {
  const checkpoint = {
    id: "checkpoint",
    threadId: "thread",
    runId: "run",
    appRunOrdinal: 3,
    status: "ready",
    files: [{ path: "app.ts", additions: 12, deletions: 4 }],
  };
  const h = history(
    [
      row("command", "command_execution"),
      row("answer", "assistant_message", { messageId: "message" }),
    ],
    [completed],
    { messages: [{ id: "message", role: "assistant", runId: "run" }] },
  );
  h.apply({
    kind: "event",
    sequence: 2,
    event: { type: "checkpoint.captured", threadId: "thread", payload: checkpoint },
  });
  const changes = {
    threadId: "thread",
    checkpointId: "checkpoint",
    turnCount: 3,
    fileCount: 1,
    additions: 12,
    deletions: 4,
    additionsLabel: "12",
    deletionsLabel: "4",
  };
  expect(
    h
      .feed()
      .filter((row) => row.changes)
      .map((row) => [row.activity?.category, row.changes]),
  ).toEqual([["run-fold", changes]]);
  expect(h.feed().find((row) => row.message)?.changes).toBeNull();
  h.apply({
    kind: "event",
    sequence: 3,
    event: {
      type: "checkpoint.captured",
      threadId: "thread",
      payload: { ...checkpoint, status: "stale" },
    },
  });
  expect(h.feed().filter((row) => row.changes)).toEqual([]);
  const plain = history(
    [row("answer", "assistant_message", { messageId: "message" })],
    [completed],
    { checkpoints: [checkpoint] },
  );
  expect(plain.feed().filter((row) => row.changes)).toEqual([]);
  plain.apply({
    kind: "event",
    sequence: 2,
    event: {
      type: "message.updated",
      threadId: "thread",
      payload: { id: "message", role: "assistant", runId: "run" },
    },
  });
  expect(plain.feed().find((row) => row.message)?.changes).toEqual(changes);
});

test.each([
  { status: "missing", files: [{ path: "a", additions: 1, deletions: 0 }], source: "thread" },
  { status: "ready", files: [], source: "thread" },
  { status: "ready", files: [{ path: "a", additions: 1, deletions: 0 }], source: "ancestor" },
])(
  "does not invent checkpoint changes for unavailable, empty, or inherited work ($status, $source)",
  ({ status, files, source }) => {
    const h = history(
      [row("answer", "assistant_message", { messageId: "message" }, source)],
      [completed],
      {
        messages: [{ id: "message", role: "assistant", runId: "run" }],
        checkpoints: [
          { id: "checkpoint", threadId: "thread", runId: "run", appRunOrdinal: 1, status, files },
        ],
      },
    );
    expect(h.feed().filter((row) => row.changes)).toEqual([]);
  },
);

const nativeForkCapabilities = {
  threads: { canForkThread: true, canForkFromTurn: true },
  identity: { nativeThreadIds: "strong" },
  context: { supportsFullThreadHandoff: false },
};

test.each([
  { name: "unknown", capabilities: undefined, allowed: true },
  { name: "native", capabilities: nativeForkCapabilities, allowed: true },
  {
    name: "weak native identity",
    capabilities: { ...nativeForkCapabilities, identity: { nativeThreadIds: "weak" } },
    allowed: false,
  },
  {
    name: "no turn fork",
    capabilities: {
      ...nativeForkCapabilities,
      threads: { canForkThread: true, canForkFromTurn: false },
    },
    allowed: false,
  },
  {
    name: "no thread fork",
    capabilities: {
      ...nativeForkCapabilities,
      threads: { canForkThread: false, canForkFromTurn: true },
    },
    allowed: false,
  },
  {
    name: "portable",
    capabilities: { context: { supportsFullThreadHandoff: true } },
    allowed: true,
  },
  { name: "known incapable", capabilities: {}, allowed: false },
])("fork eligibility follows $name capability evidence", ({ capabilities, allowed }) => {
  const h = history(
    [row("answer", "assistant_message", { providerThreadId: "provider-thread" })],
    [completed],
    {
      providerThreads: [{ id: "provider-thread", providerSessionId: "provider-session" }],
      providerSessions: [{ id: "provider-session", capabilities }],
    },
  );
  expect(h.feed().find((entry) => entry.id === key("answer"))?.message?.canFork).toBe(allowed);
  expect(h.forkPoint(key("answer"))).toEqual(
    allowed ? { sourceThreadId: "thread", runId: "run" } : null,
  );
});

test("fork targets use the visible source row and ignore unrelated provider records", () => {
  const inherited = row(
    "answer",
    "assistant_message",
    { providerThreadId: "stale-provider" },
    "ancestor",
  );
  const source = new ThreadHistory("ancestor");
  const snapshot = {
    projection: {
      visibleTurnItems: [
        {
          ...inherited,
          visibility: "local",
          item: { ...inherited.item, providerThreadId: "provider-thread" },
        },
      ],
      providerThreads: [{ id: "provider-thread", providerSessionId: "provider-session" }],
      providerSessions: [{ id: "provider-session", capabilities: {} }],
    },
  };
  source.install(snapshot);
  const h = history([inherited], [], {
    providerThreads: snapshot.projection.providerThreads,
    providerSessions: snapshot.projection.providerSessions,
  });
  const point = { sourceThreadId: "ancestor", runId: "run" };
  expect(h.forkPoint(key("answer", "ancestor"))).toEqual(point);
  expect(h.forkPoint(key("answer", "ancestor"), history([]))).toEqual(point);
  expect(h.forkPoint(key("answer", "ancestor"), source)).toBeNull();
  source.install({
    projection: {
      providerThreads: snapshot.projection.providerThreads,
      providerSessions: snapshot.projection.providerSessions,
    },
  });
  expect(h.forkPoint(key("answer", "ancestor"), source)).toEqual(point);
  expect(h.forkPoint(key("answer"), source)).toBeNull();
});

test("provider updates refresh fork visibility and detaching restores the portable fallback", () => {
  const h = history(
    [row("answer", "assistant_message", { providerThreadId: "provider-thread" })],
    [completed],
  );
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(true);
  const update = (sequence: number, type: string, payload: HistoryRecord) =>
    h.apply({ kind: "event", sequence, event: { threadId: "thread", type, payload } });
  update(2, "provider-session.attached", { id: "provider-session", capabilities: {} });
  update(3, "provider-thread.updated", {
    id: "provider-thread",
    providerSessionId: "provider-session",
  });
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(false);
  update(4, "provider-session.updated", {
    id: "provider-session",
    capabilities: nativeForkCapabilities,
  });
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(true);
  update(5, "provider-thread.updated", {
    id: "provider-thread",
    providerSessionId: "other-session",
  });
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(true);
  update(6, "provider-session.updated", { id: "other-session", capabilities: {} });
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(false);
  update(7, "provider-session.detached", { providerSessionId: "other-session" });
  expect(h.feed().find((entry) => entry.message)?.message?.canFork).toBe(true);
  h.remove();
  expect(h.forkPoint(key("answer"))).toBeNull();
  expect(h.feed()).toEqual([]);
});

test.each([
  { type: "assistant_message", fields: { status: "running" } },
  { type: "assistant_message", fields: { status: "pending" } },
  { type: "assistant_message", fields: { streaming: true } },
  { type: "assistant_message", fields: { runId: null } },
  { type: "assistant_message", fields: { runId: "" } },
  { type: "user_message", fields: {} },
  { type: "command_execution", fields: {} },
])("does not fork ineligible visible rows ($type $fields)", ({ type, fields }) => {
  const h = history([row("item", type, fields)], [completed]);
  expect(h.forkPoint(key("item"))).toBeNull();
  expect(h.feed().some((entry) => entry.message?.canFork)).toBe(false);
});
