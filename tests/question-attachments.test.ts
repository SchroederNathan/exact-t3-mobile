import { expect, test } from "bun:test";
import { emptyDraft } from "../drafts";
import { questionAttachmentState } from "../question-attachments";
import { projectControls } from "../thread-controls";
import type { DraftAttachment } from "../attachments";

const attachment: DraftAttachment = {
  type: "file",
  id: "uploaded",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  width: 0,
  height: 0,
  localId: "picked",
  path: "app:/data/composer-attachments/picked/notes.txt",
  state: "uploaded",
  attempt: 0,
  error: "",
  insertionRevision: 1,
};
function controls(ready = true) {
  const base = projectControls("environment", "thread", [], [], []);
  const question = {
    id: "q",
    header: "Files",
    text: "Attach evidence",
    runs: [],
    multi: false,
    custom: true,
    initial: "",
    hasInitial: false,
    options: [],
  };
  return {
    ...base,
    ready,
    pendingKeys: ["request-key"],
    requests: [
      {
        id: "request",
        key: "request-key",
        kind: "question",
        title: "",
        detail: "",
        reason: "",
        warning: "",
        supportsFeedback: false,
        capability: "native",
        unavailable: "",
        dismissible: false,
        pending: false,
        error: "",
        options: [],
        questions: [question, { ...question, id: "other" }],
      },
    ],
  };
}

test("question attachment drafts are isolated by environment, thread, request and question", () => {
  const state = questionAttachmentState("environment:thread", controls(), [], []);
  const first = state.targets[0]!;
  const saved = { ...first.draft, revision: 1, attachments: [attachment] };
  const edited = { ...saved, revision: 2, attachments: [] };
  expect(
    questionAttachmentState("environment:thread", controls(), [saved], [edited]).targets[0]?.draft,
  ).toEqual(edited);
  expect(state.targets[1]?.draft.id).not.toBe(first.draft.id);
  expect(
    questionAttachmentState("other:thread", controls(), [saved], []).targets[0]?.draft.attachments,
  ).toEqual([]);
  const nextRequest = controls();
  nextRequest.requests[0]!.key = "another-request";
  expect(
    questionAttachmentState("environment:thread", nextRequest, [saved], []).targets[0]?.draft
      .attachments,
  ).toEqual([]);
  const colliding = controls();
  colliding.requests[0]!.key = 'request-key","q';
  colliding.requests[0]!.questions[0]!.id = '"';
  expect(
    questionAttachmentState("environment:thread", colliding, [], []).targets[0]?.draft.id,
  ).not.toBe(first.draft.id);
});

test("resolution collects only the current thread after its pending requests are loaded", () => {
  const state = questionAttachmentState("environment:thread", controls(), [], []);
  const saved = { ...state.targets[0]!.draft, revision: 1, attachments: [attachment] };
  const composer = { ...emptyDraft("environment:thread"), attachments: [attachment] };
  const other = {
    ...questionAttachmentState("other:thread", controls(), [], []).targets[0]!.draft,
    attachments: [attachment],
  };
  const resolved = { ...controls(), pendingKeys: [], requests: [] };
  expect(
    questionAttachmentState("environment:thread", { ...controls(), requests: [] }, [saved], [])
      .retired,
  ).toEqual([]);
  expect(
    questionAttachmentState("environment:thread", controls(), [saved], [], ["request-key"]).retired,
  ).toEqual([saved]);
  expect(
    questionAttachmentState("environment:thread", { ...resolved, ready: false }, [saved], [])
      .retired,
  ).toEqual([]);
  expect(
    questionAttachmentState("environment:thread", resolved, [saved, composer, other], []).retired,
  ).toEqual([saved]);
  expect(
    questionAttachmentState(
      "environment:thread",
      resolved,
      [saved],
      [{ ...saved, revision: 2, attachments: [] }],
    ).retired,
  ).toEqual([]);
});
