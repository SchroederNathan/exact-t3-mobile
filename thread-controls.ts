import { markdownBlocks, type InlineRun } from "./markdown";
import type { StoredAttachment } from "./attachments";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const records = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);

export interface Question {
  id: string;
  header: string;
  text: string;
  runs: InlineRun[];
  multi: boolean;
  custom: boolean;
  initial: string;
  hasInitial: boolean;
  options: { id: string; label: string; description: string; value: string; exact: boolean }[];
}
export interface QuestionDraft {
  key: string;
  questionId: string;
  selected: string[];
  custom: string;
  hasCustom: boolean;
  revision: number;
}
export interface PendingControl {
  id: string;
  key: string;
  kind: string;
  title: string;
  detail: string;
  reason: string;
  warning: string;
  capability: string;
  supportsFeedback: boolean;
  unavailable: string;
  dismissible: boolean;
  pending: boolean;
  error: string;
  options: { decision: string; label: string; description: string }[];
  questions: Question[];
}
export interface ThreadControls {
  accessKey: string;
  keyPrefix: string;
  pendingKeys: string[];
  ready: boolean;
  stop: { runId: string; state: string; error: string };
  requests: PendingControl[];
  resolvedKeys: string[];
}
export const emptyControls = (): ThreadControls => ({
  accessKey: "",
  keyPrefix: "",
  pendingKeys: [],
  ready: false,
  stop: { runId: "", state: "", error: "" },
  requests: [],
  resolvedKeys: [],
});
export const controlKey = (environmentId: string, threadId: string, requestId: string) =>
  JSON.stringify([environmentId, threadId, requestId]);

export function controlAccess(value: unknown): boolean {
  const session = record(value);
  const permissions = session.permissions ?? session.scopes;
  return (
    session.authenticated === true &&
    Array.isArray(permissions) &&
    permissions.includes("orchestration:operate")
  );
}

export function answersFor(
  questions: Question[],
  drafts: QuestionDraft[],
  key: string,
  attachmentsByQuestionId: Record<string, StoredAttachment[]> = {},
): Record<string, string | string[]> | null {
  const entries: [string, string | string[]][] = [];
  for (const question of questions) {
    const draft = drafts.find((entry) => entry.key === key && entry.questionId === question.id);
    const rawCustom = draft
      ? draft.hasCustom
        ? draft.custom
        : null
      : question.hasInitial
        ? question.initial
        : null;
    const custom = !question.custom
      ? null
      : question.hasInitial
        ? rawCustom
        : rawCustom?.trim() || null;
    const selected = [
      ...new Set(
        (draft?.selected ?? []).flatMap((value) => {
          const option =
            question.options.find((option) => option.value === value) ??
            question.options.find((option) => !option.exact && option.value === value.trim());
          return option ? [option.value] : [];
        }),
      ),
    ];
    const answer =
      custom !== null && custom.length > 0
        ? custom
        : selected.length
          ? question.multi
            ? selected
            : selected[0]!
          : custom;
    const hasAttachments =
      Object.hasOwn(attachmentsByQuestionId, question.id) &&
      attachmentsByQuestionId[question.id]!.length > 0;
    if (answer === null && !hasAttachments) return null;
    entries.push([question.id, answer ?? ""]);
  }
  return Object.fromEntries(entries);
}

const defaults = [
  { decision: "accept", label: "Allow once", description: "" },
  { decision: "acceptForSession", label: "Allow session", description: "" },
  { decision: "decline", label: "Decline", description: "" },
];

function questionRuns(body: string, key: string): InlineRun[] {
  return markdownBlocks(body, key).flatMap((block, index) => {
    const plain = (text: string, suffix: string, code = false): InlineRun => ({
      id: `${block.id}:${suffix}`,
      text,
      strong: false,
      emphasis: false,
      strike: false,
      code,
      href: "",
      linkKind: "",
    });
    const runs = block.runs.length
      ? block.runs
      : [plain(block.body, "body", block.kind === "code")];
    return [
      ...(index > 0 ? [plain("\n", "break")] : []),
      ...(block.marker ? [plain(`${block.marker} `, "marker")] : []),
      ...runs,
    ];
  });
}

export function projectControls(
  environmentId: string,
  threadId: string,
  runtimeRequests: RecordValue[],
  items: RecordValue[],
  runs: RecordValue[],
): ThreadControls {
  const result = emptyControls();
  result.keyPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1) + ",";
  for (const request of runtimeRequests) {
    const id = text(request.id);
    const key = controlKey(environmentId, threadId, id);
    if (request.status !== "pending") {
      if (["resolved", "expired", "cancelled"].includes(text(request.status)))
        result.resolvedKeys.push(key);
      continue;
    }
    result.pendingKeys.push(key);
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const question = request.kind === "user_input";
    const item = items.findLast(
      (item) =>
        item.requestId === id &&
        item.type === (question ? "user_input_request" : "approval_request"),
    );
    if (question && !item) continue;
    const capability = text(record(request.responseCapability).type);
    const actionable = capability === "live" || (question && capability === "message");
    const questions: Question[] = records(item?.questions).map((entry) => ({
      id: text(entry.id),
      header: text(entry.header),
      text: text(entry.question),
      runs: questionRuns(text(entry.question), key + text(entry.id)),
      multi: entry.multiSelect === true,
      custom: entry.allowCustomAnswer !== false,
      hasInitial: typeof entry.initialAnswer === "string",
      initial: text(entry.initialAnswer),
      options: records(entry.options).map((option, index) => ({
        id: String(index),
        label: text(option.label),
        description: text(option.description),
        value: typeof option.value === "string" ? option.value : text(option.label).trim(),
        exact: typeof option.value === "string",
      })),
    }));
    result.requests.push({
      id,
      key,
      kind: question ? "question" : "approval",
      title: question ? "Input requested" : text(item?.appName) || text(request.kind),
      detail: text(item?.prompt),
      reason: text(item?.reason),
      warning:
        item?.fullAccessOverride === "ask_rule"
          ? "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
          : item?.fullAccessOverride === "provider_check"
            ? "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. T3 Code can't turn these off, so check the request and approve it if it's what you expect."
            : "",
      capability,
      supportsFeedback:
        !question &&
        capability === "live" &&
        record(request.responseCapability).supportsFeedback === true,
      unavailable: actionable
        ? ""
        : text(record(request.responseCapability).reason) ||
          "This request can no longer be answered. Send a new message to continue.",
      dismissible: question && (capability === "message" || item?.responseMode === "message"),
      pending: false,
      error: "",
      options: question
        ? []
        : item?.options === undefined
          ? defaults
          : records(item.options).map((option) => ({
              decision: text(option.decision),
              label: text(option.label),
              description: text(option.warning),
            })),
      questions,
    });
  }
  const run = runs
    .filter((run) => ["preparing", "starting", "running", "waiting"].includes(text(run.status)))
    .sort((a, b) => Number(b.ordinal ?? 0) - Number(a.ordinal ?? 0))[0];
  if (run) {
    const related = items.filter((item) => item.runId === run.id);
    const interrupt = related.findLast((item) => item.type === "run_interrupt_request");
    const finished = related.some((item) => item.type === "run_interrupt_result");
    result.stop = {
      runId: text(run.id),
      state:
        !interrupt || finished
          ? "available"
          : interrupt.unresponsiveAt
            ? "unresponsive"
            : "stopping",
      error: "",
    };
  }
  return result;
}
