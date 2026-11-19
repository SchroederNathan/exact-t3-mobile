import { expect, test } from "bun:test";
import { composerContextDetail, composerDocument, parseNativeComposerEvent, pruneComposerContext, selectComposerItem } from "../composer-context";

test("prunes context records whose native chips were deleted", () => {
  const context = JSON.stringify({
    version: 1,
    editorLabels: { thread_a: "renamed locally" },
    records: [
      { kind: "thread", contextId: "thread_a", label: "A" },
      { kind: "environment", contextId: "environment_b", label: "B" },
    ],
  });

  expect(
    JSON.parse(
      pruneComposerContext("See [A](t3-context://v1/thread/thread_a)", context),
    ),
  ).toEqual({
    version: 1,
    records: [{ kind: "thread", contextId: "thread_a", label: "A" }],
  });
});

test("returns an empty wire context when no context chip remains", () => {
  const context = JSON.stringify({
    version: 1,
    records: [{ kind: "thread", contextId: "thread_a", label: "A" }],
  });
  expect(pruneComposerContext("plain text", context)).toBe("");
});

test("selects flat contract command rows and opens model settings or clears", () => {
  const draft = { id: "thread", revision: 4, text: "/model", context: "" };
  expect(selectComposerItem({
    draft,
    item: { id: "cmd:model", kind: "slash-command", insertText: "/model", label: "/model" },
    start: 0,
    end: 6,
  })).toMatchObject({ text: "", action: "model-settings", cursor: 0 });

  expect(selectComposerItem({
    draft: { ...draft, text: "/clear" },
    item: { id: "cmd:clear", kind: "slash-command", insertText: "/clear", label: "/clear" },
    start: 0,
    end: 6,
  })).toMatchObject({ text: "", action: "clear", freshContext: true });
});

test("uses skill display metadata for native cube chips while keeping it local", () => {
  const choice = selectComposerItem({
    draft: { id: "thread", revision: 1, text: "$review", context: "" },
    item: { id: "skill:review", kind: "skill", insertText: "$review", label: "Code review" },
    start: 0,
    end: 7,
  });
  expect(JSON.parse(choice.context)).toMatchObject({
    editorLabels: { "$review": { label: "Code review", symbol: "symbol:sf/cube" } },
  });
  expect(JSON.parse(composerDocument(choice.text, choice.context).tokens)).toMatchObject([
    { type: "skill", label: "Code review", symbol: "symbol:sf/cube" },
  ]);
  expect(JSON.parse(composerDocument(choice.text, choice.context).tokens)[0].accent).toBeUndefined();
  expect(pruneComposerContext(choice.text, choice.context)).toBe("");
});

test("does not turn unfinished trigger words into native chips", () => {
  expect(JSON.parse(composerDocument("@src").tokens)).toEqual([]);
  expect(JSON.parse(composerDocument("$review").tokens)).toEqual([]);
  expect(JSON.parse(composerDocument("model:codex/gpt-6").tokens)).toEqual([]);
  expect(JSON.parse(composerDocument("@src ").tokens)).toHaveLength(1);
});

test("merges only supported context records from a native paste", () => {
  const event = parseNativeComposerEvent(JSON.stringify({
    kind: "paste",
    key: "composer",
    text: "See [A](t3-context://v1/thread/a)",
    revision: 2,
    start: 35,
    end: 35,
    context: JSON.stringify({ version: 1, records: [
      { kind: "thread", contextId: "thread_a", label: "A" },
      { kind: "file", contextId: "file_b", label: "B" },
    ] }),
  }), JSON.stringify({ version: 1, records: [{ kind: "environment", contextId: "environment_e", label: "E" }] }));
  expect(event.context).toBe(JSON.stringify({ version: 1, records: [
    { kind: "environment", contextId: "environment_e", label: "E" },
    { kind: "thread", contextId: "thread_a", label: "A" },
  ] }));
  const withExistingFile = parseNativeComposerEvent(JSON.stringify({
    kind: "paste", key: "composer", text: "pasted", revision: 3, start: 6, end: 6,
    context: JSON.stringify({ version: 1, records: [{ kind: "environment", contextId: "environment_f", label: "F" }] }),
  }), JSON.stringify({ version: 1, records: [{ kind: "file", contextId: "file_existing", label: "Existing" }] }));
  expect(JSON.parse(withExistingFile.context).records).toEqual([
    { kind: "file", contextId: "file_existing", label: "Existing" },
    { kind: "environment", contextId: "environment_f", label: "F" },
  ]);
});

