import { expect, test } from "bun:test";
import { emptyControls } from "../thread-controls";
import {
  formatWorkingDuration,
  projectThreadStatus,
  threadIsCompacting,
  threadLifecycleStatus,
  threadWorkStartedAt,
  type ThreadStatusInput,
} from "../thread-status";

const start = "2026-11-11T10:00:00.000Z";
const input = (patch: Partial<ThreadStatusInput> = {}): ThreadStatusInput => ({
  connection: { phase: "connected", label: "Mac mini", error: null },
  history: { ready: true, synchronized: true, error: "" },
  controls: emptyControls(),
  startedAt: null,
  compacting: false,
  stopping: false,
  nowMs: Date.parse(start) + 65_000,
  ...patch,
});

test("completed threads have no status and working timers match Expo without shimmer", () => {
  expect(projectThreadStatus(input())).toBeNull();
  const settled = { state: "settled" } as const;
  expect(projectThreadStatus(input({ lifecycle: settled }))).toEqual({
    kind: "lifecycle",
    label: "Settled",
    symbol: "checkmark.circle",
    indicator: "none",
    action: "unsettle",
    actionLabel: "Un-settle",
    actionPendingLabel: "Un-settling...",
    ticking: false,
  });
  expect(projectThreadStatus(input({ lifecycle: settled, startedAt: start }))?.kind).toBe(
    "working",
  );
  expect(projectThreadStatus(input({ startedAt: start }))).toEqual({
    kind: "working",
    label: "Working 1m 05s",
    symbol: "",
    indicator: "none",
    action: "none",
    ticking: true,
  });
  expect(
    [0, 999, 59_999, 60_000, 65_000, 3_600_000, 3_665_000].map((elapsed) =>
      formatWorkingDuration(start, Date.parse(start) + elapsed),
    ),
  ).toEqual(["0s", "0s", "59s", "1m 00s", "1m 05s", "1h", "1h 1m 5s"]);
  expect(formatWorkingDuration("invalid", Date.parse(start))).toBe("0s");
  expect(formatWorkingDuration(start, Date.parse(start) - 1_000)).toBe("0s");
});

test("lifecycle labels follow snooze expiration, seen wakes, and explicit settlement", () => {
  const nowMs = Date.parse(start);
  const snoozedUntil = "2026-11-11T11:01:00.000Z";
  const snoozedAt = "2026-11-11T09:00:00.000Z";
  const shell = { settledOverride: "settled", snoozedAt, snoozedUntil };
  const lifecycle = threadLifecycleStatus(shell, nowMs);
  expect(lifecycle).toEqual({ state: "snoozed", until: snoozedUntil });
  expect(projectThreadStatus(input({ lifecycle, nowMs }))).toEqual({
    kind: "lifecycle",
    label: "Snoozed, wakes in 2h",
    symbol: "clock",
    indicator: "none",
    action: "wake",
    actionLabel: "Wake now",
    actionPendingLabel: "Waking...",
    ticking: true,
  });
  for (const [until, label] of [
    ["2026-11-11T10:00:01.000Z", "Snoozed, wakes in 1m"],
    ["2026-11-11T10:59:59.000Z", "Snoozed, wakes in 60m"],
    ["2026-11-12T10:00:00.000Z", "Snoozed, wakes in 1d"],
  ]) {
    expect(
      projectThreadStatus(input({ lifecycle: { state: "snoozed", until }, nowMs }))?.label,
    ).toBe(label);
  }
  expect(threadLifecycleStatus({ ...shell, snoozedUntil: start }, nowMs)).toEqual({
    state: "settled",
  });
  const woke = { ...shell, settledOverride: null, snoozedUntil: start };
  expect(threadLifecycleStatus(woke, nowMs)).toEqual({ state: "woke", at: start });
  expect(
    projectThreadStatus(input({ lifecycle: threadLifecycleStatus(woke, nowMs), nowMs })),
  ).toEqual({
    kind: "lifecycle",
    label: "Woke from snooze",
    symbol: "clock",
    indicator: "none",
    action: "dismiss",
    actionLabel: "Dismiss",
    actionPendingLabel: "Dismissing...",
    actionTimestamp: start,
    ticking: false,
  });
  for (const seen of [{ lastVisitedAt: start }, { latestRunCompletedAt: start }]) {
    expect(threadLifecycleStatus({ ...woke, ...seen }, nowMs)).toBeNull();
  }
  expect(threadLifecycleStatus({ snoozedUntil: "invalid" }, nowMs)).toBeNull();
  expect(
    threadLifecycleStatus({ ...shell, pendingBackgroundTasks: [{ taskId: "task" }] }, nowMs),
  ).toBeNull();
  const question = { kind: "user_input", createdAt: snoozedAt };
  expect(
    threadLifecycleStatus({ ...woke, snoozedUntil, pendingRuntimeRequest: question }, nowMs),
  ).toEqual({ state: "snoozed", until: snoozedUntil });
  expect(
    threadLifecycleStatus(
      { ...woke, snoozedUntil, pendingRuntimeRequest: { ...question, createdAt: start } },
      nowMs,
    ),
  ).toEqual({ state: "woke", at: start });
  expect(
    threadLifecycleStatus(
      { ...woke, snoozedUntil, status: "failed", latestRunCompletedAt: start },
      nowMs,
    ),
  ).toBeNull();
  expect(
    threadLifecycleStatus(
      {
        snoozedUntil,
        snoozedAt,
        status: "failed",
        latestRunId: "run",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: snoozedUntil,
        latestRunCompletedAt: snoozedAt,
        limitRecovery: { runId: "run", resetAt: snoozedUntil, snooze: true },
      },
      nowMs,
    ),
  ).toBeNull();
});

