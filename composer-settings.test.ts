import { describe, expect, test } from "bun:test";
import { ComposerSettings } from "./composer-settings";
import type { DirectSession } from "./connection";
import {
  projectThreadSettings,
  stageThreadSettings,
  validateThreadSettings,
} from "./thread-settings";

function fixture() {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort", label: "Reasoning", type: "select",
        options: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "xhigh", label: "Extra high" },
        ],
      },
      { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: true },
    ],
  };
  const provider = {
    instanceId: "codex-work", driver: "codex", displayName: "Work account",
    enabled: true, installed: true, auth: { status: "authenticated" },
    models: [
      { slug: "gpt-6", name: "GPT-6", isDefault: true, capabilities },
      { slug: "gpt-6-mini", name: "GPT-6 Mini", capabilities },
    ],
  };
  let config: unknown = { providers: [provider] };
  const threads = new Map(["thread-one", "thread-two"].map((id) => [id, {
    id, projectId: "project", runtimeMode: "full-access",
    modelSelection: { instanceId: "codex-work", model: "gpt-6" },
  }]));
  const session: Pick<DirectSession, "settings" | "stageSettings" | "validateSettings"> = {
    settings: (id, selection) => projectThreadSettings(config, threads.get(id), selection),
    stageSettings: (id, selection, change) => stageThreadSettings(config, threads.get(id), selection, change),
    validateSettings: (id, selection) => validateThreadSettings(config, threads.get(id), selection),
  };
  return { session, provider, setConfig: (value: unknown) => { config = value; } };
}

