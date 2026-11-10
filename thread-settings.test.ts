import { describe, expect, test } from "bun:test";
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
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: true },
      { id: "ultracode", label: "Ultracode", type: "boolean", currentValue: false },
      {
        id: "variant", label: "Variant", type: "select",
        options: [{ id: "default", label: "Default", isDefault: true }],
      },
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
  return {
    config: { providers: [provider], settings: {} },
    thread: {
      id: "thread-one", projectId: "project", runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-6" },
    },
    provider,
    capabilities,
  };
}

describe("thread settings", () => {
  test("projects catalog groups and defaults without sending implicit options", () => {
    const { config, thread } = fixture();
    const before = JSON.stringify({ config, thread });
    const view = projectThreadSettings(config, thread);
    expect(view.groups.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "codex-work", label: "Work account" },
    ]);
    expect(view.selectedModelId).toBe("codex-work:gpt-6");
    expect(view.selectedModel?.options.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: "effort", value: "medium" },
      { id: "fastMode", value: "true" },
      { id: "ultracode", value: "false" },
      { id: "variant", value: "" },
    ]);
    expect(view.selectedModel?.options[0]?.choices.map((choice) => choice.id)).toEqual([
      "medium", "xhigh",
    ]);
    expect(view.selection?.modelSelection.options).toBeUndefined();
    expect(view.error).toBe("");
    expect(JSON.stringify({ config, thread })).toBe(before);
  });

  test("decodes legacy selections, preserves explicit false, and migrates Ultracode effort", () => {
    const { config, thread } = fixture();
    const legacyThread = {
      ...thread,
      modelSelection: {
        provider: "codex-work", model: "gpt-6",
        options: { fastMode: false, effort: "ultracode" },
      },
    };
    const view = projectThreadSettings(config, legacyThread);
    expect(view.selection?.modelSelection.options).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "fastMode", value: false },
      { id: "ultracode", value: true },
    ]);
    expect(view.selectedModel?.options.find((option) => option.id === "fastMode")?.value).toBe("false");
  });

  test("stages typed option values independently per thread and rejects invalid choices", () => {
    const { config, thread } = fixture();
    const result = stageThreadSettings(config, thread, undefined, {
      type: "option", id: "fastMode", value: "false",
    });
    expect(result.ok).toBe(true);
    expect(result.selection?.modelSelection.options).toEqual([{ id: "fastMode", value: false }]);
    expect(projectThreadSettings(config, thread).selection?.modelSelection.options).toBeUndefined();
    expect(projectThreadSettings(config, { ...thread, id: "thread-two" }, result.selection).selection?.modelSelection.options).toBeUndefined();
    expect(validateThreadSettings(config, { ...thread, id: "thread-two" }, result.selection).error).toContain("another thread");
    for (const change of [
      { type: "option", id: "fastMode", value: "yes" },
      { type: "option", id: "effort", value: "nonexistent" },
      { type: "option", id: "effort", value: "ultrathink" },
      { type: "option", id: "missing", value: "true" },
    ] as const) {
      expect(stageThreadSettings(config, thread, result.selection, change).ok).toBe(false);
    }
    const changed = stageThreadSettings(config, thread, result.selection, {
      type: "model", id: "codex-work:gpt-6-mini",
    });
    expect(changed.selection?.modelSelection).toEqual({ instanceId: "codex-work", model: "gpt-6-mini" });
    expect(result.selection?.modelSelection.model).toBe("gpt-6");
  });

  test("respects project overrides, hidden ordering, provider locks and current fallbacks", () => {
    const { config, thread, provider } = fixture();
    const catalog = {
      ...config,
      providers: [provider, { ...provider, instanceId: "codex-personal" }, { ...provider, instanceId: "claude", driver: "claudeAgent" }],
      settings: {
        providerModelPreferences: { "codex-work": { hiddenModels: ["gpt-6"], modelOrder: ["gpt-6-mini"] } },
        projectSettingsOverrides: { project: { providerInstances: { "codex-personal": { enabled: false } } } },
      },
    };
    const view = projectThreadSettings(catalog, thread, undefined, { canSwitchProvider: false });
    expect(view.groups.map((group) => group.id)).toEqual(["codex-work"]);
    expect(view.groups[0]?.models.map((model) => model.slug)).toEqual(["gpt-6-mini"]);
    expect(view.selectedModel?.slug).toBe("gpt-6");
    expect(view.selectedModel?.available).toBe(true);
    expect(stageThreadSettings(catalog, thread, undefined, { type: "model", id: "claude:gpt-6" }, { canSwitchProvider: false }).ok).toBe(false);
    expect(stageThreadSettings(catalog, thread, undefined, { type: "model", id: "codex-personal:gpt-6" }).ok).toBe(false);
    const continuation = {
      providers: [
        { ...provider, continuation: { groupKey: "first" } },
        { ...provider, instanceId: "same-family", continuation: { groupKey: "first" } },
        { ...provider, instanceId: "other-family", continuation: { groupKey: "second" } },
      ],
    };
    expect(projectThreadSettings(continuation, thread, undefined, { canSwitchProvider: false }).groups.map((group) => group.id)).toEqual(["codex-work", "same-family"]);
    expect(projectThreadSettings({ providers: [] }, thread).selectedModel?.available).toBe(true);
    expect(projectThreadSettings({ providers: [{ ...provider, enabled: false }] }, thread).error).toContain("turned off");
    expect(projectThreadSettings({ providers: [{ ...provider, driver: "antigravity", availability: "unavailable" }] }, thread).selectedModel?.available).toBe(false);
  });

  test("retains supported runtime choices and refuses managed or stale staged settings", () => {
    const { config, thread, provider } = fixture();
    const restricted = {
      ...config,
      providers: [{ ...provider, supportedRuntimeModes: ["approval-required", "full-access"] }],
      managedPolicy: { organization: "Example", limits: { maxRuntimeMode: "approval-required" } },
    };
    const view = projectThreadSettings(restricted, thread);
    expect(view.runtimeChoices.map(({ id, available }) => ({ id, available }))).toEqual([
      { id: "approval-required", available: true },
      { id: "full-access", available: false },
    ]);
    expect(view.error).toContain("limits threads");
    expect(stageThreadSettings(restricted, thread, undefined, { type: "runtime", id: "auto" }).ok).toBe(false);
    const staged = stageThreadSettings(restricted, thread, undefined, { type: "runtime", id: "approval-required" });
    expect(staged.ok).toBe(true);
    const disabled = { ...restricted, providers: [{ ...provider, enabled: false }] };
    expect(validateThreadSettings(disabled, thread, staged.selection).ok).toBe(false);
    const otherModel = stageThreadSettings(config, thread, undefined, { type: "model", id: "codex-work:gpt-6-mini" });
    const hidden = { ...config, settings: { providerModelPreferences: { "codex-work": { hiddenModels: ["gpt-6-mini"] } } } };
    expect(validateThreadSettings(hidden, thread, otherModel.selection).ok).toBe(false);
    const option = stageThreadSettings(config, thread, undefined, { type: "option", id: "effort", value: "xhigh" });
    const changedCatalog = {
      providers: [{ ...provider, models: [{ ...provider.models[0], capabilities: { optionDescriptors: [{ id: "effort", type: "select", options: [{ id: "medium", isDefault: true }] }] } }] }],
    };
    expect(validateThreadSettings(changedCatalog, thread, option.selection).ok).toBe(false);
    const disallowed = { ...config, managedPolicy: { organization: "Example", limits: { providers: { allowedDrivers: ["claudeAgent"] } } } };
    expect(projectThreadSettings(disallowed, thread).error).toContain("not allowed");
  });
});
