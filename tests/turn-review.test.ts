import { expect, test } from "bun:test";
import { projectTurnDiff } from "../turn-review";

test("projects unified hunks with independent old and new line numbers", () => {
  const rows = projectTurnDiff(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -7,3 +7,4 @@ function render() {",
      " context",
      "-old",
      "+new",
      "+extra",
      " tail",
      "\\ No newline at end of file",
      "@@ -20 +21 @@",
      "-last",
      "+updated",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+",
      "",
    ].join("\n"),
  );
  expect(rows.map(({ kind, text, oldLine, newLine }) => [kind, text, oldLine, newLine])).toEqual([
    ["file", "src/app.ts", "", ""],
    ["meta", "index 1111111..2222222 100644", "", ""],
    ["hunk", "@@ -7,3 +7,4 @@ function render() {", "", ""],
    ["context", "context", "7", "7"],
    ["deletion", "old", "8", ""],
    ["addition", "new", "", "8"],
    ["addition", "extra", "", "9"],
    ["context", "tail", "9", "10"],
    ["meta", "\\ No newline at end of file", "", ""],
    ["hunk", "@@ -20 +21 @@", "", ""],
    ["deletion", "last", "20", ""],
    ["addition", "updated", "", "21"],
    ["file", "new.txt", "", ""],
    ["meta", "new file mode 100644", "", ""],
    ["hunk", "@@ -0,0 +1,2 @@", "", ""],
    ["addition", "first", "", "1"],
    ["addition", "", "", "2"],
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
});

test("retains rename and binary metadata and decodes quoted Git paths", () => {
  const rows = projectTurnDiff(
    [
      'diff --git "a/old\\tname.png" "b/caf\\303\\251.png"',
      "similarity index 100%",
      'rename from "old\\tname.png"',
      'rename to "caf\\303\\251.png"',
      'Binary files "a/old\\tname.png" and "b/caf\\303\\251.png" differ',
      "diff --git a/picture.png b/picture.png",
      "GIT binary patch",
      "literal 2",
      "+opaque-encoded-data",
      "",
      "diff --git a/removed.txt b/removed.txt",
      "deleted file mode 100644",
      "--- a/removed.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n"),
  );
  expect(rows.filter((row) => row.kind === "file").map((row) => row.text)).toEqual([
    "café.png",
    "picture.png",
    "removed.txt",
  ]);
  expect(rows.filter((row) => row.kind === "meta").map((row) => row.text)).toEqual([
    "similarity index 100%",
    "rename from old\tname.png",
    "rename to café.png",
    'Binary files "a/old\\tname.png" and "b/caf\\303\\251.png" differ',
    "Binary file changed",
    "deleted file mode 100644",
  ]);
  expect(rows.at(-1)).toMatchObject({
    kind: "deletion",
    text: "removed",
    oldLine: "1",
    newLine: "",
  });
  expect(
    projectTurnDiff(
      'diff --git "a/quote\\\"and\\\\path\\t😀.txt" "b/quote\\\"and\\\\path\\t😀.txt"',
    )[0]?.text,
  ).toBe('quote"and\\path\t😀.txt');
});

test("recognizes plain patch headers without confusing header-looking hunk content", () => {
  const rows = projectTurnDiff(
    [
      "--- old file.txt\t2026-11-11 01:00:00",
      "+++ new file.txt\t2026-11-11 01:01:00",
      "@@ -2,2 +2,2 @@",
      "--- old content",
      "+++ new content",
      " ",
      "--- second.txt",
      "+++ second.txt",
      "@@ -3 +3 @@",
      "-before",
      "+after",
      "",
    ].join("\r\n"),
  );
  expect(rows.map(({ kind, text, oldLine, newLine }) => [kind, text, oldLine, newLine])).toEqual([
    ["file", "old file.txt → new file.txt", "", ""],
    ["hunk", "@@ -2,2 +2,2 @@", "", ""],
    ["deletion", "-- old content", "2", ""],
    ["addition", "++ new content", "", "2"],
    ["context", "", "3", "3"],
    ["file", "second.txt", "", ""],
    ["hunk", "@@ -3 +3 @@", "", ""],
    ["deletion", "before", "3", ""],
    ["addition", "after", "", "3"],
  ]);
});

test("preserves unsupported patch text instead of presenting it as an empty diff", () => {
  expect(projectTurnDiff("")).toEqual([]);
  expect(projectTurnDiff("\n\r\n")).toEqual([]);
  expect(projectTurnDiff("diff --cc merged.txt\n@@@ -1,1 -1,1 +1,1 @@@\n++merged")).toEqual([
    { id: "0", kind: "file", text: "merged.txt", oldLine: "", newLine: "" },
    { id: "1", kind: "meta", text: "@@@ -1,1 -1,1 +1,1 @@@", oldLine: "", newLine: "" },
    { id: "2", kind: "meta", text: "++merged", oldLine: "", newLine: "" },
  ]);
});
