import { emptyDraft, type Draft } from "./drafts";
import type { ThreadControls } from "./thread-controls";

function prefix(threadId: string) {
  return `question:${threadId.length}:${threadId}:`;
}

export function questionAttachmentState(
  threadId: string,
  controls: Pick<ThreadControls, "ready" | "requests" | "pendingKeys">,
  saved: Draft[],
  edits: Draft[],
  answeredKeys: string[] = [],
) {
  const drafts = new Map([...saved, ...edits].map((draft) => [draft.id, draft]));
  const targets = controls.requests
    .filter((request) => request.kind === "question" && !answeredKeys.includes(request.key))
    .flatMap((request) =>
      request.questions.map((question) => {
        const id = `${prefix(threadId)}${JSON.stringify([request.key, question.id])}`;
        return {
          key: request.key,
          questionId: question.id,
          draft: drafts.get(id) ?? emptyDraft(id),
        };
      }),
    );
  return {
    threadId,
    ready: controls.ready,
    targets,
    retired: controls.ready
      ? [...drafts.values()].filter((draft) => {
          if (!draft.id.startsWith(prefix(threadId)) || !draft.attachments.length) return false;
          try {
            const identity: unknown = JSON.parse(draft.id.slice(prefix(threadId).length));
            return (
              Array.isArray(identity) &&
              typeof identity[0] === "string" &&
              (answeredKeys.includes(identity[0]) || !controls.pendingKeys.includes(identity[0]))
            );
          } catch {
            return false;
          }
        })
      : [],
  };
}
