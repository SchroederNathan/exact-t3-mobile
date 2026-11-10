import type { Storage } from "./app.contract.d.ts";
import type { ModelSelection } from "./thread-settings";

export type ModelDraftSelection = {
  threadId: string;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
};
export type ModelDraft = { id: string; selection: ModelDraftSelection };
type DraftStorage = { fs: Pick<Storage["fs"], "readFile" | "atomicWriteFile"> };
const FILE = "app:/data/model-drafts-v1.json";
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelDraft(value: unknown): value is ModelDraft {
  if (!record(value) || !nonempty(value.id) || !record(value.selection)) return false;
  const selection = value.selection;
  if (!nonempty(selection.threadId)
    || (selection.modelSelection === undefined && selection.runtimeMode === undefined)
    || (selection.runtimeMode !== undefined && (typeof selection.runtimeMode !== "string"
      || !RUNTIME_MODES.has(selection.runtimeMode)))) return false;
  const model = selection.modelSelection;
  if (model !== undefined) {
    if (!record(model) || !nonempty(model.instanceId) || !nonempty(model.model)) return false;
    if (model.options !== undefined && (!Array.isArray(model.options) || !model.options.every(
      (option: unknown) => record(option) && nonempty(option.id)
        && (typeof option.value === "string" || typeof option.value === "boolean"),
    ))) return false;
  }
  const separator = value.id.indexOf(":");
  if (separator < 1) return false;
  try {
    return nonempty(decodeURIComponent(value.id.slice(0, separator)))
      && decodeURIComponent(value.id.slice(separator + 1)) === selection.threadId;
  } catch {
    return false;
  }
}

function modelDrafts(value: unknown): ModelDraft[] {
  if (!Array.isArray(value) || !value.every(isModelDraft)
    || new Set(value.map(({ id }) => id)).size !== value.length)
    throw new Error("Model drafts require valid, unique scoped selections.");
  return value;
}

export async function loadModelDrafts(storage: DraftStorage): Promise<ModelDraft[]> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.fs.readFile(FILE);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return modelDrafts(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function saveModelDrafts(storage: DraftStorage, records: ModelDraft[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(modelDrafts(records)));
  await storage.fs.atomicWriteFile(FILE, bytes);
}
