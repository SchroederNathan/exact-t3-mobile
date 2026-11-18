import { composerFileLink } from "./composer-commands";
import { scopedThreadId } from "./connection";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Match the Expo composer chip's compact attachment size suffix. */
function composerAttachmentSize(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const kilobytes = Math.max(1, Math.ceil(bytes / 1024));
  return kilobytes >= 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${kilobytes} KB`;
}

function contextRecords(serialized: string): RecordValue[] {
  try {
    const value = JSON.parse(serialized) as RecordValue;
    return Array.isArray(value.records) ? value.records.map(record) : [];
  } catch {
    return [];
  }
}

function contextObject(serialized: string): RecordValue | undefined {
  if (!serialized.trim()) return undefined;
  try {
    const value = JSON.parse(serialized) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as RecordValue)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep only context records that still have an inline reference in the draft.
 *
 * The native editor owns chip deletion, so a draft can briefly retain the
 * record that backed a deleted chip while its text has already changed. The
 * server only needs records referenced by the message text. Pruning at the
 * send boundary also prevents display-only metadata from becoming part of the
 * wire context envelope.
 */
export function pruneComposerContext(value: string, serializedContext = ""): string {
  const context = contextObject(serializedContext);
  if (!context || !Array.isArray(context.records)) return "";

  const referenced = new Set<string>();
  const contextPattern = /!?(?:\[[^\]\n]*\])\(t3-context:\/\/v1\/[a-z][a-z0-9-]{0,39}\/([^\s)]+)\)/gu;
  for (const match of value.matchAll(contextPattern)) {
    let contextId = match[1] ?? "";
    try {
      contextId = decodeURIComponent(contextId);
    } catch {
      continue;
    }
    if (contextId) referenced.add(contextId);
  }

  const records = context.records
    .map(record)
    .filter((entry) => {
      const contextId = text(entry.contextId);
      return contextId !== "" && referenced.has(contextId);
    });
  if (records.length === 0) return "";

  const { editorLabels: _editorLabels, ...wireContext } = context;
  return JSON.stringify({ ...wireContext, version: Number(context.version) || 1, records });
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** Serialize the inline references understood by T3ComposerEditor. Offsets are UTF-16. */
export function composerDocumentTokens(value: string, serializedContext = ""): string {
  const tokens: RecordValue[] = [];
  const records = contextRecords(serializedContext);
  const editorLabels = record(contextObject(serializedContext)?.editorLabels);
  const byId = new Map(records.map((entry) => [text(entry.contextId), entry]));
  const occupied: Array<{ start: number; end: number }> = [];
  const add = (token: RecordValue) => {
    const start = Number(token.start);
    const end = Number(token.end);
    if (occupied.some((range) => start < range.end && end > range.start)) return;
    occupied.push({ start, end });
    tokens.push(token);
  };
  const hasCommittedBoundary = (end: number, known = false) =>
    end < value.length ? /\s/u.test(value[end] ?? "") : known;
  const contextPattern = /!?\[([^\]\n]*)\]\(t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([^\s)]+)\)/gu;
  for (const match of value.matchAll(contextPattern)) {
    const source = match[0];
    const start = match.index ?? 0;
    const end = start + source.length;
    const contextId = match[3] ?? "";
    const entry = byId.get(contextId);
    const kind = text(entry?.kind) || text(match[2]);
    const label = text(match[1]) || text(entry?.label);
    add({
      type: "context",
      source,
      start,
      end,
      value: label,
      label: `${label}${entry ? "" : " · unavailable"}`,
      contextId,
      kind,
      symbol: kind === "thread" ? "symbol:sf/text.bubble" : kind === "environment" ? "symbol:sf/desktopcomputer" : kind === "review-comment" ? "symbol:sf/arrow.triangle.pull" : kind === "image" ? "symbol:sf/photo" : "symbol:sf/doc",
      detail: kind === "file" || kind === "image" ? composerAttachmentSize(entry?.sizeBytes) : "",
    });
  }
  const filePattern = /(^|\s)\[([^\]\n]*)\]\(([^)\s]+)\)(?=\s|$)/gu;
  for (const match of value.matchAll(filePattern)) {
    const source = match[0];
    const prefix = match[1] ?? "";
    let path = match[3] ?? "";
    try { path = decodeURIComponent(path); } catch { continue; }
    if (!path || text(match[2]) !== basename(path)) continue;
    const start = (match.index ?? 0) + prefix.length;
    const end = start + source.length - prefix.length;
    if (!hasCommittedBoundary(end)) continue;
    add({ type: "mention", source: value.slice(start, end), value: path, label: basename(path), symbol: "symbol:sf/doc", start, end });
  }
  const mentionPattern = /(^|\s)@(?:("(?:\\.|[^"\\])*")|([^\s@"]+))(?=\s|$)/gu;
  for (const match of value.matchAll(mentionPattern)) {
    const prefix = match[1] ?? "";
    const raw = match[2] ? match[2].slice(1, -1).replace(/\\(.)/gu, "$1") : match[3] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;
    if (!hasCommittedBoundary(end)) continue;
    add({ type: "mention", source: value.slice(start, end), value: raw, label: basename(raw), symbol: "symbol:sf/doc", start, end });
  }
  const skillPattern = /(^|\s)\$(?![0-9])[a-zA-Z0-9][a-zA-Z0-9:_-]*(?=\s|$)/gu;
  for (const match of value.matchAll(skillPattern)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const source = value.slice(start, start + match[0].length - prefix.length);
    const metadata = record(editorLabels[source] ?? editorLabels[source.slice(1)]);
    if (!hasCommittedBoundary(start + source.length, Object.keys(metadata).length > 0)) continue;
    add({
      type: "skill",
      source,
      value: source.slice(1),
      label: text(metadata.label) || source.slice(1),
      symbol: text(metadata.symbol) || "symbol:sf/cube",
      start,
      end: start + source.length,
    });
  }
  const modelPattern = /(?<![^\s,(\["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu;
  for (const match of value.matchAll(modelPattern)) {
    const source = match[0];
    const start = match.index ?? 0;
    if (!hasCommittedBoundary(start + source.length)) continue;
    add({ type: "model", source, value: match[2] ?? "", label: match[2] ?? "", instanceId: match[1] ?? "", symbol: "symbol:sf/cpu", start, end: start + source.length });
  }
  tokens.sort((left, right) => Number(left.start) - Number(right.start));
  return JSON.stringify(tokens);
}

export function composerDocument(value: string, serializedContext = "") {
  const tokens = composerDocumentTokens(value, serializedContext);
  const parsed = JSON.parse(tokens) as RecordValue[];
  let displayText = value;
  for (const token of [...parsed].reverse()) {
    const start = Number(token.start);
    const end = Number(token.end);
    const label = text(token.label) || text(token.value);
    displayText = `${displayText.slice(0, start)}${label ? ` ${label} ` : " "}${displayText.slice(end)}`;
  }
  const records = contextRecords(serializedContext);
  const attachments = parsed.flatMap((token) => {
    const entry = records.find((record) => record.contextId === token.contextId);
    return entry && (entry.kind === "file" || entry.kind === "image") && text(entry.attachmentId)
      ? [{ source: text(token.source), attachmentId: text(entry.attachmentId) }]
      : [];
  });
  return { tokens, displayText, attachments };
}

export interface ComposerSelectionItem extends RecordValue {
  type?: string;
  kind?: string;
}

export function selectComposerItem(input: {
  draft: { id: string; revision: number; text: string; context?: string; freshContext?: boolean };
  item: ComposerSelectionItem;
  start: number;
  end: number;
}) {
  const item = input.item;
  const itemKind = text(item.type) || text(item.kind);
  const itemInsertText = text(item.insertText);
  const command = itemKind === "provider-slash-command"
    ? text(record(item.command).name) || itemInsertText.trim().replace(/^\//u, "")
    : itemKind === "slash-command"
      ? text(item.command) || itemInsertText.trim().replace(/^\//u, "")
      : "";
  const isSlashCommand = itemKind === "slash-command" || itemKind === "provider-slash-command";
  const isClear = isSlashCommand && command === "clear";
  const isModelSettings = isSlashCommand && command === "model";
  const skillName = text(record(item.skill).name) || (itemInsertText.startsWith("$") ? itemInsertText.slice(1).trim() : "");
  const modelParts = itemInsertText.match(/^model:([^/\s]+)\/([^\s]+)\s*$/u);
  const insertText = isClear || isModelSettings ? "" : itemInsertText ||
    (itemKind === "path" || itemKind === "file" || itemKind === "directory" ? composerFileLink(text(item.path)) : itemKind === "skill" ? `$${skillName}` : itemKind === "model" && modelParts ? `model:${modelParts[1]}/${modelParts[2]}` : command ? `/${command}` : "");
  const replacement = insertText ? `${insertText} ` : "";
  const start = Math.max(0, Math.min(input.draft.text.length, input.start));
  const end = Math.max(start, Math.min(input.draft.text.length, input.end));
  const nextText = `${input.draft.text.slice(0, start)}${replacement}${input.draft.text.slice(end)}`;
  const context = contextObject(input.draft.context ?? "");
  const itemContext = contextObject(text(item.context));
  const records = [...contextRecords(input.draft.context ?? "")];
  for (const entry of itemContext?.records && Array.isArray(itemContext.records) ? itemContext.records.map(record) : []) {
    if (entry.contextId && !records.some((existing) => existing.contextId === entry.contextId)) records.push(entry);
  }
  const editorLabels = { ...record(context?.editorLabels), ...record(itemContext?.editorLabels) };
  if (itemKind === "skill" && skillName) {
    const skill = record(item.skill);
    const metadata = record(editorLabels[`$${skillName}`]);
    editorLabels[`$${skillName}`] = {
      label: text(metadata.label) || text(skill.displayName) || text(item.label) || skillName,
      name: text(metadata.name) || skillName,
      path: text(metadata.path) || text(item.path),
      description: text(metadata.description) || text(skill.shortDescription) || text(skill.description),
      symbol: "symbol:sf/cube",
    };
  }
  const nextContext = records.length > 0 || Object.keys(editorLabels).length > 0
    ? JSON.stringify({ ...(context ?? {}), version: 1, records, ...(Object.keys(editorLabels).length > 0 ? { editorLabels } : {}) })
    : "";
  return {
    id: input.draft.id,
    revision: input.draft.revision,
    text: nextText,
    context: nextContext,
    freshContext: isClear || input.draft.freshContext === true,
    cursor: start + replacement.length,
    action: isClear ? "clear" : isModelSettings ? "model-settings" : text(item.action),
  };
}

const NATIVE_CONTEXT_KINDS = new Set(["thread", "environment", "review-comment"]);

export function composerContextDetail(source: string, serializedContext = "") {
  const context = contextObject(serializedContext);
  const records = contextRecords(serializedContext);
  const labels = record(context?.editorLabels);
  const contextMatch = source.match(/^!?\[([^\]\n]*)\]\(t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([^\s)]+)\)$/u);
  if (contextMatch) {
    let contextId = contextMatch[3] ?? "";
    try { contextId = decodeURIComponent(contextId); } catch {}
    const kind = contextMatch[2] ?? "context";
    const recordValue = records.find((entry) => text(entry.contextId) === contextId);
    const label = text(contextMatch[1]) || text(recordValue?.label) || kind;
    const pullRequest = record(recordValue?.pullRequest);
    const branches = [text(pullRequest.baseBranch), text(pullRequest.headBranch)].filter(Boolean).join(" ← ");
    const detail = kind === "review-comment"
      ? [text(recordValue?.title) || text(recordValue?.rangeLabel) || label, branches].filter(Boolean).join(" · ")
      : kind === "environment"
        ? text(recordValue?.label) || text(recordValue?.environmentId)
        : text(recordValue?.text) || text(recordValue?.title) || text(recordValue?.rangeLabel) || text(recordValue?.label);
    const thread = kind === "thread" && text(recordValue?.environmentId) && text(recordValue?.threadId)
      ? scopedThreadId(text(recordValue?.environmentId), text(recordValue?.threadId))
      : "";
    const href = thread
      ? `/threads/${thread}`
      : kind === "review-comment" ? text(record(recordValue?.pullRequest).url) : "";
    return {
      source,
      label: recordValue ? label : `${label} (unavailable)`,
      detail: recordValue ? detail : "Context unavailable",
      fieldLabel: kind === "thread" ? "Thread" : kind === "environment" ? "Machine" : kind === "review-comment" ? `#${pullRequest.number || ""} · ${text(pullRequest.state) || "open"}` : kind,
      secondaryLabel: kind === "thread" ? "Machine" : kind === "review-comment" ? "Branches" : "",
      secondaryDetail: kind === "thread" ? text(recordValue?.environmentId) : kind === "review-comment" ? branches : "",
      openLabel: kind === "thread" ? "Open thread" : kind === "review-comment" ? "Open pull request" : "",
      href,
      kind,
      threadId: thread,
    };
  }
  const fileMatch = source.match(/^!?\[([^\]\n]*)\]\(([^)\s]+)\)$/u);
  if (fileMatch) {
    let href = fileMatch[2] ?? "";
    try { href = decodeURIComponent(href); } catch {}
    return { source, label: text(fileMatch[1]) || basename(href), detail: href, fieldLabel: "Path", secondaryLabel: "", secondaryDetail: "", openLabel: "Open file", href, kind: "file", threadId: "" };
  }
  if (source.startsWith("$")) {
    const name = source.slice(1);
    const metadata = record(labels[source] ?? labels[name]);
    return { source, label: text(metadata.label) || name, detail: name, fieldLabel: "Skill", secondaryLabel: "Description", secondaryDetail: text(metadata.description), openLabel: "View instructions", href: text(metadata.path), kind: "skill", threadId: "" };
  }
  if (source.startsWith("model:")) {
    const model = source.slice("model:".length);
    return { source, label: model.split("/").at(-1) || model, detail: model, fieldLabel: "Model", secondaryLabel: "", secondaryDetail: "", openLabel: "", href: "", kind: "model", threadId: "" };
  }
  return { source, label: source, detail: "", fieldLabel: "Context", secondaryLabel: "", secondaryDetail: "", openLabel: "", href: "", kind: "context", threadId: "" };
}

