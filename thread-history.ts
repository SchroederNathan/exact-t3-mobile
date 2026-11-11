import { markdownBlocks } from "./markdown";
import { toolSummary, type ToolSummary } from "./tool-activity";
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
    ? value as HistoryRecord : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const records = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
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
    return sourceItemId ? [{
      position: sequence(row.position) ?? 0,
      visibility: text(row.visibility), sourceThreadId, sourceItemId, item,
    }] : [];
  });
}

function displayMessage(id: string, role: string, body: string, createdAt: string, pending: boolean) {
  const date = new Date(createdAt);
  return {
    id, role, body, createdAt, pending,
    timeLabel: Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    blocks: markdownBlocks(body, id, role === "user", pending),
  };
}

type DisplayMessage = ReturnType<typeof displayMessage>;
export type FeedRow =
  | { id: string; message: DisplayMessage; activity: null }
  | { id: string; message: null; activity: ToolSummary };

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
  private runs = new Map<string, HistoryRecord>();
  private attempts = new Map<string, HistoryRecord>();
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
    return { ready: this.ready, synchronized: this.synchronized, hasMore: this.hasMore,
      loading: this.loading, error: this.error };
  }

  visibleRows(): readonly TimelineRow[] { return this.rows; }

  controls(environmentId: string) {
    this.controlProjection ??= projectControls(environmentId, this.threadId, [...this.requests.values()], [...this.items.values()].filter((item) => !item.threadId || item.threadId === this.threadId).sort((a, b) => ordinal(a) - ordinal(b)), [...this.runs.values()]);
    return { ...this.controlProjection, stop: { ...this.controlProjection.stop }, requests: this.controlProjection.requests.map((request) => ({ ...request })), ready: this.synchronized && !this.deleted };
  }

  private invalidateControls() {
    this.controlProjection = undefined;
    this.interruptTokens = undefined;
  }

  interruptResult(runId: string) {
    this.interruptTokens ??= new Map([...this.items.values()].filter((item) => item.type === "run_interrupt_result").map((item) => [text(item.runId), JSON.stringify([item.id, item.updatedAt])]));
    return this.interruptTokens.get(runId) ?? "";
  }

  row(id: string): TimelineRow | undefined {
    this.rowIndex ??= new Map(this.rows.map((row) => [key(row), row]));
    return this.rowIndex.get(id);
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
    this.runs.clear();
    this.attempts.clear();
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
      if (this.local(row) && !this.items.has(row.sourceItemId)) this.items.set(row.sourceItemId, row.item);
    }
    this.rawMessages = entities(projection.messages);
    this.runs = entities(projection.runs);
    this.attempts = entities(projection.attempts);
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
    if (nextSequence !== null && this.sequence !== null && nextSequence <= this.sequence) return false;
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
        if (!this.timeline) this.invalidate();
        break;
      case "turn-item.updated":
        if (["approval_request", "user_input_request", "run_interrupt_request", "run_interrupt_result"].includes(text(payload.type))) this.invalidateControls();
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
        this.filterVisible();
        break;
      case "run-attempt.created":
      case "run-attempt.updated":
        if (id) this.attempts.set(id, payload);
        this.filterVisible();
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
    if (status === "cancelled" && item.type === "user_message" && item.inputIntent === "queued_turn") return false;
    if (item.type !== "run_interrupt_result" || !runId || !item.nodeId) return true;
    const superseded = [...this.attempts.values()].some((attempt) =>
      attempt.runId === runId && attempt.rootNodeId === item.nodeId && attempt.status === "superseded");
    return !superseded || [...this.items.values()].some((candidate) =>
      candidate.type === "run_interrupt_request" && candidate.runId === runId);
  }

  private filterVisible() {
    const filtered = this.rows.filter((row) => !this.local(row) || this.visible(row.item));
    if (filtered.length !== this.rows.length) {
      this.rows = filtered.map((row, position) => row.position === position ? row : { ...row, position });
      this.invalidate();
    }
  }

  private outsideWindow(item: HistoryRecord) {
    if (!this.hasMore && this.cursor === null) return false;
    if (this.rows.some((row) => this.local(row) && row.sourceItemId === item.id)) return false;
    const runId = text(item.runId);
    if (runId && unfinished.has(text(this.runs.get(runId)?.status))) return false;
    if (runId && this.rows.some((row) => this.local(row) && row.item.runId === runId && ordinal(row.item) <= ordinal(item))) return false;
    if (this.latestLocalOrdinal !== null && ordinal(item) <= this.latestLocalOrdinal) return true;
    const oldest = this.rows.reduce((value, row) => this.local(row) ? Math.min(value, ordinal(row.item)) : value, Infinity);
    return ordinal(item) < oldest && oldest !== Infinity;
  }

  private updateItem(incoming: HistoryRecord) {
    const id = text(incoming.id);
    const previous = this.items.get(id);
    if (!previous && this.outsideWindow(incoming)) {
      if (["approval_request", "user_input_request", "run_interrupt_request", "run_interrupt_result"].includes(text(incoming.type))) this.items.set(id, incoming);
      this.latestLocalOrdinal = Math.max(this.latestLocalOrdinal ?? 0, ordinal(incoming));
      return;
    }
    const item = previous?.deferredWork === undefined ? incoming : { ...incoming, deferredWork: previous.deferredWork };
    this.items.set(id, item);
    if (item.type === "run_interrupt_request" || previous?.type === "run_interrupt_request") this.filterVisible();
    const index = this.rows.findIndex((row) => this.local(row) && row.sourceItemId === id);
    if (!this.visible(item)) {
      if (index >= 0) this.rows.splice(index, 1);
    } else if (index >= 0 && ordinal(this.rows[index]!.item) === ordinal(item)) {
      this.rows[index] = { ...this.rows[index]!, item };
    } else if (index >= 0 || !this.outsideWindow(item)) {
      if (index >= 0) this.rows.splice(index, 1);
      const insertion = this.rows.findIndex((row) => this.local(row) &&
        (ordinal(row.item) > ordinal(item) || (ordinal(row.item) === ordinal(item) && row.sourceItemId.localeCompare(id) > 0)));
      this.rows.splice(insertion < 0 ? this.rows.length : insertion, 0, {
        position: 0, visibility: "local", sourceThreadId: this.threadId, sourceItemId: id, item,
      });
    }
    this.latestLocalOrdinal = Math.max(this.latestLocalOrdinal ?? 0, ordinal(item));
    this.rows = this.rows.map((row, position) => row.position === position ? row : { ...row, position });
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
        const retainedRequest = current && ["run_interrupt_request", "approval_request", "user_input_request"].includes(text(current.type));
        if (!this.visible(current ?? row.item) || (!existing.has(rowKey) && current && !retainedRequest)) continue;
        if (current && !existing.has(rowKey)) row = { ...row, item: current };
        if (!current) this.items.set(row.sourceItemId, row.item);
      }
      seen.add(rowKey);
      older.push(row);
    }
    this.rows = [...older, ...this.rows.filter((row) => !seen.has(key(row)))].map((row, position) => ({ ...row, position }));
    this.cursor = text(page.nextCursor) || null;
    this.hasMore = page.hasMoreHistory === true;
    this.error = "";
    this.invalidate();
  }

  feed(): FeedRow[] {
    if (this.rendered) return this.rendered;
    const rows: FeedRow[] = [];
    const messages = new Map<string, DisplayMessage>();
    const append = (id: string, role: string, body: string, createdAt: string, pending: boolean) => {
      if (!id || !["user", "assistant", "system"].includes(role)) return;
      const cached = this.messageCache.get(id);
      const message = cached?.body === body && cached.role === role && cached.createdAt === createdAt && cached.pending === pending
        ? cached : displayMessage(id, role, body, createdAt, pending);
      messages.set(id, message);
      rows.push({ id, message, activity: null });
    };
    if (this.timeline) {
      for (const row of this.rows) {
        const item = row.item;
        if (item.type === "error") {
          append(key(row), "system", [text(item.title), text(record(item.failure).message)].filter(Boolean).join("\n\n"), text(item.updatedAt), false);
          continue;
        }
        if (item.type !== "user_message" && item.type !== "assistant_message") {
          let activity = this.activityCache.get(item);
          if (activity === undefined) {
            activity = toolSummary(item);
            this.activityCache.set(item, activity);
          }
          if (activity) rows.push({ id: key(row), message: null, activity });
          continue;
        }
        if (item.type === "user_message" && item.inputIntent === "queued_turn" && item.status === "pending") continue;
        append(key(row), item.type === "user_message" ? "user" : "assistant", text(item.text), text(item.startedAt) || text(item.updatedAt), item.streaming === true);
      }
    } else {
      for (const item of this.rawMessages.values()) append(text(item.id), text(item.role), text(item.text), text(item.createdAt), item.streaming === true);
    }
    if (messages.size !== this.messageCache.size || [...messages].some(([id, message]) => this.messageCache.get(id) !== message)) this.markdownRevision++;
    this.messageCache = messages;
    return this.rendered = rows;
  }
}
