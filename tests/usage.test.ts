import { expect, test } from "bun:test";
import { usageTotals, usageWindow } from "../usage";

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
