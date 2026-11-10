import { expect, test } from "bun:test";
import { loadModelDrafts, saveModelDrafts, type ModelDraft } from "./model-drafts";

function fixture(initial?: string) {
  const state: { contents?: string; readError?: Error; writeError?: Error } = { contents: initial };
  const storage: Parameters<typeof loadModelDrafts>[0] = { fs: {
    async readFile(path) {
      if (path !== "app:/data/model-drafts-v1.json") throw new Error("Unknown file");
      if (state.readError) throw state.readError;
      if (state.contents === undefined) throw Object.assign(new Error("Missing file"), { code: "ENOENT" });
      return new TextEncoder().encode(state.contents).buffer;
    },
    async atomicWriteFile(path, bytes) {
      if (path !== "app:/data/model-drafts-v1.json") throw new Error("Unknown file");
      if (state.writeError) throw state.writeError;
      state.contents = new TextDecoder().decode(bytes);
    },
  } };
  return { state, storage };
}

function draft(): ModelDraft {
  return {
    id: "first:thread",
    selection: {
      threadId: "thread", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6" },
    },
  };
}

test("a relaunch restores scoped selections and explicit boolean options from saved bytes", async () => {
  const { storage, state } = fixture();
  expect(await loadModelDrafts(storage)).toEqual([]);
  await saveModelDrafts(storage, [
    {
      id: "first:thread",
      selection: {
        threadId: "thread", runtimeMode: "approval-required",
        modelSelection: {
          instanceId: "codex-work", model: "gpt-6-mini",
          options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: false }, { id: "ultracode", value: true }],
        },
      },
    },
    { ...draft(), id: "second:thread" },
    {
      id: "remote%3Amac:thread%3Aone",
      selection: {
        threadId: "thread:one", runtimeMode: "auto",
        modelSelection: { instanceId: "claude-personal", model: "claude-haiku-4-5" },
      },
    },
  ]);
  expect(await loadModelDrafts(fixture(state.contents).storage)).toEqual([
    {
      id: "first:thread",
      selection: {
        threadId: "thread", runtimeMode: "approval-required",
        modelSelection: {
          instanceId: "codex-work", model: "gpt-6-mini",
          options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: false }, { id: "ultracode", value: true }],
        },
      },
    },
    {
      id: "second:thread",
      selection: { threadId: "thread", runtimeMode: "full-access", modelSelection: { instanceId: "codex-work", model: "gpt-6" } },
    },
    {
      id: "remote%3Amac:thread%3Aone",
      selection: {
        threadId: "thread:one", runtimeMode: "auto",
        modelSelection: { instanceId: "claude-personal", model: "claude-haiku-4-5" },
      },
    },
  ]);
});

test("each save replaces the complete snapshot without reading or merging prior selections", async () => {
  const { storage, state } = fixture();
  state.readError = new Error("Reads are unavailable");
  await saveModelDrafts(storage, [draft(), { ...draft(), id: "second:thread" }]);
  await saveModelDrafts(storage, [draft()]);
  await saveModelDrafts(storage, [draft()]);
  expect(state.contents).toBe('[{"id":"first:thread","selection":{"threadId":"thread","runtimeMode":"full-access","modelSelection":{"instanceId":"codex-work","model":"gpt-6"}}}]');
  await saveModelDrafts(storage, []);
  expect(state.contents).toBe("[]");
  expect(await loadModelDrafts(fixture(state.contents).storage)).toEqual([]);
});

test("model and runtime overrides roundtrip independently after acknowledgement", async () => {
  const { storage, state } = fixture();
  await saveModelDrafts(storage, [
    { id: "first:thread", selection: { threadId: "thread", runtimeMode: "approval-required" } },
    { id: "second:thread", selection: { threadId: "thread", modelSelection: { instanceId: "codex-work", model: "gpt-6" } } },
  ]);
  expect(await loadModelDrafts(fixture(state.contents).storage)).toEqual([
    { id: "first:thread", selection: { threadId: "thread", runtimeMode: "approval-required" } },
    { id: "second:thread", selection: { threadId: "thread", modelSelection: { instanceId: "codex-work", model: "gpt-6" } } },
  ]);
});

test("corrupt, duplicate, or mismatched stored selections fail instead of becoming empty state", async () => {
  const valid = draft();
  const invalid: unknown[] = [
    {}, null, [null], [valid, valid],
    [{ ...valid, id: "" }],
    [{ ...valid, id: "thread" }],
    [{ ...valid, id: "%:thread" }],
    [{ ...valid, id: "first:other-thread" }],
    [{ ...valid, selection: { ...valid.selection, threadId: "" } }],
    [{ ...valid, selection: { threadId: "thread" } }],
    [{ ...valid, selection: { ...valid.selection, runtimeMode: "invalid" } }],
    [{ ...valid, selection: { ...valid.selection, modelSelection: null } }],
    [{ ...valid, selection: { ...valid.selection, modelSelection: { instanceId: "", model: "gpt-6" } } }],
    [{ ...valid, selection: { ...valid.selection, modelSelection: { instanceId: "codex-work", model: " " } } }],
    ...[null, {}, [{ id: "", value: false }], [{ id: "effort", value: 1 }], [{ id: "effort" }]].map((options) => [
      { ...valid, selection: { ...valid.selection, modelSelection: { ...valid.selection.modelSelection, options } } },
    ]),
  ];
  for (const contents of ["not JSON", ...invalid.map((value) => JSON.stringify(value))]) {
    const { storage, state } = fixture(contents);
    await expect(loadModelDrafts(storage)).rejects.toThrow();
    expect(state.contents).toBe(contents);
  }
});

test("only a missing file becomes empty state and other read failures propagate", async () => {
  const { storage, state } = fixture("[]");
  for (const error of [
    Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    new Error("Storage unavailable"),
  ]) {
    state.readError = error;
    await expect(loadModelDrafts(storage)).rejects.toBe(error);
    expect(state.contents).toBe("[]");
  }
});

test("invalid outgoing snapshots cannot replace persisted selections", async () => {
  const { storage, state } = fixture();
  await saveModelDrafts(storage, [draft()]);
  const before = state.contents;
  for (const records of [
    [draft(), draft()],
    [{ ...draft(), selection: { ...draft().selection, runtimeMode: "unsupported" } }],
  ]) {
    await expect(saveModelDrafts(storage, records)).rejects.toThrow("valid, unique scoped selections");
    expect(state.contents).toBe(before);
  }
});

test("an atomic-write failure preserves the previous bytes and a later snapshot can recover", async () => {
  const { storage, state } = fixture();
  await saveModelDrafts(storage, [draft()]);
  const before = state.contents;
  state.writeError = new Error("Disk full");
  await expect(saveModelDrafts(storage, [{ ...draft(), id: "second:thread" }])).rejects.toThrow("Disk full");
  expect(state.contents).toBe(before);
  expect(await loadModelDrafts(fixture(state.contents).storage)).toEqual([{
    id: "first:thread",
    selection: { threadId: "thread", runtimeMode: "full-access", modelSelection: { instanceId: "codex-work", model: "gpt-6" } },
  }]);
  state.writeError = undefined;
  await saveModelDrafts(storage, [{
    ...draft(), selection: { ...draft().selection, runtimeMode: "auto-accept-edits" },
  }]);
  expect(await loadModelDrafts(fixture(state.contents).storage)).toEqual([{
    id: "first:thread",
    selection: { threadId: "thread", runtimeMode: "auto-accept-edits", modelSelection: { instanceId: "codex-work", model: "gpt-6" } },
  }]);
});
