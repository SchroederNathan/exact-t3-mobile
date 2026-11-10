import type { DirectSession } from "./connection";
import type { SettingsChange, ThreadSettingsSelection } from "./thread-settings";

type Session = Pick<DirectSession, "settings" | "stageSettings" | "validateSettings">;
const sameModel = (a: ThreadSettingsSelection | null | undefined, b: ThreadSettingsSelection | null | undefined) =>
  a?.modelSelection.instanceId === b?.modelSelection.instanceId && a?.modelSelection.model === b?.modelSelection.model;

export class ComposerSettings {
  private readonly drafts = new Map<string, ThreadSettingsSelection>();
  private editing: { id: string; selection: ThreadSettingsSelection | null } | undefined;

  selection(id: string) { return this.drafts.get(id); }

  begin(id: string, threadId: string, session: Session) {
    this.editing = { id, selection: session.settings(threadId, this.selection(id)).selection };
    return { ok: true, error: "" };
  }

  project(id: string, threadId: string, session: Session) {
    const applied = session.settings(threadId, this.selection(id)).selection;
    const pending = this.editing?.id === id ? this.editing.selection : applied;
    const view = session.settings(threadId, pending);
    return {
      groups: view.groups.map((group) => ({
        ...group,
        models: group.models.map(({ options: _options, ...model }) => model),
      })),
      selectedModelId: view.selectedModelId,
      options: (view.selectedModel?.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        kind: option.kind,
        value: option.value,
        valueLabel: option.choices.find((choice) => choice.id === option.value)?.label ?? "Default",
        choices: option.choices.map((choice) => ({ ...choice, description: "", available: true, unavailableReason: "" })),
      })),
      runtimeMode: view.runtimeMode,
      runtimeLabel: view.runtimeChoices.find((choice) => choice.id === view.runtimeMode)?.label ?? view.runtimeMode,
      runtimeChoices: view.runtimeChoices,
      saveLabel: sameModel(pending, applied) ? "Done" : "Save",
      error: view.error,
    };
  }

  change(id: string, threadId: string, session: Session, change: SettingsChange) {
    if (this.editing?.id !== id) return { ok: false, error: "Open this thread's settings again." };
    const result = session.stageSettings(threadId, this.editing.selection, change);
    if (result.ok && result.selection) {
      const applied = session.settings(threadId, this.selection(id)).selection;
      if (change.type === "runtime" && applied) {
        this.drafts.set(id, { ...applied, runtimeMode: result.selection.runtimeMode });
      } else if (change.type === "option" && sameModel(result.selection, applied)) {
        this.drafts.set(id, result.selection);
      }
      this.editing.selection = result.selection;
    }
    return { ok: result.ok, error: result.error };
  }

  close(id: string, threadId: string, session: Session, save: boolean) {
    if (this.editing?.id !== id) return { ok: false, error: "Open this thread's settings again." };
    if (save) {
      const result = session.validateSettings(threadId, this.editing.selection);
      if (!result.ok || !result.selection) return { ok: false, error: result.error };
      this.drafts.set(id, result.selection);
    }
    this.editing = undefined;
    return { ok: true, error: "" };
  }
}