test("Stop takes precedence over a pending approval and a connection error takes precedence over Stop", () => {
  const controls = { ...emptyControls(), requests: [{ kind: "approval" }] };
  controls.stop = { runId: "run", state: "stopping", error: "" };
  expect(projectThreadStatus(input({ controls, startedAt: start }))).toEqual({
    kind: "stop",
    label: "Stopping…",
    symbol: "",
    indicator: "spinner",
    action: "none",
    ticking: false,
  });
  controls.stop.state = "unresponsive";
  expect(projectThreadStatus(input({ controls, startedAt: start }))).toEqual({
    kind: "stop",
    label: "Not responding to Stop",
    symbol: "exclamationmark.triangle",
    indicator: "none",
    action: "none",
    ticking: false,
  });
  expect(
    projectThreadStatus(
      input({
        controls,
        connection: { phase: "error", label: "Mac mini", error: "Session expired" },
      }),
    ),
  ).toEqual({
    kind: "connection",
    label: "Failed to connect to Mac mini: Session expired",
    symbol: "",
    indicator: "unavailable",
    action: "reconnect",
    ticking: false,
  });
  controls.stop.state = "available";
  expect(projectThreadStatus(input({ controls, startedAt: start }))).toBeNull();
  expect(projectThreadStatus(input({ controls, startedAt: start, stopping: true }))?.label).toBe(
    "Stopping…",
  );
});

test("sync and compacting statuses supersede the working timer without claiming completion", () => {
  expect(
    projectThreadStatus(
      input({
        startedAt: start,
        compacting: true,
        history: { ready: true, synchronized: false, error: "" },
      }),
    ),
  ).toEqual({
    kind: "syncing",
    label: "Syncing messages...",
    symbol: "",
    indicator: "spinner",
    action: "none",
    ticking: false,
  });
  expect(
    projectThreadStatus(input({ history: { ready: false, synchronized: false, error: "" } }))
      ?.label,
  ).toBe("Loading messages...");
  expect(projectThreadStatus(input({ startedAt: start, compacting: true }))).toEqual({
    kind: "compacting",
    label: "Compacting…",
    symbol: "arrow.down.right.and.arrow.up.left",
    indicator: "none",
    action: "none",
    ticking: false,
  });
  expect(
    projectThreadStatus(
      input({
        startedAt: start,
        history: { ready: false, synchronized: false, error: "Could not load thread" },
      }),
    ),
  ).toBeNull();
});

test("connection statuses preserve the environment and retry reason", () => {
  for (const [phase, error, label] of [
    ["connecting", null, "Reconnecting to Mac mini..."],
    ["reconnecting", "Timeout", "Failed to connect. Retrying Mac mini..."],
    ["offline", null, "You are offline"],
    ["unsupported", null, "Client not supported"],
    ["available", null, "Mac mini is not connected"],
    ["error", null, "Failed to connect to Mac mini"],
  ] as const) {
    const status = projectThreadStatus(input({ connection: { phase, error, label: "Mac mini" } }));
    expect(status?.label).toBe(label);
    expect(status?.action).toBe("reconnect");
    expect(status?.indicator).toBe(
      phase === "connecting" || phase === "reconnecting" ? "spinner" : "unavailable",
    );
  }
});

test("work timing honors authoritative null, active ownership, and older server fallback", () => {
  const shell = {
    activeRunId: "active",
    latestRunId: "active",
    latestRunStartedAt: start,
    latestRunRequestedAt: "2026-11-11T09:59:59.000Z",
    latestRunCompletedAt: null,
    status: "running",
  };
  expect(threadWorkStartedAt(shell)).toBe(start);
  expect(threadWorkStartedAt({ ...shell, activityRunStartedAt: null })).toBeNull();
  expect(threadWorkStartedAt({ ...shell, activityRunStartedAt: "invalid" })).toBeNull();
  expect(threadWorkStartedAt({ ...shell, latestRunStartedAt: "invalid" })).toBe(
    "2026-11-11T09:59:59.000Z",
  );
  expect(threadWorkStartedAt({ ...shell, latestRunId: "queued" })).toBeNull();
  expect(threadWorkStartedAt({ ...shell, latestRunCompletedAt: start })).toBeNull();
  expect(
    threadWorkStartedAt({ ...shell, status: "completed", latestRunCompletedAt: undefined }),
  ).toBeNull();
  expect(
    threadWorkStartedAt({ ...shell, latestRunId: "queued", activityRunStartedAt: start }),
  ).toBe(start);
});

test("compaction follows the active run and explicit compact command completion", () => {
  const command = {
    runId: "run",
    type: "user_message",
    text: " /COMPACT ",
    attachments: [],
  };
  expect(threadIsCompacting("run", [command])).toBe(true);
  expect(threadIsCompacting("run", [{ ...command, attachments: [{ id: "file" }] }])).toBe(false);
  expect(threadIsCompacting("other", [command])).toBe(false);
  expect(threadIsCompacting("", [command])).toBe(false);
  expect(threadIsCompacting("run", [{ runId: "run", type: "compaction", status: "running" }])).toBe(
    true,
  );
  for (const status of ["completed", "failed", "interrupted", "cancelled"]) {
    expect(threadIsCompacting("run", [command, { runId: "run", type: "compaction", status }])).toBe(
      false,
    );
  }
});