describe("composer settings", () => {
  test("Save applies the pending model to the same thread and retains it when reopened", () => {
    const { session } = fixture();
    const settings = new ComposerSettings();
    expect(settings.begin("first:thread-one", "thread-one", session)).toEqual({ ok: true, error: "" });
    expect(settings.project("first:thread-one", "thread-one", session).saveLabel).toBe("Done");
    expect(settings.change("first:thread-one", "thread-one", session, {
      type: "model", id: "codex-work:gpt-6-mini",
    })).toEqual({ ok: true, error: "" });
    expect(settings.selection("first:thread-one")).toBeUndefined();
    expect(settings.project("first:thread-one", "thread-one", session)).toMatchObject({
      selectedModelId: "codex-work:gpt-6-mini", saveLabel: "Save", error: "",
    });

    expect(settings.close("first:thread-one", "thread-one", session, true)).toEqual({ ok: true, error: "" });
    expect(settings.selection("first:thread-one")).toEqual({
      threadId: "thread-one", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6-mini" },
    });
    expect(settings.begin("first:thread-one", "thread-one", session)).toEqual({ ok: true, error: "" });
    expect(settings.project("first:thread-one", "thread-one", session)).toMatchObject({
      selectedModelId: "codex-work:gpt-6-mini", saveLabel: "Done", error: "",
    });
  });

  test("Cancel drops a pending model but retains applied-model options and runtime changes", () => {
    const { session } = fixture();
    const settings = new ComposerSettings();
    settings.begin("first:thread-one", "thread-one", session);
    settings.change("first:thread-one", "thread-one", session, { type: "option", id: "effort", value: "xhigh" });
    settings.change("first:thread-one", "thread-one", session, { type: "option", id: "fastMode", value: "false" });
    settings.change("first:thread-one", "thread-one", session, { type: "model", id: "codex-work:gpt-6-mini" });
    settings.change("first:thread-one", "thread-one", session, { type: "runtime", id: "approval-required" });
    expect(settings.project("first:thread-one", "thread-one", session)).toMatchObject({
      selectedModelId: "codex-work:gpt-6-mini", runtimeMode: "approval-required", saveLabel: "Save",
    });

    expect(settings.close("first:thread-one", "thread-one", session, false)).toEqual({ ok: true, error: "" });
    expect(settings.selection("first:thread-one")).toEqual({
      threadId: "thread-one", runtimeMode: "approval-required",
      modelSelection: {
        instanceId: "codex-work", model: "gpt-6",
        options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: false }],
      },
    });
    const view = settings.project("first:thread-one", "thread-one", session);
    expect(view).toMatchObject({
      selectedModelId: "codex-work:gpt-6", runtimeLabel: "Supervised", saveLabel: "Done", error: "",
    });
    expect(view.options.map(({ id, value, valueLabel }) => ({ id, value, valueLabel }))).toEqual([
      { id: "effort", value: "xhigh", valueLabel: "Extra high" },
      { id: "fastMode", value: "false", valueLabel: "Off" },
    ]);
  });

  test("Cancel discards pending-model options together with that model", () => {
    const { session } = fixture();
    const settings = new ComposerSettings();
    settings.begin("first:thread-one", "thread-one", session);
    settings.change("first:thread-one", "thread-one", session, { type: "model", id: "codex-work:gpt-6-mini" });
    settings.change("first:thread-one", "thread-one", session, { type: "option", id: "effort", value: "xhigh" });
    settings.change("first:thread-one", "thread-one", session, { type: "option", id: "fastMode", value: "false" });
    expect(settings.project("first:thread-one", "thread-one", session).options.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: "effort", value: "xhigh" }, { id: "fastMode", value: "false" },
    ]);

    expect(settings.close("first:thread-one", "thread-one", session, false)).toEqual({ ok: true, error: "" });
    expect(settings.selection("first:thread-one")).toBeUndefined();
    settings.begin("first:thread-one", "thread-one", session);
    const view = settings.project("first:thread-one", "thread-one", session);
    expect(view.selectedModelId).toBe("codex-work:gpt-6");
    expect(view.options.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: "effort", value: "medium" }, { id: "fastMode", value: "true" },
    ]);
  });

  test("scoped environment and thread selections remain independent", () => {
    const first = fixture().session;
    const second = fixture().session;
    const settings = new ComposerSettings();
    settings.begin("first:thread-one", "thread-one", first);
    settings.change("first:thread-one", "thread-one", first, { type: "model", id: "codex-work:gpt-6-mini" });
    settings.change("first:thread-one", "thread-one", first, { type: "option", id: "effort", value: "xhigh" });
    settings.close("first:thread-one", "thread-one", first, true);
    settings.begin("second:thread-one", "thread-one", second);
    settings.change("second:thread-one", "thread-one", second, { type: "option", id: "fastMode", value: "false" });
    settings.close("second:thread-one", "thread-one", second, true);
    settings.begin("first:thread-two", "thread-two", first);
    settings.change("first:thread-two", "thread-two", first, { type: "runtime", id: "auto" });

    expect(settings.selection("first:thread-one")).toEqual({
      threadId: "thread-one", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6-mini", options: [{ id: "effort", value: "xhigh" }] },
    });
    expect(settings.selection("second:thread-one")).toEqual({
      threadId: "thread-one", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6", options: [{ id: "fastMode", value: false }] },
    });
    expect(settings.selection("first:thread-two")).toEqual({
      threadId: "thread-two", runtimeMode: "auto",
      modelSelection: { instanceId: "codex-work", model: "gpt-6" },
    });
    expect(settings.project("first:thread-one", "thread-one", first).selectedModelId).toBe("codex-work:gpt-6-mini");
    expect(settings.project("second:thread-one", "thread-one", second).selectedModelId).toBe("codex-work:gpt-6");
    expect(settings.project("first:thread-two", "thread-two", first).runtimeLabel).toBe("Auto");
  });

  test("Save rejects a selection disabled after the sheet opened without applying it", () => {
    const { session, provider, setConfig } = fixture();
    const settings = new ComposerSettings();
    settings.begin("first:thread-one", "thread-one", session);
    settings.change("first:thread-one", "thread-one", session, { type: "model", id: "codex-work:gpt-6-mini" });
    setConfig({ providers: [{ ...provider, enabled: false }] });

    expect(settings.close("first:thread-one", "thread-one", session, true)).toEqual({
      ok: false, error: "Model turned off for this project.",
    });
    expect(settings.selection("first:thread-one")).toBeUndefined();
    expect(settings.project("first:thread-one", "thread-one", session)).toMatchObject({
      selectedModelId: "codex-work:gpt-6-mini", saveLabel: "Save", error: "Model turned off for this project.",
    });
    expect(settings.close("first:thread-one", "thread-one", session, false)).toEqual({ ok: true, error: "" });
    expect(settings.project("first:thread-one", "thread-one", session).selectedModelId).toBe("codex-work:gpt-6");
  });

  test("a superseded sheet cannot edit or save another scoped thread's selection", () => {
    const { session } = fixture();
    const settings = new ComposerSettings();
    settings.begin("first:thread-one", "thread-one", session);
    settings.change("first:thread-one", "thread-one", session, { type: "model", id: "codex-work:gpt-6-mini" });
    settings.begin("second:thread-one", "thread-one", session);

    expect(settings.change("first:thread-one", "thread-one", session, { type: "runtime", id: "auto" })).toEqual({
      ok: false, error: "Open this thread's settings again.",
    });
    expect(settings.close("first:thread-one", "thread-one", session, true)).toEqual({
      ok: false, error: "Open this thread's settings again.",
    });
    expect(settings.selection("first:thread-one")).toBeUndefined();
    expect(settings.project("second:thread-one", "thread-one", session)).toMatchObject({
      selectedModelId: "codex-work:gpt-6", runtimeMode: "full-access", saveLabel: "Done", error: "",
    });
    expect(settings.close("second:thread-one", "thread-one", session, true)).toEqual({ ok: true, error: "" });
    expect(settings.selection("second:thread-one")).toEqual({
      threadId: "thread-one", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6" },
    });
  });
});
