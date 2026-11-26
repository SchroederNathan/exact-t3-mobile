export type UsageDays = 1 | 7 | 30 | 90;

function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("This environment returned incomplete usage totals.");
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown) {
  const totals = fields(value);
  return nonnegative(totals.uncachedInputTokens) + nonnegative(totals.cachedInputTokens)
    + nonnegative(totals.cacheCreationTokens) + nonnegative(totals.outputTokens);
}

const providers = ["codex", "claude", "grok", "cursor", "opencode", "antigravity", "pi", "muse"];
const providerNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", grok: "Grok Build", cursor: "Cursor", opencode: "OpenCode", antigravity: "Antigravity", pi: "Pi", muse: "Muse Code" };
function providerOrder(left: string, right: string) {
  const priority = (key: string) => providers.includes(key) ? providers.indexOf(key) : providers.length;
  return priority(left) - priority(right) || left.localeCompare(right);
}

export function usageChart(buckets: unknown, window: ReturnType<typeof usageWindow>) {
  const hourly = window.resolution === "hour";
  const step = hourly ? 3600000 : 86400000;
  const start = Date.parse(hourly ? window.sinceTime : window.sinceDay);
  const end = Date.parse(hourly ? window.untilTime : window.untilDay) + (hourly ? 0 : step);
  const formatter = new Intl.DateTimeFormat(undefined, hourly ? { timeZone: window.timeZone, hour: "numeric" } : { timeZone: "UTC", month: "short", day: "numeric" });
  const bins = new Map<string, Map<string, { tokens: number; cost: number }>>();
  for (let time = start; time < end && bins.size < 90; time += step) {
    const iso = new Date(time).toISOString();
    bins.set(hourly ? iso : iso.slice(0, 10), new Map());
  }
  let notice = "", maxTokens = 0, maxCost = 0;
  for (const raw of Array.isArray(buckets) ? buckets : []) {
    const entry = fields(raw);
    const instant = hourly ? Date.parse(String(entry.hourStart)) : NaN;
    const key = hourly && Number.isFinite(instant) ? new Date(instant).toISOString() : String(entry.day);
    const bin = bins.get(key);
    if (!bin || typeof entry.provider !== "string" || !entry.provider) {
      notice = "Chart unavailable: the environment returned incomplete time buckets.";
      continue;
    }
    const value = bin.get(entry.provider) ?? { tokens: 0, cost: 0 };
    value.tokens += tokenCount(entry.totals);
    value.cost += nonnegative(entry.costUsd);
    bin.set(entry.provider, value);
  }
  const periods = [...bins].map(([id, bin]) => {
    const segments = [...bin.keys()].sort(providerOrder)
      .map(provider => ({ provider, ...bin.get(provider)!, costPercent: 0, tokenPercent: 0 }));
    maxTokens = Math.max(maxTokens, segments.reduce((sum, part) => sum + part.tokens, 0));
    maxCost = Math.max(maxCost, segments.reduce((sum, part) => sum + part.cost, 0));
    return { id, label: formatter.format(new Date(id)), segments };
  });
  for (const period of periods) for (const part of period.segments) {
    part.costPercent = maxCost ? part.cost / maxCost * 100 : 0;
    part.tokenPercent = maxTokens ? part.tokens / maxTokens * 100 : 0;
  }
  const legend = [...new Set(periods.flatMap(period => period.segments.map(part => part.provider)))].sort(providerOrder)
    .map(id => ({ id, label: Object.hasOwn(providerNames, id) ? providerNames[id]! : id }));
  return { periods, legend, notice, hasActivity: maxTokens > 0 || maxCost > 0, startLabel: periods[0]?.label ?? "", endLabel: periods.at(-1)?.label ?? "" };
}

export function usageTotals(value: unknown) {
  const summary = fields(value);
  if (![4, 5, 6].includes(Number(summary.contractVersion)))
    throw new Error("This environment reports an incompatible usage version.");
  if (!Array.isArray(summary.buckets) || !Array.isArray(summary.sources))
    throw new Error("This environment returned incomplete usage totals.");
  let tokens = 0, cost = 0, sessions = 0, unpriced = 0, records = 0;
  for (const item of summary.buckets) {
    const bucket = fields(item);
    tokens += tokenCount(bucket.totals);
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
