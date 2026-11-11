import type { PendingControl } from "./thread-controls";
import type { StoredAttachment } from "./attachments";

export interface ApprovalSend {
  type: "feedback" | "redirect";
  requests: { id: string; live: boolean }[];
}

export interface ControlOptions {
  feedback?: string;
  attachmentsByQuestionId?: Record<string, StoredAttachment[]>;
}

export function captureApprovalSend(requests: PendingControl[]): ApprovalSend | null {
  if (requests.some((request) => request.kind === "question")) return null;
  const approvals = requests.filter((request) => request.kind === "approval");
  if (!approvals.length) return null;
  return {
    type: approvals[0]!.supportsFeedback ? "feedback" : "redirect",
    requests: approvals.map((request) => ({ id: request.id, live: request.capability === "live" })),
  };
}

export function parseApprovalSend(input: string): ApprovalSend | null {
  if (!input) return null;
  const value: unknown = JSON.parse(input);
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    !("requests" in value) ||
    (value.type !== "feedback" && value.type !== "redirect") ||
    !Array.isArray(value.requests) ||
    !value.requests.length
  )
    throw new Error("The saved approval response could not be read.");
  const requests = value.requests.map((request: unknown) => {
    if (
      !request ||
      typeof request !== "object" ||
      !("id" in request) ||
      typeof request.id !== "string" ||
      !request.id ||
      !("live" in request) ||
      typeof request.live !== "boolean"
    )
      throw new Error("The saved approval response could not be read.");
    return { id: request.id, live: request.live };
  });
  if (
    (value.type === "feedback" && !requests[0]!.live) ||
    new Set(requests.map((request) => request.id)).size !== requests.length
  )
    throw new Error("The saved approval response could not be read.");
  return { type: value.type, requests };
}

export class ComposerSendScope {
  private threadId = "";
  private routeId = "";
  private revision = -1;
  private epoch = 0;
  private prepared = new Map<string, () => boolean>();

  observe(threadId: string, routeId: string, revision: number): number {
    if (this.threadId !== threadId || this.routeId !== routeId) this.epoch++;
    this.threadId = threadId;
    this.routeId = routeId;
    this.revision = revision;
    return this.epoch;
  }

  capture(threadId: string, revision: number): () => boolean {
    const epoch = this.epoch;
    return () => this.threadId === threadId && this.epoch === epoch && this.revision === revision;
  }

  prepare(commandId: string, threadId: string, revision: number) {
    this.prepared.clear();
    this.prepared.set(commandId, this.capture(threadId, revision));
  }

  take(commandId: string, threadId: string, revision: number, retry = false) {
    const guard = retry
      ? this.capture(threadId, this.revision)
      : (this.prepared.get(commandId) ?? this.capture(threadId, revision));
    this.prepared.delete(commandId);
    return guard;
  }
}
