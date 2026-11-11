import type { PendingControl, ThreadControls } from "./thread-controls";
import type { HistorySummary } from "./thread-history";

export type ThreadLifecycleStatus =
  | { state: "settled" }
  | { state: "snoozed"; until: string }
  | { state: "woke"; at: string };

export interface ThreadStatusInput {
  connection: {
    phase:
      | "connected"
      | "connecting"
      | "reconnecting"
      | "offline"
      | "unsupported"
      | "available"
      | "error";
    label: string;
    error: string | null;
  };
  history: Pick<HistorySummary, "ready" | "synchronized" | "error">;
  controls: {
    stop: Pick<ThreadControls["stop"], "runId" | "state">;
    requests: readonly Pick<PendingControl, "kind">[];
  };
  startedAt: string | null;
  compacting: boolean;
  stopping: boolean;
  nowMs: number;
  lifecycle?: ThreadLifecycleStatus | null;
}

export interface ThreadStatus {
  kind: "working" | "syncing" | "compacting" | "stop" | "connection" | "lifecycle";
  label: string;
  symbol: string;
  indicator: "none" | "spinner" | "unavailable";
  action: "none" | "reconnect" | "unsettle" | "wake" | "dismiss";
  actionLabel?: string;
  actionPendingLabel?: string;
  actionTimestamp?: string;
  ticking: boolean;
}

export function formatWorkingDuration(startedAt: string, nowMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || nowMs <= startedAtMs) return "0s";
  const totalSeconds = Math.floor((nowMs - startedAtMs) / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalSeconds < 3_600) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return [
    `${Math.floor(minutes / 60)}h`,
    ...(minutes % 60 ? [`${minutes % 60}m`] : []),
    ...(seconds ? [`${seconds}s`] : []),
  ].join(" ");
}

const validDate = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const activeStatuses = new Set(["preparing", "starting", "running", "waiting"]);

export function threadLifecycleStatus(
  shell: Record<string, unknown>,
  nowMs: number,
): ThreadLifecycleStatus | null {
  if (Array.isArray(shell.pendingBackgroundTasks) && shell.pendingBackgroundTasks.length > 0)
    return null;
  const settled = shell.settledOverride === "settled";
  const until = validDate(shell.snoozedUntil);
  if (until === null || !Number.isFinite(nowMs)) return settled ? { state: "settled" } : null;
  const snoozedAt = validDate(shell.snoozedAt);
  const request = record(shell.pendingRuntimeRequest);
  const questionAt = request.kind === "user_input" ? validDate(request.createdAt) : null;
  const freshQuestion =
    questionAt !== null && snoozedAt !== null && Date.parse(questionAt) > Date.parse(snoozedAt);
  const failedAt = shell.status === "failed" ? validDate(shell.latestRunCompletedAt) : null;
  const freshFailure =
    failedAt !== null && (snoozedAt === null || Date.parse(failedAt) > Date.parse(snoozedAt));
  const raisedHand =
    (typeof request.kind === "string" && request.kind !== "user_input") ||
    (request.kind === "user_input" &&
      (snoozedAt === null || questionAt === null || freshQuestion)) ||
    shell.pendingSubagentRequest != null ||
    (typeof shell.pendingGuestMessageCount === "number" && shell.pendingGuestMessageCount > 0) ||
    (shell.status === "failed" && (snoozedAt === null || freshFailure));
  const snoozed = !raisedHand && Date.parse(until) > nowMs;
  const recovery = record(shell.limitRecovery);
  const recoveryOwnsSnooze =
    shell.status === "failed" &&
    shell.lastErrorClass === "usage_limit" &&
    recovery.snooze === true &&
    typeof shell.latestRunId === "string" &&
    recovery.runId === shell.latestRunId &&
    recovery.resetAt === shell.usageLimitResetAt &&
    Date.parse(until) === Date.parse(String(recovery.resetAt));
  if (snoozed && !recoveryOwnsSnooze) return { state: "snoozed", until };
  if (settled) return { state: "settled" };
  const wokeAt = raisedHand
    ? freshFailure && (!freshQuestion || Date.parse(failedAt) >= Date.parse(questionAt))
      ? failedAt
      : freshQuestion
        ? questionAt
        : (validDate(shell.updatedAt) ?? snoozedAt)
    : Date.parse(until) <= nowMs
      ? until
      : null;
  if (wokeAt === null) return null;
  const seen = [shell.lastVisitedAt, shell.latestRunCompletedAt].some((value) => {
    const at = validDate(value);
    return at !== null && Date.parse(at) >= Date.parse(wokeAt);
  });
  return seen ? null : { state: "woke", at: wokeAt };
}

