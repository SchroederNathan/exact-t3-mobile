type Shell = {
  updatedAt?: unknown;
  lastVisitedAt?: unknown;
  latestRunCompletedAt?: unknown;
};

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function visitMetadata(shell: Shell, wokeAt: string | null = null) {
  const updated = timestamp(shell.updatedAt);
  const wake = timestamp(wokeAt);
  const seen = timestamp(shell.lastVisitedAt);
  const completed = timestamp(shell.latestRunCompletedAt);
  const ready = Number.isFinite(updated);
  const wakeIsLatest = wake > updated;
  return {
    ready,
    supported: shell.lastVisitedAt !== undefined,
    at: ready ? String(wakeIsLatest ? wokeAt : shell.updatedAt) : "",
    watermark: ready ? wakeIsLatest ? wake : updated : -1,
    seen: Number.isFinite(seen) ? seen : -1,
    urgent: ready && (wakeIsLatest || (Number.isFinite(completed) && (!Number.isFinite(seen) || completed > seen))),
  };
}