export function parseNativeComposerEvent(value: string, currentContext = "") {
  const raw = record(contextObject(value) ?? {});
  const selection = record(raw.selection);
  const key = text(raw.key) || text(raw.documentKey);
  const eventText = typeof raw.text === "string" ? raw.text : typeof raw.value === "string" ? raw.value : "";
  const revisionValue = raw.eventCount ?? raw.revision;
  const revision = Number(revisionValue);
  const valid = key !== "" && (typeof raw.text === "string" || typeof raw.value === "string") && Number.isFinite(revision);
  const kind = valid ? text(raw.kind) || "edit" : "invalid";
  const files = Array.isArray(raw.files)
    ? raw.files.flatMap((value) => {
        const file = record(value);
        const path = text(file.path);
        const name = text(file.name);
        const type = text(file.type) || "application/octet-stream";
        const size = Number(file.size);
        if (!path || !name || !Number.isFinite(size) || size < 0) return [];
        const optionalDimension = (entry: unknown) => {
          const number = Number(entry);
          return Number.isFinite(number) && number >= 0 ? number : null;
        };
        return [{ path, name, type, size, width: optionalDimension(file.width), height: optionalDimension(file.height), duration: optionalDimension(file.duration) }];
      })
    : [];
  let context = currentContext;
  if (kind === "paste") {
    const nativeState = typeof raw.contextState === "string" ? (contextObject(raw.contextState) ?? {}) : record(raw.contextState);
    if (Array.isArray(nativeState.records)) {
      context = JSON.stringify(nativeState);
    }
    const incoming = typeof raw.context === "string" ? (contextObject(raw.context) ?? {}) : record(raw.context);
    const existing = contextObject(currentContext);
    const records = [
      ...contextRecords(currentContext),
      ...(Array.isArray(incoming.records) ? incoming.records.map(record).filter((entry) => NATIVE_CONTEXT_KINDS.has(text(entry.kind)) && text(entry.contextId)) : []),
    ];
    const deduped = [...new Map(records.map((entry) => [text(entry.contextId), entry])).values()];
    if (!Array.isArray(nativeState.records)) {
      context = deduped.length > 0
        ? JSON.stringify({ ...(existing ?? {}), version: 1, records: deduped })
        : "";
    }
  }
  return {
    key,
    kind,
    alternate: raw.alternate === true,
    error: kind === "pasteError" ? text(raw.context) : "",
    text: eventText,
    revision: Number.isFinite(revision) ? revision : 0,
    start: Number(selection.start ?? raw.start ?? 0),
    end: Number(selection.end ?? raw.end ?? 0),
    context,
    source: kind === "context" ? text(raw.context) : "",
    files,
    fragment: kind === "pasteFragment" ? text(raw.context) : "",
    pastedText: kind === "pasteFragment" ? text(raw.pastedText) : "",
  };
}