function snoozeWakeLabel(until: string, nowMs: number): string {
  const remaining = Date.parse(until) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  if (remaining < 3_600_000) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)}h`;
  return `${Math.ceil(remaining / 86_400_000)}d`;
}

export function threadWorkStartedAt(shell: Record<string, unknown>): string | null {
  if (shell.activityRunStartedAt !== undefined) return validDate(shell.activityRunStartedAt);
  const completed =
    shell.latestRunCompletedAt !== undefined
      ? shell.latestRunCompletedAt !== null
      : !activeStatuses.has(String(shell.status));
  if (!shell.activeRunId || shell.activeRunId !== shell.latestRunId || completed) return null;
  return validDate(shell.latestRunStartedAt) ?? validDate(shell.latestRunRequestedAt);
}

const finishedCompactions = new Set(["completed", "failed", "interrupted", "cancelled"]);

export function threadIsCompacting(
  activeRunId: string | null,
  items: readonly Record<string, unknown>[],
): boolean {
  if (!activeRunId) return false;
  const active = items.filter((item) => item.runId === activeRunId);
  if (active.some((item) => item.type === "compaction" && item.status === "running")) return true;
  return (
    active.some(
      (item) =>
        item.type === "user_message" &&
        typeof item.text === "string" &&
        item.text.trim().toLowerCase() === "/compact" &&
        Array.isArray(item.attachments) &&
        item.attachments.length === 0,
    ) &&
    !active.some(
      (item) => item.type === "compaction" && finishedCompactions.has(String(item.status)),
    )
  );
}

export function projectThreadStatus(input: ThreadStatusInput): ThreadStatus | null {
  const { connection, history, controls } = input;
  if (connection.phase !== "connected") {
    const environment = connection.label || "Environment";
    const retrying = connection.phase === "connecting" || connection.phase === "reconnecting";
    const label = retrying
      ? connection.error === null
        ? `Reconnecting to ${environment}...`
        : `Failed to connect. Retrying ${environment}...`
      : connection.phase === "offline"
        ? "You are offline"
        : connection.phase === "unsupported"
          ? "Client not supported"
          : connection.phase === "available"
            ? `${environment} is not connected`
            : `Failed to connect to ${environment}${connection.error ? `: ${connection.error}` : ""}`;
    return {
      kind: "connection",
      label,
      symbol: "",
      indicator: retrying ? "spinner" : "unavailable",
      action: "reconnect",
      ticking: false,
    };
  }
  if (
    history.ready &&
    (input.stopping || controls.stop.state === "stopping" || controls.stop.state === "unresponsive")
  ) {
    const unresponsive = controls.stop.state === "unresponsive";
    return {
      kind: "stop",
      label: unresponsive ? "Not responding to Stop" : "Stopping…",
      symbol: unresponsive ? "exclamationmark.triangle" : "",
      indicator: unresponsive ? "none" : "spinner",
      action: "none",
      ticking: false,
    };
  }
  if (
    controls.requests.some((request) => request.kind === "approval" || request.kind === "question")
  )
    return null;
  if (!history.synchronized && !history.error) {
    return {
      kind: "syncing",
      label: history.ready ? "Syncing messages..." : "Loading messages...",
      symbol: "",
      indicator: "spinner",
      action: "none",
      ticking: false,
    };
  }
  if (!history.ready) return null;
  if (input.compacting) {
    return {
      kind: "compacting",
      label: "Compacting…",
      symbol: "arrow.down.right.and.arrow.up.left",
      indicator: "none",
      action: "none",
      ticking: false,
    };
  }
  if (input.startedAt !== null) {
    return {
      kind: "working",
      label: `Working ${formatWorkingDuration(input.startedAt, input.nowMs)}`,
      symbol: "",
      indicator: "none",
      action: "none",
      ticking: true,
    };
  }
  const lifecycle = input.lifecycle;
  if (!lifecycle) return null;
  if (lifecycle.state === "snoozed") {
    return {
      kind: "lifecycle",
      label: `Snoozed, wakes in ${snoozeWakeLabel(lifecycle.until, input.nowMs)}`,
      symbol: "clock",
      indicator: "none",
      action: "wake",
      actionLabel: "Wake now",
      actionPendingLabel: "Waking...",
      ticking: true,
    };
  }
  return lifecycle.state === "settled"
    ? {
        kind: "lifecycle",
        label: "Settled",
        symbol: "checkmark.circle",
        indicator: "none",
        action: "unsettle",
        actionLabel: "Un-settle",
        actionPendingLabel: "Un-settling...",
        ticking: false,
      }
    : {
        kind: "lifecycle",
        label: "Woke from snooze",
        symbol: "clock",
        indicator: "none",
        action: "dismiss",
        actionLabel: "Dismiss",
        actionPendingLabel: "Dismissing...",
        actionTimestamp: lifecycle.at,
        ticking: false,
      };
}
