import { composerContextDetail, composerDocument, parseNativeComposerEvent, pruneComposerContext, selectComposerItem, type ComposerSelectionItem } from "./composer-context";
import {
  buildComposerModelItems,
  buildComposerPathItems,
  buildComposerSkillItems,
  buildComposerSlashCommandItems,
  composerFileLink,
  composerSkillIcon,
  type ComposerCommandItem,
} from "./composer-commands";
import { type ComposerSettings } from "./composer-settings";
import { type DirectSession, object, string, threadIdentity } from "./connection";
import { isDraftKey } from "./new-task";
import { bindComposerAttachmentContext } from "./composer-import";
import type { DraftAttachment } from "./attachments";
import type { NativeModule, Storage as ExactStorage } from "./app.contract.d.ts";

type Native = NativeModule | null | undefined;
type Storage = ExactStorage;

interface ComposerSourceRow {
  id: string;
  label: string;
  description: string;
  kind: string;
  insertText: string;
  path: string;
  context: string;
  icon: string;
  provider: string;
}

export interface ComposerSourcesBoundary {
  sessionFor(environmentId: string): DirectSession;
  sessions?(): DirectSession[];
  awaitReply<T>(operation: Promise<T>, native?: Native): Promise<T>;
  composerSettings?: ComposerSettings;
}

function idSlug(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const slug = value.replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(0, 72) || "context";
  return `${slug}_${hash.toString(16).padStart(8, "0")}`;
}

function contextLabel(value: string, fallback: string): string {
  const normalized = value.replace(/[\[\]\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(normalized || fallback).slice(0, 200).join("");
}

function contextPayload(value: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, records: [value] });
}

function voiceSnapshot(value: unknown) {
  const raw = object(value);
  return {
    available: raw.available === true,
    owner: string(raw.owner),
    phase: string(raw.phase) || "idle",
    error: string(raw.error),
    transcript: string(raw.transcript),
    elapsed: Number(raw.elapsed ?? 0),
    levels: Array.isArray(raw.levels) ? raw.levels.filter((level): level is number => typeof level === "number") : [],
  };
}

function threadContextRow(thread: { id: string; title: string; project: string }) {
  let identity: { environmentId: string; threadId: string };
  try { identity = threadIdentity(thread.id); } catch { return null; }
  const label = contextLabel(thread.title, "Thread");
  const record = { version: 1, kind: "thread", contextId: `thread_${idSlug(thread.id)}`, label, environmentId: identity.environmentId, threadId: identity.threadId, title: label };
  return { id: `thread:${thread.id}`, label, description: thread.project ? `Thread · ${thread.project}` : "Thread", kind: "thread", insertText: `[${record.label}](t3-context://v1/thread/${record.contextId})`, path: thread.id, context: contextPayload(record), icon: "symbol:sf/text.bubble", provider: "" };
}

function environmentContextRow(environment: { id: string; label: string }) {
  const label = contextLabel(environment.label, "Environment");
  const record = { version: 1, kind: "environment", contextId: `environment_${idSlug(environment.id)}`, label, environmentId: environment.id };
  return { id: `environment:${environment.id}`, label: record.label, description: "Environment", kind: "environment", insertText: `[${record.label}](t3-context://v1/environment/${record.contextId})`, path: environment.id, context: contextPayload(record), icon: "symbol:sf/desktopcomputer", provider: "" };
}

function pullRequestContextRow(value: Record<string, unknown>) {
  const number = Number(value.number);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const repository = string(value.repository) || string(value.repositoryFullName) || string(value.repo);
  const title = contextLabel(string(value.title), `Pull request #${number}`);
  const url = string(value.url);
  const id = `pr_${idSlug(`${repository}_${number}`)}`;
  const record = { version: 1, kind: "review-comment", contextId: id, label: `#${number}`, sectionId: `pull-request:${number}`, sectionTitle: `PR #${number}`, filePath: `PR #${number}`, startIndex: 0, endIndex: 0, rangeLabel: title, text: `Pull request #${number}, titled ${title}${url ? `, at ${url}` : ""}.`, diff: "", pullRequest: { number, title, url, headBranch: string(value.headBranch) || string(value.headRef), baseBranch: string(value.baseBranch) || string(value.baseRef), state: string(value.state) || "open", isDraft: value.isDraft === true } };
  return { id: `pr:${repository}:${number}`, label: `#${number}`, description: `${record.pullRequest.state} · ${repository ? `${repository} · ` : ""}${title}`, kind: "pull-request", insertText: `[#${number}](t3-context://v1/review-comment/${id})`, path: url, context: contextPayload(record), icon: "symbol:sf/arrow.triangle.pull", provider: "" };
}

function rawThreadId(id: string): string {
  try {
    return threadIdentity(id).threadId;
  } catch {
    return id;
  }
}

