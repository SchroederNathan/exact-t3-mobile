export type UsageDays = 1 | 7 | 30 | 90;

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
