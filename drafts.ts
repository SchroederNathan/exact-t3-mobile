import type { Storage } from "./app.contract.d.ts";
import {
  parseDraftAttachment,
  storedReference,
  validateAttachments,
  FILE_LIMIT,
  type DraftAttachment,
  type StoredAttachment,
  ownedAttachmentPath,
} from "./attachments";
import { decodeSelection, type ThreadSettingsSelection } from "./thread-settings";
import { parseApprovalSend } from "./approval-send";
import { isDraftKey, type LaunchPlan, type TaskStamp, type WorkspacePick } from "./new-task";

export interface PendingSend {
  commandId: string;
  messageId: string;
  revision: number;
  text: string;
  context: string;
  freshContext: boolean;
  dispatchMode?: string;
  attachments: StoredAttachment[];
  paths: string[];
  selection: string;
  approval: string;
  state: string;
  error: string;
  launch: LaunchPlan | null;
}
export interface Draft {
  id: string;
  text: string;
  context: string;
  freshContext: boolean;
  revision: number;
  attachments: DraftAttachment[];
  pendingSend: PendingSend | null;
  task: TaskStamp | null;
}
type DraftStorage = { fs: Pick<Storage["fs"], "readFile" | "atomicWriteFile"> };
const FILE = "app:/data/drafts-v1.json";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const revision = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function emptyDraft(id: string): Draft {
  return { id, text: "", context: "", freshContext: false, revision: 0, attachments: [], pendingSend: null, task: null };
}

export function parseSendSelection(input: string): ThreadSettingsSelection | null {
  if (!input) return null;
  const value = object(JSON.parse(input));
  const modelSelection = decodeSelection(value.modelSelection);
  if (
    !modelSelection ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
      String(value.runtimeMode),
    )
  )
    throw new Error("The saved message settings could not be read.");
  return { threadId: value.threadId, runtimeMode: value.runtimeMode as string, modelSelection };
}

const optionalString = (value: unknown) => value === undefined || value === null || typeof value === "string";
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

function parseWorkspacePick(value: unknown): WorkspacePick | null {
  if (value == null) return null;
  const item = object(value);
  if (
    (item.mode !== "local" && item.mode !== "worktree") ||
    !optionalString(item.branch) ||
    !optionalString(item.worktreePath) ||
    !(item.startFromOrigin == null || typeof item.startFromOrigin === "boolean")
  )
    throw new Error("A saved draft's workspace could not be read.");
  return {
    mode: item.mode,
    branch: optionalText(item.branch),
    worktreePath: optionalText(item.worktreePath),
    startFromOrigin: typeof item.startFromOrigin === "boolean" ? item.startFromOrigin : null,
    followsCurrentCheckout: item.followsCurrentCheckout === true,
  };
}

export function parseTaskStamp(value: unknown): TaskStamp {
  const item = object(value);
  if (
    typeof item.environmentId !== "string" ||
    typeof item.projectId !== "string" ||
    typeof item.createdAt !== "string"
  )
    throw new Error("A saved new thread draft could not be read.");
  return {
    environmentId: item.environmentId,
    projectId: item.projectId,
    createdAt: item.createdAt,
    cloning: item.cloning === true,
    workspace: parseWorkspacePick(item.workspace),
  };
}

export function parseLaunch(value: unknown): LaunchPlan | null {
  if (value == null) return null;
  const item = object(value);
  const strategy = item.strategy;
  if (
    typeof item.threadId !== "string" ||
    !item.threadId ||
    typeof item.projectId !== "string" ||
    typeof item.title !== "string" ||
    typeof item.runtimeMode !== "string" ||
    (strategy !== "root" && strategy !== "existing_worktree" && strategy !== "worktree") ||
    !optionalString(item.branch) ||
    !optionalString(item.baseRef) ||
    !optionalString(item.worktreePath)
  )
    throw new Error("A saved thread launch could not be read.");
  return {
    threadId: item.threadId,
    projectId: item.projectId,
    projectTitle: typeof item.projectTitle === "string" ? item.projectTitle : "",
    title: item.title,
    runtimeMode: item.runtimeMode,
    interactionMode: typeof item.interactionMode === "string" ? item.interactionMode : "default",
    strategy,
    branch: optionalText(item.branch),
    baseRef: optionalText(item.baseRef),
    worktreePath: optionalText(item.worktreePath),
    startFromOrigin: item.startFromOrigin === true,
  };
}