test("marks malformed native events invalid without clearing the draft", () => {
  const event = parseNativeComposerEvent("{}", "existing-context");
  expect(event.kind).toBe("invalid");
  expect(event.text).toBe("");
  expect(event.context).toBe("existing-context");
});

test("preserves the native alternate submit intent", () => {
  const event = parseNativeComposerEvent(JSON.stringify({ kind: "submit", key: "composer", text: "next", revision: 4, alternate: true }));
  expect(event).toMatchObject({ kind: "submit", alternate: true, files: [] });
});

test("resolves tapped context chips to detail and a thread route", () => {
  const detail = composerContextDetail(
    "[Fix bug](t3-context://v1/thread/thread_a)",
    JSON.stringify({ version: 1, records: [{ kind: "thread", contextId: "thread_a", label: "Fix bug", environmentId: "Mac Mini", threadId: "abc" }] }),
  );
  expect(detail).toMatchObject({ label: "Fix bug", kind: "thread", detail: "Fix bug", threadId: "Mac%20Mini:abc", href: "/threads/Mac%20Mini:abc" });
});

test("native attachment paste and failures retain their transfer payloads", () => {
  const base = { key: "draft:test", text: "Review ", revision: 2, start: 7, end: 7 };
  const fragment = JSON.stringify({ version: 1, source: { environmentId: "source" }, records: [] });
  const event = parseNativeComposerEvent(JSON.stringify({ ...base, kind: "pasteFragment", context: fragment, pastedText: "[file](t3-context://v1/file/file1)" }));
  expect(event.kind).toBe("pasteFragment");
  expect(event.fragment).toBe(fragment);
  expect(event.pastedText).toBe("[file](t3-context://v1/file/file1)");
  expect(event.start).toBe(7);
  const error = parseNativeComposerEvent(JSON.stringify({ ...base, kind: "pasteError", context: "The clipboard file could not be read." }));
  expect(error.error).toBe("The clipboard file could not be read.");
});

test("inline attachment metadata identifies the owned file for preview and removal", () => {
  const source = "[notes.txt](t3-context://v1/file/attachment_local1)";
  const context = JSON.stringify({ version: 1, records: [{ version: 1, kind: "file", contextId: "attachment_local1", label: "notes.txt", attachmentId: "local1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 }] });
  const document = composerDocument(`Review ${source} `, context);
  expect(document.attachments).toEqual([{ source, attachmentId: "local1" }]);
  expect(composerDocument("Review ", context).attachments).toEqual([]);
});

test("context chip tokens show attachment size suffixes like Expo", () => {
  const source = "![photo.png](t3-context://v1/image/image_local)";
  const context = JSON.stringify({ version: 1, records: [{ version: 1, kind: "image", contextId: "image_local", label: "photo.png", attachmentId: "local1", name: "photo.png", mimeType: "image/png", sizeBytes: 1536 }] });
  expect(JSON.parse(composerDocument(source, context).tokens)[0]).toMatchObject({ kind: "image", detail: "2 KB" });
});

test("unavailable thread chips keep their identity and available threads have no type suffix", () => {
  const value = "Compare [Remote](t3-context://v1/thread/remote) and [Local](t3-context://v1/thread/local)";
  const context = JSON.stringify({ version: 1, records: [{ version: 1, kind: "thread", contextId: "local", label: "Local", environmentId: "target", threadId: "local" }] });
  expect(JSON.parse(composerDocument(value, context).tokens)).toMatchObject([
    { kind: "thread", label: "Remote · unavailable", detail: "", symbol: "symbol:sf/text.bubble" },
    { kind: "thread", label: "Local", detail: "", symbol: "symbol:sf/text.bubble" },
  ]);
});
