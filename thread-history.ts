import { markdownBlocks } from "./markdown";

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

function displayMessage(id: string, role: string, body: string, createdAt: string) {
  const date = new Date(createdAt);
  return {
    id, role, body, createdAt,
    timeLabel: Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    blocks: markdownBlocks(body, id),
  };
}

type DisplayMessage = ReturnType<typeof displayMessage>;

export class ThreadHistory {
  sequence: number | null = null;
  generation = 0;
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
  private latestLocalOrdinal: number | null = null;
  private rendered: DisplayMessage[] | undefined;
  private messageCache = new Map<string, DisplayMessage>();

  constructor(readonly threadId: string) {}

  summary(): HistorySummary {
    return { ready: this.ready, synchronized: this.synchronized, hasMore: this.hasMore,
      loading: this.loading, error: this.error };
  }

  visibleRows(): readonly TimelineRow[] { return this.rows; }

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
    this.messageCache.clear();
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
    this.cursor = text(snapshot.historyCursor) || null;
    this.hasMore = snapshot.hasMoreHistory === true;
    this.latestLocalOrdinal = sequence(snapshot.latestLocalTurnOrdinal);
    this.loading = false;
    this.error = "";
    this.rendered = undefined;
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
        if (!this.timeline) this.rendered = undefined;
        break;
      case "turn-item.updated":
        if (id && this.timeline) this.updateItem(payload);
        break;
      case "run.created":
      case "run.updated":
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
      this.rendered = undefined;
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
    this.rendered = undefined;
  }

  mergePage(page: HistoryRecord) {
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
    this.rendered = undefined;
  }

  messages(): DisplayMessage[] {
    if (this.rendered) return this.rendered;
    const messages: DisplayMessage[] = [];
    const append = (id: string, role: string, body: string, createdAt: string) => {
      if (!id || !["user", "assistant", "system"].includes(role)) return;
      const cached = this.messageCache.get(id);
      const message = cached?.body === body && cached.role === role && cached.createdAt === createdAt
        ? cached : displayMessage(id, role, body, createdAt);
      messages.push(message);
    };
    if (this.timeline) {
      for (const row of this.rows) {
        const item = row.item;
        if (item.type !== "user_message" && item.type !== "assistant_message") continue;
        if (item.type === "user_message" && item.inputIntent === "queued_turn" && item.status === "pending") continue;
        append(key(row), item.type === "user_message" ? "user" : "assistant", text(item.text), text(item.startedAt) || text(item.updatedAt));
      }
    } else {
      for (const item of this.rawMessages.values()) append(text(item.id), text(item.role), text(item.text), text(item.createdAt));
    }
    this.messageCache = new Map(messages.map((message) => [message.id, message]));
    return this.rendered = messages;
  }
}
