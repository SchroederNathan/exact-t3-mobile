import type { Storage } from "./app.contract.d.ts";

export type Draft = { id: string; text: string; revision: number };
type DraftStorage = { fs: Pick<Storage["fs"], "readFile" | "atomicWriteFile"> };
const FILE = "app:/data/drafts-v1.json";

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.id === "string" && draft.id.length > 0 &&
    typeof draft.text === "string" && typeof draft.revision === "number" &&
    Number.isSafeInteger(draft.revision) && draft.revision >= 0;
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
  if (!Array.isArray(value) || !value.every(isDraft) || new Set(value.map(({ id }) => id)).size !== value.length)
    throw new Error("The saved drafts could not be read.");
  return value;
}

// The caller serializes saves; atomic replacement does not serialize read-modify-write.
export async function saveDraft(storage: DraftStorage, id: string, text: string, revision: number): Promise<void> {
  const draft = { id, text, revision };
  if (!isDraft(draft)) throw new Error("A draft requires an identity and a nonnegative whole revision.");
  const drafts = await loadDrafts(storage);
  const previous = drafts.find((entry) => entry.id === id);
  if (previous && revision <= previous.revision) {
    if (revision === previous.revision && text !== previous.text)
      throw new Error("This draft revision already contains different text.");
    return;
  }
  const next = previous ? drafts.map((entry) => entry.id === id ? draft : entry) : drafts.concat(draft);
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(next)));
}
