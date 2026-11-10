import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText } from "./terminal-output";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const records = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const active = new Set(["idle", "pending", "running", "waiting"]);
const types = new Set(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool"]);
const DETAIL_LIMIT = 256 * 1024;
const TRANSPORT_TRUNCATION_MARKER = "\n… output truncated for transport";
const T3_TOOL_SUBJECTS: Record<string, readonly [string, string]> = {
  thread: ["a T3 thread", "T3 threads"], project: ["a project", "projects"],
  environment: ["an environment", "environments"], worktree: ["a workspace branch", "workspace branches"],
  queue: ["a queued message", "queued messages"], pending_request: ["pending questions", "pending questions"],
};

export interface ToolSummary {
  category: "command" | "file-change" | "search" | "mcp" | "tool";
  status: "pending" | "running" | "completed" | "error" | "interrupted";
  title: string;
  symbol: string;
  revision: string;
  exitLabel: string;
}

export interface ToolRequest {
  rowId: string;
  revision: string;
  retry: number;
}

export interface ToolPanel {
  rowId: string;
  revision: string;
  retry: number;
  state: "loading" | "ready" | "error" | "missing";
  input: string;
  output: string;
  truncated: boolean;
  error: string;
}

export interface ToolBatch {
  viewKey: string;
  panels: ToolPanel[];
}

export function summarized(value: unknown): boolean {
  const item = record(value);
  return item.truncated === true && typeof item.summary === "string";
}

export function toolRevision(item: RecordValue): string {
  return active.has(text(item.status)) ? "live" : text(item.updatedAt);
}

function t3ToolTitle(toolName: string, input: unknown): string | null {
  const label = toolName.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  const namespaced = /^(?:mcp__)?(?:t3[-_]code(?:[-_]direct)?|t3code)(?:__|[.:/]|\s*·\s*)(.+)$/i.exec(label);
  const name = namespaced?.[1] ?? (/^t3_/.test(label) ? label : "");
  if (!name) return null;
  const call = /^(?:t3_)?(thread|project|environment|worktree|queue|pending_request)_(.+)$/.exec(name);
  const actionTool = /^(?:t3_)?(queue|pending_request)$/.exec(name);
  const family = call?.[1] ?? actionTool?.[1];
  const action = call?.[2] ?? (actionTool ? text(record(input).action) : "");
  if (family && action) {
    if (family === "thread" && action === "configure") return "Use thread model settings";
    if (family === "thread" && action === "configuration") return "Read thread configuration";
    const subject = T3_TOOL_SUBJECTS[family]!;
    const verb = action === "respond" ? "Answer" : action[0]!.toUpperCase() + action.slice(1).replaceAll("_", " ");
    return `${verb}${action === "wait" ? " for" : action === "send" ? " to" : ""} ${subject[action === "list" ? 1 : 0]}`;
  }
  const words = name.replace(/^t3_/, "").split("_");
  return words.map((word, index) => index === 0 ? word[0]?.toUpperCase() + word.slice(1) : word).join(" ");
}

export function toolSummary(item: RecordValue): ToolSummary | null {
  if (!types.has(text(item.type))) return null;
  const output = record(item.output);
  const failed = item.status === "failed" || (item.type === "command_execution"
    ? typeof item.exitCode === "number" ? item.exitCode !== 0 : item.outputIndicatesFailure === true
    : output.isError === true || output.is_error === true);
  const status: ToolSummary["status"] = failed ? "error"
    : item.status === "cancelled" || item.status === "interrupted" ? "interrupted"
      : item.status === "pending" || item.status === "idle" ? "pending"
        : active.has(text(item.status)) ? "running" : "completed";
  let category: ToolSummary["category"] = "tool";
  let symbol = "wrench.and.screwdriver";
  let title = text(item.title);
  switch (item.type) {
    case "command_execution":
      category = "command";
      symbol = "terminal";
      title = text(item.input) || title || "Command";
      break;
    case "file_change": {
      category = "file-change";
      symbol = "square.and.pencil";
      const count = records(item.changes).length;
      title ||= count > 1 ? `Changed ${count} files` : `Changed ${text(item.fileName) || "file"}`;
      break;
    }
    case "file_search":
      category = "search";
      symbol = "magnifyingglass";
      title ||= text(item.pattern) ? `Searched for ${text(item.pattern)}` : "Searched files";
      break;
    case "web_search":
      category = "search";
      symbol = "globe";
      title ||= "Searched the web";
      break;
    case "dynamic_tool":
      category = /(?:^|[._])mcp(?:[._]|$)|^mcp__/i.test(text(item.toolName)) ? "mcp" : "tool";
      title = t3ToolTitle(text(item.toolName), item.input) || title || text(item.toolName) || "Tool call";
      break;
  }
  return {
    category, status, title: title.replace(/\s+/gu, " ").trim().slice(0, 180), symbol, revision: toolRevision(item),
    exitLabel: item.type === "command_execution" && typeof item.exitCode === "number" && item.exitCode !== 0 ? `exit ${item.exitCode}` : "",
  };
}

export function toolNeedsDetail(item: RecordValue, streaming: boolean): boolean {
  if (item.type === "command_execution") return !streaming && item.outputOmitted === true;
  if (item.type === "file_change") return item.diffStr === undefined && item.oldStr === undefined && item.newStr === undefined;
  return item.type === "dynamic_tool" && (item.outputOmitted === true || summarized(item.input));
}

function outputText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => outputText(part, depth + 1));
    return parts.every((part) => part !== null) ? parts.filter(Boolean).join("\n") : null;
  }
  const item = record(value);
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "image") return "[image]";
  if (item.type === "resource_link" && typeof item.uri === "string") return item.uri;
  if (item.type === "resource") {
    const resource = record(item.resource);
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.uri === "string") return resource.uri;
  }
  const keys = Object.keys(item).filter((key) => key !== "isError" && key !== "is_error");
  if (keys.length === 1 && keys[0] === "content") return outputText(item.content, depth + 1);
  if (keys.length === 2 && keys.includes("content") && keys.includes("structuredContent")) {
    const content = outputText(item.content, depth + 1);
    const images = records(item.content).filter((block) => block.type === "image");
    const structured = formatJson(item.structuredContent);
    if (structured && (images.length > 0 || !content?.trim()))
      return [structured, outputText(images, depth + 1)].filter(Boolean).join("\n");
    return content?.trim() ? content : null;
  }
  return null;
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null || typeof value === "string" && !value.trim()) return "";
  const json = JSON.stringify(value, null, 2) ?? "";
  return json === "{}" || json === "[]" ? "" : json;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (summarized(value)) return text(record(value).summary);
  const readable = outputText(value);
  if (readable !== null) return readable;
  return formatJson(value);
}

