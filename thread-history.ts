import { displayAttachments, type DisplayAttachment } from "./attachments";
import { markdownBlocks } from "./markdown";
import { liveToolTitle, toolSummary, type ToolSummary } from "./tool-activity";
import { projectControls } from "./thread-controls";

export type HistoryRecord = Record<string, unknown>;
export interface TimelineRow {
  position: number;
  visibility: string;
  sourceThreadId: string;
  sourceItemId: string;
  item: HistoryRecord;
}
export interface HistorySummary {
  ready: boolean;
  synchronized: boolean;
  hasMore: boolean;
  loading: boolean;
  error: string;
}

const record = (value: unknown): HistoryRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as HistoryRecord)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const records = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
const sequence = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const entities = (value: unknown) => new Map(records(value).map((item) => [text(item.id), item]));
const key = (row: TimelineRow) => JSON.stringify([row.sourceThreadId, row.sourceItemId]);
const ordinal = (item: HistoryRecord) => sequence(item.ordinal) ?? 0;
const unfinished = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function timelineRows(value: unknown): TimelineRow[] {
  return records(value).flatMap((row) => {
    const item = record(row.item);
    const sourceItemId = text(row.sourceItemId) || text(item.id);
    const sourceThreadId = text(row.sourceThreadId) || text(item.threadId);
    return sourceItemId
      ? [
          {
            position: sequence(row.position) ?? 0,
            visibility: text(row.visibility),
            sourceThreadId,
            sourceItemId,
            item,
          },
        ]
      : [];
  });
}

function displayMessage(
  id: string,
  role: string,
  body: string,
  createdAt: string,
  pending: boolean,
  attachments: DisplayAttachment[],
  updatedAt: string,
) {
  const date = new Date(role === "assistant" ? updatedAt : createdAt);
  return {
    id,
    role,
    body,
    createdAt,
    updatedAt,
    pending,
    showAssistantMeta: false,
    canFork: false,
    spacingAfter: role === "user" ? 17.5 : role === "assistant" ? 3.5 : 0,
    attachments,
    timeLabel: Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    blocks: markdownBlocks(body, id, role === "user", pending),
  };
}

