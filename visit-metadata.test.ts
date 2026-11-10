import { expect, test } from "bun:test";
import { visitMetadata } from "./visit-metadata";

test("visit metadata uses raw shell time and preserves unsupported versus unvisited servers", () => {
  expect(visitMetadata({ updatedAt: "1970-01-01T00:00:10.000Z", lastVisitedAt: null })).toEqual({
    ready: true, supported: true, at: "1970-01-01T00:00:10.000Z", watermark: 10000, seen: -1, urgent: false,
  });
  expect(visitMetadata({ updatedAt: "1970-01-01T00:00:10.000Z" })).toEqual({
    ready: true, supported: false, at: "1970-01-01T00:00:10.000Z", watermark: 10000, seen: -1, urgent: false,
  });
  expect(visitMetadata({ updatedAt: "10s ago", lastVisitedAt: null })).toEqual({
    ready: false, supported: true, at: "", watermark: -1, seen: -1, urgent: false,
  });
});

test("an unseen completion is urgent until the server's visit watermark catches up", () => {
  expect(visitMetadata({
    updatedAt: "1970-01-01T00:00:20.000Z", lastVisitedAt: "1970-01-01T00:00:10.000Z",
    latestRunCompletedAt: "1970-01-01T00:00:20.000Z",
  })).toEqual({
    ready: true, supported: true, at: "1970-01-01T00:00:20.000Z", watermark: 20000, seen: 10000, urgent: true,
  });
  expect(visitMetadata({
    updatedAt: "1970-01-01T00:00:20.000Z", lastVisitedAt: "1970-01-01T00:00:20.000Z",
    latestRunCompletedAt: "1970-01-01T00:00:20.000Z",
  }).urgent).toBe(false);
});

test("a later wake advances the visit watermark immediately and a retired wake falls back to shell time", () => {
  const shell = { updatedAt: "1970-01-01T00:00:20.000Z", lastVisitedAt: "1970-01-01T00:00:10.000Z" };
  expect(visitMetadata(shell, "1970-01-01T00:00:25.000Z")).toEqual({
    ready: true, supported: true, at: "1970-01-01T00:00:25.000Z", watermark: 25000, seen: 10000, urgent: true,
  });
  expect(visitMetadata(shell, null)).toEqual({
    ready: true, supported: true, at: "1970-01-01T00:00:20.000Z", watermark: 20000, seen: 10000, urgent: false,
  });
  expect(visitMetadata(shell, "1970-01-01T00:00:15.000Z")).toEqual({
    ready: true, supported: true, at: "1970-01-01T00:00:20.000Z", watermark: 20000, seen: 10000, urgent: false,
  });
});
