import { describe, expect, test } from "bun:test";
import { markdownBlocks } from "../markdown";

describe("native markdown blocks", () => {
  test("keeps list continuations and nesting in their structural blocks", () => {
    const blocks = markdownBlocks(
      "3. first **bold**\n   continuation\n\n   second paragraph\n   - nested\n4. last",
      "message",
    );
    expect(
      blocks.map(({ kind, body, marker, depth, spacingAfter }) => ({
        kind,
        body,
        marker,
        depth,
        spacingAfter,
      })),
    ).toEqual([
      {
        kind: "list-item",
        body: "first **bold**\ncontinuation",
        marker: "3.",
        depth: 1,
        spacingAfter: 8,
      },
      { kind: "paragraph", body: "second paragraph", marker: "", depth: 1, spacingAfter: 8 },
      { kind: "list-item", body: "nested", marker: "•", depth: 2, spacingAfter: 8 },
      { kind: "list-item", body: "last", marker: "4.", depth: 1, spacingAfter: 8 },
    ]);
    expect(blocks.map((block) => block.gutter)).toEqual([24, 24, 14, 24]);
    expect(
      markdownBlocks("- first\n\n  continuation\n\n  > quote", "gutter").map((block) => ({
        marker: block.marker,
        gutter: block.gutter,
      })),
    ).toEqual([
      { marker: "•", gutter: 14 },
      { marker: "", gutter: 14 },
      { marker: "", gutter: 14 },
    ]);
    const inline =
      "**bold *nested* ~~gone~~** &copy; &amp;lt; \\* \nnext  \nline [file](src/app.ts:2) [reference][r] `&amp;`\n\n[r]: https://example.com";
    expect(
      markdownBlocks(inline, "m")[0]?.runs.map(
        ({ text, strong, emphasis, strike, code, href }) => ({
          text,
          strong,
          emphasis,
          strike,
          code,
          href,
        }),
      ),
    ).toEqual([
      { text: "bold ", strong: true, emphasis: false, strike: false, code: false, href: "" },
      { text: "nested", strong: true, emphasis: true, strike: false, code: false, href: "" },
      { text: " ", strong: true, emphasis: false, strike: false, code: false, href: "" },
      { text: "gone", strong: true, emphasis: false, strike: true, code: false, href: "" },
      {
        text: " © &lt; *  next\nline ",
        strong: false,
        emphasis: false,
        strike: false,
        code: false,
        href: "",
      },
      {
        text: "file",
        strong: false,
        emphasis: false,
        strike: false,
        code: false,
        href: "src/app.ts:2",
      },
      { text: " ", strong: false, emphasis: false, strike: false, code: false, href: "" },
      {
        text: "reference",
        strong: false,
        emphasis: false,
        strike: false,
        code: false,
        href: "https://example.com",
      },
      { text: " ", strong: false, emphasis: false, strike: false, code: false, href: "" },
      { text: "&amp;", strong: false, emphasis: false, strike: false, code: true, href: "" },
    ]);
    expect(markdownBlocks("first\nsecond", "m", true)[0]?.runs[0]?.text).toBe("first\nsecond");
    expect(markdownBlocks("- first\n- second", "m").map((block) => block.spacingAfter)).toEqual([
      0, 8,
    ]);
    for (const path of [
      "src/app.ts:12",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\_private\\app.tsx",
      "app.tsx:12:3",
      "./src/a&copy;.ts",
      "./src/[id].ts",
    ]) {
      expect(markdownBlocks(`\`${path}\``, "file")[0]?.runs, path).toMatchObject([
        { text: path, href: path, linkKind: "file", code: false },
      ]);
    }
    for (const code of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
      "./src/<name>.ts",
    ]) {
      expect(markdownBlocks(`\`${code}\``, "code")[0]?.runs, code).toMatchObject([
        { text: code, href: "", linkKind: "", code: true },
      ]);
    }
    expect(
      markdownBlocks("[`src/app.ts`](https://example.com) [`./README.md`]()", "linked")[0]?.runs,
    ).toMatchObject([
      { text: "src/app.ts", href: "https://example.com", linkKind: "external", code: true },
      { text: " " },
      { text: "./README.md", href: "", linkKind: "", code: true },
    ]);
  });

  test("keeps fenced list-looking text literal and preserves quote and heading structure", () => {
    const blocks = markdownBlocks(
      "## Heading *inline*\n\n> quoted\n> - inside\n\n```ts\n- not a list\n1. still code\n```\n\n---",
      "m",
    );
    expect(
      blocks.map(({ kind, body, marker, quoteDepth, language, headingLevel }) => ({
        kind,
        body,
        marker,
        quoteDepth,
        language,
        headingLevel,
      })),
    ).toEqual([
      {
        kind: "heading",
        body: "Heading *inline*",
        marker: "",
        quoteDepth: 0,
        language: "",
        headingLevel: 2,
      },
      { kind: "quote", body: "quoted", marker: "", quoteDepth: 1, language: "", headingLevel: 0 },
      {
        kind: "list-item",
        body: "inside",
        marker: "•",
        quoteDepth: 1,
        language: "",
        headingLevel: 0,
      },
      {
        kind: "code",
        body: "- not a list\n1. still code",
        marker: "",
        quoteDepth: 0,
        language: "ts",
        headingLevel: 0,
      },
      {
        kind: "thematic-break",
        body: "",
        marker: "",
        quoteDepth: 0,
        language: "",
        headingLevel: 0,
      },
    ]);
    const table =
      "| Name | Value |\n| --- | --- |\n| alpha<br>second<br/>third<BR />**fourth** | **one** `<br>` &lt;br&gt; |";
    expect(markdownBlocks(table, "m")[0]).toMatchObject({
      kind: "table",
      columns: 2,
      cells: [
        { column: 0, header: true, align: "left", runs: [{ text: "Name" }] },
        { column: 1, header: true, align: "left", runs: [{ text: "Value" }] },
        {
          column: 0,
          header: false,
          align: "left",
          runs: [{ text: "alpha\nsecond\nthird\n" }, { text: "fourth", strong: true }],
        },
        {
          column: 1,
          header: false,
          align: "left",
          runs: [
            { text: "one", strong: true },
            { text: " " },
            { text: "<br>", code: true },
            { text: " <br>" },
          ],
        },
      ],
    });
    expect(markdownBlocks("```ts\nconst x = `literal`;\n", "m", false, true)[0]?.pending).toBe(
      true,
    );
    expect(markdownBlocks("```ts\nconst x = `literal`;\n```", "m", false, true)[0]?.pending).toBe(
      false,
    );
    expect(markdownBlocks("```ts\nunfinished", "m", false, false)[0]?.pending).toBe(false);
    expect(markdownBlocks("```txt\r\n\tkeep  spaces  \r\n\r\n```", "copy")[0]?.body).toBe(
      "\tkeep  spaces  ",
    );
    expect(markdownBlocks("~~~txt\nline one\n\nline three\n\n~~~", "copy")[0]?.body).toBe(
      "line one\n\nline three",
    );
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  });

  test("keeps screenshot sources and surrounding prose in order", () => {
    expect(
      markdownBlocks(
        "![Screen &amp; **one**](/tmp/screen%20one.png?x=1&amp;y=2)\n\n![Reference][shot]\n\n[shot]: https://example.com/screen.png",
        "screenshots",
        false,
        true,
      ),
    ).toMatchObject([
      {
        kind: "image",
        imageSource: "/tmp/screen%20one.png?x=1&y=2",
        imageAlt: "Screen & one",
        runs: [],
        pending: false,
      },
      {
        kind: "image",
        imageSource: "https://example.com/screen.png",
        imageAlt: "Reference",
        runs: [],
        pending: false,
      },
    ]);
    const mixed = markdownBlocks(
      "> - **Before ![First](./first.png) *after*** and ![Second][second] done.\n>\n> [second]: /tmp/second.png",
      "mixed",
    );
    expect(mixed).toMatchObject([
      {
        kind: "list-item",
        marker: "•",
        runs: [{ text: "Before ", strong: true }],
        imageSource: "",
        imageAlt: "",
      },
      { kind: "image", marker: "", imageSource: "./first.png", imageAlt: "First" },
      {
        kind: "quote",
        marker: "",
        runs: [
          { text: " ", strong: true, emphasis: false },
          { text: "after", strong: true, emphasis: true },
          { text: " and ", strong: false, emphasis: false },
        ],
      },
      { kind: "image", marker: "", imageSource: "/tmp/second.png", imageAlt: "Second" },
      { kind: "quote", marker: "", runs: [{ text: " done." }] },
    ]);
    expect(
      mixed.every((block) => block.depth === 1 && block.quoteDepth === 1 && block.gutter === 14),
    ).toBe(true);
    expect(new Set(mixed.map((block) => block.id)).size).toBe(mixed.length);
    expect(
      markdownBlocks(
        "- ![](./empty-alt.png)\n\n## Before ![Heading](./heading.png) after",
        "nested",
      ),
    ).toMatchObject([
      {
        kind: "image",
        marker: "•",
        depth: 1,
        gutter: 14,
        imageAlt: "",
        imageSource: "./empty-alt.png",
      },
      { kind: "heading", headingLevel: 2, runs: [{ text: "Before " }] },
      { kind: "image", imageAlt: "Heading", imageSource: "./heading.png" },
      { kind: "heading", headingLevel: 2, runs: [{ text: " after" }] },
    ]);
    expect(
      markdownBlocks("| Screenshot |\n| --- |\n| ![Cell](./cell.png) |", "table")[0]?.cells,
    ).toMatchObject([
      { runs: [{ text: "Screenshot" }], parts: [{ runs: [{ text: "Screenshot" }] }] },
      {
        runs: [],
        parts: [{ imageSource: "./cell.png", imageAlt: "Cell", inlineImage: false }],
      },
    ]);
    const tableImages = markdownBlocks(
      '| Screenshot |\n| --- |\n| **Before ![First](./first.png) after**<br><img alt="Second" src="https://example.com/second.png?a=1&#124;2"> tail ![Last](./last.png) |',
      "table-images",
    )[0]!;
    expect(tableImages.cells[1]?.parts).toMatchObject([
      { runs: [{ text: "Before ", strong: true }], imageSource: "" },
      { imageSource: "./first.png", imageAlt: "First", inlineImage: true, runs: [] },
      { runs: [{ text: " after", strong: true }, { text: "\n" }], imageSource: "" },
      {
        imageSource: "https://example.com/second.png?a=1%7C2",
        imageAlt: "Second",
        inlineImage: false,
      },
      { runs: [{ text: " tail " }], imageSource: "" },
      { imageSource: "./last.png", imageAlt: "Last", inlineImage: true },
    ]);
    const partIds = tableImages.cells.flatMap((cell) => cell.parts.map((part) => part.id));
    expect(new Set(partIds).size).toBe(partIds.length);
    expect(tableImages.tableSignature).not.toBe(
      markdownBlocks("| Screenshot |\n| --- |\n| Before after tail |", "table-images")[0]
        ?.tableSignature,
    );
    expect(
      markdownBlocks(
        "`![literal](./literal.png)`\n\n![unfinished](./screen\n\n```md\n![fenced](./fenced.png)",
        "pending",
        false,
        true,
      ),
    ).toMatchObject([
      { kind: "paragraph", runs: [{ text: "![literal](./literal.png)", code: true }] },
      { kind: "paragraph", runs: [{ text: "![unfinished](./screen" }] },
      { kind: "code", body: "![fenced](./fenced.png)", pending: true },
    ]);
    expect(
      markdownBlocks(
        '<details data-example="`"><summary>Screenshots</summary>\n<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />\n</details>\n\nBefore <IMG ALT="&amp;lt;" SRC="https://example.com/shot.png?label=&amp;lt;&amp;sig=a%26b"> after',
        "html-images",
      ),
    ).toMatchObject([
      { kind: "paragraph", runs: [{ text: "Screenshots", strong: true }] },
      {
        kind: "image",
        imageSource: "https://example.com/before.png?a=1&b=2",
        imageAlt: "Before > after [settings]",
      },
      { kind: "paragraph", runs: [{ text: "Before " }] },
      {
        kind: "image",
        imageSource: "https://example.com/shot.png?label=&lt;&sig=a%26b",
        imageAlt: "&lt;",
      },
      { kind: "paragraph", runs: [{ text: " after" }] },
    ]);
    const htmlLiterals = markdownBlocks(
      '<!-- ` ignored -->\n\n`<img src="inline.png">`\n\n    <img src="indented.png">\n\n<div>\n<img src="before.png">\n```html\n<img src="fenced.png">\n</div>',
      "html-literals",
      false,
      true,
    );
    expect(htmlLiterals.filter((block) => block.kind === "image")).toMatchObject([
      { imageSource: "before.png" },
    ]);
    expect(htmlLiterals.filter((block) => block.kind === "code")).toMatchObject([
      { body: '<img src="indented.png">' },
      { body: '<img src="fenced.png">\n</div>', pending: true },
    ]);
    expect(
      htmlLiterals.some((block) =>
        block.runs.some((run) => run.text === '<img src="inline.png">' && run.code),
      ),
    ).toBe(true);
  });
});