function commandOutput(value: unknown): string {
  const output = text(value);
  try {
    const parsed = record(JSON.parse(output));
    if (typeof parsed.stdout === "string" && typeof parsed.stderr === "string" && typeof parsed.interrupted === "boolean")
      return [parsed.stdout, parsed.stderr].filter((part) => part.trim()).join("\n");
  } catch {}
  return output;
}

export function toolBody(item: RecordValue): Pick<ToolPanel, "input" | "output" | "truncated"> {
  let input = "";
  let output = "";
  let truncated = summarized(item.input) || summarized(item.output);
  switch (item.type) {
    case "command_execution": {
      input = text(item.input);
      const terminal = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, commandOutput(item.output));
      output = terminalOutputPlainText(terminal.text);
      truncated ||= terminal.truncated;
      break;
    }
    case "dynamic_tool":
      input = summarized(item.input) ? text(record(item.input).summary)
        : typeof item.input === "string" && item.input !== "" ? item.input
          : JSON.stringify(item.input, null, 2) ?? "";
      output = item.outputOmitted === true ? "" : formatValue(item.output);
      break;
    case "file_change":
      input = records(item.changes).map((change) => [text(change.operation), text(change.oldPath), text(change.path)].filter(Boolean).join(" ")).join("\n") || text(item.fileName);
      output = text(item.diffStr) || [text(item.oldStr) && `Before\n${text(item.oldStr)}`, text(item.newStr) && `After\n${text(item.newStr)}`].filter(Boolean).join("\n\n");
      break;
    case "file_search":
      input = text(item.pattern);
      output = records(item.results).map((result) => [text(result.fileName) + (typeof result.line === "number" ? `:${result.line}` : ""), text(result.preview)].filter(Boolean).join("\n")).join("\n");
      break;
    case "web_search":
      input = Array.isArray(item.patterns) ? item.patterns.map(text).join("\n") : "";
      output = records(item.results).map((result) => [text(result.title), text(result.url), text(result.snippet)].filter(Boolean).join("\n")).join("\n\n");
      break;
  }
  return {
    input: input.slice(0, DETAIL_LIMIT), output: output.slice(0, DETAIL_LIMIT),
    truncated: truncated || input.length > DETAIL_LIMIT || output.length > DETAIL_LIMIT ||
      input.includes(TRANSPORT_TRUNCATION_MARKER) || output.includes(TRANSPORT_TRUNCATION_MARKER),
  };
}
