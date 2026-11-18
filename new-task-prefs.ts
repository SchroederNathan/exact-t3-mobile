import type { Storage } from "./app.contract.d.ts";
import { decodeSelection, type ModelSelection } from "./thread-settings";

export interface TaskPrefs {
  lastProject: { environmentId: string; projectId: string } | null;
  stickyModel: ModelSelection | null;
}

type PrefsStorage = { fs: Pick<Storage["fs"], "readFile" | "atomicWriteFile"> };
export const PREFS_FILE = "app:/data/new-task-prefs-v1.json";

function parse(value: unknown): TaskPrefs {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const last = record.lastProject && typeof record.lastProject === "object"
    ? (record.lastProject as Record<string, unknown>)
    : null;
  return {
    lastProject:
      last && typeof last.environmentId === "string" && typeof last.projectId === "string"
        ? { environmentId: last.environmentId, projectId: last.projectId }
        : null,
    stickyModel: decodeSelection(record.stickyModel),
  };
}

export async function loadTaskPrefs(storage: PrefsStorage): Promise<TaskPrefs> {
  try {
    return parse(JSON.parse(new TextDecoder().decode(await storage.fs.readFile(PREFS_FILE))));
  } catch {
    return { lastProject: null, stickyModel: null };
  }
}

export async function saveTaskPrefs(storage: PrefsStorage, prefs: TaskPrefs): Promise<void> {
  await storage.fs.atomicWriteFile(PREFS_FILE, new TextEncoder().encode(JSON.stringify(prefs)));
}
