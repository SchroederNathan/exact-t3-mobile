import { describe, expect, test } from "bun:test";
import { markdownBlocks } from "./markdown";

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
    expect(markdownBlocks("- first\n- second", "m").map((block) => block.spacingAfter)).toEqual([
      0, 8,
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
    const table = "| Name | Value |\n| --- | --- |\n| alpha | **one** |";
    expect(markdownBlocks(table, "m")[0]).toMatchObject({ kind: "markdown", body: table });
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  });
});