function commandRow(item: ComposerCommandItem | ComposerSourceRow): ComposerSourceRow {
  if ("context" in item) return item;
  if (item.type === "path") return { id: item.id, label: item.label, description: item.description, kind: item.kind, insertText: composerFileLink(item.path), path: item.path, context: "", icon: item.kind === "directory" ? "symbol:sf/folder" : "symbol:sf/doc", provider: "" };
  if (item.type === "model") return { id: item.id, label: item.label, description: item.description, kind: "model", insertText: `model:${item.model.instanceId}/${item.model.slug}`, path: "", context: "", icon: "symbol:sf/cpu", provider: item.model.provider };
  if (item.type === "skill") {
    const name = item.skill.name;
    return {
      id: item.id,
      label: item.label,
      description: item.description,
      kind: "skill",
      insertText: `$${name}`,
      path: item.skill.path,
      context: JSON.stringify({ version: 1, records: [], editorLabels: { [`$${name}`]: { label: item.skill.displayName || name, name, path: item.skill.path, description: item.skill.shortDescription || item.skill.description || "", symbol: "symbol:sf/cube" } } }),
      icon: composerSkillIcon(item.skill),
      provider: "",
    };
  }
  const command = item.type === "provider-slash-command" ? item.command.name : item.command;
  return { id: item.id, label: item.label, description: item.description, kind: item.type, insertText: `/${command}`, path: "", context: "", icon: "symbol:sf/terminal", provider: item.type === "provider-slash-command" ? "provider" : "" };
}

