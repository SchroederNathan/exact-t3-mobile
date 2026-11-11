import { AttachmentSession, RpcFailure } from "./attachment-session";
import { FILE_LIMIT, validateAttachments, type StoredAttachment } from "./attachments";
import type { Result, StreamSocket } from "./app.contract.d.ts";
import { visitMetadata } from "./visit-metadata";
import { ThreadHistory, type HistorySummary, type TimelineRow } from "./thread-history";
import { answersFor, controlAccess, controlKey, emptyControls, type QuestionDraft } from "./thread-controls";
import { summarized, toolBody, toolNeedsDetail, toolRevision, toolSummary, type ToolBatch, type ToolPanel, type ToolRequest } from "./tool-activity";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText, type TerminalOutputState } from "./terminal-output";
import {
  decodeSelection,
  projectThreadSettings,
  stageThreadSettings,
  validateThreadSettings,
  type ModelSelection,
  type SettingsChange,
  type SettingsResult,
  type ThreadSettingsSelection,
} from "./thread-settings";

export type Catalog = Omit<Result<"loadCatalog">, "modelDraftRevision">;
export type Environment = Catalog["environments"][number];
type Thread = Catalog["threads"][number];
type Reply = Result<"command">;
type ObjectValue = Record<string, unknown>;
let sessionSerial = 0;
interface ExpandedTool {
  threadId: string;
  viewKey: string;
  request: ToolRequest;
  source: ObjectValue;
  panel: ToolPanel;
  requestId: string;
  stream: boolean;
  terminal: TerminalOutputState;
  first: Promise<void>;
  resolve: () => void;
}
export interface Inspection {
  ok: boolean;
  error: string;
  title: string;
  body: string;
  items: { id: string; label: string; detail: string; kind: string }[];
}

export function object(value: unknown): ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

function records(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function addressParts(address: string): { origin: string; credential: string } {
  let input = address.trim();
  if (!input) throw new Error("Enter your server address or pairing URL.");
  if (!input.includes("://")) {
    const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?::|\/|$)/i.test(input);
    input = `${local ? "http" : "https"}://${input}`;
  }
  let url = new URL(input);
  const nested = url.searchParams.get("pairingUrl");
  if (nested && url.protocol.startsWith("t3code")) return addressParts(nested);
  const credential =
    new URLSearchParams(url.hash.slice(1)).get("token") || url.searchParams.get("token") || "";
  const host = url.searchParams.get("host");
  if (host) url = new URL(host);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Use an HTTP or HTTPS server address.");
  if (url.username || url.password)
    throw new Error("Use a pairing code instead of credentials in the address.");
  return { origin: url.origin, credential };
}

export function parsePairingAddress(
  address: string,
  code: string,
): { origin: string; credential: string } {
  const parsed = addressParts(address);
  const credential = code.trim() || parsed.credential;
  if (!credential) throw new Error("Enter the pairing code from T3 Code on your computer.");
  return { origin: parsed.origin, credential };
}

export function normalizeEnvironmentUrl(address: string): string {
  return addressParts(address).origin;
}

function machineSymbol(config: ObjectValue): string {
  const kind =
    string(object(config.settings).environmentIcon) ||
    string(object(object(config.environment).platform).machine);
  switch (kind) {
    case "cloud":
      return "cloud";
    case "linux":
      return "terminal";
    case "desktop":
      return "desktopcomputer";
    case "laptop":
      return "laptopcomputer";
    case "mac-mini":
      return "macmini";
    case "mac-studio":
      return "macstudio";
    default:
      return "server.rack";
  }
}

export function scopedThreadId(environmentId: string, threadId: string): string {
  return `${encodeURIComponent(environmentId)}:${encodeURIComponent(threadId)}`;
}

export function threadIdentity(id: string): { environmentId: string; threadId: string } {
  const separator = id.indexOf(":");
  if (separator < 1) throw new Error("This thread is not associated with a connected environment.");
  return {
    environmentId: decodeURIComponent(id.slice(0, separator)),
    threadId: decodeURIComponent(id.slice(separator + 1)),
  };
}

export function threadIdFromUrl(url: string): string {
  const path = new URL(url, "https://t3.invalid").pathname;
  const match = /^\/threads\/([^/]+)$/.exec(path);
  if (!match) throw new Error("This address is not associated with a thread.");
  const id = decodeURIComponent(match[1]!);
  threadIdentity(id);
  return id;
}

export async function readJson(url: string, options: RequestInit = {}): Promise<ObjectValue> {
  const response = await fetch(url, { ...options, exactTimeout: 10000 });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`The server returned HTTP ${response.status} instead of a T3 Code response.`);
  }
  if (!response.ok)
    throw new Error(string(object(body).message) || `The server returned HTTP ${response.status}.`);
  return object(body);
}

export async function pair(
  address: string,
  code: string,
): Promise<{ environment: Environment; token: string }> {
  const { origin, credential } = parsePairingAddress(address, code);
  const descriptor = await readJson(`${origin}/.well-known/t3/environment`);
  const id = string(descriptor.environmentId);
  if (!id) throw new Error("This address did not return a T3 Code environment.");
  if (descriptor.orchestrationProtocolVersion !== 2)
    throw new Error(
      "This server uses an unsupported T3 Code protocol. Update the client and server before pairing.",
    );
  const access = await readJson(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "T3 Code Exact iOS",
      client_device_type: "mobile",
      client_os: "iOS",
    }).toString(),
  });
  const token = string(access.access_token);
  if (!token) throw new Error("The server did not return an access token.");
  return {
    environment: {
      id,
      label: string(descriptor.label) || "T3 Code",
      url: origin,
      enabled: true,
      status: "Connecting",
      machineSymbol: machineSymbol({ environment: descriptor }),
    },
    token,
  };
}

