import { expect, test } from "bun:test";
import { markdownBlocks } from "./markdown";
import { TableLayouts } from "./table-layout";

test("table measurements are source-owned, matched by rendered content, and cached only after settlement", async () => {
  const cache = new TableLayouts(2, 4096);
  const table = markdownBlocks("| One | Two |\n| --- | --- |\n| **wide** | code |", "m")[0]!;
  const requests: { finish: (result: unknown) => void; fail: () => void }[] = [];
  const request = () => new Promise((finish, reject) => requests.push({ finish, fail: () => reject(new Error("Superseded")) }));
  const first = cache.load([table], request);
  const second = cache.load([table], request);
  expect(requests).toHaveLength(2);
  requests[0]!.fail();
  requests[1]!.finish({ widths: [120, 240] });
  expect(await first).toEqual([]);
  expect(await second).toEqual([{ blockId: table.id, signature: table.tableSignature, widths: [120, 240] }]);
  expect(await cache.load([table], request)).toMatchObject([{ widths: [120, 240] }]);
  expect(requests).toHaveLength(2);
  const changed = markdownBlocks("| One | Two |\n| --- | --- |\n| **much wider** | code |", "m")[0]!;
  const third = cache.load([changed], request);
  requests[2]!.fail();
  expect(await third).toEqual([]);
  const retry = cache.load([changed], request);
  requests[3]!.finish({ widths: [40, 500] });
  expect(await retry).toEqual([]);
  const valid = cache.load([changed], request);
  requests[4]!.finish({ widths: [60, 320] });
  expect(await valid).toMatchObject([{ signature: changed.tableSignature, widths: [60, 320] }]);
});

test("a reference definition changes measurement identity while IDs and link destinations do not", async () => {
  const cache = new TableLayouts();
  const raw = "| Label |\n| --- |\n| [**wide**][target] |";
  const unresolved = markdownBlocks(raw, "message")[0]!;
  const resolved = markdownBlocks(`${raw}\n\n[target]: https://example.com`, "message")[0]!;
  expect(resolved.body).toBe(unresolved.body);
  expect(resolved.cells[1]?.runs.map((run) => run.text).join("")).toBe("wide");
  expect(unresolved.cells[1]?.runs.map((run) => run.text).join("")).toBe("[wide][target]");
  let requests = 0;
  const request = async () => ({ widths: [++requests === 1 ? 180 : 90] });
  const before = await cache.load([unresolved], request);
  const after = await cache.load([resolved], request);
  expect(before[0]?.widths).toEqual([180]);
  expect(after[0]?.widths).toEqual([90]);
  expect(after[0]?.signature).not.toBe(before[0]?.signature);
  const otherMessage = markdownBlocks(`${raw}\n\n[target]: https://elsewhere.example`, "other-message")[0]!;
  expect(await cache.load([otherMessage], request)).toMatchObject([{ blockId: otherMessage.id, widths: [90] }]);
  expect(requests).toBe(2);
});
