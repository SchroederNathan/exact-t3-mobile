import type { NativeModule, Storage } from "./app.contract.d.ts";
import type { AttachmentSession } from "./attachment-session";
import { ATTACHMENT_DIRECTORY, FILE_LIMIT, IMAGE_LIMIT, ownedAttachmentPath, parseDraftAttachment, validateAttachments, type DraftAttachment } from "./attachments";
import { threadIdentity } from "./connection";
import { parseThreadLink } from "./markdown-links";

type ContextRecord = Record<string, unknown>;
export interface ComposerImportDraft {
  id: string;
  revision: number;
  text: string;
  context: string;
  attachments: readonly { type: string; id: string; name: string; mimeType: string; sizeBytes: number; width: number; height: number; localId: string; path: string; state: string; attempt: number; error: string; insertionRevision: number }[];
  task?: { environmentId: string } | null;
}
export interface ComposerImportInput {
  draft: ComposerImportDraft;
  environmentId: string;
  fragment: string;
  pastedText: string;
  start: number;
  end: number;
  localDrafts?: readonly ComposerImportDraft[];
}
export interface ComposerImportBoundary {
  sessionFor(environmentId: string): { attachments: AttachmentSession };
  readableEnvironmentIds(environmentId: string): Promise<string[]>;
  awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T>;
}
interface ImportFile {
  attachment: DraftAttachment;
  contextId: string;
  localPath: string;
  url: string;
}
interface ImportPlan {
  id: string;
  revision: number;
  environmentId: string;
  sourceEnvironmentId: string;
  targetAccessKey: string;
  targetOrigin: string;
  sourceAccessKey: string;
  sourceOrigin: string;
  text: string;
  context: string;
  cursor: number;
  existing: readonly DraftAttachment[];
  files: ImportFile[];
  failures: string[];
  skippedThreads: string[];
}
const object = (value: unknown): ContextRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ContextRecord : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const errorText = (error: unknown) => error instanceof Error ? error.message : "The copied context could not be imported.";
const parseObject = (value: string) => object(JSON.parse(value || "{}"));
const records = (value: string) => {
  const parsed = parseObject(value);
  return Array.isArray(parsed.records) ? parsed.records.map(object) : [];
};
const contextReference = (record: ContextRecord) => `t3-context://v1/${record.kind}/${record.contextId})`;
const assertActive = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Context import cancelled."); };
interface LegacyReference {
  source: string;
  label: string;
}
interface ImportedSelection {
  environmentId: string;
  records: ContextRecord[];
  references: Map<string, string>;
  legacyReferences: Map<string, LegacyReference>;
}

function legacyThreadRecords(pastedText: string, readableEnvironments: ReadonlySet<string>, occupiedIds = new Set<string>()) {
  const links: Array<{ href: string; source: string; label: string }> = [];
  const linkPattern = /(?:https:\/\/app\.t3\.codes\/threads\/[^\s)]+|t3-thread:\/\/v2\/[^\s)]+)/gu;
  for (const match of pastedText.matchAll(linkPattern)) {
    const href = match[0] ?? "";
    if (!href || links.some((entry) => entry.href === href)) continue;
    const start = match.index ?? 0;
    const markdown = /\[([^\]\n]{1,200})\]\($/u.exec(pastedText.slice(Math.max(0, start - 202), start));
    const source = markdown ? `${markdown[0]}${href})` : href;
    links.push({ href, source, label: markdown?.[1]?.trim() || "Thread" });
  }
  const records: ContextRecord[] = [];
  const references = new Map<string, string>();
  const legacyReferences = new Map<string, LegacyReference>();
  const used = new Set(occupiedIds);
  for (const [index, link] of links.entries()) {
    const { href } = link;
    const parsed = parseThreadLink(href);
    if (!parsed?.environmentId || !readableEnvironments.has(parsed.environmentId)) continue;
    let contextId = `legacy_thread_${index}`;
    let suffix = 0;
    while (used.has(contextId)) contextId = `legacy_thread_${index}_${++suffix}`;
    used.add(contextId);
    const label = link.label;
    records.push({ version: 1, kind: "thread", contextId, label, environmentId: parsed.environmentId, threadId: parsed.threadId, title: label });
    references.set(contextId, link.source);
    legacyReferences.set(contextId, { source: link.source, label });
  }
  return { records, references, legacyReferences };
}

