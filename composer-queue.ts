import { storedReference, type StoredAttachment } from "./attachments";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export interface QueuedComposerMessage {
  id: string;
  messageId: string;
  text: string;
  attachments: StoredAttachment[];
  context: string;
  position: number;
}

export interface ComposerQueueState {
  items: QueuedComposerMessage[];
  held: boolean;
  ready: boolean;
  canSendNow: boolean;
  activeRunId: string;
}

export type ComposerQueueOperation =
  | { type: "resume" }
  | { type: "start"; runId: string }
  | { type: "cancel"; runId: string }
  | { type: "edit"; runId: string; text: string; attachments: StoredAttachment[]; context: string };

export function projectComposerQueue(
  runs: Iterable<RecordValue>,
  messages: Iterable<RecordValue>,
  sessions: Iterable<RecordValue>,
  ready: boolean,
  providerThreads: Iterable<RecordValue> = [],
): ComposerQueueState {
  const allRuns = [...runs];
  const byId = new Map([...messages].map(message => [text(message.id), message]));
  const active = allRuns.find(run => ["preparing", "starting", "running", "waiting"].includes(text(run.status)));
  const providerThread = [...providerThreads].find(thread => thread.id === active?.providerThreadId);
  const activeSession = [...sessions].find(session => session.id === providerThread?.providerSessionId);
  const turns = record(record(activeSession?.capabilities).turns);
  const items = allRuns.filter(run => run.status === "queued" && !run.delegatedTaskId)
    .sort((left, right) => Number(left.queuePosition ?? left.ordinal) - Number(right.queuePosition ?? right.ordinal) || Number(left.ordinal) - Number(right.ordinal))
    .map((run, index) => {
      const message = byId.get(text(run.userMessageId)) ?? {};
      const attachments = Array.isArray(message.attachments) ? message.attachments.flatMap(value => {
        const item = record(value);
        if (!text(item.id) || !text(item.name) || !text(item.mimeType) || typeof item.sizeBytes !== "number") return [];
        return [storedReference({ type: item.type === "image" ? "image" : "file", id: text(item.id), name: text(item.name), mimeType: text(item.mimeType), sizeBytes: item.sizeBytes })];
      }) : [];
      return { id: text(run.id), messageId: text(run.userMessageId), text: text(message.text), attachments,
        context: message.context ? JSON.stringify(message.context) : "", position: index + 1 };
    });
  return {
    items,
    held: allRuns.some(run => run.status === "queued" && run.queueHeld === true),
    ready,
    activeRunId: text(active?.id),
    canSendNow: !active || (active.status === "running" && active.activeAttemptId != null &&
      (turns.supportsActiveSteering === true || turns.supportsSteeringByInterruptRestart === true)),
  };
}
