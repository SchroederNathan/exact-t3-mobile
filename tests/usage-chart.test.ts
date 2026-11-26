import { expect, test } from "bun:test";
import { usageChart, usageWindow } from "../usage";

const window = usageWindow(7, new Date("2026-11-10T12:05Z"), "America/Toronto");
const bucket = (provider: string, costUsd: number, tokens: number, day = "2026-11-08") => ({
  day, provider, costUsd, records: 1, unpricedRecords: 0,
  totals: { uncachedInputTokens: tokens, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 },
});

test("chart sums repeated models by provider, fills quiet dates and scales each metric independently", () => {
  const chart = usageChart([bucket("claude", 2, 4), bucket("codex", 1, 2), bucket("codex", 1, 2), bucket("codex", 8, 1, "2026-11-10")], window);
  expect(chart.periods).toHaveLength(7);
  expect(chart.periods[0]).toMatchObject({ id: "2026-11-04", segments: [] });
  expect(chart.periods[4]?.segments).toEqual([
    { provider: "codex", cost: 2, tokens: 4, costPercent: 25, tokenPercent: 50 },
    { provider: "claude", cost: 2, tokens: 4, costPercent: 25, tokenPercent: 50 },
  ]);
  expect(chart.periods[6]?.segments[0]).toMatchObject({ costPercent: 100, tokenPercent: 12.5 });
});

test("rolling hourly bins keep both local 1 AMs distinct and exclude the upper boundary", () => {
  const hourly = usageWindow(1, new Date("2026-11-02T04:30Z"), "America/Toronto");
  const chart = usageChart(["05:30", "06:30"].map(hour => ({ ...bucket("codex", 1, 1), hourStart: `2026-11-01T${hour}:00Z` })), hourly);
  expect(chart.periods).toHaveLength(24);
  expect(chart.periods[1]?.segments[0]?.tokens).toBe(1);
  expect(chart.periods[2]?.segments[0]?.tokens).toBe(1);
  expect(chart.periods.at(-1)?.id).toBe("2026-11-02T03:30:00.000Z");
});

test("missing time buckets are not silent zeroes; unknown price does not hide tokens", () => {
  expect(usageChart([{ ...bucket("codex", 1, 1), day: undefined }], window).notice).not.toBe("");
  const unpriced = usageChart([{ ...bucket("codex", 0, 3), unpricedRecords: 1 }], window);
  expect(unpriced.periods[4]?.segments[0]).toMatchObject({ costPercent: 0, tokenPercent: 100 });
  expect(usageChart([], window).notice).toBe("");
});