function importedRecords(fragment: string, pastedText: string, readableEnvironments: ReadonlySet<string>) {
  if (fragment.length > 16_000_000 || pastedText.length > 16_000_000) throw new Error("This clipboard selection is too large.");
  let payload: ContextRecord = {};
  try { payload = parseObject(fragment); } catch {}
  const environmentId = text(object(payload.source).environmentId);
  if (payload.version === 1 && environmentId && Array.isArray(payload.records) && payload.records.length <= 200) {
    const seen = new Set<string>();
    const selected = payload.records.map(object).filter((entry) => {
      const id = text(entry.contextId);
      if (entry.version !== 1 || !idPattern.test(id) || seen.has(id) || typeof entry.label !== "string" || entry.label.length > 200 || !["file", "image", "thread", "environment", "review-comment"].includes(text(entry.kind))) return false;
      if (!pastedText.includes(contextReference(entry))) return false;
      seen.add(id);
      return true;
    });
    if (selected.length) {
      const legacy = legacyThreadRecords(pastedText, readableEnvironments, new Set(selected.map((entry) => text(entry.contextId))));
      const records = selected.concat(legacy.records.filter((entry) => !selected.some((existing) => text(existing.contextId) === text(entry.contextId))));
      const references = new Map(selected.map((entry) => [text(entry.contextId), contextReference(entry)]));
      for (const [id, href] of legacy.references) references.set(id, href);
      return { environmentId, records, references, legacyReferences: legacy.legacyReferences } satisfies ImportedSelection;
    }
  }
  const legacy = legacyThreadRecords(pastedText, readableEnvironments);
  if (legacy.records.length) return { environmentId: text(legacy.records[0]?.environmentId), records: legacy.records, references: legacy.references, legacyReferences: legacy.legacyReferences } satisfies ImportedSelection;
  if (!fragment) return { environmentId: "", records: [], references: new Map<string, string>(), legacyReferences: new Map<string, LegacyReference>() } satisfies ImportedSelection;
  throw new Error(fragment ? "The copied context is invalid." : "The clipboard has no supported context to import.");
}

function localAttachment(drafts: readonly ComposerImportDraft[], environmentId: string, attachmentId: string, current: ComposerImportInput) {
  for (const draft of drafts) {
    let draftEnvironment = draft.task?.environmentId || (draft.id === current.draft.id ? current.environmentId : "");
    if (!draftEnvironment) { try { draftEnvironment = threadIdentity(draft.id).environmentId; } catch { continue; } }
    if (draftEnvironment !== environmentId) continue;
    const item = draft.attachments.find((entry) => entry.id === attachmentId || entry.localId === attachmentId);
    if (item) return parseDraftAttachment(item as DraftAttachment);
  }
  return undefined;
}

async function discardPlan(plan: ImportPlan, storage: Storage) {
  await Promise.allSettled(plan.files.map(async ({ attachment }) => {
    if (!ownedAttachmentPath(attachment.path)) return;
    await storage.fs.rm(attachment.path).catch(() => {});
    await storage.fs.rm(`${ATTACHMENT_DIRECTORY}${attachment.localId}`).catch(() => {});
  }));
}