export async function socketUrl(environment: Environment, token: string): Promise<string> {
  const ticket = await readJson(`${environment.url}/api/auth/websocket-ticket/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const value = string(ticket.ticket);
  if (!value) throw new Error("The server did not return a connection ticket.");
  const url = new URL("/ws", environment.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", value);
  url.searchParams.set("orchestrationProtocol", "2");
  return url.toString();
}

function errorDetails(thread: ObjectValue): { message: string; time: string } {
  const message = string(thread.lastError) || string(object(thread.runtime).lastError);
  const createdAt =
    string(thread.latestRunCompletedAt) ||
    string(thread.latestRunStartedAt) ||
    string(thread.updatedAt);
  const date = new Date(createdAt);
  const time = Number.isNaN(date.getTime())
    ? ""
    : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return { message, time };
}

function listedThread(thread: ObjectValue): boolean {
  const lineage = object(thread.lineage);
  return !thread.deletedAt && !thread.archivedAt && lineage.relationshipToParent !== "subagent" && lineage.sideChat !== true;
}

function status(thread: ObjectValue): string {
  const request = string(object(thread.pendingRuntimeRequest).kind);
  if (request === "user_input") return "Input";
  if (request && request !== "auth_refresh") return "Approval";
  if (Number(thread.pendingGuestMessageCount) > 0) return "Request";
  const waiting = records(thread.pendingBackgroundTasks).some((task) =>
    task.awaited === true || task.kind === "subagent" || task.kind === "background_task");
  if (thread.status !== "failed" && waiting) return "Waiting";
  const state = string(thread.activityRunStatus) || string(thread.status);
  if (state === "running" && thread.blockedOnThreadWait === true) return "Waiting";
  if (["preparing", "starting", "running", "waiting", "queued"].includes(state))
    return object(thread.goal).status === "active" ? "Goal" : "Working";
  if (state === "failed") return thread.lastErrorClass === "usage_limit" ? "Limited" : "Failed";
  if (state === "idle" && (thread.latestRunId || thread.activeProviderThreadId)) return "Waiting";
  const completed = thread.latestRunId
    ? timestamp(thread.latestRunCompletedAt === undefined ? thread.updatedAt : thread.latestRunCompletedAt)
    : 0;
  return completed > 0 && Boolean(thread.lastVisitedAt) &&
    (Number.isNaN(Date.parse(string(thread.lastVisitedAt))) || completed > timestamp(thread.lastVisitedAt))
    ? "Done" : "";
}

function failure(exit: ObjectValue): string {
  for (const cause of records(exit.cause)) {
    const detail = object(cause.error ?? cause.defect);
    if (string(detail.message)) return string(detail.message);
  }
  return "The server could not complete this request.";
}

const iconColors = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];
const iconHex = [
  "#6a7282",
  "#fb2c36",
  "#ff6900",
  "#fe9a00",
  "#efb100",
  "#9ae600",
  "#00c950",
  "#00bc7d",
  "#00bba7",
  "#00b8db",
  "#00a6f4",
  "#2b7fff",
  "#615fff",
  "#8e51ff",
  "#ad46ff",
  "#e12afb",
  "#f6339a",
  "#ff2056",
];

function projectIcon(project: ObjectValue) {
  const title = string(project.title).normalize("NFKC").trim();
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  const glyphs = Array.from(words[0] ?? "");
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  const initials = words.length
    ? Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("")
    : "PR";
  let colorIndex = 0;
  for (const glyph of title.toLocaleLowerCase("en-US") || "project")
    colorIndex = (colorIndex * 31 + (glyph.codePointAt(0) ?? 0)) % iconColors.length;
  const override = object(project.projectIcon);
  return {
    projectIcon:
      override.kind === "emoji"
        ? string(override.emoji)
        : override.kind === "lucide" && override.name === "message-square-dashed"
          ? "symbol:text.bubble"
          : "",
    projectInitials: override.kind === "monogram" ? string(override.text) : initials,
    projectIconColor:
      iconHex[iconColors.indexOf(string(override.color))] || iconHex[colorIndex] || "#2b7fff",
  };
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function activity(thread: ObjectValue, settled: boolean): number {
  if (settled && timestamp(thread.settledAt)) return timestamp(thread.settledAt);
  return (
    Math.max(
      ...[
        thread.latestUserMessageAt,
        thread.latestRunRequestedAt,
        thread.latestRunStartedAt,
        thread.latestRunCompletedAt,
      ].map(timestamp),
    ) || timestamp(thread.updatedAt)
  );
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (!at || seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function switchingThread(value: ObjectValue) {
  return {
    id: string(value.id),
    activeProviderThreadId: string(value.activeProviderThreadId),
    instanceId: string(object(value.modelSelection).instanceId),
    historyOrigin: string(value.historyOrigin),
  };
}

function switchingRun(value: ObjectValue) {
  return { id: string(value.id), status: string(value.status), providerThreadId: string(value.providerThreadId) };
}

function switchingProviderThread(value: ObjectValue) {
  return {
    id: string(value.id), appThreadId: string(value.appThreadId),
    instanceId: string(value.providerInstanceId), sessionId: string(value.providerSessionId),
    hasNativeThread: value.nativeThreadRef != null,
  };
}

function switchingSession(value: ObjectValue) {
  return {
    id: string(value.id), status: string(value.status),
    canHandoff: object(object(value.capabilities).sessions).supportsProviderSwitchingViaHandoff === true,
  };
}

function switchingProjection(value: ObjectValue) {
  return {
    thread: switchingThread(object(value.thread)),
    runs: records(value.runs).map(switchingRun),
    providerThreads: records(value.providerThreads).map(switchingProviderThread),
    providerSessions: records(value.providerSessions).map(switchingSession),
  };
}

function supportsProviderHandoff(projection: ReturnType<typeof switchingProjection>): boolean {
  const activeRun = projection.runs.findLast((run) => ["preparing", "starting", "running", "waiting"].includes(run.status));
  const providerThreadId = activeRun?.providerThreadId || projection.thread.activeProviderThreadId;
  const attached = projection.providerThreads.find((thread) => thread.id === providerThreadId)
    ?? projection.providerThreads.find((thread) => thread.appThreadId === projection.thread.id && thread.sessionId);
  const session = attached?.sessionId
    ? projection.providerSessions.find((session) => session.id === attached.sessionId)
    : projection.providerSessions.findLast((session) => session.status !== "stopped" && session.status !== "error");
  if (session) return session.canHandoff;
  if (activeRun) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;
  return projection.providerThreads.some((thread) => thread.id === projection.thread.activeProviderThreadId
    && thread.appThreadId === projection.thread.id && thread.instanceId === projection.thread.instanceId && thread.hasNativeThread);
}

function upsertSwitchingRecord<T extends { id: string }>(rows: T[], value: T): T[] {
  const index = rows.findIndex((row) => row.id === value.id);
  return index < 0 ? [...rows, value] : rows.map((row, at) => at === index ? value : row);
}

export class DirectSession {
  readonly environment: Environment;
  private readonly serial = ++sessionSerial;
  private controlEpoch = 0;
  private controlGrant = false;
  private controlOperations = new Map<string, { pending: boolean; error: string; threadId: string; runId: string; result: string }>();
  private tools = new Map<string, ExpandedTool>();
  private socket: StreamSocket | undefined;
  private nextId = 0;
  private shellRequest = "";
  private configRequest = "";
  private threadRequest = "";
  private selected = "";
  private projects = new Map<string, ObjectValue>();
  private config: ObjectValue = {};
  private configReady = false;
  private faviconRequests = new Map<string, string>();
  private favicons = new Map<string, { revision: string; url: string }>();
  private shells = new Map<string, ObjectValue>();
  private shellLive = false;
  private transcripts = new Map<string, ThreadHistory>();
  private switchingSnapshots = new Map<string, ReturnType<typeof switchingProjection>>();
  private switching: ReturnType<typeof switchingProjection> | undefined;
  private replies = new Map<string, (reply: Reply) => void>();
  private queries = new Map<
    string,
    { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }
  >();

  readonly attachments = new AttachmentSession({
    metadata: () => {
      const capabilities = object(object(this.config.environment).capabilities);
      const files = object(capabilities.fileAttachments);
      return { accessKey: this.controlAccessKey(), origin: this.environment.url, allowed: this.hasControlAccess(),
        uploads: capabilities.attachmentUploads === true, maxFileBytes: typeof files.maxUploadBytes === "number" ? Math.min(FILE_LIMIT, files.maxUploadBytes) : 0 };
    },
    query: (tag, payload) => {
      if (this.queries.size >= 32) throw new Error("Too many requests are pending. Wait for them to finish.");
      const id = this.request(tag, payload);
      const promise = new Promise<ObjectValue>((resolve, reject) => this.queries.set(id, { resolve, reject }));
      return { id, promise };
    },
    cancel: (id) => {
      if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
      this.queries.get(id)?.reject(new Error("This attachment request was cancelled."));
      this.queries.delete(id);
    },
    resolve: (threadId, viewKey, demand) => {
      if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return;
      return this.transcripts.get(threadId)?.feed().find((row) => row.message?.id === demand.messageId)?.message?.attachments.find((item) => item.id === demand.attachmentId);
    },
  });

  constructor(environment: Environment) {
    this.environment = {
      ...environment,
      machineSymbol: environment.machineSymbol || "server.rack",
      status: "Connecting",
    };
  }

  private request(tag: string, payload: unknown): string {
    if (!this.socket || this.socket.readyState !== 1)
      throw new Error("This environment is disconnected. Reconnect before sending.");
    const id = String(++this.nextId);
    this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return id;
  }

  private query(tag: string, payload: unknown): Promise<ObjectValue> {
    if (this.queries.size >= 32)
      throw new Error("Too many requests are pending. Wait for them to finish.");
    const id = this.request(tag, payload);
    return new Promise((resolve, reject) => this.queries.set(id, { resolve, reject }));
  }

  threadRefs() {
    return [...this.shells].filter(([, thread]) => !thread.deletedAt).map(([threadId]) => ({ environmentId: this.environment.id, threadId }));
  }

  async fileLinkPath(threadId: string, path: string): Promise<string> {
    const shell = this.shells.get(threadId);
    if (!shell) throw new Error("This thread is no longer available.");
    const cwd = string(shell.worktreePath) || string(this.projects.get(string(shell.projectId))?.workspaceRoot);
    if (!cwd) throw new Error("This thread has no available workspace.");
    if (path.startsWith("~/")) {
      const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd)?.[1];
      if (home) return `${home}/${path.slice(2)}`;
    }
    if (/[\\/]/.test(path)) return path;
    const result = await this.query("projects.searchEntries", { cwd, query: path, limit: 100, kind: "file" });
    const matches = records(result.entries).map((entry) => string(entry.path)).filter((entry) => entry.split("/").at(-1) === path);
    if (matches.includes(path)) return path;
    if (matches.length === 1 && result.truncated !== true) return matches[0]!;
    if (matches.length > 1 || result.truncated === true) throw new Error("This file name is ambiguous. Open a link with its full path.");
    return path;
  }

  async inspect(threadId: string, kind: string, path: string): Promise<Inspection> {
    const shell = this.shells.get(threadId);
    if (!shell) throw new Error("This thread is no longer available.");
    const project = this.projects.get(string(shell.projectId));
    const cwd = string(shell.worktreePath) || string(project?.workspaceRoot);
    if (!cwd) throw new Error("This thread has no available workspace.");
    if (kind === "file") {
      const result = await this.query("projects.readFile", { cwd, relativePath: path });
      return {
        ok: true,
        error: "",
        title: string(result.relativePath),
        body:
          string(result.contents) +
          (result.truncated === true ? "\n\nFile preview truncated." : ""),
        items: [],
      };
    }
    if (kind === "files") {
      const result = await this.query("projects.listEntries", { cwd, directoryPath: path });
      return {
        ok: true,
        error: "",
        title: "Files",
        body: `${cwd}${path ? `/${path}` : ""}${result.truncated === true ? "\nResults truncated." : ""}`,
        items: records(result.entries).map((entry) => ({
          id: string(entry.path),
          label: string(entry.path).split("/").at(-1) || string(entry.path),
          detail: entry.ignored === true ? "Ignored" : string(entry.path),
          kind: string(entry.kind),
        })),
      };
    }
    if (kind === "git") {
      const result = await this.query("vcs.refreshStatus", { cwd, localOnly: true });
      if (result.isRepo !== true)
        return {
          ok: true,
          error: "",
          title: "Source Control",
          body: `${cwd}\nThis workspace is not a repository.`,
          items: [],
        };
      const workingTree = object(result.workingTree);
      return {
        ok: true,
        error: "",
        title: "Source Control",
        body: `${string(workingTree.rootPath) || cwd}\n${result.hasWorkingTreeChanges === true ? "Uncommitted changes" : "Working tree clean"}`,
        items: [
          {
            id: "branch",
            label: string(result.refName) || "Detached HEAD",
            detail: result.isDefaultRef === true ? "Default branch" : "Current branch",
            kind: "info",
          },
          {
            id: "upstream",
            label: "Upstream",
            detail:
              result.hasUpstream === true
                ? `${Number(result.aheadCount ?? 0)} ahead · ${Number(result.behindCount ?? 0)} behind`
                : "No upstream configured",
            kind: "info",
          },
          ...records(workingTree.files).map((file) => ({
            id: string(file.path),
            label: string(file.path),
            detail: `+${Number(file.insertions ?? 0)} −${Number(file.deletions ?? 0)}`,
            kind: "file",
          })),
        ],
      };
    }
    throw new Error("This inspector is not available.");
  }

  open(socket: StreamSocket) {
    this.controlEpoch++;
    this.controlGrant = false;
    this.clearToolPanels();
    for (const history of this.transcripts.values()) history.disconnect();
    this.shellLive = false;
    this.switching = undefined;
    this.threadRequest = "";
    this.configReady = false;
    this.socket = socket;
    this.environment.status = "Connected";
    this.shellRequest = this.request("orchestration.subscribeShell", {});
    this.configRequest = this.request("subscribeServerConfig", {
      workspaceSnapshotsOnDemand: true,
      providerCatalogsOnDemand: true,
    });
  }

  select(threadId: string) {
    if (threadId === this.selected && this.threadRequest) return;
    if (threadId !== this.selected) this.clearToolPanels();
    this.switching = undefined;
    this.selected = threadId;
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.threadRequest)
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: this.threadRequest }));
    this.threadRequest = "";
    this.subscribeSelected();
  }

  private subscribeSelected() {
    if (!this.selected || this.threadRequest || !this.configReady || this.socket?.readyState !== 1) return;
    let history = this.transcripts.get(this.selected);
    if (!history) {
      history = new ThreadHistory(this.selected);
      this.transcripts.set(this.selected, history);
    }
    if (history.deleted) return;
    const completion = this.config.threadResumeCompletionMarker === true;
    history.subscribing(completion);
    this.threadRequest = this.request("orchestration.subscribeThread", {
      threadId: this.selected,
      ...(completion && history.ready && history.sequence !== null ? { afterSequence: history.sequence } : {}),
      ...(completion ? { requestCompletionMarker: true } : {}),
      ...(this.config.threadSnapshotPagination === true ? { acceptBoundedSnapshot: true } : {}),
    });
  }

  history(threadId: string): HistorySummary {
    return this.transcripts.get(threadId)?.summary() ?? {
      ready: false, synchronized: false, hasMore: false, loading: false, error: "",
    };
  }

  controlAccessKey() {
    return this.socket?.readyState === 1 ? JSON.stringify([this.environment.id, this.serial, this.controlEpoch]) : "";
  }

  installControlAccess(key: string, session: unknown): boolean {
    if (!key || key !== this.controlAccessKey()) return false;
    return this.controlGrant = controlAccess(session);
  }

  hasControlAccess() { return this.controlGrant && this.controlAccessKey() !== ""; }

  controls(threadId: string) {
    const controls = this.transcripts.get(threadId)?.controls(this.environment.id) ?? emptyControls();
    controls.accessKey = this.controlAccessKey();
    for (const key of controls.resolvedKeys) this.controlOperations.delete(key);
    for (const [key, operation] of this.controlOperations) {
      if (operation.threadId === threadId && !operation.runId && controls.ready && !controls.pendingKeys.includes(key)) this.controlOperations.delete(key);
      if (operation.threadId === threadId && operation.runId &&
        (operation.runId !== controls.stop.runId || this.transcripts.get(threadId)?.interruptResult(operation.runId) !== operation.result)) this.controlOperations.delete(key);
    }
    for (const request of controls.requests) {
      const operation = this.controlOperations.get(request.key);
      if (operation) { request.pending = operation.pending; request.error = operation.error; }
    }
    const stopping = this.controlOperations.get(controlKey(this.environment.id, threadId, `stop:${controls.stop.runId}`));
    if (stopping) {
      controls.stop.error = stopping.error;
      if (stopping.pending && controls.stop.state === "available") controls.stop.state = "stopping";
    }
    return controls;
  }

  async control(threadId: string, accessKey: string, kind: string, targetId: string, decision: string, drafts: QuestionDraft[], commandId: string): Promise<Reply> {
    if (!this.hasControlAccess() || accessKey !== this.controlAccessKey()) throw new Error("Reconnect and check your permission before responding.");
    const controls = this.controls(threadId);
    if (threadId !== this.selected || !controls.ready) throw new Error("Wait for this thread to finish reconnecting.");
    let payload: ObjectValue;
    let key = controlKey(this.environment.id, threadId, targetId);
    if (kind === "stop") {
      if (controls.stop.runId !== targetId || !targetId) throw new Error("This turn is no longer running.");
      if (controls.stop.state !== "available") throw new Error("This turn is already stopping.");
      key = controlKey(this.environment.id, threadId, `stop:${targetId}`);
      payload = { type: "run.interrupt", commandId, threadId, runId: targetId, holdQueue: true };
    } else {
      const request = controls.requests.find((request) => request.id === targetId);
      if (!request) throw new Error("This request is no longer pending.");
      if (request.pending) throw new Error("A response is already being sent.");
      if (request.unavailable && !(kind === "dismiss" && request.dismissible)) throw new Error(request.unavailable);
      if (kind === "approve" && request.kind === "approval") {
        if (!request.options.some((option) => option.decision === decision)) throw new Error("This approval option is no longer available.");
        payload = { type: "runtime-request.respond", commandId, threadId, requestId: targetId, decision };
      } else if (kind === "answer" && request.kind === "question") {
        const answers = answersFor(request.questions, drafts, key);
        if (!answers) throw new Error("Answer every question before submitting.");
        payload = { type: "runtime-request.respond", commandId, threadId, requestId: targetId, answers };
      } else if (kind === "dismiss" && request.dismissible) {
        payload = { type: "thread.user-input.dismiss", commandId, threadId, requestId: targetId };
      } else throw new Error("This response is not available.");
    }
    const operation = { pending: true, error: "", threadId, runId: kind === "stop" ? targetId : "", result: this.transcripts.get(threadId)?.interruptResult(targetId) ?? "" };
    const id = this.request("orchestration.dispatchCommand", payload);
    this.controlOperations.set(key, operation);
    const reply = await new Promise<Reply>((resolve) => this.replies.set(id, resolve));
    if (!reply.ok) {
      operation.pending = false;
      operation.error = reply.error;
      if (/permission|forbidden|unauthorized|scope|not authorized/i.test(reply.error)) {
        this.controlGrant = false;
        this.controlEpoch++;
      }
    }
    return reply;
  }

  timeline(threadId: string): readonly TimelineRow[] {
    return this.transcripts.get(threadId)?.visibleRows() ?? [];
  }

  private toolViewKey(threadId: string): string {
    return JSON.stringify([this.environment.id, this.serial, threadId, this.transcripts.get(threadId)?.generation ?? -1]);
  }

  markdownBlocks(threadId: string, viewKey: string, refs: { messageId: string; blockId: string }[], kind: "code" | "table") {
    if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return [];
    const history = this.transcripts.get(threadId);
    if (!history || history.deleted) return [];
    return refs.slice(-64).flatMap((ref) => {
      const block = history.block(ref.messageId, ref.blockId);
      return block?.kind === kind ? [block] : [];
    });
  }

  private currentTool(entry: ExpandedTool): TimelineRow | undefined {
    if (entry.threadId !== this.selected || entry.viewKey !== this.toolViewKey(entry.threadId)) return;
    const history = this.transcripts.get(entry.threadId);
    const row = history?.row(entry.request.rowId);
    return !history?.deleted && row && toolSummary(row.item) && toolRevision(row.item) === entry.request.revision ? row : undefined;
  }

  private removeTool(entry: ExpandedTool) {
    this.tools.delete(entry.request.rowId);
    if (entry.requestId && this.socket?.readyState === 1)
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: entry.requestId }));
    entry.resolve();
  }

  clearToolPanels() {
    for (const entry of this.tools.values()) this.removeTool(entry);
  }

  private pruneTools() {
    for (const entry of this.tools.values()) {
      const row = this.currentTool(entry);
      if (!row) { this.removeTool(entry); continue; }
      if (row.item === entry.source) continue;
      const needsDetail = toolNeedsDetail(row.item, entry.stream);
      if (!entry.stream && needsDetail && !toolNeedsDetail(entry.source, false)) {
        this.removeTool(entry);
        continue;
      }
      entry.source = row.item;
      const body = toolBody(row.item);
      if (!entry.stream && !needsDetail) {
        if (entry.requestId && this.socket?.readyState === 1)
          this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: entry.requestId }));
        entry.requestId = "";
        entry.panel = { ...entry.panel, ...body, state: "ready", error: "" };
        entry.resolve();
      } else if (!needsDetail || !summarized(row.item.input)) {
        entry.panel.input = body.input;
      }
    }
  }

  async toolPanels(threadId: string, viewKey: string, wanted: readonly ToolRequest[]): Promise<ToolBatch> {
    if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return { viewKey, panels: [] };
    this.pruneTools();
    for (const entry of this.tools.values()) {
      if (!wanted.some((request) => request.rowId === entry.request.rowId && request.revision === entry.request.revision && request.retry === entry.request.retry))
        this.removeTool(entry);
    }
    const entries: ExpandedTool[] = [];
    for (const request of wanted) {
      const row = this.transcripts.get(threadId)?.row(request.rowId);
      if (!row || !toolSummary(row.item) || toolRevision(row.item) !== request.revision) continue;
      let entry = this.tools.get(request.rowId);
      if (!entry) {
        let resolve = () => {};
        const first = new Promise<void>((done) => { resolve = done; });
        const streaming = row.item.type === "command_execution" && object(object(this.config.environment).capabilities).commandOutputStreaming === true;
        entry = {
          threadId, viewKey, request, source: row.item, requestId: "", stream: streaming, terminal: EMPTY_TERMINAL_OUTPUT, first, resolve,
          panel: { ...request, state: "loading", ...toolBody(row.item), error: "" },
        };
        this.tools.set(request.rowId, entry);
        try {
          if (streaming) {
            entry.panel.output = "";
            entry.requestId = this.request("orchestration.subscribeCommandOutput", { threadId: row.sourceThreadId, itemId: row.sourceItemId });
          } else if (toolNeedsDetail(row.item, false)) {
            entry.requestId = this.request("orchestration.getTurnItem", { threadId: row.sourceThreadId, itemId: row.sourceItemId, revision: request.revision });
          } else {
            entry.panel.state = "ready";
            entry.resolve();
          }
        } catch (error) {
          entry.panel.state = "error";
          entry.panel.error = error instanceof Error ? error.message : "Could not load this activity.";
          entry.resolve();
        }
      }
      entries.push(entry);
    }
    if (entries.length) await Promise.race(entries.map((entry) => entry.first));
    return {
      viewKey,
      panels: entries.filter((entry) => this.tools.get(entry.request.rowId) === entry && this.currentTool(entry)).map((entry) => ({ ...entry.panel })),
    };
  }

  private toolFrame(entry: ExpandedTool, frame: ObjectValue) {
    if (!this.currentTool(entry)) { this.removeTool(entry); return; }
    if (!entry.stream || !["replace", "append"].includes(string(frame.kind)) || typeof frame.text !== "string" ||
      typeof frame.running !== "boolean" || typeof frame.truncated !== "boolean") {
      entry.panel.state = "error";
      entry.panel.error = "The server returned invalid command output.";
      entry.resolve();
      return;
    }
    const before = frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : entry.terminal;
    entry.terminal = appendTerminalOutput(before, frame.text);
    entry.panel = {
      ...entry.panel, state: "ready", output: terminalOutputPlainText(entry.terminal.text),
      truncated: entry.terminal.truncated || frame.truncated || (frame.kind === "append" && entry.panel.truncated), error: "",
    };
    entry.resolve();
  }

  private toolExit(entry: ExpandedTool, exit: ObjectValue, error: string) {
    if (!this.currentTool(entry)) { this.removeTool(entry); return; }
    entry.requestId = "";
    if (error) entry.panel = { ...entry.panel, state: "error", error };
    else if (entry.stream) entry.panel = { ...entry.panel, state: "ready" };
    else {
      const value = object(exit.value);
      const item = object(value.item);
      const current = this.currentTool(entry)!;
      if (value.item === null) entry.panel = { ...entry.panel, state: "missing", error: "This activity is no longer available." };
      else if (item.id !== current.sourceItemId || item.threadId !== current.sourceThreadId || item.type !== current.item.type)
        entry.panel = { ...entry.panel, state: "error", error: "The server returned invalid activity detail." };
      else if (entry.request.revision !== "live" && toolRevision(item) !== entry.request.revision)
        entry.panel = { ...entry.panel, state: "error", error: "This activity changed while its output loaded. Retry to load it again." };
      else entry.panel = { ...entry.panel, ...toolBody(item), state: "ready", error: "" };
    }
    entry.resolve();
  }

  async loadEarlier(threadId: string, read: (relativePath: string) => Promise<unknown>): Promise<Reply> {
    const history = this.transcripts.get(threadId);
    if (!history?.ready || history.deleted || !history.hasMore || !history.cursor || history.loading)
      return { ok: true, error: "" };
    const generation = history.generation;
    const cursor = history.cursor;
    const current = () => this.transcripts.get(threadId) === history && history.generation === generation && history.cursor === cursor;
    history.loading = true;
    history.error = "";
    try {
      const query = new URLSearchParams({ cursor });
      const page = object(await read(`/api/orchestration/threads/${encodeURIComponent(threadId)}/history?${query}`));
      if (!current()) return { ok: true, error: "" };
      if (!Array.isArray(page.items) || typeof page.hasMoreHistory !== "boolean" ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string"))
        throw new Error("The server returned invalid thread history.");
      if (page.hasMoreHistory && (!page.nextCursor || page.nextCursor === cursor))
        throw new Error("History did not advance. Retry loading it.");
      history.mergePage(page);
      history.loading = false;
      return { ok: true, error: "" };
    } catch (error) {
      if (!current()) return { ok: true, error: "" };
      history.error = error instanceof Error ? error.message : "Could not load earlier history.";
      return { ok: false, error: history.error };
    } finally {
      if (current()) history.loading = false;
    }
  }

  settings(threadId: string, staged?: ThreadSettingsSelection | null) {
    const thread = this.shells.get(threadId);
    const view = projectThreadSettings(this.config, thread ?? { id: threadId }, staged, this.settingsPolicy(thread));
    return thread ? view : { ...view, error: "This thread is no longer available." };
  }

  liveSettings(threadId: string): ThreadSettingsSelection | null {
    if (!this.shellLive) return null;
    const thread = this.shells.get(threadId);
    const modelSelection = decodeSelection(thread?.modelSelection);
    return thread && modelSelection
      ? { threadId, modelSelection, runtimeMode: string(thread.runtimeMode) }
      : null;
  }

  stageSettings(
    threadId: string,
    staged: ThreadSettingsSelection | null | undefined,
    change: SettingsChange,
  ): SettingsResult {
    const thread = this.shells.get(threadId);
    return thread
      ? stageThreadSettings(this.config, thread, staged, change, this.settingsPolicy(thread))
      : { ok: false, error: "This thread is no longer available.", selection: null };
  }

  validateSettings(threadId: string, staged?: ThreadSettingsSelection | null): SettingsResult {
    const thread = this.shells.get(threadId);
    return thread
      ? validateThreadSettings(this.config, thread, staged, this.settingsPolicy(thread))
      : { ok: false, error: "This thread is no longer available.", selection: null };
  }

  async setModelFavorite(threadId: string, modelId: string, favorite: boolean): Promise<Reply> {
    if (!this.shells.has(threadId)) return { ok: false, error: "This thread is no longer available." };
    const settings = this.config.settings;
    if (!settings) return { ok: false, error: "Model favorites are still loading." };
    const model = this.settings(threadId).groups.flatMap((group) => group.models)
      .find((model) => model.id === modelId);
    const saved = !favorite ? records(object(settings).favorites)
      .find((entry) => `${string(entry.provider)}:${string(entry.model)}` === modelId) : undefined;
    const target = model ? { provider: model.instanceId, model: model.slug }
      : saved ? { provider: string(saved.provider), model: string(saved.model) } : undefined;
    if (!target?.provider || !target.model)
      return { ok: false, error: "This model is no longer available." };
    try {
      const updated = await this.query("server.updateSettings", {
        patch: {
          setModelFavorites: [{ ...target, favorite }],
          ...(object(settings).favorites === null ? { migrateModelPreferences: { favorites: [] } } : {}),
        },
      });
      if (this.config.settings === settings) this.config.settings = updated;
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The favorite could not be updated." };
    }
  }

  private settingsPolicy(thread: ObjectValue | undefined) {
    const projection = this.switching;
    if (thread && projection && projection.thread.id === thread.id)
      return { canSwitchProvider: supportsProviderHandoff(projection) };
    const backgroundHolds = thread?.status !== "failed" && records(thread?.pendingBackgroundTasks)
      .some((task) => task.awaited === true || task.kind === "subagent" || task.kind === "background_task");
    return {
      canSwitchProvider: !thread || (thread.latestRunId == null && thread.latestUserMessageAt == null
        && thread.activeProviderThreadId == null && !backgroundHolds),
    };
  }

  visit(threadId: string, visitedAt: string, opened: boolean, commandId: string): Promise<Reply> {
    const id = this.request("orchestration.dispatchCommand", {
      type: "thread.visit",
      commandId,
      threadId,
      visitedAt,
      ...(opened ? { opened: true } : {}),
    });
    return new Promise((resolve) => this.replies.set(id, resolve));
  }

  send(
    threadId: string,
    text: string,
    commandId: string,
    messageId: string,
    staged?: ThreadSettingsSelection | null,
    attachments: StoredAttachment[] = [],
    replayUnknown = false,
  ): Promise<{ ok: boolean; error: string; state: string }> {
    const refused = (error: string) => ({ ok: false, error, state: replayUnknown ? "unknown" : "rejected" });
    try { validateAttachments(attachments, this.attachments.metadata().maxFileBytes, true); }
    catch (error) { return Promise.resolve(refused(error instanceof Error ? error.message : "Invalid attachments.")); }
    const dispatch = (modelSelection?: ModelSelection) => {
      const shell = this.shells.get(threadId);
      return this.query("orchestration.dispatchCommand", {
        type: "message.dispatch", commandId, threadId, messageId, text, attachments,
        createdBy: "user", creationSource: "mobile",
        dispatchMode: { type: shell?.activeRunId ? "queue_after_active" : "start_immediately" },
        ...(modelSelection ? { modelSelection } : {}),
      }).then(() => ({ ok: true, error: "", state: "accepted" }), (error: unknown) => ({
        ok: false, error: error instanceof Error ? error.message : "Delivery could not be confirmed.", state: !replayUnknown && error instanceof RpcFailure ? "rejected" : "unknown",
      }));
    };
    if (!staged) return dispatch();
    const validated = this.validateSettings(threadId, staged);
    if (!validated.ok || !validated.selection) return Promise.resolve(refused(validated.error));
    const selection = validated.selection;
    if (selection.runtimeMode === this.shells.get(threadId)?.runtimeMode) return dispatch(selection.modelSelection);
    return this.query("orchestration.dispatchCommand", {
      type: "thread.runtime-mode.set", commandId: `${commandId}:runtime-mode`, threadId, runtimeMode: selection.runtimeMode,
    }).then(() => {
      const latest = this.validateSettings(threadId, selection);
      if (!latest.ok || !latest.selection) return refused(latest.error);
      return dispatch(latest.selection.modelSelection);
    }, (error: unknown) => refused(error instanceof Error ? error.message : "The runtime mode could not be changed."));
  }

  create(projectId: string, title: string, commandId: string, threadId: string): Promise<Reply> {
    const project = this.projects.get(projectId);
    if (!project || project.archivedAt || project.deletedAt)
      throw new Error("Choose an available project.");
    const settings = object(this.config.settings);
    const overrides = object(object(settings.projectSettingsOverrides)[projectId]);
    const providers = records(this.config.providers).filter((provider) => {
      const override = object(object(overrides.providerInstances)[string(provider.instanceId)]);
      return (
        (override.enabled ?? provider.enabled) === true &&
        provider.installed === true &&
        object(provider.auth).status !== "unauthenticated" &&
        provider.availability !== "unavailable"
      );
    });
    const preferred = [project.defaultModelSelection, settings.defaultModelSelection]
      .map(object)
      .find((selection) =>
        providers.some(
          (provider) =>
            provider.instanceId === selection.instanceId &&
            records(provider.models).some(
              (model) => model.slug === selection.model && model.isLegacy !== true,
            ),
        ),
      );
    const models = providers.flatMap((provider) =>
      records(provider.models)
        .filter((model) => model.isLegacy !== true)
        .map((model) => ({
          instanceId: string(provider.instanceId),
          model: string(model.slug),
          isDefault: model.isDefault === true,
        })),
    );
    const fallback = models.find((model) => model.isDefault) ?? models[0];
    const selection =
      preferred ??
      (fallback ? { instanceId: fallback.instanceId, model: fallback.model } : undefined);
    if (!selection)
      throw new Error("Configure an available model in T3 Code before creating a thread.");
    const id = this.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId,
      threadId,
      projectId,
      title: title.trim() || "New thread",
      createdBy: "user",
      creationSource: "mobile",
      modelSelection: selection,
      runtimeMode:
        settings.defaultRuntimeMode === "approval-required" ? "approval-required" : "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return new Promise((resolve) => this.replies.set(id, resolve));
  }

  disconnected(reason: string) {
    this.controlEpoch++;
    this.controlGrant = false;
    this.clearToolPanels();
    this.attachments.clear();
    this.shellLive = false;
    this.shellRequest = "";
    this.switching = undefined;
    this.threadRequest = "";
    this.socket = undefined;
    for (const history of this.transcripts.values()) history.disconnect();
    this.environment.status = reason;
    for (const resolve of this.replies.values()) resolve({ ok: false, error: reason });
    this.replies.clear();
    for (const query of this.queries.values()) query.reject(new Error(reason));
    this.queries.clear();
  }

  receive(data: string) {
    const parsed: unknown = JSON.parse(data);
    for (const frame of records(Array.isArray(parsed) ? parsed : [parsed])) {
      const id = String(frame.requestId ?? "");
      const tool = [...this.tools.values()].find((entry) => entry.requestId !== "" && entry.requestId === id);
      if (frame._tag === "Chunk") {
        for (const item of records(frame.values)) {
          if (tool) this.toolFrame(tool, item);
          if (id === this.shellRequest) this.shell(item);
          if (this.threadRequest && id === this.threadRequest) this.transcript(item);
          if (id === this.configRequest) {
            if (item.type === "snapshot") {
              this.config = object(item.config);
              this.configReady = true;
              this.subscribeSelected();
            }
            if (item.type === "providerStatuses")
              this.config.providers = object(item.payload).providers;
            if (item.type === "settingsUpdated")
              this.config.settings = object(item.payload).settings;
            this.environment.machineSymbol = machineSymbol(this.config);
          }
        }
        this.socket?.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit") {
        if (id === this.shellRequest) this.shellLive = false;
        const threadEnded = id === this.threadRequest;
        if (threadEnded) {
          this.switching = undefined;
          this.threadRequest = "";
        }
        const exit = object(frame.exit);
        const error = exit._tag === "Success" ? "" : failure(exit);
        if (tool) this.toolExit(tool, exit, error);
        if (threadEnded) {
          const history = this.transcripts.get(this.selected);
          history?.disconnect();
          if (history) history.error = error;
        }
        const query = this.queries.get(id);
        this.queries.delete(id);
        if (error) query?.reject(new RpcFailure(error, string(object(records(exit.cause)[0]?.error)._tag)));
        else query?.resolve(object(exit.value));
        const projectId = this.faviconRequests.get(id);
        if (projectId) {
          this.faviconRequests.delete(id);
          const relativeUrl = string(object(exit.value).relativeUrl);
          const favicon = this.favicons.get(projectId);
          if (
            !error &&
            relativeUrl &&
            favicon &&
            !new URL(relativeUrl, this.environment.url).pathname.endsWith(
              "/project-favicon-missing",
            )
          )
            favicon.url = new URL(relativeUrl, this.environment.url).toString();
        }
        this.replies.get(id)?.({ ok: !error, error });
        this.replies.delete(id);
        if (error && id === this.shellRequest)
          this.environment.status = error;
        if (id === this.shellRequest) this.shellRequest = "";
      } else if (frame._tag === "Defect") {
        this.disconnected(
          string(object(frame.defect).message) || "The server closed the connection unexpectedly.",
        );
      }
    }
  }

  private shell(item: ObjectValue) {
    if (item.kind === "snapshot") {
      const snapshot = object(item.snapshot);
      const projects = records(snapshot.projects);
      if (Array.isArray(item.resolvedRepositoryIdentityRoots)) {
        for (const project of projects) this.projects.set(string(project.id), project);
      } else {
        this.shellLive = true;
        this.projects = new Map(projects.map((project) => [string(project.id), project]));
        this.shells = new Map(
          records(snapshot.threads).map((thread) => [string(thread.id), thread]),
        );
        if (this.switching && !this.shells.has(this.switching.thread.id)) this.switching = undefined;
      }
      for (const project of this.projects.values()) this.requestFavicon(project);
    } else if (item.kind === "project.updated") {
      const project = object(item.project);
      this.projects.set(string(project.id), project);
      this.requestFavicon(project);
    } else if (item.kind === "project.removed") {
      this.projects.delete(string(item.projectId));
    } else if (item.kind === "thread.updated" && item.location === "active") {
      const thread = object(item.thread);
      this.shells.set(string(thread.id), thread);
    } else if (item.kind === "thread.removed" && item.location === "active") {
      if (item.threadId === this.switching?.thread.id) this.switching = undefined;
      this.shells.delete(string(item.threadId));
      this.transcripts.get(string(item.threadId))?.remove();
      this.transcripts.delete(string(item.threadId));
      this.switchingSnapshots.delete(string(item.threadId));
      this.pruneTools();
    }
  }

  private requestFavicon(project: ObjectValue) {
    const id = string(project.id);
    const cwd = string(project.workspaceRoot);
    if (!cwd || project.projectIcon) return;
    const revision = JSON.stringify([cwd, project.faviconPath ?? null]);
    if (this.favicons.get(id)?.revision === revision) return;
    this.favicons.set(id, { revision, url: "" });
    const request = this.request("assets.createUrl", {
      resource: {
        _tag: "project-favicon",
        cwd,
        ...(project.faviconPath ? { path: project.faviconPath } : {}),
      },
    });
    this.faviconRequests.set(request, id);
  }

  private transcript(item: ObjectValue) {
    const history = this.transcripts.get(this.selected);
    if (!history) return;
    if (item.kind === "snapshot") {
      const projection = object(item.projection);
      const switching = switchingProjection(projection);
      this.switching = switching.thread.id === this.selected ? switching : undefined;
      if (this.switching) this.switchingSnapshots.set(this.selected, this.switching);
      history.install(item);
    } else if (history.apply(item)) {
      const event = object(item.event);
      if (item.kind === "event") this.updateSwitching(event);
      if (history.deleted) {
        this.switchingSnapshots.delete(this.selected);
        this.switching = undefined;
      } else if (history.synchronized) {
        this.switching = this.switchingSnapshots.get(this.selected);
      }
    }
    this.pruneTools();
  }

  private updateSwitching(event: ObjectValue) {
    const projection = this.switchingSnapshots.get(this.selected);
    if (!projection || event.threadId !== projection.thread.id) return;
    const payload = object(event.payload);
    const type = string(event.type);
    if (type === "thread.archived" || type === "thread.deleted") {
      this.switching = undefined;
      this.switchingSnapshots.delete(this.selected);
    } else if (type.startsWith("thread.") && payload.id === projection.thread.id && payload.modelSelection) {
      projection.thread = switchingThread(payload);
    } else if (type === "run.created" || type === "run.updated") {
      projection.runs = upsertSwitchingRecord(projection.runs, switchingRun(payload));
    } else if (type === "provider-thread.updated") {
      projection.providerThreads = upsertSwitchingRecord(projection.providerThreads, switchingProviderThread(payload));
    } else if (type === "provider-session.attached" || type === "provider-session.updated") {
      projection.providerSessions = upsertSwitchingRecord(projection.providerSessions, switchingSession(payload));
    } else if (type === "provider-session.detached") {
      projection.providerSessions = projection.providerSessions.filter((session) => session.id !== payload.providerSessionId);
    }
  }

  projectList(): Catalog["projects"] {
    return [...this.projects.entries()]
      .filter(([, project]) => !project.archivedAt && !project.deletedAt)
      .map(([id, project]) => ({
        id: scopedThreadId(this.environment.id, id),
        title: string(project.title),
        environmentId: this.environment.id,
      }));
  }

  threads(now = 0): Thread[] {
    return [...this.shells.entries()]
      .filter(([id, thread]) => !thread.deletedAt && (id === this.selected || listedThread(thread)))
      .map(([id, thread]) => {
        const project = this.projects.get(string(thread.projectId)) ?? {};
        const selection = object(thread.modelSelection);
        const provider =
          records(this.config.providers).find(
            (entry) => entry.instanceId === selection.instanceId,
          ) ?? {};
        const model =
          records(provider.models).find((entry) => entry.slug === selection.model) ?? {};
        const settled = thread.settledOverride === "settled" && thread.status !== "queued";
        const activityAt = activity(thread, settled);
        const rows = this.transcripts.get(id)?.feed() ?? [];
        const error = errorDetails(thread);
        return {
          id: scopedThreadId(this.environment.id, id),
          listed: listedThread(thread),
          environmentId: this.environment.id,
          project: string(project.title) || "Project",
          projectId: scopedThreadId(this.environment.id, string(thread.projectId)),
          ...projectIcon(project),
          ...(!project.projectIcon && this.favicons.get(string(thread.projectId))?.url
            ? { projectIcon: this.favicons.get(string(thread.projectId))!.url }
            : {}),
          provider:
            string(provider.driver) ||
            string(
              object(
                object(object(this.config.settings).providerInstances)[
                  string(selection.instanceId)
                ],
              ).driver,
            ),
          model: string(model.shortName) || string(model.name) || string(selection.model),
          lastError: error.message,
          lastErrorTime: error.time,
          settled,
          activityAt,
          title: string(thread.title),
          status: status(thread),
          visit: visitMetadata(thread),
          updatedAt: relativeTime(activityAt, now),
          rows,
          toolViewKey: this.toolViewKey(id),
          markdownRevision: this.transcripts.get(id)?.markdownRevision ?? 0,
          history: this.history(id),
          controls: this.controls(id),
        };
      })
      .sort(
        (left, right) =>
          Number(left.settled) - Number(right.settled) ||
          right.activityAt - left.activityAt ||
          left.id.localeCompare(right.id),
      );
  }
}
