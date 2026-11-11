import { expect, test } from "bun:test";
import {
  markdownLinkKind,
  parseFileLink,
  parseThreadLink,
  resolveThreadLink,
} from "../markdown-links";

test("thread links preserve written escapes, decode hosted segments once, and resolve within their scope", () => {
  expect(parseThreadLink("t3-thread://v1/thread%252Fpart")).toEqual({
    environmentId: null,
    threadId: "thread%252Fpart",
  });
  expect(parseThreadLink("https://app.t3.codes/threads/mac/thread%252Fpart")).toEqual({
    environmentId: "mac",
    threadId: "thread%2Fpart",
  });
  expect(parseThreadLink("t3-thread://v2/mac/thread%2Fpart")).toEqual({
    environmentId: "mac",
    threadId: "thread%2Fpart",
  });
  const refs = [
    { environmentId: "a", threadId: "t" },
    { environmentId: "b", threadId: "t" },
    { environmentId: "b", threadId: "slash/part" },
  ];
  expect(resolveThreadLink({ environmentId: null, threadId: "t" }, "a", refs)).toEqual({
    environmentId: "a",
    threadId: "t",
  });
  expect(resolveThreadLink({ environmentId: null, threadId: "slash%2Fpart" }, "a", refs)).toEqual({
    environmentId: "b",
    threadId: "slash/part",
  });
  expect(() => resolveThreadLink({ environmentId: null, threadId: "t" }, "c", refs)).toThrow(
    "more than one environment",
  );
  expect(() =>
    resolveThreadLink({ environmentId: "a", threadId: "slash/part" }, "b", refs),
  ).toThrow("unavailable");
});

test("file destinations preserve host paths, Unicode, and positions without interpreting external links", () => {
  const cases = [
    ["src/a.ts:4:2#L8C3", { path: "src/a.ts", line: 4, column: 2 }],
    ["src/a.ts:4#L8C3", { path: "src/a.ts", line: 4, column: 0 }],
    ["src/app.ts:12:3", { path: "src/app.ts", line: 12, column: 3 }],
    [
      "file:///Users/nate/My%20Project/中文.ts#L8C2",
      { path: "/Users/nate/My Project/中文.ts", line: 8, column: 2 },
    ],
    [
      "/Volumes/ExternalSSD/a%252Fb.ts:4",
      { path: "/Volumes/ExternalSSD/a%2Fb.ts", line: 4, column: 0 },
    ],
    ["./README", { path: "./README", line: 0, column: 0 }],
    ["lib/pipe.ts#L3", { path: "lib/pipe.ts", line: 3, column: 0 }],
    ["https://example.com/file.ts", null],
    ["javascript:alert(1)", null],
    ["mailto:me@example.com", null],
    ["#section", null],
  ] as const;
  for (const [href, result] of cases) expect(parseFileLink(href)).toEqual(result);
  for (const path of [
    "Makefile",
    "makefile",
    "GNUmakefile",
    "Dockerfile",
    "Containerfile",
    "Justfile",
    "justfile",
    "Rakefile",
    "Gemfile",
    "Procfile",
    "Brewfile",
    "Caddyfile",
    "Vagrantfile",
    "Jenkinsfile",
    "Podfile",
    "Fastfile",
    "BUILD",
    "WORKSPACE",
    "LICENSE",
    "LICENCE",
    "COPYING",
    "NOTICE",
    "AUTHORS",
    "CONTRIBUTORS",
    "CHANGELOG",
    "README",
    "CODEOWNERS",
  ]) {
    expect(parseFileLink(path)).toEqual({ path, line: 0, column: 0 });
  }
  expect(markdownLinkKind("https://app.t3.codes/threads/mac/thread")).toBe("thread");
  expect(markdownLinkKind("https://example.com")).toBe("external");
  expect(markdownLinkKind("src/app.ts:2")).toBe("file");
  expect(markdownLinkKind("javascript:alert(1)")).toBe("");
});