export async function prepareComposerImport(input: ComposerImportInput, storage: Storage, boundary: ComposerImportBoundary, native?: NativeModule | null, signal?: AbortSignal) {
  const base = { id: input.draft.id, revision: input.draft.revision };
  let plan: ImportPlan | undefined;
  try {
    assertActive(signal);
    const readableEnvironments = new Set([input.environmentId, ...await boundary.awaitReply(boundary.readableEnvironmentIds(input.environmentId), native)]);
    assertActive(signal);
    const selected = importedRecords(input.fragment, input.pastedText, readableEnvironments);
    const target = boundary.sessionFor(input.environmentId).attachments;
    const targetMetadata = target.metadata();
    const existing = input.draft.attachments.map((item) => parseDraftAttachment(item as DraftAttachment));
    const currentContext = parseObject(input.draft.context);
    const currentRecords = records(input.draft.context);
    const readableRecords = selected.records.filter((record) => record.kind !== "thread" || readableEnvironments.has(text(record.environmentId)));
    if (currentRecords.length + readableRecords.length > 200) throw new Error("Remove some context items from the draft before pasting more.");
    plan = { ...base, environmentId: input.environmentId, sourceEnvironmentId: selected.environmentId, targetAccessKey: targetMetadata.accessKey, targetOrigin: targetMetadata.origin, sourceAccessKey: "", sourceOrigin: "", text: "", context: "", cursor: 0, existing, files: [], failures: [], skippedThreads: [] };
    let inserted = input.pastedText;
    const imported: ContextRecord[] = [];
    for (const record of selected.records) {
      assertActive(signal);
      const contextId = crypto.randomUUID();
      const updated: ContextRecord = { ...record, contextId };
      const recordId = text(record.contextId);
      const source = selected.references.get(recordId) ?? contextReference(record);
      const legacy = selected.legacyReferences.get(recordId);
      const replacement = legacy
        ? `[${legacy.label}](${contextReference(updated).slice(0, -1)})`
        : contextReference(updated);
      inserted = inserted.replaceAll(source, replacement);
      if (record.kind === "thread" && !readableEnvironments.has(text(record.environmentId))) {
        plan.skippedThreads.push(text(record.title) || text(record.label));
        continue;
      }
      if (record.kind === "file" || record.kind === "image") {
        let pendingPath = "";
        try {
          if (!idPattern.test(text(record.attachmentId))) throw new Error("The copied attachment identifier is invalid.");
          const item = { type: record.kind, id: "", name: text(record.name), mimeType: text(record.mimeType), sizeBytes: Number(record.sizeBytes), width: 0, height: 0 };
          if (!targetMetadata.allowed || !targetMetadata.accessKey) throw new Error("Reconnect and check your attachment upload permission.");
          if (!targetMetadata.uploads) throw new Error("This environment does not support attachment uploads.");
          validateAttachments([...existing, ...plan.files.map((entry) => entry.attachment), item], targetMetadata.maxFileBytes);
          const localId = crypto.randomUUID();
          const extension = /\.([A-Za-z0-9]{1,10})$/u.exec(item.name)?.[1] ?? "bin";
          const attachment: DraftAttachment = { ...item, type: record.kind, localId, path: `${ATTACHMENT_DIRECTORY}${localId}/content.${extension}`, state: "local", attempt: 0, error: "", insertionRevision: input.draft.revision + 1 };
          pendingPath = attachment.path;
          const local = localAttachment(input.localDrafts ?? [input.draft], selected.environmentId, text(record.attachmentId), input);
          const file: ImportFile = { attachment, contextId, localPath: local?.path ?? "", url: "" };
          await storage.fs.mkdir(`${ATTACHMENT_DIRECTORY}${localId}`);
          if (local) {
            file.attachment.width = local.width;
            file.attachment.height = local.height;
          } else {
            const source = boundary.sessionFor(selected.environmentId).attachments;
            const metadata = source.metadata();
            if (!metadata.accessKey) throw new Error("Reconnect to the source environment to paste this attachment.");
            if (plan.sourceAccessKey && (plan.sourceAccessKey !== metadata.accessKey || plan.sourceOrigin !== metadata.origin)) throw new Error("The source connection changed. Paste the attachment again.");
            plan.sourceAccessKey = metadata.accessKey;
            plan.sourceOrigin = metadata.origin;
            const asset = await boundary.awaitReply(source.read({ ...item, id: text(record.attachmentId) }), native);
            file.url = asset.url;
            file.attachment.width = asset.imageDimensions?.width ?? 0;
            file.attachment.height = asset.imageDimensions?.height ?? 0;
          }
          plan.files.push(file);
          updated["attachmentId"] = localId;
          imported.push(updated);
        } catch (error) {
          if (pendingPath) {
            await storage.fs.rm(pendingPath).catch(() => {});
            await storage.fs.rm(pendingPath.slice(0, pendingPath.lastIndexOf("/"))).catch(() => {});
          }
          if (signal?.aborted) throw error;
          plan.failures.push(text(record.name) || "Attachment");
        }
      } else {
        imported.push(updated);
      }
    }
    assertActive(signal);
    const start = Math.min(input.draft.text.length, Math.max(0, Math.trunc(input.start)));
    const end = Math.min(input.draft.text.length, Math.max(start, Math.trunc(input.end)));
    plan.text = input.draft.text.slice(0, start) + inserted + input.draft.text.slice(end);
    plan.cursor = start + inserted.length;
    plan.context = JSON.stringify({ ...currentContext, version: 1, records: [...currentRecords, ...imported] });
    return { ...base, plan: JSON.stringify(plan), error: "" };
  } catch (error) {
    if (plan) await discardPlan(plan, storage);
    return { ...base, plan: "", error: errorText(error) };
  }
}