export function composerSources(boundary: ComposerSourcesBoundary) {
  const session = (environmentId: string): DirectSession | null => {
    try {
      return boundary.sessionFor(environmentId);
    } catch {
      return null;
    }
  };
  const watch = (native: Native) => native?.watch?.("connections");
  type ProviderCatalog = ReturnType<DirectSession["composerProviderCatalog"]>;
  const providerCatalogRefreshes = new Map<string, Promise<ProviderCatalog>>();

  const currentProviderCatalog = (target: DirectSession, id: string, cwd: string, instanceId = "") =>
    target.composerProviderCatalog({ threadId: rawThreadId(id), cwd, instanceId });

  const refreshedProviderCatalog = async (
    target: DirectSession,
    id: string,
    cwd: string,
    instanceId: string,
    modelRevision: string,
    native: Native,
  ): Promise<ProviderCatalog> => {
    const fallback = currentProviderCatalog(target, id, cwd, instanceId);
    const key = JSON.stringify([target.environment.id, target.attachments.metadata().accessKey, cwd, instanceId, modelRevision, fallback]);
    const cached = providerCatalogRefreshes.get(key);
    if (cached) return cached;
    if (providerCatalogRefreshes.size >= 32) providerCatalogRefreshes.clear();
    const pending = boundary
      .awaitReply(
        target.refreshComposerProviderCatalog({
          threadId: rawThreadId(id),
          cwd,
          ...(instanceId ? { instanceId } : {}),
        }),
        native,
      )
      .catch(() => {
        providerCatalogRefreshes.delete(key);
        return fallback;
      });
    providerCatalogRefreshes.set(key, pending);
    return pending;
  };

  return {
    async loadComposerCommands([id, environmentId, projectId, cwd, kind, query, start, modelRevision]: [string, string, string, string, string, string, number, string], _store: unknown, _storage: Storage, native: Native) {
      watch(native);
      if (!kind) return { items: [], error: "" };
      const hasThread = id !== "" && !isDraftKey(id);
      const targetEnvironmentId = hasThread
        ? (() => {
            try { return threadIdentity(id).environmentId; } catch { return environmentId; }
          })()
        : environmentId;
      const target = session(targetEnvironmentId);
      if (!target) {
        const items = kind === "/" || kind === "slash-command"
          ? buildComposerSlashCommandItems({ query, atMessageStart: start === 0, offersFreshSession: hasThread })
          : [];
        return { items: items.map(commandRow), error: items.length ? "" : "This environment is disconnected." };
      }
      try {
        let resolvedCwd = cwd;
        if (!resolvedCwd) {
          try {
            resolvedCwd = target.composerProviderCatalog({ threadId: rawThreadId(id) }).cwd;
          } catch {
            const rawProjectId = projectId ? rawThreadId(projectId) : "";
            resolvedCwd = rawProjectId ? (target.task(rawProjectId)?.workspaceRoot ?? "") : "";
          }
        }
        if (!resolvedCwd) return { items: [], error: "A workspace is required to search the composer." };
        let instanceId = "";
        try {
          const selection = boundary.composerSettings?.resolve(id, rawThreadId(id), target);
          instanceId = selection?.modelSelection.instanceId ?? "";
        } catch {}
        const catalog = await refreshedProviderCatalog(target, id, resolvedCwd, instanceId, modelRevision, native);
        const provider = catalog.selected;
        let items: Array<ComposerCommandItem | ComposerSourceRow> = [];
        if (kind === "/" || kind === "slash-command") {
          items = buildComposerSlashCommandItems({ query, atMessageStart: start === 0, hasThread, hasCompactableConversation: hasThread, providerDriver: provider?.driver, providerCommands: provider?.slashCommands, skills: provider?.skills, offersFreshSession: hasThread });
        } else if (kind === "$" || kind === "skill") {
          items = buildComposerSkillItems(provider?.skills ?? [], query);
        } else if (kind === "#" || kind === "pull-request") {
          const pullRequests = await boundary.awaitReply(target.listPullRequests(), native);
          items = (Array.isArray(pullRequests.entries) ? pullRequests.entries : [])
            .map((entry) => pullRequestContextRow(object(entry)))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
            .filter((entry) => !query || entry.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || entry.description.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        } else if (kind === "@" || kind === "path") {
          const paths = await boundary.awaitReply(target.searchComposerEntries(resolvedCwd, query, 100), native);
          const sources = boundary.sessions?.() ?? [target];
          const threads = sources
            .flatMap((entry) => entry.threads(0))
            .filter((thread) => thread.id !== id)
            .filter((thread) => !query || thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((thread) => threadContextRow(thread))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
          const environments = sources
            .filter((entry) => !query || entry.environment.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((entry) => environmentContextRow({ id: entry.environment.id, label: entry.environment.label }));
          items = [
            ...threads,
            ...environments,
            ...buildComposerModelItems(catalog.providers.flatMap((entry) => entry.models), query),
            ...buildComposerPathItems(paths.entries, query),
          ];
        }
        return { items: items.map(commandRow), error: "" };
      } catch (error) {
        return { items: [], error: error instanceof Error ? error.message : "Composer commands are unavailable." };
      }
    },

    composerDocument([value, context]: [string, string]) {
      return composerDocument(value, context);
    },

    selectComposerItem([draft, item, start, end]: [Record<string, unknown>, Record<string, unknown>, number, number]) {
      return selectComposerItem({ draft: draft as { id: string; revision: number; text: string; context?: string; freshContext?: boolean }, item: item as ComposerSelectionItem, start, end });
    },

    parseNativeComposerEvent([value, currentContext]: [string, string]) {
      return parseNativeComposerEvent(value, currentContext);
    },

    loadComposerContextDetail([source, context]: [string, string]) {
      return composerContextDetail(source, context);
    },

    async loadComposerQueue([id, _catalog]: [string, unknown], _store: unknown, _storage: Storage, native: Native) {
      watch(native);
      try {
        const identity = threadIdentity(id);
        const target = session(identity.environmentId);
        if (!target) return { items: [], held: false, ready: false, canSendNow: false, activeRunId: "", accessKey: "", allowed: false };
        return target.composerQueue(identity.threadId);
      } catch {
        return { items: [], held: false, ready: false, canSendNow: false, activeRunId: "", accessKey: "", allowed: false };
      }
    },

    async changeComposerQueue([id, accessKey, operation, runId, textValue, context, attachments, rawAttachments]: [string, string, string, string, string, string, unknown[], unknown[]?], _store: unknown, _storage: Storage, native: Native) {
      watch(native);
      try {
        const identity = threadIdentity(id);
        const target = session(identity.environmentId);
        if (!target) return { ok: false, error: "This environment is disconnected." };
        let boundContext = pruneComposerContext(textValue, context);
        if (rawAttachments) boundContext = bindComposerAttachmentContext(boundContext, rawAttachments as DraftAttachment[]);
        const value = operation === "resume" ? { type: "resume" as const } : operation === "start" || operation === "cancel" ? { type: operation as "start" | "cancel", runId } : { type: "edit" as const, runId, text: textValue, context: boundContext, attachments: attachments as Array<{ type: "file" | "image"; id: string; name: string; mimeType: string; sizeBytes: number }> };
        return await boundary.awaitReply(target.operateComposerQueue(identity.threadId, accessKey, value), native);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "The queued message could not be changed." };
      }
    },

    loadComposerVoice(_args: [], _store: unknown, _storage: Storage, native: Native) {
      native?.watch?.("voice");
      if (!native?.available || !native.call) return { available: false, owner: "", phase: "idle", error: "", transcript: "", elapsed: 0, levels: [] as number[] };
      try { return voiceSnapshot(native.call({ op: "voice.state" })); }
      catch (error) { return { available: false, owner: "", phase: "error", error: error instanceof Error ? error.message : "Voice input is unavailable.", transcript: "", elapsed: 0, levels: [] as number[] }; }
    },
    async controlComposerVoice([id, operation]: [string, string], _store: unknown, _storage: Storage, native: Native) {
      native?.watch?.("voice");
      const unavailable = { available: false, owner: "", phase: "error", error: "Voice input is unavailable on this build.", transcript: "", elapsed: 0, levels: [] as number[] };
      if (!native?.available) return unavailable;
      try {
        if ((operation === "start" || operation === "confirm") && native.later) {
          const op = operation === "start" ? "voice.start" : "voice.confirm";
          return voiceSnapshot(await native.later({ op, owner: id }));
        }
        if (operation === "cancel" && native.call) return voiceSnapshot(native.call({ op: "voice.cancel", owner: id }));
        if (operation === "settings" && native.call) return voiceSnapshot(native.call({ op: "voice.settings" }));
        if (native.call) return voiceSnapshot(native.call({ op: "voice.state" }));
      } catch (error) {
        return { ...unavailable, error: error instanceof Error ? error.message : unavailable.error };
      }
      return unavailable;
    },
  };
}