function parsePendingSend(value: unknown): PendingSend | null {
  if (value == null) return null;
  const item = object(value);
  if (
    typeof item.commandId !== "string" ||
    !item.commandId ||
    typeof item.messageId !== "string" ||
    !item.messageId ||
    typeof item.text !== "string" ||
    !revision(item.revision) ||
    typeof item.selection !== "string" ||
    !["prepared", "unknown", "accepted", "rejected"].includes(String(item.state)) ||
    !Array.isArray(item.attachments) ||
    !Array.isArray(item.paths) ||
    !item.paths.every((path) => typeof path === "string" && ownedAttachmentPath(path))
  )
    throw new Error("The saved message awaiting delivery could not be read.");
  parseSendSelection(item.selection);
  const approval = item.approval === undefined ? "" : item.approval;
  if (typeof approval !== "string")
    throw new Error("The saved approval response could not be read.");
  parseApprovalSend(approval);
  const attachments = item.attachments.map((attachment: unknown) =>
    storedReference(object(attachment) as unknown as StoredAttachment),
  );
  validateAttachments(attachments, FILE_LIMIT, true);
  return {
    commandId: item.commandId,
    messageId: item.messageId,
    revision: item.revision as number,
    text: item.text,
    context: typeof item.context === "string" ? item.context : "",
    freshContext: item.freshContext === true,
    ...(typeof item.dispatchMode === "string" ? { dispatchMode: item.dispatchMode } : {}),
    attachments,
    paths: item.paths as string[],
    selection: item.selection,
    approval,
    state: item.state as string,
    error: typeof item.error === "string" ? item.error : "",
    launch: parseLaunch(item.launch),
  };
}

function parseDraft(value: unknown): Draft {
  const item = object(value);
  if (
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.text !== "string" ||
    !revision(item.revision) ||
    (item.attachments !== undefined && !Array.isArray(item.attachments))
  )
    throw new Error("The saved drafts could not be read.");
  const attachments = ((item.attachments as unknown[] | undefined) ?? []).map(parseDraftAttachment);
  if (new Set(attachments.map((attachment) => attachment.localId)).size !== attachments.length)
    throw new Error("A saved draft contains duplicate attachments.");
  validateAttachments(attachments, FILE_LIMIT);
  const task = item.task == null ? null : parseTaskStamp(item.task);
  if ((task !== null) !== isDraftKey(item.id))
    throw new Error("A saved draft's new thread details could not be read.");
  return {
    id: item.id,
    text: item.text,
    context: typeof item.context === "string" ? item.context : "",
    freshContext: item.freshContext === true,
    revision: item.revision as number,
    attachments,
    pendingSend: parsePendingSend(item.pendingSend),
    task,
  };
}

export async function loadDrafts(storage: DraftStorage): Promise<Draft[]> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.fs.readFile(FILE);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(value)) throw new Error("The saved drafts could not be read.");
  const drafts = value.map(parseDraft);
  if (new Set(drafts.map(({ id }) => id)).size !== drafts.length)
    throw new Error("The saved drafts could not be read.");
  return drafts;
}

/** New thread drafts the person left empty are not kept across launches. */
function kept(draft: Draft): boolean {
  return (
    !draft.task ||
    draft.text.trim() !== "" ||
    draft.attachments.length > 0 ||
    (draft.pendingSend !== null && draft.pendingSend.state !== "accepted")
  );
}

export function restoreDrafts(drafts: Draft[]): Draft[] {
  return drafts.filter(kept).map((draft) => {
    const interrupted =
      draft.attachments.some((item) => item.state === "uploading") ||
      draft.pendingSend?.state === "prepared";
    const revision = draft.revision + (interrupted ? 1 : 0);
    return {
      ...draft,
      revision,
      pendingSend:
        draft.pendingSend?.state === "prepared"
          ? {
              ...draft.pendingSend,
              state: "unknown",
              revision:
                draft.pendingSend.revision === draft.revision
                  ? revision
                  : draft.pendingSend.revision,
            }
          : draft.pendingSend,
      attachments: draft.attachments.map((item) =>
        item.state === "uploading"
          ? {
              ...item,
              state: "failed" as const,
              error: "Upload was interrupted. Retry or remove this attachment.",
            }
          : item,
      ),
    };
  });
}

// The caller serializes saves; atomic replacement does not serialize read-modify-write.
export async function saveDraft(storage: DraftStorage, input: unknown): Promise<Draft> {
  const draft = parseDraft(input);
  const drafts = await loadDrafts(storage);
  const previous = drafts.find((entry) => entry.id === draft.id);
  if (previous && draft.revision <= previous.revision) {
    if (draft.revision === previous.revision && JSON.stringify(draft) !== JSON.stringify(previous))
      throw new Error("This draft revision already contains different content.");
    return previous;
  }
  const next = (
    previous ? drafts.map((entry) => (entry.id === draft.id ? draft : entry)) : drafts.concat(draft)
  ).filter((entry) => entry.id === draft.id || kept(entry));
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(next)));
  return draft;
}
