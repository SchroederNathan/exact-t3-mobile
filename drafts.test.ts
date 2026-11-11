import { expect, test } from "bun:test";
import { loadDrafts, saveDraft as writeDraft, emptyDraft, restoreDrafts } from "./drafts";

const saveDraft = (storage: Parameters<typeof writeDraft>[0], id: string, text: string, revision: number) => writeDraft(storage, { ...emptyDraft(id), text, revision });

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
    { ...emptyDraft("a:thread"), text: "More typing", revision: 2 },
    { ...emptyDraft("b:thread"), text: "Other environment", revision: 1 },
  ]);
});

test("a delayed clear cannot overwrite another thread or a newer draft, including after reload", async () => {
  const { storage, state } = fixture();
  await saveDraft(storage, "a:thread", "Submitted text", 1);
  await saveDraft(storage, "b:thread", "Keep this draft", 1);
  await saveDraft(storage, "a:thread", "Newer unsent text", 3);
  await saveDraft(storage, "a:thread", "", 2);
  expect(await loadDrafts(storage)).toEqual([
    { ...emptyDraft("a:thread"), text: "Newer unsent text", revision: 3 },
    { ...emptyDraft("b:thread"), text: "Keep this draft", revision: 1 },
  ]);
  await saveDraft(storage, "a:thread", "", 4);
  const reloaded = fixture(state.contents).storage;
  await saveDraft(reloaded, "a:thread", "Late old text", 3);
  expect(await loadDrafts(reloaded)).toEqual([
    { ...emptyDraft("a:thread"), text: "", revision: 4 },
    { ...emptyDraft("b:thread"), text: "Keep this draft", revision: 1 },
  ]);
  await saveDraft(reloaded, "a:thread", "New draft after reload", 5);
  expect(await loadDrafts(reloaded)).toEqual([
    { ...emptyDraft("a:thread"), text: "New draft after reload", revision: 5 },
    { ...emptyDraft("b:thread"), text: "Keep this draft", revision: 1 },
  ]);
});

test("equal revisions are idempotent only when their text agrees", async () => {
  const { storage, state } = fixture();
  await saveDraft(storage, "a:thread", "Unchanged", 7);
  state.writeError = new Error("Writing is unavailable");
  await saveDraft(storage, "a:thread", "Unchanged", 7);
  await saveDraft(storage, "a:thread", "Older", 6);
  await expect(saveDraft(storage, "a:thread", "Conflicting", 7)).rejects.toThrow("already contains different content");
  expect(await loadDrafts(storage)).toEqual([{ ...emptyDraft("a:thread"), text: "Unchanged", revision: 7 }]);
});

test("unreadable or invalid stored drafts are never replaced by a save", async () => {
  for (const contents of [
    "not JSON", "{}",
    JSON.stringify([{ id: "a:thread", text: "Wrong revision", revision: -1 }]),
    JSON.stringify([{ id: "", text: "No identity", revision: 1 }]),
    JSON.stringify([{ ...emptyDraft("a:thread"), text: "First", revision: 1 }, { ...emptyDraft("a:thread"), text: "Duplicate", revision: 2 }]),
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
  expect(await loadDrafts(storage)).toEqual([{ ...emptyDraft("a:thread"), text: "Saved", revision: 1 }]);
  state.writeError = undefined;
  await saveDraft(storage, "a:thread", "Recovered", 3);
  expect(await loadDrafts(storage)).toEqual([{ ...emptyDraft("a:thread"), text: "Recovered", revision: 3 }]);
});

test("attachment drafts migrate old text and preserve pending delivery identities across restoration", async () => {
  const { storage, state } = fixture(JSON.stringify([{ id: "a:thread", text: "old", revision: 1 }]));
  expect(await loadDrafts(storage)).toEqual([{ ...emptyDraft("a:thread"), text: "old", revision: 1 }]);
  const attachment = { type: "file", id: "pending-file", localId: "file", path: "app:/data/composer-attachments/file/content.pdf", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 20, width: 0, height: 0, state: "uploaded", attempt: 1, error: "", insertionRevision: 2 };
  const pending = { commandId: "command-1", messageId: "message-1", revision: 4, text: "", selection: "", state: "unknown", paths: [attachment.path], attachments: [{ type: "file", id: "pending-file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 20 }] };
  await writeDraft(storage, { id: "a:thread", text: "", revision: 4, attachments: [attachment], pendingSend: pending });
  expect((await loadDrafts(fixture(state.contents).storage))[0]).toEqual({ id: "a:thread", text: "", revision: 4, attachments: [attachment], pendingSend: pending });
  await expect(writeDraft(storage, { id: "a:thread", text: "", revision: 4, attachments: [], pendingSend: pending })).rejects.toThrow("different content");
  const restored = restoreDrafts([{ id: "a:thread", text: "", revision: 5, attachments: [{ ...attachment, state: "uploading" }], pendingSend: null }]);
  const prepared = { id: "a:thread", text: "", revision: 4, attachments: [], pendingSend: { ...pending, state: "prepared" } };
  const recovered = restoreDrafts([prepared])[0]!;
  expect(recovered).toMatchObject({ revision: 5, pendingSend: { commandId: "command-1", messageId: "message-1", state: "unknown", revision: 5, paths: [attachment.path] } });
  await writeDraft(storage, recovered);
  expect((await loadDrafts(storage))[0]!.pendingSend!.paths).toEqual([attachment.path]);
  expect(restored[0]!.attachments[0]).toMatchObject({ state: "failed", error: "Upload was interrupted. Retry or remove this attachment.", path: attachment.path });
});
