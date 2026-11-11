import { expect, test } from "bun:test";
import { toolBody, toolSummary } from "../tool-activity";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputPlainText,
} from "../terminal-output";

test.each([
  {
    item: {
      type: "command_execution",
      status: "completed",
      exitCode: 0,
      outputIndicatesFailure: true,
    },
    expected: "completed",
  },
  { item: { type: "command_execution", status: "failed", exitCode: 0 }, expected: "error" },
  { item: { type: "command_execution", status: "completed", exitCode: 2 }, expected: "error" },
  {
    item: { type: "command_execution", status: "completed", outputIndicatesFailure: true },
    expected: "error",
  },
  {
    item: { type: "dynamic_tool", status: "completed", output: { isError: true } },
    expected: "error",
  },
  { item: { type: "command_execution", status: "interrupted" }, expected: "interrupted" },
])("activity status reflects the authoritative result: %j", ({ item, expected }) => {
  expect(toolSummary(item)?.status).toBe(expected);
});

test.each([
  { input: null, expected: "null" },
  { input: "", expected: '""' },
  { input: { text: "", value: null }, expected: '{\n  "text": "",\n  "value": null\n}' },
  {
    input: { content: "keep", other: "also keep" },
    expected: '{\n  "content": "keep",\n  "other": "also keep"\n}',
  },
])("tool input preserves explicit reset arguments: %j", ({ input, expected }) => {
  expect(toolBody({ type: "dynamic_tool", input }).input).toBe(expected);
});

test.each([
  { toolName: "mcp__t3_code__t3_thread_read", expected: "Read a T3 thread" },
  { toolName: "t3-code-direct.t3_thread_list", expected: "List T3 threads" },
  { toolName: "mcp__t3_code_direct__t3_thread_wait", expected: "Wait for a T3 thread" },
  { toolName: "t3_thread_send", expected: "Send to a T3 thread" },
  {
    toolName: "mcp__t3_code__t3_queue",
    input: { action: "read" },
    expected: "Read a queued message",
  },
  { toolName: "mcp__other__t3_thread_read", expected: "mcp__other__t3_thread_read" },
])("T3 tool names use friendly action labels: %j", ({ toolName, input, expected }) => {
  expect(toolSummary({ type: "dynamic_tool", toolName, input })?.title).toBe(expected);
});

test.each([
  { input: "pwd", expected: "Running pwd" },
  { input: "cd /tmp && env CI=1 bun test", expected: "Running bun" },
  { input: "/bin/zsh -lc 'git status'", expected: "Running git" },
])("live commands use Expo's program label: %j", ({ input, expected }) => {
  expect(toolSummary({ type: "command_execution", status: "running", input })?.displayTitle).toBe(
    expected,
  );
});

test.each([
  { input: "/bin/zsh -lc 'git status'", expected: "git status" },
  { input: "bash -o pipefail -c 'rg foo | head -10'", expected: "rg foo | head -10" },
  { input: 'zsh -lc "printf \\n"', expected: "printf \\n" },
  { input: "zsh -lc 'printf '\"'\"'hello'\"'\"''", expected: "printf 'hello'" },
  {
    input: "zsh -lc 'printf %s \"$1\"' label value",
    expected: "zsh -lc 'printf %s \"$1\"' label value",
  },
  { input: "zsh -lc 'pwd", expected: "zsh -lc 'pwd" },
  { input: "zsh -lc 'pwd' && whoami", expected: "zsh -lc 'pwd' && whoami" },
  { input: "zsh -lc 'pwd' > result", expected: "zsh -lc 'pwd' > result" },
  { input: "zsh -lc ''", expected: "zsh -lc ''" },
  { input: "printf '\u001b[31mred'", expected: "printf '␛[31mred'" },
])(
  "command display unwraps a complete shell script while detail preserves input: %j",
  ({ input, expected }) => {
    expect(toolSummary({ type: "command_execution", status: "completed", input })?.title).toBe(
      expected,
    );
    expect(toolBody({ type: "command_execution", input }).input).toBe(input);
  },
);

test("reasoning preserves previews and exposes Markdown blocks for expanded detail", () => {
  const item = {
    id: "thought",
    type: "reasoning",
    text: "**Check the branch**\n\nBefore\\rAfter",
    status: "completed",
  };
  expect(toolSummary(item)).toMatchObject({
    category: "reasoning",
    title: "**Check the branch** Before\\rAfter",
    symbol: "brain",
    live: false,
  });
  expect(toolSummary({ ...item, status: "running" })).toMatchObject({
    displayTitle: "Thinking",
    live: true,
  });
  const body = toolBody(item);
  expect(body).toMatchObject({ input: "", output: item.text, images: [], truncated: false });
  expect(
    body.blocks.map((block) => block.runs.map((run) => ({ text: run.text, strong: run.strong }))),
  ).toEqual([
    [{ text: "Check the branch", strong: true }],
    [{ text: "Before\\rAfter", strong: false }],
  ]);
});

