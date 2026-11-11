import type { DirectSession } from "./connection";
import type { ModelDraft, ModelDraftSelection } from "./model-drafts";
import type {
  ModelSelection,
  SettingsChange,
  SettingsOption,
  ThreadSettingsSelection,
} from "./thread-settings";

type Session = Pick<DirectSession, "settings" | "stageSettings" | "validateSettings">;
const sameModel = (
  a: ThreadSettingsSelection | null | undefined,
  b: ThreadSettingsSelection | null | undefined,
) =>
  a?.modelSelection.instanceId === b?.modelSelection.instanceId &&
  a?.modelSelection.model === b?.modelSelection.model;

function matchesModelPick(pick: ModelSelection, live: ModelSelection) {
  if (pick.instanceId !== live.instanceId || pick.model !== live.model) return false;
  // The web sends fastMode:false where mobile omits it; both mean off.
  const options = (model: ModelSelection) =>
    (model.options ?? [])
      .filter((option) => option.id !== "fastMode" || option.value !== false)
      .sort((a, b) => a.id.localeCompare(b.id) || String(a.value).localeCompare(String(b.value)));
  const left = options(pick),
    right = options(live);
  return (
    left.length === right.length &&
    left.every(
      (option, index) => option.id === right[index]?.id && option.value === right[index]?.value,
    )
  );
}

const REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
  "thinking",
]);

/** The composer's trait label, as `buildTraitsTriggerDisplay` words it in the Expo client. */
export function modelTraitsSummary(options: ReadonlyArray<SettingsOption>): string {
  let speed: string | null = null;
  let fallback: string | null = null;
  let reasoning = -1;
  const labels: string[] = [];
  for (const option of options) {
    const choice = option.choices.find((entry) => entry.id === option.value)?.label;
    if (option.id === "fastMode" && option.kind === "boolean") {
      speed = option.value === "true" ? "Fast" : null;
      fallback = speed ?? "Normal";
      continue;
    }
    if (option.id === "ultracode" && option.kind === "boolean") {
      if (option.value === "true") labels.push(option.label);
      continue;
    }
    if (option.id === "serviceTier" && option.kind === "select") {
      const fast = option.choices.find((entry) => entry.label === "Fast");
      const ultrafast = option.choices.find((entry) => entry.label === "Ultrafast");
      if (
        ((fast || ultrafast) && option.value === "default") ||
        option.value === fast?.id ||
        option.value === ultrafast?.id
      ) {
        speed =
          option.value === ultrafast?.id ? "Ultrafast" : option.value === fast?.id ? "Fast" : null;
        fallback = choice ?? "Normal";
        continue;
      }
    }
    const label =
      option.kind === "boolean"
        ? `${option.label} ${option.value === "true" ? "On" : "Off"}`
        : (choice ?? (option.id === "thinking" ? option.label : ""));
    if (!label) continue;
    if (reasoning < 0 && option.kind === "select" && REASONING_OPTION_IDS.has(option.id))
      reasoning = labels.length;
    labels.push(label);
  }
  if (labels.length === 0 && fallback !== null) return fallback;
  if (speed) {
    if (reasoning >= 0) labels[reasoning] = `${labels[reasoning]} ${speed}`;
    else labels.push(speed);
  }
  return labels.join(" · ");
}

export class ComposerSettings {
  private readonly drafts = new Map<string, ModelDraftSelection>();
  private editing: { id: string; selection: ThreadSettingsSelection | null } | undefined;

  selection(id: string) {
    return this.drafts.get(id);
  }

  resolve(id: string, threadId: string, session: Session): ThreadSettingsSelection | undefined {
    const draft = this.selection(id);
    if (!draft || draft.threadId !== threadId) return;
    const live = session.settings(threadId);
    const modelSelection = draft.modelSelection ?? live.selection?.modelSelection;
    if (!modelSelection) return;
    return { threadId, modelSelection, runtimeMode: draft.runtimeMode ?? live.runtimeMode };
  }