type DisplayMessage = ReturnType<typeof displayMessage>;
export interface TurnChanges {
  threadId: string;
  checkpointId: string;
  turnCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  additionsLabel: string;
  deletionsLabel: string;
}
export type FeedRow = { foldId: string; changes: TurnChanges | null } & (
  | { id: string; message: DisplayMessage; activity: null }
  | { id: string; message: null; activity: ToolSummary }
);

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${Math.round(ms / 100) / 10}s`;
  const total = Math.round(ms / 1_000);
  if (total < 60) return `${total}s`;
  return [
    Math.floor(total / 3_600) ? `${Math.floor(total / 3_600)}h` : "",
    Math.floor((total % 3_600) / 60) ? `${Math.floor((total % 3_600) / 60)}m` : "",
    total % 60 ? `${total % 60}s` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function groupTitle(entries: Array<{ tool: ToolSummary; item: HistoryRecord }>): string {
  const tools = entries.filter(({ tool }) => tool.category !== "reasoning");
  if (tools.length === 0) return entries.length === 1 ? "Thought" : `Thought (×${entries.length})`;
  const groups = new Map<string, { count: number; files: Set<string>; priority: number }>();
  for (const { tool, item } of tools) {
    const action =
      tool.category === "command"
        ? "command"
        : tool.category === "file-change"
          ? "edit"
          : tool.category === "search"
            ? item.type === "web_search"
              ? "web"
              : "search"
            : "tool";
    const group = groups.get(action) ?? {
      count: 0,
      files: new Set<string>(),
      priority: action === "command" || action === "edit" ? 0 : action === "tool" ? 2 : 1,
    };
    const files = records(item.changes)
      .map((change) => text(change.path) || text(change.fileName))
      .filter(Boolean);
    if (files.length === 0 && text(item.fileName)) files.push(text(item.fileName));
    if (action === "edit" && files.length > 0) files.forEach((file) => group.files.add(file));
    else group.count++;
    groups.set(action, group);
  }
  const all = [...groups].map(([action, group], index) => ({ action, ...group, index }));
  const selected = all
    .toSorted((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .toSorted((a, b) => a.index - b.index);
  const labels = selected.map(({ action, count, files }) => {
    const n = count + files.size;
    if (action === "command") return `Ran ${n} ${n === 1 ? "command" : "commands"}`;
    if (action === "edit") return `Changed ${n} ${n === 1 ? "file" : "files"}`;
    if (action === "web") return `Searched the web ${n} ${n === 1 ? "time" : "times"}`;
    if (action === "search") return `Searched code ${n} ${n === 1 ? "time" : "times"}`;
    return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
  });
  const remaining = all
    .filter((group) => !selected.includes(group))
    .reduce((n, group) => n + group.count, 0);
  if (remaining)
    labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  const sentence = labels.map((label, index) =>
    index ? label[0]!.toLowerCase() + label.slice(1) : label,
  );
  return sentence.length < 3
    ? sentence.join(" and ")
    : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
}

export class ThreadHistory {
  sequence: number | null = null;
  generation = 0;
  markdownRevision = 0;
  ready = false;
  synchronized = false;
  deleted = false;
  cursor: string | null = null;
  hasMore = false;
  loading = false;
  error = "";
  private waitForCompletion = false;
  private timeline = false;
  private rows: TimelineRow[] = [];
  private items = new Map<string, HistoryRecord>();
  private rawMessages = new Map<string, HistoryRecord>();
  private checkpoints = new Map<string, HistoryRecord>();
  private providerThreads = new Map<string, HistoryRecord>();
  private providerSessions = new Map<string, HistoryRecord>();
  private runs = new Map<string, HistoryRecord>();
  private attempts = new Map<string, HistoryRecord>();
  private nodes = new Map<string, HistoryRecord>();
  private requests = new Map<string, HistoryRecord>();
  private controlProjection: ReturnType<typeof projectControls> | undefined;
  private interruptTokens: Map<string, string> | undefined;
  private latestLocalOrdinal: number | null = null;
  private rendered: FeedRow[] | undefined;
  private messageCache = new Map<string, DisplayMessage>();
  private activityCache = new WeakMap<HistoryRecord, ToolSummary | null>();
  private rowIndex: Map<string, TimelineRow> | undefined;

  constructor(readonly threadId: string) {}

  summary(): HistorySummary {
    return {
      ready: this.ready,
      synchronized: this.synchronized,
      hasMore: this.hasMore,
      loading: this.loading,
      error: this.error,
    };
  }

  visibleRows(): readonly TimelineRow[] {
    return this.rows;
  }

  controls(environmentId: string) {
    this.controlProjection ??= projectControls(
      environmentId,
      this.threadId,
      [...this.requests.values()],
      [...this.items.values()]
        .filter((item) => !item.threadId || item.threadId === this.threadId)
        .sort((a, b) => ordinal(a) - ordinal(b)),
      [...this.runs.values()],
    );
    return {
      ...this.controlProjection,
      stop: { ...this.controlProjection.stop },
      requests: this.controlProjection.requests.map((request) => ({ ...request })),
      ready: this.synchronized && !this.deleted,
    };
  }

  private invalidateControls() {
    this.controlProjection = undefined;
    this.interruptTokens = undefined;
  }

  interruptResult(runId: string) {
    this.interruptTokens ??= new Map(
      [...this.items.values()]
        .filter((item) => item.type === "run_interrupt_result")
        .map((item) => [text(item.runId), JSON.stringify([item.id, item.updatedAt])]),
    );
    return this.interruptTokens.get(runId) ?? "";
  }

  row(id: string): TimelineRow | undefined {
    this.rowIndex ??= new Map(this.rows.map((row) => [key(row), row]));
    return this.rowIndex.get(id);
  }

  forkPoint(rowId: string, sourceHistory?: ThreadHistory) {
    const row = this.row(rowId);
    if (!row) return null;
    const item = row.item;
    const runId = text(item.runId);
    if (
      item.type !== "assistant_message" ||
      item.status !== "completed" ||
      item.streaming === true ||
      !runId
    )
      return null;
    const source =
      row.sourceThreadId === this.threadId
        ? this
        : sourceHistory?.threadId === row.sourceThreadId
          ? sourceHistory
          : undefined;
    const sourceItem = source?.items.get(row.sourceItemId) ?? source?.row(key(row))?.item;
    const providerThread = source?.providerThreads.get(text(sourceItem?.providerThreadId));
    const capabilities = source?.providerSessions.get(
      text(providerThread?.providerSessionId),
    )?.capabilities;
    if (capabilities !== undefined) {
      const known = record(capabilities);
      const threads = record(known.threads);
      const native =
        threads.canForkThread === true &&
        threads.canForkFromTurn === true &&
        record(known.identity).nativeThreadIds === "strong";
      if (!native && record(known.context).supportsFullThreadHandoff !== true) return null;
    }
    return { sourceThreadId: row.sourceThreadId, runId };
  }

  block(messageId: string, blockId: string) {
    return this.messageCache.get(messageId)?.blocks.find((block) => block.id === blockId);
  }

  private invalidate() {
    this.rendered = undefined;
    this.rowIndex = undefined;
  }

  subscribing(waitForCompletion: boolean) {
    this.waitForCompletion = waitForCompletion;
    this.synchronized = false;
    this.error = "";
  }

  disconnect() {
    this.synchronized = false;
    this.generation++;
    this.loading = false;
  }

  remove() {
    this.disconnect();
    this.deleted = true;
    this.ready = false;
    this.sequence = null;
    this.cursor = null;
    this.hasMore = false;
    this.rows = [];
    this.items.clear();
    this.rawMessages.clear();
    this.checkpoints.clear();
    this.providerThreads.clear();
    this.providerSessions.clear();
    this.runs.clear();
    this.attempts.clear();
    this.nodes.clear();
    this.requests.clear();
    this.invalidateControls();
    this.messageCache.clear();
    this.rowIndex = undefined;
    this.rendered = [];
  }

  install(snapshot: HistoryRecord) {
    const projection = record(snapshot.projection);
    this.generation++;
    this.sequence = sequence(snapshot.snapshotSequence);
    this.ready = true;
    this.deleted = false;
    this.synchronized = !this.waitForCompletion;
    this.timeline = Array.isArray(projection.visibleTurnItems);
    this.rows = timelineRows(projection.visibleTurnItems);
    this.items = entities(projection.turnItems);
    for (const row of this.rows) {
      if (this.local(row) && !this.items.has(row.sourceItemId))
        this.items.set(row.sourceItemId, row.item);
    }
    this.rawMessages = entities(projection.messages);
    this.checkpoints = entities(projection.checkpoints);
    this.providerThreads = entities(projection.providerThreads);
    this.providerSessions = entities(projection.providerSessions);
    this.runs = entities(projection.runs);
    this.attempts = entities(projection.attempts);
    this.nodes = entities(projection.nodes);
    this.requests = entities(projection.runtimeRequests);
    this.invalidateControls();
    this.cursor = text(snapshot.historyCursor) || null;
    this.hasMore = snapshot.hasMoreHistory === true;
    this.latestLocalOrdinal = sequence(snapshot.latestLocalTurnOrdinal);
    this.loading = false;
    this.error = "";
    this.invalidate();
  }

  apply(item: HistoryRecord): boolean {
    if (item.kind === "synchronized") {
      this.synchronized = this.ready && !this.deleted;
      return true;
    }
    if (item.kind !== "event" && item.kind !== "unknown-event") return false;
    if (this.deleted) return false;
    const nextSequence = sequence(item.sequence);
    if (nextSequence !== null && this.sequence !== null && nextSequence <= this.sequence)
      return false;
    const event = record(item.event);
    if (event.threadId && event.threadId !== this.threadId) return false;
    const payload = record(event.payload);
    const id = text(payload.id);
    switch (event.type) {
      case "thread.deleted":
        this.remove();
        break;
      case "message.updated":
        if (id) this.rawMessages.set(id, payload);
        if (!this.timeline || this.checkpoints.size > 0) this.invalidate();
        break;
      case "checkpoint.captured":
        if (id) this.checkpoints.set(id, payload);
        this.invalidate();
        break;
      case "provider-session.attached":
      case "provider-session.updated":
        if (id) this.providerSessions.set(id, payload);
        this.invalidate();
        break;
      case "provider-session.detached":
        this.providerSessions.delete(text(payload.providerSessionId));
        this.invalidate();
        break;
      case "provider-thread.updated":
        if (id) this.providerThreads.set(id, payload);
        this.invalidate();
        break;
      case "turn-item.updated":
        if (
          [
            "approval_request",
            "user_input_request",
            "run_interrupt_request",
            "run_interrupt_result",
          ].includes(text(payload.type))
        )
          this.invalidateControls();
        if (id) this.updateItem(payload);
        break;
      case "runtime-request.updated":
        this.invalidateControls();
        if (id) this.requests.set(id, payload);
        break;
      case "run.created":
      case "run.updated":
        this.invalidateControls();
        if (id) this.runs.set(id, payload);
        this.invalidate();
        this.filterVisible();
        break;
      case "run-attempt.created":
      case "run-attempt.updated":
        if (id) this.attempts.set(id, payload);
        this.invalidate();
        this.filterVisible();
        break;
      case "node.updated":
        if (id) this.nodes.set(id, payload);
        this.invalidate();
        break;
    }
    if (nextSequence !== null && !this.deleted) this.sequence = nextSequence;
    if (!this.waitForCompletion && this.ready) this.synchronized = true;
    return true;
  }

  private local(row: TimelineRow) {
    return row.visibility === "local" || row.sourceThreadId === this.threadId;
  }

  private visible(item: HistoryRecord) {
    const runId = text(item.runId);
    const status = this.runs.get(runId)?.status;
    if (status === "rolled_back") return false;
    if (
      status === "cancelled" &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    if (item.type !== "run_interrupt_result" || !runId || !item.nodeId) return true;
    const superseded = [...this.attempts.values()].some(
      (attempt) =>
        attempt.runId === runId &&
        attempt.rootNodeId === item.nodeId &&
        attempt.status === "superseded",
    );
    return (
      !superseded ||
      [...this.items.values()].some(
        (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === runId,
      )
    );
  }

  private filterVisible() {
    const filtered = this.rows.filter((row) => !this.local(row) || this.visible(row.item));
    if (filtered.length !== this.rows.length) {
      this.rows = filtered.map((row, position) =>
        row.position === position ? row : { ...row, position },
      );
      this.invalidate();
    }
  }

  private outsideWindow(item: HistoryRecord) {
    if (!this.hasMore && this.cursor === null) return false;
    if (this.rows.some((row) => this.local(row) && row.sourceItemId === item.id)) return false;
    const runId = text(item.runId);
    if (runId && unfinished.has(text(this.runs.get(runId)?.status))) return false;
    if (
      runId &&
      this.rows.some(
        (row) => this.local(row) && row.item.runId === runId && ordinal(row.item) <= ordinal(item),
      )
    )
      return false;
    if (this.latestLocalOrdinal !== null && ordinal(item) <= this.latestLocalOrdinal) return true;
    const oldest = this.rows.reduce(
      (value, row) => (this.local(row) ? Math.min(value, ordinal(row.item)) : value),
      Infinity,
    );
    return ordinal(item) < oldest && oldest !== Infinity;
  }

  private updateItem(incoming: HistoryRecord) {
    const id = text(incoming.id);
    const previous = this.items.get(id);
    if (!previous && this.outsideWindow(incoming)) {
      if (
        [
          "approval_request",
          "user_input_request",
          "run_interrupt_request",
          "run_interrupt_result",
        ].includes(text(incoming.type))
      )
        this.items.set(id, incoming);
      this.latestLocalOrdinal = Math.max(this.latestLocalOrdinal ?? 0, ordinal(incoming));
      return;
    }
    const item =
      previous?.deferredWork === undefined
        ? incoming
        : { ...incoming, deferredWork: previous.deferredWork };
    this.items.set(id, item);
    if (item.type === "run_interrupt_request" || previous?.type === "run_interrupt_request")
      this.filterVisible();
    const index = this.rows.findIndex((row) => this.local(row) && row.sourceItemId === id);
    if (!this.visible(item)) {
      if (index >= 0) this.rows.splice(index, 1);
    } else if (index >= 0 && ordinal(this.rows[index]!.item) === ordinal(item)) {
      this.rows[index] = { ...this.rows[index]!, item };
    } else if (index >= 0 || !this.outsideWindow(item)) {
      if (index >= 0) this.rows.splice(index, 1);
      const insertion = this.rows.findIndex(
        (row) =>
          this.local(row) &&
          (ordinal(row.item) > ordinal(item) ||
            (ordinal(row.item) === ordinal(item) && row.sourceItemId.localeCompare(id) > 0)),
      );
      this.rows.splice(insertion < 0 ? this.rows.length : insertion, 0, {
        position: 0,
        visibility: "local",
        sourceThreadId: this.threadId,
        sourceItemId: id,
        item,
      });
    }
    this.latestLocalOrdinal = Math.max(this.latestLocalOrdinal ?? 0, ordinal(item));
    this.rows = this.rows.map((row, position) =>
      row.position === position ? row : { ...row, position },
    );
    this.invalidate();
  }

  mergePage(page: HistoryRecord) {
    this.invalidateControls();
    const existing = new Map(this.rows.map((row) => [key(row), row]));
    const seen = new Set<string>();
    const older: TimelineRow[] = [];
    for (const incoming of timelineRows(page.items)) {
      const rowKey = key(incoming);
      if (seen.has(rowKey)) continue;
      let row = existing.get(rowKey) ?? incoming;
      if (this.local(row)) {
        const current = this.items.get(row.sourceItemId);
        const retainedRequest =
          current &&
          ["run_interrupt_request", "approval_request", "user_input_request"].includes(
            text(current.type),
          );
        if (
          !this.visible(current ?? row.item) ||
          (!existing.has(rowKey) && current && !retainedRequest)
        )
          continue;
        if (current && !existing.has(rowKey)) row = { ...row, item: current };
        if (!current) this.items.set(row.sourceItemId, row.item);
      }
      seen.add(rowKey);
      older.push(row);
    }
    this.rows = [...older, ...this.rows.filter((row) => !seen.has(key(row)))].map(
      (row, position) => ({ ...row, position }),
    );
    this.cursor = text(page.nextCursor) || null;
    this.hasMore = page.hasMoreHistory === true;
    this.error = "";
    this.invalidate();
  }

  feed(): FeedRow[] {
    if (this.rendered) return this.rendered;
    const rows: FeedRow[] = [];
    const messages = new Map<string, DisplayMessage>();
    const append = (
      id: string,
      role: string,
      body: string,
      createdAt: string,
      pending: boolean,
      rawAttachments: unknown = [],
      updatedAt = createdAt,
    ) => {
      if (!id || !["user", "assistant", "system"].includes(role)) return;
      const attachments = displayAttachments(rawAttachments);
      const cached = this.messageCache.get(id);
      const message =
        cached?.body === body &&
        cached.role === role &&
        cached.createdAt === createdAt &&
        cached.updatedAt === updatedAt &&
        cached.pending === pending &&
        JSON.stringify(cached.attachments) === JSON.stringify(attachments)
          ? cached
          : displayMessage(id, role, body, createdAt, pending, attachments, updatedAt);
      messages.set(id, message);
      rows.push({ id, foldId: "", changes: null, message, activity: null });
    };
    if (this.timeline) {
      for (const row of this.rows) {
        const item = row.item;
        if (item.type === "error") {
          append(
            key(row),
            "system",
            [text(item.title), text(record(item.failure).message)].filter(Boolean).join("\n\n"),
            text(item.updatedAt),
            false,
          );
          continue;
        }
        if (item.type !== "user_message" && item.type !== "assistant_message") {
          let activity = this.activityCache.get(item);
          if (activity === undefined) {
            activity = toolSummary(item);
            this.activityCache.set(item, activity);
          }
          if (activity)
            rows.push({
              id: key(row),
              foldId: "",
              changes: null,
              message: null,
              activity: { ...activity, id: key(row) },
            });
          continue;
        }
        if (
          item.type === "user_message" &&
          item.inputIntent === "queued_turn" &&
          item.status === "pending"
        )
          continue;
        append(
          key(row),
          item.type === "user_message" ? "user" : "assistant",
          text(item.text),
          text(item.startedAt) || text(item.updatedAt),
          item.streaming === true,
          item.attachments,
          text(item.updatedAt) || text(item.startedAt),
        );
      }
    } else {
      for (const item of this.rawMessages.values())
        append(
          text(item.id),
          text(item.role),
          text(item.text),
          text(item.createdAt),
          item.streaming === true,
          item.attachments,
          text(item.updatedAt) || text(item.createdAt),
        );
    }
    if (
      messages.size !== this.messageCache.size ||
      [...messages].some(([id, message]) => this.messageCache.get(id) !== message)
    )
      this.markdownRevision++;
    this.messageCache = messages;
    return (this.rendered = this.present(rows));
  }

  private present(rows: FeedRow[]): FeedRow[] {
    const attemptByRoot = new Map(
      [...this.attempts.values()].map((attempt) => [text(attempt.rootNodeId), attempt]),
    );
    const attemptId = (item: HistoryRecord) => {
      let nodeId = text(item.nodeId);
      const visited = new Set<string>();
      while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = this.nodes.get(nodeId);
        const attempt = attemptByRoot.get(nodeId) ?? attemptByRoot.get(text(node?.rootNodeId));
        if (attempt && attempt.runId === item.runId) return text(attempt.id);
        nodeId = text(node?.parentNodeId);
      }
      return "";
    };
    const meta = new Map<string, { row: TimelineRow; runKey: string; boundary: number }>();
    const blocked = new Set<string>();
    const failed = new Set<string>();
    const starts = new Map<string, string>();
    let runlessKey = "";
    let boundary = 0;
    for (const row of this.rows) {
      const item = row.item;
      const id = key(row);
      const ownRun = text(item.runId);
      if (item.type === "user_message") {
        runlessKey = ownRun ? "" : `runless:${id}`;
      }
      const runKey = ownRun ? JSON.stringify([row.sourceThreadId, ownRun]) : runlessKey;
      if (item.type === "user_message" && runKey && !starts.has(runKey)) {
        starts.set(runKey, text(item.startedAt) || text(item.updatedAt));
      }
      if (
        [
          "notification",
          "compaction",
          "handoff",
          "subagent",
          "fork",
          "thread_created",
          "system_notice",
          "proposed_plan",
          "secret_request",
          "link_request",
        ].includes(text(item.type)) ||
        item.questionAnswer
      )
        boundary++;
      meta.set(id, { row, runKey, boundary });
      if (
        item.type === "run_interrupt_result" ||
        (item.type === "error" && item.status === "failed" && !item.parentItemId) ||
        item.streaming === true
      )
        blocked.add(runKey);
      const run = this.local(row) ? this.runs.get(ownRun) : undefined;
      if (!run && ["pending", "idle", "running", "waiting"].includes(text(item.status)))
        blocked.add(runKey);
      if (
        run?.status === "failed" ||
        (item.type === "error" && item.status === "failed" && !item.parentItemId)
      )
        failed.add(runKey);
      if (
        run &&
        (run.status === "failed" ||
          (run.status !== "queued" &&
            (run.completedAt === null || unfinished.has(text(run.status)))))
      )
        blocked.add(runKey);
    }
    const grouped: FeedRow[] = [];
    let pending: Array<FeedRow & { activity: ToolSummary }> = [];
    let groupKey = "";
    const flush = (tail: boolean) => {
      if (pending.length === 0) return;
      const first = pending[0]!;
      const last = pending.at(-1)!;
      const source = meta.get(last.id)?.row;
      const run = source && this.local(source) ? this.runs.get(text(source.item.runId)) : undefined;
      const activeRun = run === undefined || unfinished.has(text(run.status));
      const latestActive = activeRun ? pending.findLast((row) => row.activity.live) : undefined;
      const latest = latestActive ?? last;
      const tools = pending.filter(({ activity }) => activity.category !== "reasoning");
      const latestTool = tools.at(-1);
      const live = Boolean(
        latestActive || (tail && run && activeRun && last.activity.status === "completed"),
      );
      const title =
        pending.length > 1 ||
        first.activity.category === "file-change" ||
        first.activity.category === "reasoning"
          ? groupTitle(
              pending.map((row) => ({
                tool: row.activity,
                item: meta.get(row.id)?.row.item ?? {},
              })),
            )
          : first.activity.title;
      const symbols = new Set(
        (live ? [latest] : tools.length ? tools : pending).map(({ activity }) =>
          activity.category === "tool" || activity.category === "mcp" ? "hammer" : activity.symbol,
        ),
      );
      const activity =
        pending.length === 1
          ? { ...first.activity }
          : {
              ...first.activity,
              id: `${first.id}:group`,
              category: tools.length === 0 ? ("reasoning" as const) : ("tool" as const),
              status: latestTool?.activity.status ?? latest.activity.status,
              title,
              symbol: symbols.size === 1 ? symbols.values().next().value! : "hammer",
              revision: pending.map((row) => `${row.id}:${row.activity.revision}`).join("|"),
              exitLabel: "",
              groupCount: pending.length,
              grouped: pending.map(({ activity }) => ({
                id: activity.id,
                category: activity.category,
                status: activity.status,
                title: activity.title,
                displayTitle: activity.displayTitle,
                live: activity.live,
                symbol: activity.symbol,
                revision: activity.revision,
                exitLabel: activity.exitLabel,
              })),
              groupedIds: pending.map((row) => row.id),
            };
      activity.live = live;
      activity.displayTitle = live
        ? liveToolTitle(latest.activity.category, latest.activity.title)
        : title;
      grouped.push({
        id: pending.length === 1 ? first.id : activity.id,
        foldId: "",
        changes: null,
        message: null,
        activity,
      });
      if (pending.length > 1 && meta.has(first.id)) meta.set(activity.id, meta.get(first.id)!);
      pending = [];
    };
    for (const row of rows) {
      if (row.activity) {
        const source = meta.get(row.id);
        const nextKey = JSON.stringify([
          source?.row.sourceThreadId,
          source?.row.item.runId,
          source ? attemptId(source.row.item) : "",
          source?.boundary,
          source && failed.has(source.runKey) ? row.id : "",
        ]);
        if (groupKey !== nextKey) flush(false);
        groupKey = nextKey;
        pending.push(row as FeedRow & { activity: ToolSummary });
      } else {
        if (!row.message.body.trim() && row.message.attachments.length === 0) continue;
        flush(false);
        grouped.push(row);
      }
    }
    flush(true);
    const groups = new Map<string, FeedRow[]>();
    for (const row of grouped) {
      if (row.message?.role === "user" || row.message?.role === "system") continue;
      const runKey = meta.get(row.id)?.runKey;
      if (!runKey) continue;
      const group = groups.get(runKey) ?? [];
      group.push(row);
      groups.set(runKey, group);
    }
    const folds = new Map<string, FeedRow>();
    const lastMessages = new Map<string, string>();
    for (const message of this.rawMessages.values())
      if (message.role === "assistant" && message.runId)
        lastMessages.set(text(message.runId), text(message.id));
    const checkpoints = new Map(
      [...this.checkpoints.values()]
        .filter(
          (checkpoint) =>
            checkpoint.threadId === this.threadId &&
            checkpoint.status === "ready" &&
            records(checkpoint.files).length > 0 &&
            (sequence(checkpoint.appRunOrdinal) ?? 0) > 0,
        )
        .map((checkpoint) => [text(checkpoint.runId), checkpoint]),
    );
    for (const [runKey, group] of groups) {
      const terminal = group.findLast((row) => row.message?.role === "assistant");
      const terminalSource = terminal && meta.get(terminal.id)?.row;
      const terminalRun =
        terminalSource && this.local(terminalSource)
          ? this.runs.get(text(terminalSource.item.runId))
          : undefined;
      const unsettled =
        terminalRun &&
        terminalRun.status !== "queued" &&
        (terminalRun.completedAt === null || unfinished.has(text(terminalRun.status)));
      if (
        terminal?.message &&
        terminalSource?.item.runId &&
        !unsettled &&
        !terminal.message.pending
      )
        terminal.message = {
          ...terminal.message,
          showAssistantMeta: true,
          canFork: this.forkPoint(terminal.id) !== null,
          spacingAfter: failed.has(runKey) ? 3.5 : 17.5,
        };
      const checkpoint =
        terminalSource && this.local(terminalSource)
          ? checkpoints.get(text(terminalSource.item.runId))
          : undefined;
      if (
        checkpoint &&
        terminal &&
        terminalSource &&
        !unsettled &&
        !terminal.message?.pending &&
        lastMessages.get(text(checkpoint.runId)) === terminalSource.item.messageId
      ) {
        const files = records(checkpoint.files);
        const additions = files.reduce((sum, file) => sum + (sequence(file.additions) ?? 0), 0);
        const deletions = files.reduce((sum, file) => sum + (sequence(file.deletions) ?? 0), 0);
        terminal.changes = {
          threadId: this.threadId,
          checkpointId: text(checkpoint.id),
          turnCount: sequence(checkpoint.appRunOrdinal)!,
          fileCount: files.length,
          additions,
          deletions,
          additionsLabel: additions.toLocaleString(),
          deletionsLabel: deletions.toLocaleString(),
        };
      }
      if (blocked.has(runKey)) continue;
      const hidden = group.filter((row) => row !== terminal);
      const first = hidden[0];
      if (!first) continue;
      const source = meta.get(first.id)?.row;
      const run = source && this.local(source) ? this.runs.get(text(source.item.runId)) : undefined;
      const last = meta.get(group.at(-1)!.id)?.row.item;
      const from =
        text(run?.startedAt) ||
        starts.get(runKey) ||
        text(source?.item.startedAt) ||
        text(source?.item.updatedAt);
      const end = text(run?.completedAt) || text(last?.updatedAt);
      const elapsed = Date.parse(end) - Date.parse(from);
      const duration = Number.isFinite(elapsed) ? formatDuration(Math.max(0, elapsed)) : "";
      const stopped = run?.status === "cancelled" || run?.status === "interrupted";
      const title = stopped
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked";
      const id = `run-fold:${runKey}`;
      for (const row of hidden) row.foldId = id;
      folds.set(first.id, {
        id,
        foldId: "",
        changes: terminal?.changes ?? null,
        message: null,
        activity: {
          id,
          category: "run-fold",
          status: "completed",
          title,
          displayTitle: title,
          live: false,
          symbol: "clock",
          revision: "",
          exitLabel: "",
          groupCount: hidden.length,
          grouped: [],
          groupedIds: [],
        },
      });
      if (terminal) terminal.changes = null;
    }
    return grouped.flatMap((row) => {
      const fold = folds.get(row.id);
      return fold ? [fold, row] : [row];
    });
  }
}
