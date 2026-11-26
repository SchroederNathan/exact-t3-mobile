export type UsageDays = 1 | 7 | 30 | 90;

export function subscriptionLimits(environmentId: string, environment: string, providers: unknown) {
  const rows: { id: string; environment: string; provider: string; notice: string; windows: { id: string; label: string; remaining: number }[] }[] = [];
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  for (const entry of Array.isArray(providers) ? providers : []) {
    const provider = fields(entry), limits = fields(provider.usageLimits);
    const instance = text(provider.instanceId);
    if (!instance || provider.enabled !== true || !Array.isArray(limits.windows)) continue;
    const unavailable = fields(limits.unavailable);
    const notice = unavailable.reason === "unsupported" ? text(unavailable.message) || "This account has no subscription limits."
      : unavailable.reason === "probeFailed" ? text(unavailable.message) || "Could not read limits." : "";
    const windows = limits.windows.flatMap(value => {
      const window = fields(value), used = window.usedPercent;
      if (!text(window.id) || !text(window.label) || typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return [];
      return [{ id: text(window.id), label: text(window.label), remaining: Math.round(100 - used) }];
    });
    const driver = text(provider.driver);
    rows.push({ id: JSON.stringify([environmentId, instance]), environment,
      provider: text(provider.displayName) || (driver === "codex" ? "Codex" : driver) || instance,
      notice: notice || (windows.length ? "" : "No limits reported."), windows: notice ? [] : windows });
  }
  return rows;
}

function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("This environment returned incomplete usage totals.");
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function usageTotals(value: unknown) {
  const summary = fields(value);
  if (![4, 5, 6].includes(Number(summary.contractVersion)))
    throw new Error("This environment reports an incompatible usage version.");
  if (!Array.isArray(summary.buckets) || !Array.isArray(summary.sources))
    throw new Error("This environment returned incomplete usage totals.");
  let tokens = 0, cost = 0, sessions = 0, unpriced = 0, records = 0;
  for (const item of summary.buckets) {
    const bucket = fields(item), totals = fields(bucket.totals);
    tokens += nonnegative(totals.uncachedInputTokens) + nonnegative(totals.cachedInputTokens)
      + nonnegative(totals.cacheCreationTokens) + nonnegative(totals.outputTokens);
    cost += nonnegative(bucket.costUsd);
    records += nonnegative(bucket.records);
    unpriced += nonnegative(bucket.unpricedRecords);
  }
  let partial = false;
  for (const item of summary.sources) {
    const source = fields(item);
    sessions += nonnegative(source.distinctSessions);
    if (source.status === "failed" || source.status === "partial") partial = true;
  }
  return { tokens, cost, sessions, unpriced, priced: records === 0 || records > unpriced, partial };
}

export function usageWindow(days: UsageDays, now: Date, timeZone: string) {
  const calendar = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone,
  });
  const localDay = (date: Date) => calendar.format(date);
  if (days === 1) {
    const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const start = new Date(end.getTime() - 86_400_000);
    return {
      timeZone, resolution: "hour" as const, sinceDay: localDay(start), untilDay: localDay(end),
      sinceTime: start.toISOString(), untilTime: end.toISOString(),
    };
  }
  const untilDay = localDay(now);
  const start = new Date(`${untilDay}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { timeZone, resolution: "day" as const, sinceDay: start.toISOString().slice(0, 10), untilDay };
}
