import type { Storage } from "./app.contract.d.ts";
import { parseDraftAttachment, storedReference, validateAttachments, FILE_LIMIT, type DraftAttachment, type StoredAttachment, ownedAttachmentPath } from "./attachments";
import { decodeSelection, type ThreadSettingsSelection } from "./thread-settings";

export interface PendingSend {
  commandId: string;
  messageId: string;
  revision: number;
  text: string;
  attachments: StoredAttachment[];
  paths: string[];
  selection: string;
  state: string;
}
export interface Draft { id: string; text: string; revision: number; attachments: DraftAttachment[]; pendingSend: PendingSend | null }
type DraftStorage = { fs: Pick<Storage["fs"], "readFile" | "atomicWriteFile"> };
const FILE = "app:/data/drafts-v1.json";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const revision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function emptyDraft(id: string): Draft { return { id, text: "", revision: 0, attachments: [], pendingSend: null }; }

export function parseSendSelection(input: string): ThreadSettingsSelection | null {
  if (!input) return null;
  const value = object(JSON.parse(input));
  const modelSelection = decodeSelection(value.modelSelection);
  if (!modelSelection || typeof value.threadId !== "string" || !value.threadId ||
      !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(String(value.runtimeMode)))
    throw new Error("The saved message settings could not be read.");
  return { threadId: value.threadId, runtimeMode: value.runtimeMode as string, modelSelection };
}

function parsePendingSend(value: unknown): PendingSend | null {
  if (value == null) return null;
  const item = object(value);
  if (typeof item.commandId !== "string" || !item.commandId || typeof item.messageId !== "string" || !item.messageId ||
      typeof item.text !== "string" || !revision(item.revision) || typeof item.selection !== "string" ||
      !["prepared", "unknown", "accepted"].includes(String(item.state)) || !Array.isArray(item.attachments) || !Array.isArray(item.paths) || !item.paths.every((path) => typeof path === "string" && ownedAttachmentPath(path)))
    throw new Error("The saved message awaiting delivery could not be read.");
  parseSendSelection(item.selection);
  const attachments = item.attachments.map((attachment: unknown) => storedReference(object(attachment) as unknown as StoredAttachment));
  validateAttachments(attachments, FILE_LIMIT, true);
  return { commandId: item.commandId, messageId: item.messageId, revision: item.revision as number, text: item.text, attachments, paths: item.paths as string[], selection: item.selection, state: item.state as string };
}

function parseDraft(value: unknown): Draft {
  const item = object(value);
  if (typeof item.id !== "string" || !item.id || typeof item.text !== "string" || !revision(item.revision) || (item.attachments !== undefined && !Array.isArray(item.attachments)))
    throw new Error("The saved drafts could not be read.");
  const attachments = (item.attachments as unknown[] | undefined ?? []).map(parseDraftAttachment);
  if (new Set(attachments.map((attachment) => attachment.localId)).size !== attachments.length) throw new Error("A saved draft contains duplicate attachments.");
  validateAttachments(attachments, FILE_LIMIT);
  return { id: item.id, text: item.text, revision: item.revision as number, attachments, pendingSend: parsePendingSend(item.pendingSend) };
}

export async function loadDrafts(storage: DraftStorage): Promise<Draft[]> {
  let bytes: ArrayBuffer;
  try { bytes = await storage.fs.readFile(FILE); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(value)) throw new Error("The saved drafts could not be read.");
  const drafts = value.map(parseDraft);
  if (new Set(drafts.map(({ id }) => id)).size !== drafts.length) throw new Error("The saved drafts could not be read.");
  return drafts;
}

export function restoreDrafts(drafts: Draft[]): Draft[] {
  return drafts.map((draft) => {
    const interrupted = draft.attachments.some((item) => item.state === "uploading") || draft.pendingSend?.state === "prepared";
    const revision = draft.revision + (interrupted ? 1 : 0);
    return { ...draft, revision,
      pendingSend: draft.pendingSend?.state === "prepared" ? { ...draft.pendingSend, state: "unknown", revision: draft.pendingSend.revision === draft.revision ? revision : draft.pendingSend.revision } : draft.pendingSend,
      attachments: draft.attachments.map((item) => item.state === "uploading" ? { ...item, state: "failed" as const, error: "Upload was interrupted. Retry or remove this attachment." } : item),
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
  const next = previous ? drafts.map((entry) => entry.id === draft.id ? draft : entry) : drafts.concat(draft);
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(next)));
  return draft;
}