test("tool output unwraps resources and reports truncated bodies", () => {
  expect(
    toolBody({
      type: "dynamic_tool",
      output: { content: [{ type: "image" }], structuredContent: { temp: 21 } },
    }).output,
  ).toBe('{\n  "temp": 21\n}');
  expect(
    toolBody({
      type: "dynamic_tool",
      output: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    }).images,
  ).toEqual([
    {
      url: "data:image/png;base64,aGVsbG8=",
      alt: "Tool output image",
      mimeType: "image/png",
      expiresAt: Number.MAX_SAFE_INTEGER,
      error: "",
    },
  ]);
  expect(
    toolBody({
      type: "dynamic_tool",
      output: {
        content: [
          { type: "text", text: "Screenshot" },
          { type: "image", mimeType: "image/svg+xml", data: "AA==" },
          { type: "image", source: { type: "url", media_type: "image/png", data: "AA==" } },
          { content: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
          { type: "image", mimeType: "image/png", source: [] },
          { type: "image", source: { type: "base64", media_type: "image/JPEG", data: "AQID" } },
        ],
      },
    }).images,
  ).toEqual([
    { url: "", alt: "Tool output image", mimeType: "image/png", expiresAt: 0, error: "" },
    {
      url: "data:image/jpeg;base64,AQID",
      alt: "Tool output image",
      mimeType: "image/jpeg",
      expiresAt: Number.MAX_SAFE_INTEGER,
      error: "",
    },
  ]);
  expect(
    toolBody({
      type: "dynamic_tool",
      output: { content: [{ type: "text", text: "Summary" }], result: { count: 42 } },
    }).output,
  ).toBe(
    '{\n  "content": [\n    {\n      "type": "text",\n      "text": "Summary"\n    }\n  ],\n  "result": {\n    "count": 42\n  }\n}',
  );
  expect(
    toolBody({
      type: "dynamic_tool",
      output: {
        content: [{ type: "text", text: "Summary" }],
        structuredContent: { count: 42 },
        isError: false,
      },
    }).output,
  ).toBe("Summary");
  expect(
    toolBody({ type: "dynamic_tool", output: { content: [], structuredContent: { count: 42 } } })
      .output,
  ).toBe('{\n  "count": 42\n}');
  expect(
    toolBody({
      type: "dynamic_tool",
      input: {},
      output: {
        content: [
          { type: "text", text: "Result" },
          { type: "resource_link", uri: "https://example.test/result" },
          { type: "resource", resource: { uri: "file:///result", text: "embedded text" } },
        ],
      },
    }),
  ).toEqual({
    input: "{}",
    output: "Result\nhttps://example.test/result\nembedded text",
    images: [],
    blocks: [],
    truncated: false,
  });
  expect(
    toolBody({
      type: "dynamic_tool",
      input: {},
      output: { truncated: true, summary: "Large result" },
    }),
  ).toEqual({ input: "{}", output: "Large result", images: [], blocks: [], truncated: true });
  const transportText = "部分内容\n… output truncated for transport";
  for (const item of [
    { type: "command_execution", input: "build", output: transportText },
    {
      type: "dynamic_tool",
      input: {},
      output: { content: [{ type: "text", text: transportText }, { type: "image" }] },
    },
    { type: "dynamic_tool", input: transportText, output: "Done" },
    { type: "file_change", fileName: "app.ts", oldStr: transportText, newStr: "Updated" },
  ])
    expect(toolBody(item).truncated).toBe(true);
  expect(
    toolBody({
      type: "dynamic_tool",
      input: {},
      output: "Document the phrase output truncated for transport.",
    }).truncated,
  ).toBe(false);
});

test("command output retains split escapes, carriage returns and cursor edits", () => {
  let output = appendTerminalOutput(
    EMPTY_TERMINAL_OUTPUT,
    "progress 1\rprogress 2\u001b[K\n\u001b[3",
  );
  output = appendTerminalOutput(output, "1mred\u001b[0m\nsecond\u001b[1A\rGREEN\u001b[K");
  expect(terminalOutputPlainText(output.text)).toBe("progress 2\nGREEN\nsecond");
  expect(output.truncated).toBe(false);
});
