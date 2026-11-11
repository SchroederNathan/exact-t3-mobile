import { expect, test } from "bun:test";
import { CodeHighlights, codeRuns } from "../code-highlight";

test("UTF-16 token ranges preserve source exactly and reject invalid native ranges", () => {
  const body = "😀 const value = 'é';\r\n\0";
  const runs = codeRuns(body, {
    tokens: [
      { start: 3, end: 8, kind: 0 },
      { start: 8, end: 9, kind: 0 },
    ],
  });
  expect(runs).toEqual([
    { id: "0", text: "😀 ", kind: -1 },
    { id: "1", text: "const ", kind: 0 },
    { id: "2", text: "value = 'é';\r\n\0", kind: -1 },
  ]);
  for (const tokens of [
    [{ start: 1, end: 2, kind: 0 }],
    [
      { start: 5, end: 8, kind: 0 },
      { start: 3, end: 4, kind: 1 },
    ],
    [{ start: 0, end: 500, kind: 1 }],
    [{ start: 0, end: 2, kind: 14 }],
  ])
    expect(codeRuns(body, { tokens })).toEqual([{ id: "0", text: body, kind: -1 }]);
});

test("each source owns native requests while settled results stay bounded and reusable", async () => {
  const cache = new CodeHighlights(2, 240);
  const requests: { code: string; finish: (value: unknown) => void; fail: () => void }[] = [];
  const request = (code: string) =>
    new Promise((finish, reject) =>
      requests.push({ code, finish, fail: () => reject(new Error("Superseded")) }),
    );
  const block = { id: "code", body: "one", language: "ts", pending: false };
  const first = cache.load([block], request);
  const repeated = cache.load([block], request);
  expect(requests.map(({ code }) => code)).toEqual(["one", "one"]);
  requests[0]!.fail();
  requests[1]!.finish({ tokens: [{ start: 0, end: 3, kind: 0 }] });
  expect((await first)[0]?.runs).toEqual([{ id: "0", text: "one", kind: -1 }]);
  expect((await repeated)[0]?.runs).toEqual([{ id: "0", text: "one", kind: 0 }]);
  expect(await cache.load([block], request)).toMatchObject([{ body: "one", runs: [{ kind: 0 }] }]);
  const changed = cache.load([{ ...block, body: "two" }], request);
  const duplicate = cache.load([{ ...block, id: "copy", body: "two" }], request);
  expect(requests.map(({ code }) => code)).toEqual(["one", "one", "two", "two"]);
  requests[2]!.finish({ tokens: [] });
  requests[3]!.finish({ tokens: [] });
  await Promise.all([changed, duplicate]);
  await cache.load([block, { ...block, body: "two" }], request);
  expect(requests).toHaveLength(4);
  expect(await cache.load([{ ...block, pending: true }], request)).toEqual([]);
  await cache.load([{ ...block, body: "three" }], async () => ({ tokens: [] }));
  const evicted = cache.load([block], request);
  expect(requests).toHaveLength(5);
  requests[4]!.fail();
  await evicted;
  const retry = cache.load([block], request);
  expect(requests).toHaveLength(6);
  requests[5]!.finish({ tokens: [] });
  await retry;
});
