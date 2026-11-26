import { expect, test } from "bun:test";
import { usageTotals, usageWindow } from "../usage";
import { limitReports, poolLimitReports } from "../limit-pools";

test("subscription windows show remaining allowance, not used allowance", () => {
  const provider = { instanceId: "local", installed: true, enabled: true, driver: "codex", usageLimits: { windows: [
    { id: "month", label: "Monthly", usedPercent: 100 }, { id: "week", label: "Weekly", usedPercent: 24.5 },
    { id: "bad", label: "Invalid", usedPercent: null },
  ] } };
  const report = (providers: unknown[]) => poolLimitReports(limitReports("home", "Home", providers, []), 0);
  const reports = report([provider, { ...provider, enabled: false }]);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.windows.map(window => window.remaining)).toEqual([0, 76]);
  const unavailable = { ...provider, usageLimits: { ...provider.usageLimits, unavailable: { reason: "unsupported" } } };
  expect(report([unavailable])[0]).toMatchObject({ windows: [], notice: "This account has no subscription limits." });
  expect(report([{ ...provider, usageLimits: undefined }])).toEqual([]);
});

test("the freshest reading wins across hosts and hub mirrors; unknown workspaces merge only when unambiguous", () => {
  const provider = (id: string, email: string, workspaceId: string, usedPercent: number, seen: string) => ({ instanceId: id, driver: "codex", auth: {email, workspaceId}, installed:true, enabled:true, usageLimits:{checkedAt:seen, windows:[{id, kind:"weekly", label:"Weekly", usedPercent}]} });
  const past="2026-11-01T12:00:00Z", latest="2026-11-02T12:00:00Z";
  const first=provider("old", " A@example.test ", "", 100, past), next=provider("new", "a@example.test", "team", 20, latest), other=provider("solo", "b@example.test", "", 50, past);
  const hub = {id:"hub", label:"Hub", accounts:[{id:"mirrored.json",driver:"codex",email:"a@example.test",workspaceId:"team",usageLimits:first.usageLimits}]};
  const collect = (extra: unknown[] = []) => poolLimitReports([...limitReports("one","One",[first,other,...extra],[]), ...limitReports("two","Two",[next],[hub])], Date.parse(latest));
  const result = collect(); expect(result).toHaveLength(1);
  expect(result[0]!.windows[0]).toMatchObject({ id:"weekly",remaining:65,columns:[{name:"AE",remaining:80},{name:"BE",remaining:50}] });
  expect(JSON.stringify(result)).not.toContain("@example.test");
  const unreadable = {...next,instanceId:"private",auth:{email:"a@example.test",workspaceId:"personal"},usageLimits:undefined};
  expect(collect([unreadable])[0]!.windows[0]!.columns).toHaveLength(3);
});

test("missing windows keep their column but not their weight; exhausted weekly allowance blocks a session", () => {
  const reports = limitReports("one","One",[0,1].map(index => ({instanceId:String(index),driver:"codex", enabled:true,installed:true,usageLimits:{windows:[{id:"week",kind:"weekly",label:"Weekly",usedPercent:index ? 0 : 100},...(index ? [] : [{id:"slot",kind:"session",label:"Session",usedPercent:10}])]}})), []);
  const windows = poolLimitReports(reports,0)[0]!.windows;
  expect(windows.map(window => window.remaining)).toEqual([0,50]);
  expect(windows[0]!.columns.map(column => column.reported)).toEqual([true,false]);
});

const bucket = {
  totals: { uncachedInputTokens: 30, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 10, reasoningTokens: 7 },
  costUsd: 0.25, sessions: 1, records: 2, unpricedRecords: 1,
};

test("usage does not double count reasoning tokens or sessions spanning days", () => {
  expect(usageTotals({ contractVersion: 6, buckets: [bucket, bucket], sources: [{status: "partial", distinctSessions: 1}] })).toEqual({
    tokens: 130, sessions: 1, cost: 0.5, unpriced: 2, priced: true, partial: true,
  });
});

test("unpriced and incompatible usage do not look like free usage", () => {
  expect(usageTotals({ contractVersion: 4, buckets: [{ ...bucket, records: 1, costUsd: 0 }], sources: [] }).priced).toBe(false);
  for (const contractVersion of [3, 7]) expect(() => usageTotals({ contractVersion, buckets: [], sources: [] })).toThrow("incompatible");
  expect(() => usageTotals({ contractVersion: 6, buckets: [{}], sources: [] })).toThrow("incomplete");
});

test("daily usage windows end on the viewer's local day, not the UTC day", () => {
  const end = new Date("2026-11-03T04:15:37Z");
  expect(usageWindow(7, end, "America/Toronto")).toEqual({
    sinceDay: "2026-10-27", untilDay: "2026-11-02", resolution: "day", timeZone: "America/Toronto",
  });
  expect(usageWindow(30, end, "UTC").sinceDay).toBe("2026-10-05");
  expect(usageWindow(90, end, "UTC").sinceDay).toBe("2026-08-06");
});

test("past 24 hours spans exactly 24 hours across the fall clock change", () => {
  expect(usageWindow(1, new Date("2026-11-02T04:30:58.739Z"), "America/Toronto")).toEqual({
    sinceDay: "2026-11-01", untilDay: "2026-11-01", resolution: "hour", timeZone: "America/Toronto",
    sinceTime: "2026-11-01T04:30:00.000Z", untilTime: "2026-11-02T04:30:00.000Z",
  });
});
