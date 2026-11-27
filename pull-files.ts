import { projectTurnDiff, type ReviewRow } from "./turn-review";

function describePath(path: string) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const directory = parts.join("/");
  const generated = /(?:^|\/)(?:__generated__|_?generated)(?:\/|$)|\.(?:generated|gen|min)\.|(?:\.lockb?|\.sum|lock\.json|lock\.yaml|\.map)$/i.test(path);
  const testDirectory = parts.some(part => /^(?:__tests?__|tests?|specs?|evals|e2e|cypress|__fixtures__|__mocks__|__snapshots__|fixtures?|mocks?|fakes|stubs|testdata)$/i.test(part));
  const testName = /(?:[._](?:test|spec|e2e|eval)|\.(?:mock|fixture|stub|fake)s?)\.[^.]+$|^(?:test_.*|conftest)\.py$|^(?:vitest|jest)\.setup\.|\.snap$/i.test(name) || /(?:Tests?|Spec)\.(?:swift|java|kt|kts|scala|groovy|cs|php|m)$/.test(name);
  return {name, directory, testFile: !generated && (testDirectory || testName)};
}

export type ChangedFile = ReturnType<typeof describePath> & { path: string; previousPath: string; copied: boolean; additions: number; deletions: number; omitted: boolean; rows: ReviewRow[] };

export function filePickerRows(files: readonly Pick<ChangedFile,"path"|"name"|"directory"|"previousPath"|"copied"|"additions"|"deletions">[], folded: readonly string[]) {
  const hidden = new Set(folded);
  const order = [...files].sort((left,right) => left.directory.localeCompare(right.directory) || left.path.localeCompare(right.path));
  let previous: string | undefined;
  return order.flatMap(file => {
    const items = [];
    if (previous !== file.directory) {
      previous = file.directory;
      items.push({kind:"directory",key:`dir:${previous}`,path:previous,label:previous || "Repository root",origin:"",added:0,deleted:0});
    }
    if (!hidden.has(file.directory)) items.push({kind:"file",key:`file:${file.path}`,path:file.path,label:file.name,origin:file.previousPath ? `${file.copied ? "Copied" : "Renamed"} from ${file.previousPath}` : "",added:file.additions,deleted:file.deletions});
    return items;
  });
}

export function changedFiles(value: Record<string, unknown>) {
  if (typeof value.patch !== "string" || typeof value.truncated !== "boolean" || !(value.nextCursor === null || typeof value.nextCursor === "string")) throw new Error("The environment returned an invalid diff.");
  const files: ChangedFile[] = [];
  let file: ChangedFile | undefined;
  for (const row of projectTurnDiff(value.patch)) {
    if (row.kind === "file") {
      const path = row.targetPath ?? row.text;
      file = { path, ...describePath(path), previousPath:row.previousPath ?? "", copied:row.copied === true, additions: 0, deletions: 0, omitted: false, rows: [] };
      files.push(file);
    } else if (file) {
      file.rows.push(row);
      if (row.kind === "addition") file.additions++;
      if (row.kind === "deletion") file.deletions++;
    }
  }
  const paths = new Set(files.map(item => item.path));
  if (Array.isArray(value.omittedFileStats)) for (const stat of value.omittedFileStats) {
    if (typeof stat?.path !== "string" || paths.has(stat.path) || !Number.isSafeInteger(stat.additions) || !Number.isSafeInteger(stat.deletions)) continue;
    paths.add(stat.path);
    files.push({ path: stat.path, ...describePath(stat.path), previousPath:"", copied:false, additions: stat.additions, deletions: stat.deletions, omitted: true, rows: [] });
  }
  return { files, truncated: value.truncated, nextCursor: value.nextCursor || "" };
}

export class ChangedFilePages {
  private active?: { key: string; index: number; files: Map<string, ChangedFile>; nextCursor: string; seen: Set<string>; truncated: boolean };

  async read(key: string, index: number, load: (cursor: string) => Promise<Record<string, unknown>>) {
    let chain = this.active;
    if (!chain || chain.key !== key || index === 0) {
      chain = {key, index: -1, files: new Map(), nextCursor: "", seen: new Set(), truncated: false};
      this.active = chain;
    }
    const snapshot = (error = "") => ({files: [...chain.files.values()], nextCursor: chain.nextCursor, truncated: chain.truncated, error});
    if (chain.index === index || (chain.index >= 0 && !chain.nextCursor)) return snapshot();
    const cursor = chain.nextCursor;
    chain.index = index;
    let page;
    try {
      page = changedFiles(await load(cursor));
    } catch (error) {
      if (this.active !== chain || index !== chain.index) throw error;
      if (!cursor) {
        this.active = undefined;
        throw error;
      }
      return snapshot(error instanceof Error ? error.message : "More files could not be loaded.");
    }
    if (this.active !== chain || index !== chain.index) throw new Error("The selected diff changed.");
    for (const file of page.files) {
      if (!file.omitted || !chain.files.has(file.path)) chain.files.set(file.path, file);
    }
    chain.seen.add(cursor);
    chain.truncated ||= page.truncated || Boolean(page.nextCursor && chain.seen.has(page.nextCursor));
    chain.nextCursor = chain.seen.has(page.nextCursor) ? "" : page.nextCursor;
    return snapshot();
  }
}