/** Called directly from a fresh mutation: every fetch starts before its first await. */
export function materializeComposerImport(serialized: string, storage: Storage, boundary: ComposerImportBoundary, signal?: AbortSignal) {
  const plan = JSON.parse(serialized) as ImportPlan;
  const base = { id: plan.id, revision: plan.revision };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const failure = async (error: unknown) => {
    controller.abort();
    await discardPlan(plan, storage);
    return { ...base, text: "", context: "", cursor: 0, attachments: [] as DraftAttachment[], failures: [] as string[], skippedThreads: [] as string[], error: errorText(error) };
  };
  try {
    assertActive(signal);
    const target = plan.files.length > 0 ? boundary.sessionFor(plan.environmentId).attachments : undefined;
    const targetMetadata = target ? target.assertAccess(plan.targetAccessKey, plan.targetOrigin) : undefined;
    const maxFileBytes = targetMetadata?.maxFileBytes ?? FILE_LIMIT;
    if (plan.sourceAccessKey) {
      const source = boundary.sessionFor(plan.sourceEnvironmentId).attachments.metadata();
      if (source.accessKey !== plan.sourceAccessKey || source.origin !== plan.sourceOrigin) throw new Error("The source connection changed. Paste the attachment again.");
    }
    for (const file of plan.files) {
      if (!ownedAttachmentPath(file.attachment.path) || (file.localPath && !ownedAttachmentPath(file.localPath))) throw new Error("The imported attachment path is invalid.");
    }
    const operations = plan.files.map(async (file) => {
      try {
        if (file.localPath) {
          await storage.fs.copyFile(file.localPath, file.attachment.path);
        } else {
          const response = await fetch(file.url, { signal: controller.signal, exactBodyTo: file.attachment.path, exactIndependentHttp: { maxResponseBytes: Math.min(file.attachment.type === "image" ? IMAGE_LIMIT : Math.min(FILE_LIMIT, maxFileBytes), file.attachment.sizeBytes) }, exactTimeout: 300000 });
          if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
        }
        return { file, error: "" };
      } catch (error) {
        if (controller.signal.aborted || signal?.aborted) throw error;
        return { file, error: errorText(error) };
      }
    });
    return Promise.allSettled(operations).then(async (settled) => {
      const rejected = settled.find((entry) => entry.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      assertActive(signal);
      target?.assertAccess(plan.targetAccessKey, plan.targetOrigin);
      const context = parseObject(plan.context);
      let contextRecords = records(plan.context);
      const completed: ImportFile[] = [];
      for (const entry of settled) {
        if (entry.status !== "fulfilled") continue;
        const result = entry.value;
        if (result.error) {
          plan.failures.push(result.file.attachment.name);
          await storage.fs.rm(result.file.attachment.path).catch(() => {});
          await storage.fs.rm(`${ATTACHMENT_DIRECTORY}${result.file.attachment.localId}`).catch(() => {});
          contextRecords = contextRecords.filter((entry) => entry.contextId !== result.file.contextId);
          continue;
        }
        try {
          result.file.attachment.sizeBytes = (await storage.fs.stat(result.file.attachment.path)).size;
          const record = contextRecords.find((entry) => entry.contextId === result.file.contextId);
          if (record) record.sizeBytes = result.file.attachment.sizeBytes;
          validateAttachments([...plan.existing, ...completed.map((entry) => entry.attachment), result.file.attachment], maxFileBytes);
          completed.push(result.file);
        } catch (error) {
          plan.failures.push(result.file.attachment.name);
          await storage.fs.rm(result.file.attachment.path).catch(() => {});
          await storage.fs.rm(`${ATTACHMENT_DIRECTORY}${result.file.attachment.localId}`).catch(() => {});
          contextRecords = contextRecords.filter((entry) => entry.contextId !== result.file.contextId);
        }
      }
      validateAttachments([...plan.existing, ...completed.map((entry) => entry.attachment)], maxFileBytes);
      assertActive(signal);
      target?.assertAccess(plan.targetAccessKey, plan.targetOrigin);
      return { ...base, text: plan.text, context: JSON.stringify({ ...context, records: contextRecords }), cursor: plan.cursor, attachments: completed.map((entry) => entry.attachment), failures: plan.failures, skippedThreads: plan.skippedThreads, error: "" };
    }).catch(failure).finally(() => signal?.removeEventListener("abort", abort));
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    return failure(error);
  }
}

export async function discardComposerImport(serialized: string, storage: Storage) {
  try { await discardPlan(JSON.parse(serialized) as ImportPlan, storage); } catch {}
  return { ok: true, error: "" };
}

/** Resolve local context bindings only after their owned files finish uploading. */
export function bindComposerAttachmentContext(serialized: string, attachments: readonly Pick<DraftAttachment, "localId" | "id" | "state">[]) {
  if (!serialized) return "";
  const context = parseObject(serialized);
  const items = records(serialized).map((entry) => {
    if (entry.kind !== "file" && entry.kind !== "image") return entry;
    const attachment = attachments.find((item) => item.localId === entry.attachmentId);
    if (!attachment) return entry;
    if (attachment.state !== "uploaded" || !attachment.id) throw new Error("Wait for copied attachments to finish uploading.");
    return { ...entry, attachmentId: attachment.id };
  });
  return JSON.stringify({ ...context, records: items });
}

export function appendComposerAttachmentReferences(value: string, serialized: string, attachments: readonly DraftAttachment[], start: number, end: number) {
  if (!attachments.length) return { text: value, context: serialized, cursor: Math.min(value.length, Math.max(0, start < 0 ? value.length : start)) };
  const context = parseObject(serialized);
  const current = records(serialized);
  const additions = attachments.map((attachment) => ({ version: 1, kind: attachment.type, contextId: `attachment_${attachment.localId}`, label: attachment.name.replace(/[\[\]\\\r\n]/gu, " ").slice(0, 200), attachmentId: attachment.localId, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
  const next = [...current.filter((entry) => !additions.some((item) => item.contextId === entry.contextId)), ...additions];
  if (next.length > 200) throw new Error("Remove some context items before adding more attachments.");
  const from = Math.min(value.length, Math.max(0, Math.trunc(start < 0 ? value.length : start)));
  const to = Math.min(value.length, Math.max(from, Math.trunc(end < 0 ? from : end)));
  const references = additions.map((item) => `${item.kind === "image" ? "!" : ""}[${item.label}](t3-context://v1/${item.kind}/${item.contextId})`).join(" ");
  const inserted = (from > 0 && !/\s/u.test(value[from - 1]!) ? " " : "") + references + (references ? " " : "");
  return { text: value.slice(0, from) + inserted + value.slice(to), context: JSON.stringify({ ...context, version: 1, records: next }), cursor: from + inserted.length };
}

export function composerImportSources(boundary: ComposerImportBoundary) {
  return {
    prepareComposerImport([draft, environmentId, fragment, pastedText, start, end, localDrafts]: [ComposerImportDraft, string, string, string, number, number, ComposerImportDraft[]], _store: unknown, storage: Storage, native?: NativeModule | null) {
      return prepareComposerImport({ draft, environmentId, fragment, pastedText, start, end, localDrafts }, storage, boundary, native);
    },
    materializeComposerImport([plan]: [string], _store: unknown, storage: Storage) {
      return materializeComposerImport(plan, storage, boundary);
    },
    discardComposerImport([plan]: [string], _store: unknown, storage: Storage) {
      return discardComposerImport(plan, storage);
    },
  };
}
