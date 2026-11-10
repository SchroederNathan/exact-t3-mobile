import { expect, test } from "bun:test";
import { loadDrafts, saveDraft } from "./drafts";

function fixture(initial?: string) {
  const state: { contents?: string; readError?: Error; writeError?: Error } = { contents: initial };
  const storage: Parameters<typeof loadDrafts>[0] = { fs: {
    async readFile() {
      if (state.readError) throw state.readError;
      if (state.contents === undefined) throw Object.assign(new Error("Missing file"), { code: "ENOENT" });
      return new TextEncoder().encode(state.contents).buffer;
    },
    async atomicWriteFile(_path, bytes) {
      if (state.writeError) throw state.writeError;
      state.contents = new TextDecoder().decode(bytes);
    },
  } };
  return { state, storage };
}

test("queued saves restore separate scoped thread drafts from persisted bytes", async () => {
  const { storage, state } = fixture();
  expect(await loadDrafts(storage)).toEqual([]);
  await saveDraft(storage, "a:thread", "First draft", 1);
  await saveDraft(storage, "b:thread", "Other environment", 1);
  await saveDraft(storage, "a:thread", "More typing", 2);
  expect(await loadDrafts(fixture(state.contents).storage)).toEqual([
    { id: "a:thread", text: "More typing", revision: 2 },
    { id: "b:thread", text: "Other environment", revision: 1 },
  ]);
});

test("a delayed clear cannot overwrite another thread or a newer draft, including after reload", async () => {
  const { storage, state } = fixture();
  await saveDraft(storage, "a:thread", "Submitted text", 1);
  await saveDraft(storage, "b:thread", "Keep this draft", 1);
  await saveDraft(storage, "a:thread", "Newer unsent text", 3);
  await saveDraft(storage, "a:thread", "", 2);
  expect(await loadDrafts(storage)).toEqual([
    { id: "a:thread", text: "Newer unsent text", revision: 3 },
    { id: "b:thread", text: "Keep this draft", revision: 1 },
  ]);
  await saveDraft(storage, "a:thread", "", 4);
  const reloaded = fixture(state.contents).storage;
  await saveDraft(reloaded, "a:thread", "Late old text", 3);
  expect(await loadDrafts(reloaded)).toEqual([
    { id: "a:thread", text: "", revision: 4 },
    { id: "b:thread", text: "Keep this draft", revision: 1 },
  ]);
  await saveDraft(reloaded, "a:thread", "New draft after reload", 5);
  expect(await loadDrafts(reloaded)).toEqual([
    { id: "a:thread", text: "New draft after reload", revision: 5 },
    { id: "b:thread", text: "Keep this draft", revision: 1 },
  ]);
});

test("equal revisions are idempotent only when their text agrees", async () => {
  const { storage, state } = fixture();
  await saveDraft(storage, "a:thread", "Unchanged", 7);
  state.writeError = new Error("Writing is unavailable");
  await saveDraft(storage, "a:thread", "Unchanged", 7);
  await saveDraft(storage, "a:thread", "Older", 6);
  await expect(saveDraft(storage, "a:thread", "Conflicting", 7)).rejects.toThrow("already contains different text");
  expect(await loadDrafts(storage)).toEqual([{ id: "a:thread", text: "Unchanged", revision: 7 }]);
});

test("unreadable or invalid stored drafts are never replaced by a save", async () => {
  for (const contents of [
    "not JSON", "{}",
    JSON.stringify([{ id: "a:thread", text: "Wrong revision", revision: -1 }]),
    JSON.stringify([{ id: "", text: "No identity", revision: 1 }]),
    JSON.stringify([{ id: "a:thread", text: "First", revision: 1 }, { id: "a:thread", text: "Duplicate", revision: 2 }]),
  ]) {
    const { storage, state } = fixture(contents);
    await expect(saveDraft(storage, "b:thread", "New text", 1)).rejects.toThrow();
    expect(state.contents).toBe(contents);
  }
  const { storage, state } = fixture("[]");
  state.readError = Object.assign(new Error("Permission denied"), { code: "EACCES" });
  await expect(loadDrafts(storage)).rejects.toThrow("Permission denied");
  await expect(saveDraft(storage, "a:thread", "New text", 1)).rejects.toThrow("Permission denied");
  expect(state.contents).toBe("[]");
});

test("an atomic-write failure retains the prior revision and the next queued save can recover", async () => {
  const { storage, state } = fixture();
  await saveDraft(storage, "a:thread", "Saved", 1);
  state.writeError = new Error("Disk full");
  await expect(saveDraft(storage, "a:thread", "Not saved", 2)).rejects.toThrow("Disk full");
  expect(await loadDrafts(storage)).toEqual([{ id: "a:thread", text: "Saved", revision: 1 }]);
  state.writeError = undefined;
  await saveDraft(storage, "a:thread", "Recovered", 3);
  expect(await loadDrafts(storage)).toEqual([{ id: "a:thread", text: "Recovered", revision: 3 }]);
});
