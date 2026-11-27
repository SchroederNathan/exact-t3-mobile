import { expect, test } from "bun:test";
import { excerptRuns } from "../search-excerpt";

test("matching emphasis preserves original text, accents and emoji", () => {
  const text = "🌿 Café or CAFE\u0301?";
  const runs = excerptRuns(text, "“cafe”");
  expect(runs.map(run => run.text).join("")).toBe(text);
  expect(runs.filter(run => run.highlighted).map(run => run.text)).toEqual(["Café", "CAFE\u0301"]);
});

test("overlapping words merge and punctuation matches literally", () => {
  const matches = excerptRuns("Reopened (.NET) [x]", "open opened .net [x]");
  expect(matches.filter(run => run.highlighted).map(run => run.text)).toEqual(["opened", ".NET", "[x]"]);
  expect(excerptRuns("Anything", " ")).toEqual([{ start: 0, text: "Anything", highlighted: false }]);
});
