import { expect, test } from "bun:test";
import { toolBody, toolSummary } from "./tool-activity";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText } from "./terminal-output";

test.each([
  { item: { type: "command_execution", status: "completed", exitCode: 0, outputIndicatesFailure: true }, expected: "completed" },
  { item: { type: "command_execution", status: "failed", exitCode: 0 }, expected: "error" },
  { item: { type: "command_execution", status: "completed", exitCode: 2 }, expected: "error" },
  { item: { type: "command_execution", status: "completed", outputIndicatesFailure: true }, expected: "error" },
  { item: { type: "dynamic_tool", status: "completed", output: { isError: true } }, expected: "error" },
  { item: { type: "command_execution", status: "interrupted" }, expected: "interrupted" },
])("activity status reflects the authoritative result: %j", ({ item, expected }) => {
  expect(toolSummary(item)?.status).toBe(expected);
});

test.each([
  { input: null, expected: "null" },
  { input: "", expected: '""' },
  { input: { text: "", value: null }, expected: '{\n  "text": "",\n  "value": null\n}' },
  { input: { content: "keep", other: "also keep" }, expected: '{\n  "content": "keep",\n  "other": "also keep"\n}' },
])("tool input preserves explicit reset arguments: %j", ({ input, expected }) => {
  expect(toolBody({ type: "dynamic_tool", input }).input).toBe(expected);
});

test.each([
  { toolName: "mcp__t3_code__t3_thread_read", expected: "Read a T3 thread" },
  { toolName: "t3-code-direct.t3_thread_list", expected: "List T3 threads" },
  { toolName: "mcp__t3_code_direct__t3_thread_wait", expected: "Wait for a T3 thread" },
  { toolName: "t3_thread_send", expected: "Send to a T3 thread" },
  { toolName: "mcp__t3_code__t3_queue", input: { action: "read" }, expected: "Read a queued message" },
  { toolName: "mcp__other__t3_thread_read", expected: "mcp__other__t3_thread_read" },
])("T3 tool names use friendly action labels: %j", ({ toolName, input, expected }) => {
  expect(toolSummary({ type: "dynamic_tool", toolName, input })?.title).toBe(expected);
});

test("tool output unwraps resources and reports truncated bodies", () => {
  expect(toolBody({ type: "dynamic_tool", output: { content: [{ type: "image" }], structuredContent: { temp: 21 } } }).output).toBe('{\n  "temp": 21\n}\n[image]');
  expect(toolBody({ type: "dynamic_tool", output: { content: [{ type: "text", text: "Summary" }], result: { count: 42 } } }).output).toBe('{\n  "content": [\n    {\n      "type": "text",\n      "text": "Summary"\n    }\n  ],\n  "result": {\n    "count": 42\n  }\n}');
  expect(toolBody({ type: "dynamic_tool", output: { content: [{ type: "text", text: "Summary" }], structuredContent: { count: 42 }, isError: false } }).output).toBe("Summary");
  expect(toolBody({ type: "dynamic_tool", output: { content: [], structuredContent: { count: 42 } } }).output).toBe('{\n  "count": 42\n}');
  expect(toolBody({ type: "dynamic_tool", input: {}, output: { content: [
    { type: "text", text: "Result" }, { type: "resource_link", uri: "https://example.test/result" },
    { type: "resource", resource: { uri: "file:///result", text: "embedded text" } },
  ] } })).toEqual({ input: "{}", output: "Result\nhttps://example.test/result\nembedded text", truncated: false });
  expect(toolBody({ type: "dynamic_tool", input: {}, output: { truncated: true, summary: "Large result" } })).toEqual({ input: "{}", output: "Large result", truncated: true });
  const transportText = "部分内容\n… output truncated for transport";
  for (const item of [
    { type: "command_execution", input: "build", output: transportText },
    { type: "dynamic_tool", input: {}, output: { content: [{ type: "text", text: transportText }, { type: "image" }] } },
    { type: "dynamic_tool", input: transportText, output: "Done" },
    { type: "file_change", fileName: "app.ts", oldStr: transportText, newStr: "Updated" },
  ]) expect(toolBody(item).truncated).toBe(true);
  expect(toolBody({ type: "dynamic_tool", input: {}, output: "Document the phrase output truncated for transport." }).truncated).toBe(false);
});

test("command output retains split escapes, carriage returns and cursor edits", () => {
  let output = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "progress 1\rprogress 2\u001b[K\n\u001b[3");
  output = appendTerminalOutput(output, "1mred\u001b[0m\nsecond\u001b[1A\rGREEN\u001b[K");
  expect(terminalOutputPlainText(output.text)).toBe("progress 2\nGREEN\nsecond");
  expect(output.truncated).toBe(false);
});
