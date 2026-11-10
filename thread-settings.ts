type RecordValue = Record<string, unknown>;

export type ModelSelection = {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
};

export type ThreadSettingsSelection = {
  threadId: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
};

export type SettingsOption = {
  id: string;
  label: string;
  description: string;
  kind: string;
  value: string;
  explicit: boolean;
  choices: Array<{ id: string; label: string }>;
};

export type SettingsModel = {
  id: string;
  instanceId: string;
  provider: string;
  label: string;
  slug: string;
  available: boolean;
  unavailableReason: string;
  isDefault: boolean;
  isLegacy: boolean;
  options: SettingsOption[];
};

export type SettingsPolicy = {
  canSwitchProvider?: boolean;
  lockedProviderInstanceId?: string;
};

export type SettingsChange =
  | { type: "model"; id: string }
  | { type: "option"; id: string; value: string | boolean }
  | { type: "runtime"; id: string };

export type SettingsResult = {
  ok: boolean;
  error: string;
  selection: ThreadSettingsSelection | null;
};

const runtimeModes = [
  { id: "approval-required", label: "Supervised", description: "Ask before commands and file changes." },
  { id: "auto-accept-edits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." },
  { id: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  { id: "full-access", label: "Full access", description: "Allow commands and edits without prompts." },
];

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function decodeSelection(value: unknown): ModelSelection | null {
  const raw = object(value);
  const instanceId = string(raw.instanceId ?? raw.provider).trim();
  const model = string(raw.model).trim();
  if (!instanceId || !model) return null;
  const entries = Array.isArray(raw.options)
    ? records(raw.options)
    : Object.entries(object(raw.options)).map(([id, value]) => ({ id, value }));
  const options = new Map<string, string | boolean>();
  for (const entry of entries) {
    const id = string(entry.id).trim();
    if (id && (typeof entry.value === "string" || typeof entry.value === "boolean"))
      options.set(id, entry.value);
  }
  return {
    instanceId,
    model,
    ...(options.size ? { options: [...options].map(([id, value]) => ({ id, value })) } : {}),
  };
}

function selectionId(selection: ModelSelection | null): string {
  return selection ? `${selection.instanceId}:${selection.model}` : "";
}

function descriptors(model: RecordValue) {
  return records(object(model.capabilities).optionDescriptors).filter(
    (descriptor) => string(descriptor.id) && (descriptor.type === "select" || descriptor.type === "boolean"),
  );
}

function optionRows(model: RecordValue, selection: ModelSelection | null): SettingsOption[] {
  const source = descriptors(model);
  const explicit = new Map(selection?.options?.map((option) => [option.id, option.value]));
  if (explicit.get("effort") === "ultracode" && source.some((item) => item.id === "ultracode" && item.type === "boolean")) {
    explicit.set("effort", "xhigh");
    if (!explicit.has("ultracode")) explicit.set("ultracode", true);
  }
  return source.map((descriptor) => {
    const id = string(descriptor.id);
    const choices = records(descriptor.options).filter((choice) => string(choice.id));
    const promptInjected = strings(descriptor.promptInjectedValues);
    const preferred = explicit.get(id) ?? descriptor.currentValue;
    let value = "";
    if (descriptor.type === "boolean") {
      const boolean = typeof preferred === "boolean" ? preferred : descriptor.currentValue;
      if (typeof boolean === "boolean") value = String(boolean);
    } else if (id !== "variant" || explicit.has(id)) {
      const defaultValue = string(choices.find((choice) => choice.isDefault === true)?.id);
      const current = string(descriptor.currentValue) || defaultValue;
      const candidate = typeof preferred === "string" ? preferred.trim() : current;
      value = promptInjected.includes(candidate)
        ? defaultValue
        : candidate && (choices.length === 0 || choices.some((choice) => choice.id === candidate))
          ? candidate
          : current;
    }
    return {
      id,
      label: string(descriptor.label) || id,
      description: string(descriptor.description),
      kind: string(descriptor.type),
      value,
      explicit: explicit.has(id),
      choices: descriptor.type === "boolean"
        ? [{ id: "true", label: "On" }, { id: "false", label: "Off" }]
        : choices.filter((choice) => !promptInjected.includes(string(choice.id))).map((choice) => ({
            id: string(choice.id), label: string(choice.label) || string(choice.id),
          })),
    };
  });
}

function normalizeSelection(selection: ModelSelection, model: RecordValue): ModelSelection {
  if (!model.capabilities) return decodeSelection(selection)!;
  const options = optionRows(model, selection)
    .filter((option) => option.explicit && option.value !== "")
    .map((option) => ({ id: option.id, value: option.kind === "boolean" ? option.value === "true" : option.value }));
  return { instanceId: selection.instanceId, model: selection.model, ...(options.length ? { options } : {}) };
}

function providerLabel(provider: RecordValue): string {
  return string(provider.displayName) || ({ codex: "Codex", claudeAgent: "Claude", pi: "Pi" }[string(provider.driver)]) || string(provider.instanceId);
}

function providerEnabled(config: RecordValue, provider: RecordValue, projectId: string): boolean {
  const settings = object(config.settings);
  const instanceId = string(provider.instanceId);
  const overrides = object(object(settings.projectSettingsOverrides)[projectId]);
  const override = object(object(overrides.providerInstances)[instanceId]).enabled;
  if (typeof override === "boolean") return override;
  const instance = object(object(settings.providerInstances)[instanceId]);
  if (instance.enabled === false || object(instance.config).enabled === false) return false;
  return instance.enabled === true || object(instance.config).enabled === true || provider.enabled === true;
}

function providerDenial(config: RecordValue, provider: RecordValue, projectId: string): string {
  if (!providerEnabled(config, provider, projectId)) return "Model turned off for this project.";
  const managed = object(config.managedPolicy);
  const allowed = strings(object(object(managed.limits).providers).allowedDrivers);
  if (allowed.length && !allowed.includes(string(provider.driver))) return "Provider not allowed by this environment's policy.";
  return "";
}

function matchesLock(provider: RecordValue, providers: RecordValue[], lockedId: string): boolean {
  if (!lockedId || provider.instanceId === lockedId) return true;
  const locked = providers.find((candidate) => candidate.instanceId === lockedId);
  if (!locked || provider.driver !== locked.driver) return false;
  const group = string(object(locked.continuation).groupKey);
  return group ? object(provider.continuation).groupKey === group : provider.driver !== "antigravity";
}

function runtimeChoices(config: RecordValue, provider: RecordValue) {
  const supported = strings(provider.supportedRuntimeModes);
  const managed = object(config.managedPolicy);
  const ceiling = string(object(managed.limits).maxRuntimeMode);
  const ceilingIndex = runtimeModes.findIndex((mode) => mode.id === ceiling);
  return runtimeModes.flatMap((mode, index) => {
    if (supported.length && !supported.includes(mode.id)) return [];
    const unavailableReason = ceilingIndex >= 0 && index > ceilingIndex
      ? `${string(managed.organization) || "This environment"} limits threads to ${runtimeModes[ceilingIndex]!.label}.`
      : "";
    return [{ ...mode, available: !unavailableReason, unavailableReason }];
  });
}

export function projectThreadSettings(
  rawConfig: unknown,
  rawThread: unknown,
  staged?: ThreadSettingsSelection | null,
  policy: SettingsPolicy = {},
) {
  const config = object(rawConfig);
  const thread = object(rawThread);
  const threadId = string(thread.id);
  const projectId = string(thread.projectId);
  const persisted = decodeSelection(thread.modelSelection);
  const matchingStage = staged?.threadId === threadId ? staged : null;
  let current = decodeSelection(matchingStage?.modelSelection) ?? persisted;
  const providers = records(config.providers);
  const lockedId = policy.lockedProviderInstanceId ?? (policy.canSwitchProvider === false ? persisted?.instanceId ?? "" : "");
  const preferences = object(object(config.settings).providerModelPreferences);
  const groups: Array<{ id: string; label: string; provider: string; models: SettingsModel[] }> = [];
  const modelRow = (provider: RecordValue, model: RecordValue, unavailableReason = ""): SettingsModel => {
    const instanceId = string(provider.instanceId);
    const slug = string(model.slug);
    const id = `${instanceId}:${slug}`;
    return {
      id, instanceId, provider: string(provider.driver), slug,
      label: string(model.name) || slug,
      available: !unavailableReason, unavailableReason,
      isDefault: model.isDefault === true, isLegacy: model.isLegacy === true,
      options: optionRows(model, id === selectionId(current) ? current : id === selectionId(persisted) ? persisted : null),
    };
  };
  for (const provider of providers) {
    const id = string(provider.instanceId);
    if (!id || !matchesLock(provider, providers, lockedId) || providerDenial(config, provider, projectId)
      || provider.installed !== true || object(provider.auth).status === "unauthenticated"
      || (provider.driver === "antigravity" && provider.availability === "unavailable")) continue;
    const preference = object(preferences[id]);
    const hidden = strings(preference.hiddenModels);
    const order = strings(preference.modelOrder);
    const rank = (model: RecordValue) => {
      const index = order.indexOf(string(model.slug));
      return index === -1 ? Infinity : index;
    };
    const models = records(provider.models)
      .filter((model) => string(model.slug) && (model.isCustom === true || !hidden.includes(string(model.slug))))
      .sort((a, b) => rank(a) - rank(b))
      .map((model) => modelRow(provider, model));
    if (models.length) groups.push({ id, label: providerLabel(provider), provider: string(provider.driver), models });
  }

  let selectedModel: SettingsModel | null = null;
  let selectedProvider: RecordValue = {};
  if (current) {
    const liveProvider = providers.find((provider) => provider.instanceId === current!.instanceId);
    const storedProvider = object(object(object(config.settings).providerInstances)[current.instanceId]);
    selectedProvider = liveProvider ?? { ...storedProvider, instanceId: current.instanceId, driver: storedProvider.driver ?? current.instanceId };
    const model = records(selectedProvider.models).find((model) => model.slug === current!.model);
    current = normalizeSelection(current, model ?? {});
    let reason = liveProvider ? providerDenial(config, liveProvider, projectId) : "";
    const override = object(object(object(object(object(config.settings).projectSettingsOverrides)[projectId]).providerInstances)[current.instanceId]);
    if (override.enabled === false) reason = "Model turned off for this project.";
    const allowed = strings(object(object(object(config.managedPolicy).limits).providers).allowedDrivers);
    if (allowed.length && !allowed.includes(string(selectedProvider.driver))) reason = "Provider not allowed by this environment's policy.";
    if (!matchesLock(selectedProvider, providers, lockedId)) reason = "This thread cannot switch to that provider.";
    if (selectedProvider.driver === "antigravity" && (!liveProvider || liveProvider.installed !== true
      || object(liveProvider.auth).status === "unauthenticated" || liveProvider.availability === "unavailable" || !model))
      reason ||= string(selectedProvider.unavailableReason) || "Antigravity model unavailable.";
    if (records(selectedProvider.updateRequiredModels).some((model) => model.slug === current!.model))
      reason = "Update this provider to use this model.";
    selectedModel = modelRow(selectedProvider, model ?? { slug: current.model }, reason);
    const group = groups.find((group) => group.id === current!.instanceId);
    const index = group?.models.findIndex((model) => model.id === selectedModel!.id) ?? -1;
    const hidden = strings(object(preferences[current.instanceId]).hiddenModels).includes(current.model) && model?.isCustom !== true;
    if (group && index >= 0) group.models[index] = selectedModel;
    else if (!hidden) {
      if (group) group.models.push(selectedModel);
      else groups.push({ id: current.instanceId, label: providerLabel(selectedProvider), provider: string(selectedProvider.driver), models: [selectedModel] });
    }
  }
  const choices = runtimeChoices(config, selectedProvider);
  const runtimeMode = matchingStage?.runtimeMode || string(thread.runtimeMode) || "full-access";
  const runtime = choices.find((choice) => choice.id === runtimeMode);
  const error = !selectedModel ? "Choose a model." : selectedModel.unavailableReason
    || (!runtime ? "This provider does not support the selected runtime mode." : runtime.unavailableReason);
  return {
    groups, selectedModelId: selectionId(current), selectedModel, runtimeMode,
    runtimeChoices: choices,
    selection: current ? { threadId, modelSelection: current, runtimeMode } : null,
    error,
  };
}

function rejected(error: string): SettingsResult {
  return { ok: false, error, selection: null };
}

export function validateThreadSettings(
  config: unknown,
  thread: unknown,
  selection?: ThreadSettingsSelection | null,
  policy: SettingsPolicy = {},
): SettingsResult {
  if (selection && selection.threadId !== string(object(thread).id)) return rejected("These settings belong to another thread.");
  const view = projectThreadSettings(config, thread, selection, policy);
  if (view.error) return rejected(view.error);
  if (selection) {
    const persisted = decodeSelection(object(thread).modelSelection);
    const provider = records(object(config).providers).find((provider) => provider.instanceId === selection.modelSelection.instanceId);
    const model = records(provider?.models).find((model) => model.slug === selection.modelSelection.model);
    const preferences = object(object(object(config).settings).providerModelPreferences);
    const hidden = strings(object(preferences[selection.modelSelection.instanceId]).hiddenModels)
      .includes(selection.modelSelection.model) && model?.isCustom !== true;
    if (selectionId(selection.modelSelection) !== selectionId(persisted)
      && (!provider || !model || hidden || provider.installed !== true || object(provider.auth).status === "unauthenticated"))
      return rejected("This model is no longer available.");
    if (model?.capabilities) {
      for (const option of selection.modelSelection.options ?? []) {
        const row = view.selectedModel?.options.find((row) => row.id === option.id);
        const legacyEffort = option.id === "effort" && option.value === "ultracode"
          && view.selectedModel?.options.some((row) => row.id === "ultracode" && row.kind === "boolean");
        if (!row || (row.kind === "boolean" ? typeof option.value !== "boolean"
          : !legacyEffort && (typeof option.value !== "string" || !row.choices.some((choice) => choice.id === option.value))))
          return rejected("A selected model option is no longer available.");
      }
    }
  }
  return { ok: true, error: "", selection: view.selection };
}

export function stageThreadSettings(
  config: unknown,
  thread: unknown,
  staged: ThreadSettingsSelection | null | undefined,
  change: SettingsChange,
  policy: SettingsPolicy = {},
): SettingsResult {
  if (staged && staged.threadId !== string(object(thread).id)) return rejected("These settings belong to another thread.");
  const view = projectThreadSettings(config, thread, staged, policy);
  let selection = view.selection;
  if (change.type === "model") {
    const model = view.groups.flatMap((group) => group.models).find((model) => model.id === change.id);
    if (!model || !model.available) return rejected(model?.unavailableReason || "This model is no longer available.");
    const original = decodeSelection(object(thread).modelSelection);
    const modelSelection = model.id === selectionId(selection?.modelSelection ?? null)
      ? selection!.modelSelection
      : model.id === selectionId(original) ? original! : { instanceId: model.instanceId, model: model.slug };
    selection = { threadId: string(object(thread).id), modelSelection, runtimeMode: view.runtimeMode };
    const next = projectThreadSettings(config, thread, selection, policy);
    if (!next.runtimeChoices.some((choice) => choice.id === selection!.runtimeMode && choice.available))
      selection.runtimeMode = next.runtimeChoices.find((choice) => choice.available)?.id ?? selection.runtimeMode;
  } else {
    if (!selection) return rejected("Choose a model.");
    if (change.type === "runtime") {
      const runtime = view.runtimeChoices.find((choice) => choice.id === change.id);
      if (!runtime || !runtime.available) return rejected(runtime?.unavailableReason || "This runtime mode is not available.");
      selection = { ...selection, runtimeMode: change.id };
    } else {
      const option = view.selectedModel?.options.find((option) => option.id === change.id);
      if (!option || !option.choices.some((choice) => choice.id === String(change.value))) return rejected("This model option is not available.");
      const value = option.kind === "boolean" ? String(change.value) === "true" : change.value;
      if (option.kind !== "boolean" && typeof value !== "string") return rejected("This model option is not available.");
      selection = {
        ...selection,
        modelSelection: {
          ...selection.modelSelection,
          options: [...(selection.modelSelection.options ?? []).filter((item) => item.id !== option.id), { id: option.id, value }],
        },
      };
    }
  }
  return validateThreadSettings(config, thread, selection, policy);
}
