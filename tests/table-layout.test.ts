import { expect, test } from "bun:test";
import { markdownBlocks } from "../markdown";
import { TableLayouts } from "../table-layout";

test("table measurements are source-owned, matched by rendered content, and cached only after settlement", async () => {
  const cache = new TableLayouts(2, 4096);
  const table = markdownBlocks("| One | Two |\n| --- | --- |\n| **wide** | code |", "m")[0]!;
  const requests: { finish: (result: unknown) => void; fail: () => void }[] = [];
  const request = () =>
    new Promise((finish, reject) =>
      requests.push({ finish, fail: () => reject(new Error("Superseded")) }),
    );
  const first = cache.load([table], request);
  const second = cache.load([table], request);
  expect(requests).toHaveLength(2);
  requests[0]!.fail();
  requests[1]!.finish({ widths: [120, 240] });
  expect(await first).toEqual([]);
  expect(await second).toEqual([
    {
      blockId: table.id,
      signature: table.tableSignature,
      widths: [120, 240],
      height: 0,
      images: [],
      payload: "",
    },
  ]);
  expect(await cache.load([table], request)).toMatchObject([{ widths: [120, 240] }]);
  expect(requests).toHaveLength(2);
  const changed = markdownBlocks(
    "| One | Two |\n| --- | --- |\n| **much wider** | code |",
    "m",
  )[0]!;
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
  const otherMessage = markdownBlocks(
    `${raw}\n\n[target]: https://elsewhere.example`,
    "other-message",
  )[0]!;
  expect(await cache.load([otherMessage], request)).toMatchObject([
    { blockId: otherMessage.id, widths: [90] },
  ]);
  expect(requests).toBe(2);
});

test("image table geometry is cached without retaining image sources, links, or occurrence IDs", async () => {
  const cache = new TableLayouts();
  const table = (id: string, image: string, href: string, align = "---") =>
    markdownBlocks(
      `| Label |\n| ${align} |\n| before ![preview](${image}) [after](${href}) |`,
      id,
    )[0]!;
  const original = table("first", "data:image/png;base64,AAAA", "src/first.ts");
  const geometry = {
    widths: [120],
    height: 74,
    cells: [
      { x: 0, y: 0, width: 120, height: 37 },
      { x: 0, y: 37, width: 120, height: 37 },
    ],
    images: [{ cell: 1, part: 1, x: 60, y: 46.4, width: 20, height: 20 }],
  };
  let requests = 0;
  const request = async () => {
    requests++;
    return geometry;
  };
  const [before] = await cache.load([original], request);
  expect(before?.images).toMatchObject([
    { blockId: original.cells[1]!.parts[1]!.id, x: 60, y: 46.4 },
  ]);
  const changed = table("second", "https://example.com/new.png", "src/second.ts");
  expect(changed.tableSignature).toBe(original.tableSignature);
  const [after] = await cache.load([changed], request);
  expect(requests).toBe(1);
  expect(after?.images).toMatchObject([
    { blockId: changed.cells[1]!.parts[1]!.id, alt: "preview", inlineImage: true },
  ]);
  const payload = JSON.parse(after!.payload);
  expect(payload.cells[1].parts[1]).toEqual({ image: true, inlineImage: true, runs: [] });
  expect(payload.cells[1].parts[2].runs[1].href).toBe("src/second.ts");
  expect(after!.payload).not.toContain("first");
  expect(after!.payload).not.toContain("https://example.com/new.png");
  const aligned = table("second", "https://example.com/new.png", "src/second.ts", "---:");
  expect(aligned.tableSignature).not.toBe(changed.tableSignature);
  await cache.load([aligned], request);
  expect(requests).toBe(2);
  const malformed = new TableLayouts();
  expect(
    await malformed.load([original], async () => ({
      ...geometry,
      images: [{ ...geometry.images[0], part: 0 }],
    })),
  ).toEqual([]);
  expect(
    await malformed.load([original], async () => ({ ...geometry, height: Number.NaN })),
  ).toEqual([]);
});