  reconcile(id: string, liveSelection: ThreadSettingsSelection | null | undefined, live: boolean) {
    const draft = this.selection(id);
    if (
      !live ||
      !draft?.modelSelection ||
      !liveSelection ||
      draft.threadId !== liveSelection.threadId ||
      !matchesModelPick(draft.modelSelection, liveSelection.modelSelection)
    )
      return false;
    if (draft.runtimeMode === undefined) this.drafts.delete(id);
    else this.drafts.set(id, { threadId: draft.threadId, runtimeMode: draft.runtimeMode });
    return true;
  }

  /** What the composer's model control shows: the pick this thread sends with next. */
  summary(id: string, threadId: string, session: Session) {
    const model = session.settings(threadId, this.resolve(id, threadId, session)).selectedModel;
    return {
      provider: model?.provider ?? "",
      label: model?.shortLabel ?? "",
      summary: modelTraitsSummary(model?.options ?? []),
    };
  }

  restore(records: ModelDraft[]) {
    this.drafts.clear();
    for (const record of records) this.drafts.set(record.id, record.selection);
  }

  snapshot() {
    return [...this.drafts].map(([id, selection]) => ({ id, selection }));
  }

  begin(id: string, _threadId: string, _session: Session) {
    this.editing = { id, selection: null };
    return { ok: true, error: "" };
  }

  project(id: string, threadId: string, session: Session) {
    const appliedView = session.settings(threadId, this.resolve(id, threadId, session));
    const applied = appliedView.selection;
    const pending = this.editing?.id === id ? (this.editing.selection ?? applied) : applied;
    const view = session.settings(threadId, pending);
    return {
      groups: view.groups.map((group) => ({
        ...group,
        models: group.models.map(({ options: _options, shortLabel: _short, ...model }) => model),
      })),
      selectedModelId: view.selectedModelId,
      appliedModelId: appliedView.selectedModelId,
      options: (view.selectedModel?.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        kind: option.kind,
        value: option.value,
        valueLabel: option.choices.find((choice) => choice.id === option.value)?.label ?? "Default",
        choices: option.choices.map((choice) => ({
          ...choice,
          available: true,
          unavailableReason: "",
        })),
      })),
      runtimeMode: view.runtimeMode,
      runtimeLabel:
        view.runtimeChoices.find((choice) => choice.id === view.runtimeMode)?.label ??
        view.runtimeMode,
      runtimeChoices: view.runtimeChoices,
      saveLabel: sameModel(pending, applied) ? "Done" : "Save",
      error: view.error,
    };
  }

  change(id: string, threadId: string, session: Session, change: SettingsChange) {
    if (this.editing?.id !== id) return { ok: false, error: "Open this thread's settings again." };
    const applied = session.settings(threadId, this.resolve(id, threadId, session)).selection;
    const result = session.stageSettings(threadId, this.editing.selection ?? applied, change);
    if (result.ok && result.selection) {
      if (change.type === "runtime") {
        this.drafts.set(id, {
          ...this.selection(id),
          threadId,
          runtimeMode: result.selection.runtimeMode,
        });
      } else if (change.type === "option" && sameModel(result.selection, applied)) {
        this.drafts.set(id, {
          ...this.selection(id),
          threadId,
          modelSelection: result.selection.modelSelection,
        });
      }
      this.editing.selection = sameModel(result.selection, applied) ? null : result.selection;
    }
    return { ok: result.ok, error: result.error };
  }

  close(id: string, threadId: string, session: Session, save: boolean) {
    if (this.editing?.id !== id) return { ok: false, error: "Open this thread's settings again." };
    if (save) {
      const applied = session.settings(threadId, this.resolve(id, threadId, session)).selection;
      const result = session.validateSettings(threadId, this.editing.selection ?? applied);
      if (!result.ok || !result.selection) return { ok: false, error: result.error };
      if (this.editing.selection && !sameModel(this.editing.selection, applied)) {
        this.drafts.set(id, {
          ...this.selection(id),
          threadId,
          modelSelection: result.selection.modelSelection,
          ...(result.selection.runtimeMode !== applied?.runtimeMode
            ? { runtimeMode: result.selection.runtimeMode }
            : {}),
        });
      }
    }
    this.editing = undefined;
    return { ok: true, error: "" };
  }
}
