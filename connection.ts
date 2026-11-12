import { AttachmentSession, RpcFailure } from "./attachment-session";
import { captureApprovalSend, type ApprovalSend, type ControlOptions } from "./approval-send";
import { FILE_LIMIT, validateAttachments, type StoredAttachment } from "./attachments";
import type { Result, StreamSocket } from "./app.contract.d.ts";
import { visitMetadata } from "./visit-metadata";
import { resolveMediaTarget, viewedImageBlock, type MediaRef } from "./media-preview";
import {
  projectThreadStatus,
  threadIsCompacting,
  threadLifecycleStatus,
  threadWorkStartedAt,
} from "./thread-status";
import { ThreadHistory, type HistorySummary, type TimelineRow } from "./thread-history";
import {
  answersFor,
  controlAccess,
  controlKey,
  emptyControls,
  type QuestionDraft,
} from "./thread-controls";
import {
  summarized,
  toolBody,
  toolNeedsDetail,
  toolRevision,
  toolSummary,
  type ToolBatch,
  type ToolPanel,
  type ToolRequest,
} from "./tool-activity";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputPlainText,
  type TerminalOutputState,
} from "./terminal-output";
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
  imageLoad?: { images: ToolPanel["images"]; promise: Promise<void> };
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

/** A server terminal session projected for the Exact view. */
export interface TerminalSession {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string;
  status: "starting" | "running" | "exited" | "error" | "closed";
  hasRunningSubprocess: boolean;
  label: string;
  displayLabel: string;
  updatedAt: string;
  output: string;
  error: string;
}

function terminalLabel(terminalId: string, label: string): string {
  const trimmed = label.trim();
  if (trimmed) return trimmed;
  const number = /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(terminalId)?.[1];
  return number ? `Terminal ${number}` : terminalId;
}

export interface ProjectScript {
  id: string;
  label: string;
  command: string;
  icon: string;
  runOnWorktreeCreate: boolean;
  runOnSettle: boolean;
  stopOnSettle: boolean;
}

function projectScriptLabel(script: ObjectValue, fallback: string): string {
  const name = string(script.name) || string(script.label) || string(script.id) || fallback;
  const roles = [
    script.runOnWorktreeCreate === true ? "setup" : "",
    script.runOnSettle === true ? "on settle" : "",
  ].filter(Boolean);
  return roles.length > 0 ? `${name} (${roles.join(", ")})` : name;
}

const inspectionEntryCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function sortInspectionItems(
  items: Inspection["items"],
): Inspection["items"] {
  return items.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return inspectionEntryCollator.compare(left.label, right.label);
  });
}
export interface ForceStopResult {
  outcome: "killed" | "released" | "releasing" | "shared";
  sharedWithThreadIds: string[];
}

/** A compact, UI-facing projection of the server's VCS status response. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  updatedAt: string;
}

export interface MobilePullRequestSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  repository: string;
  branch: string;
  baseBranch: string;
  author: string;
  updatedAt: string;
}

export interface PullRequestListItem extends PullRequestSummary {
  threadId: string;
  projectId: string;
}

export interface GitStatus {
  cwd: string;
  isRepo: boolean;
  canWrite: boolean;
  refName: string | null;
  isDefaultRef: boolean;
  hasWorkingTreeChanges: boolean;
  hasUpstream: boolean;
  hasPrimaryRemote: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
  branchChanges: { baseRef: string; insertions: number; deletions: number } | null;
  workingTree: { files: { path: string; insertions: number; deletions: number }[] };
  pr: PullRequestSummary | null;
  pullRequest: PullRequestSummary | null;
  unavailableReason: string;
}

export type GitAction =
  | "commit"
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitOperationState =
  | { status: "idle" }
  | {
      status: "running";
      actionId: string;
      action: GitAction;
      phase: "branch" | "commit" | "push" | "pr" | "";
      message: string;
    }
  | { status: "succeeded"; actionId: string; action: GitAction; result: ObjectValue }
  | { status: "failed"; actionId: string; action: GitAction; error: string };

export interface GitActionInput {
  actionId: string;
  action: GitAction;
  commitMessage?: string;
  featureBranch?: boolean;
  filePaths?: string[];
  projectId?: string;
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
  return (
    !thread.deletedAt &&
    !thread.archivedAt &&
    lineage.relationshipToParent !== "subagent" &&
    lineage.sideChat !== true
  );
}

function status(thread: ObjectValue): string {
  const request = string(object(thread.pendingRuntimeRequest).kind);
  if (request === "user_input") return "Input";
  if (request && request !== "auth_refresh") return "Approval";
  if (Number(thread.pendingGuestMessageCount) > 0) return "Request";
  const waiting = records(thread.pendingBackgroundTasks).some(
    (task) => task.awaited === true || task.kind === "subagent" || task.kind === "background_task",
  );
  if (thread.status !== "failed" && waiting) return "Waiting";
  const state = string(thread.activityRunStatus) || string(thread.status);
  if (state === "running" && thread.blockedOnThreadWait === true) return "Waiting";
  if (["preparing", "starting", "running", "waiting", "queued"].includes(state))
    return object(thread.goal).status === "active" ? "Goal" : "Working";
  if (state === "failed") return thread.lastErrorClass === "usage_limit" ? "Limited" : "Failed";
  if (state === "idle" && (thread.latestRunId || thread.activeProviderThreadId)) return "Waiting";
  const completed = thread.latestRunId
    ? timestamp(
        thread.latestRunCompletedAt === undefined ? thread.updatedAt : thread.latestRunCompletedAt,
      )
    : 0;
  return completed > 0 &&
    Boolean(thread.lastVisitedAt) &&
    (Number.isNaN(Date.parse(string(thread.lastVisitedAt))) ||
      completed > timestamp(thread.lastVisitedAt))
    ? "Done"
    : "";
}

function working(thread: ObjectValue): boolean {
  const request = string(object(thread.pendingRuntimeRequest).kind);
  if ((request && request !== "auth_refresh") || thread.pendingSubagentRequest != null)
    return false;
  const background =
    thread.status !== "failed" &&
    records(thread.pendingBackgroundTasks).some(
      (task) =>
        task.awaited === true || task.kind === "subagent" || task.kind === "background_task",
    );
  if (!thread.latestRunId && !thread.activeProviderThreadId && !background) return false;
  const active = ["preparing", "queued", "starting", "running", "waiting"];
  const runtime = background ? "idle" : string(thread.activityRunStatus) || string(thread.status);
  if (runtime !== "idle" && !active.includes(runtime)) return false;
  const runSettled =
    Boolean(thread.latestRunId) &&
    !active.includes(string(thread.status)) &&
    thread.activeRunId !== thread.latestRunId;
  return !(
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan === true &&
    runSettled
  );
}

function failure(exit: ObjectValue): string {
  for (const cause of records(exit.cause)) {
    const detail = object(cause.error ?? cause.defect);
    if (string(detail.message)) return string(detail.message);
    if (detail._tag === "OrchestrationV2ForceStopThreadError")
      return detail.reason === "superseded"
        ? "A new turn started, so nothing was force stopped."
        : "Failed to force stop the agent.";
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
  return {
    id: string(value.id),
    status: string(value.status),
    providerThreadId: string(value.providerThreadId),
  };
}

function switchingProviderThread(value: ObjectValue) {
  return {
    id: string(value.id),
    appThreadId: string(value.appThreadId),
    instanceId: string(value.providerInstanceId),
    sessionId: string(value.providerSessionId),
    hasNativeThread: value.nativeThreadRef != null,
  };
}

function switchingSession(value: ObjectValue) {
  return {
    id: string(value.id),
    status: string(value.status),
    canHandoff:
      object(object(value.capabilities).sessions).supportsProviderSwitchingViaHandoff === true,
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
  const activeRun = projection.runs.findLast((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const providerThreadId = activeRun?.providerThreadId || projection.thread.activeProviderThreadId;
  const attached =
    projection.providerThreads.find((thread) => thread.id === providerThreadId) ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.sessionId,
    );
  const session = attached?.sessionId
    ? projection.providerSessions.find((session) => session.id === attached.sessionId)
    : projection.providerSessions.findLast(
        (session) => session.status !== "stopped" && session.status !== "error",
      );
  if (session) return session.canHandoff;
  if (activeRun) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.instanceId === projection.thread.instanceId &&
      thread.hasNativeThread,
  );
}

function upsertSwitchingRecord<T extends { id: string }>(rows: T[], value: T): T[] {
  const index = rows.findIndex((row) => row.id === value.id);
  return index < 0 ? [...rows, value] : rows.map((row, at) => (at === index ? value : row));
}

/** Normalize an untrusted refreshStatus payload before it reaches the view. */
export function normalizeGitStatus(value: unknown): GitStatus {
  const raw = object(value);
  const branchChanges = object(raw.branchChanges);
  const tree = object(raw.workingTree);
  const files = records(tree.files).map((file) => ({
    path: string(file.path),
    insertions: Number(file.insertions ?? 0),
    deletions: Number(file.deletions ?? 0),
  }));
  const ref = string(raw.refName) || string(raw.branch) || string(raw.currentRef);
  const pr = normalizePullRequestSummary(raw.pr ?? raw.pullRequest);
  return {
    cwd: string(raw.cwd),
    isRepo: raw.isRepo === true,
    canWrite: raw.canWrite !== false && raw.readOnly !== true,
    refName: ref || null,
    isDefaultRef: raw.isDefaultRef === true || raw.isDefaultBranch === true,
    hasWorkingTreeChanges: raw.hasWorkingTreeChanges === true || files.length > 0,
    hasUpstream: raw.hasUpstream === true,
    hasPrimaryRemote: raw.hasPrimaryRemote === true,
    aheadCount: Number(raw.aheadCount ?? 0),
    behindCount: Number(raw.behindCount ?? 0),
    aheadOfDefaultCount: Number(raw.aheadOfDefaultCount ?? 0),
    branchChanges:
      Object.keys(branchChanges).length > 0
        ? {
            baseRef: string(branchChanges.baseRef),
            insertions: Number(branchChanges.insertions ?? 0),
            deletions: Number(branchChanges.deletions ?? 0),
          }
        : null,
    workingTree: { files },
    pr,
    pullRequest: pr,
    unavailableReason: raw.isRepo === true ? "" : "Not a git repository",
  };
}

function normalizePullRequestSummary(value: unknown): PullRequestSummary | null {
  if (value == null) return null;
  const raw = object(value);
  const number = Number(raw.number);
  if (!Number.isSafeInteger(number) || number < 1 || !string(raw.url)) return null;
  const state = string(raw.state);
  return {
    number,
    title: string(raw.title) || `Pull request #${number}`,
    url: string(raw.url),
    baseBranch: string(raw.baseBranch) || string(raw.baseRef),
    headBranch: string(raw.headBranch) || string(raw.headRef),
    state: state === "closed" || state === "merged" ? state : "open",
    isDraft: raw.isDraft === true,
    updatedAt: string(raw.updatedAt),
  };
}

export function pullRequestSummary(value: unknown): MobilePullRequestSummary {
  const raw = object(value);
  const number = Number(raw.number);
  const repository = string(raw.repository) || string(raw.repositoryFullName) || string(raw.repo);
  const baseBranch = string(raw.baseBranch) || string(raw.baseRef);
  const branch = string(raw.headBranch) || string(raw.headRef) || string(raw.branch);
  const author = string(object(raw.author).login) || string(raw.author);
  const state = string(raw.state);
  return {
    id: string(raw.id) || `${repository}:${number}`,
    number: Number.isSafeInteger(number) ? number : 0,
    title: string(raw.title),
    url: string(raw.url),
    state: state === "closed" || state === "merged" ? state : "open",
    repository,
    branch,
    baseBranch,
    author,
    updatedAt: string(raw.updatedAt),
  };
}

export type GitQuickAction =
  | { kind: "run_action"; action: GitAction; disabled: boolean; hint: string }
  | { kind: "run_pull"; action?: undefined; disabled: boolean; hint: string }
  | { kind: "open_pr"; action?: undefined; disabled: boolean; hint: string; url: string }
  | { kind: "show_hint"; action?: undefined; disabled: true; hint: string };

export function gitQuickAction(
  status: GitStatus,
  busy: boolean,
  canWrite: boolean,
): GitQuickAction {
  if (!status.isRepo)
    return { kind: "show_hint", disabled: true, hint: "This workspace is not a git repository." };
  if (busy) return { kind: "show_hint", disabled: true, hint: "A Git action is already running." };
  const hasOpenPr = status.pullRequest?.state === "open";
  if (!status.refName)
    return {
      kind: "show_hint",
      disabled: true,
      hint: "Create and checkout a branch before pushing or opening a pull request.",
    };
  const writeDisabled = !canWrite;
  const writeHint = writeDisabled ? "This connection cannot change source control." : "";
  const ahead = status.aheadCount > 0;
  const behind = status.behindCount > 0;
  if (status.hasWorkingTreeChanges) {
    if (behind || (!status.hasUpstream && !status.hasPrimaryRemote))
      return { kind: "run_action", action: "commit", disabled: writeDisabled, hint: writeHint || "Commit changes" };
    if (hasOpenPr || status.isDefaultRef)
      return { kind: "run_action", action: "commit_push", disabled: writeDisabled, hint: writeHint || "Commit and push changes" };
    return {
      kind: "run_action",
      action: "commit_push_pr",
      disabled: writeDisabled,
      hint: writeHint || "Commit, push, and create a pull request",
    };
  }
  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote)
      return hasOpenPr && !ahead
        ? { kind: "open_pr", disabled: false, hint: "View pull request", url: status.pullRequest!.url }
        : { kind: "show_hint", disabled: true, hint: 'Add an "origin" remote before pushing or creating a pull request.' };
    if (!ahead)
      return hasOpenPr
        ? { kind: "open_pr", disabled: false, hint: "View pull request", url: status.pullRequest!.url }
        : { kind: "show_hint", disabled: true, hint: "No local commits to push." };
    if (hasOpenPr || status.isDefaultRef)
      return {
        kind: "run_action",
        action: status.isDefaultRef ? "commit_push" : "push",
        disabled: writeDisabled,
        hint: writeHint || "Push changes",
      };
    return { kind: "run_action", action: "create_pr", disabled: writeDisabled, hint: writeHint || "Push and create a pull request" };
  }
  if (ahead && behind)
    return { kind: "show_hint", disabled: true, hint: "Branch has diverged. Rebase or merge before syncing." };
  if (behind) return { kind: "run_pull", disabled: writeDisabled, hint: writeHint || "Pull latest changes" };
  if (ahead)
    return hasOpenPr || status.isDefaultRef
      ? {
          kind: "run_action",
          action: status.isDefaultRef ? "commit_push" : "push",
          disabled: writeDisabled,
          hint: writeHint || "Push changes",
        }
      : { kind: "run_action", action: "create_pr", disabled: writeDisabled, hint: writeHint || "Push and create a pull request" };
  if (hasOpenPr)
    return { kind: "open_pr", disabled: false, hint: "View pull request", url: status.pullRequest!.url };
  return { kind: "show_hint", disabled: true, hint: "Branch is up to date. No action needed." };
}

export interface ReducedGitOperation {
  status: "running" | "succeeded" | "failed";
  operation: GitAction;
  label: string;
  error: string | null;
  result?: ObjectValue;
}

export function reduceGitOperation(
  previous: ReducedGitOperation | undefined,
  event: {
    type: "start" | "progress" | "success" | "error";
    operation?: GitAction;
    label?: string;
    result?: ObjectValue;
    error?: string;
  },
): ReducedGitOperation {
  if (event.type === "start")
    return {
      status: "running",
      operation: event.operation ?? previous?.operation ?? "commit",
      label: event.label ?? "Running source control action",
      error: null,
    };
  const operation = event.operation ?? previous?.operation ?? "commit";
  if (event.type === "progress")
    return { status: "running", operation, label: event.label ?? previous?.label ?? "Running source control action", error: null };
  if (event.type === "success")
    return { status: "succeeded", operation, label: previous?.label ?? "Completed source control action", error: null, result: event.result ?? {} };
  return { status: "failed", operation, label: previous?.label ?? "Source control action failed", error: event.error ?? "Git action failed." };
}

export class DirectSession {
  readonly environment: Environment;
  private readonly serial = ++sessionSerial;
  private controlEpoch = 0;
  private controlGrant = false;
  private controlOperations = new Map<
    string,
    { pending: boolean; error: string; threadId: string; runId: string; result: string }
  >();
  private forceStops = new Map<string, { accessKey: string }>();
  private tools = new Map<string, ExpandedTool>();
  private socket: StreamSocket | undefined;
  private nextId = 0;
  private shellRequest = "";
  private terminalMetadataRequest = "";
  private configRequest = "";
  private threadRequest = "";
  private selected = "";
  private projects = new Map<string, ObjectValue>();
  private config: ObjectValue = {};
  private configReady = false;
  private faviconRequests = new Map<string, string>();
  private favicons = new Map<string, { revision: string; url: string }>();
  private shells = new Map<string, ObjectValue>();
  private terminals = new Map<string, TerminalSession>();
  private terminalOutputStates = new Map<string, TerminalOutputState>();
  private terminalRequests = new Map<string, { threadId: string; terminalId: string }>();
  private terminalRequestIds = new Map<string, string>();
  private shellLive = false;
  private transcripts = new Map<string, ThreadHistory>();
  private switchingSnapshots = new Map<string, ReturnType<typeof switchingProjection>>();
  private switching: ReturnType<typeof switchingProjection> | undefined;
  private replies = new Map<string, (reply: Reply) => void>();
  private gitStatusByThread = new Map<string, GitStatus>();
  private gitOperations = new Map<
    string,
    { threadId: string; actionId: string; action: GitAction }
  >();
  private gitOperationStateByThread = new Map<string, GitOperationState>();
  private queries = new Map<
    string,
    { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }
  >();

  readonly attachments = new AttachmentSession({
    metadata: () => {
      const capabilities = object(object(this.config.environment).capabilities);
      const files = object(capabilities.fileAttachments);
      return {
        accessKey: this.controlAccessKey(),
        origin: this.environment.url,
        allowed: this.hasControlAccess(),
        uploads: capabilities.attachmentUploads === true,
        maxFileBytes:
          typeof files.maxUploadBytes === "number" ? Math.min(FILE_LIMIT, files.maxUploadBytes) : 0,
      };
    },
    query: (tag, payload) => {
      if (this.queries.size >= 32)
        throw new Error("Too many requests are pending. Wait for them to finish.");
      const id = this.request(tag, payload);
      const promise = new Promise<ObjectValue>((resolve, reject) =>
        this.queries.set(id, { resolve, reject }),
      );
      return { id, promise };
    },
    cancel: (id) => {
      if (this.socket?.readyState === 1)
        this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
      this.queries.get(id)?.reject(new Error("This attachment request was cancelled."));
      this.queries.delete(id);
    },
    resolve: (threadId, viewKey, demand) => {
      if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return;
      return this.transcripts
        .get(threadId)
        ?.feed()
        .find((row) => row.message?.id === demand.messageId)
        ?.message?.attachments.find((item) => item.id === demand.attachmentId);
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


  private cwdForThread(threadId: string): string {
    const shell = this.shells.get(threadId);
    if (!shell) throw new Error("This thread is no longer available.");
    const cwd =
      string(shell.worktreePath) ||
      string(this.projects.get(string(shell.projectId))?.workspaceRoot);
    if (!cwd) throw new Error("This thread has no available workspace.");
    return cwd;
  }

  private normalizePullRequest(value: unknown): PullRequestSummary | null {
    return normalizePullRequestSummary(value);
  }

  private normalizeGitStatus(cwd: string, value: ObjectValue): GitStatus {
    return { ...normalizeGitStatus({ ...value, cwd }), cwd };
  }

  gitStatus(threadId: string): GitStatus | null {
    return this.gitStatusByThread.get(threadId) ?? null;
  }

  gitOperationState(threadId: string): GitOperationState {
    return this.gitOperationStateByThread.get(threadId) ?? { status: "idle" };
  }

  async refreshGitStatus(threadId: string, localOnly = false): Promise<GitStatus> {
    const cwd = this.cwdForThread(threadId);
    try {
      const result = await this.query("vcs.refreshStatus", { cwd, ...(localOnly ? { localOnly } : {}) });
      const status = this.normalizeGitStatus(cwd, result);
      this.gitStatusByThread.set(threadId, status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git status could not be loaded.";
      const status: GitStatus = {
        cwd,
        isRepo: false,
        canWrite: false,
        refName: null,
        isDefaultRef: false,
        hasWorkingTreeChanges: false,
        hasUpstream: false,
        hasPrimaryRemote: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        branchChanges: null,
        workingTree: { files: [] },
        pr: null,
        pullRequest: null,
        unavailableReason: message,
      };
      this.gitStatusByThread.set(threadId, status);
      throw error;
    }
  }

  async pullGit(threadId: string): Promise<ObjectValue> {
    const cwd = this.cwdForThread(threadId);
    const result = await this.query("vcs.pull", { cwd });
    await this.refreshGitStatus(threadId, true).catch(() => {});
    return result;
  }

  async listGitRefs(
    threadId: string,
    options: {
      query?: string;
      cursor?: number;
      includeMatchingRemoteRefs?: boolean;
      refKind?: "all" | "local" | "remote";
      refresh?: boolean;
      limit?: number;
    } = {},
  ): Promise<ObjectValue> {
    const cwd = this.cwdForThread(threadId);
    return this.query("vcs.listRefs", {
      cwd,
      ...(options.query ? { query: options.query } : {}),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.includeMatchingRemoteRefs === undefined
        ? {}
        : { includeMatchingRemoteRefs: options.includeMatchingRemoteRefs }),
      ...(options.refKind ? { refKind: options.refKind } : {}),
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  async switchGitRef(threadId: string, refName: string): Promise<ObjectValue> {
    const cwd = this.cwdForThread(threadId);
    const result = await this.query("vcs.switchRef", { cwd, refName });
    await this.refreshGitStatus(threadId, true).catch(() => {});
    return result;
  }

  async listPullRequests(): Promise<ObjectValue> {
    return this.query("pullRequests.list", { state: "open", involvement: "all", limit: 100 });
  }

  async pullRequestDetail(projectId: string, repository: string, number: number): Promise<ObjectValue> {
    return this.query("pullRequests.detail", {
      projectId,
      repository,
      number,
      allowStale: true,
    });
  }

  async pullRequestActivity(
    projectId: string,
    repository: string,
    number: number,
  ): Promise<ObjectValue> {
    return this.query("pullRequests.activity", {
      projectId,
      repository,
      number,
      allowStale: true,
    });
  }

  async createGitRef(threadId: string, refName: string, switchRef = true): Promise<ObjectValue> {
    const cwd = this.cwdForThread(threadId);
    const result = await this.query("vcs.createRef", { cwd, refName, switchRef });
    await this.refreshGitStatus(threadId, true).catch(() => {});
    return result;
  }

  async createGitWorktree(threadId: string, baseRef: string, newRefName: string): Promise<ObjectValue> {
    const shell = this.shells.get(threadId);
    const project = this.projects.get(string(shell?.projectId));
    const cwd = string(project?.workspaceRoot) || this.cwdForThread(threadId);
    const result = await this.query("vcs.createWorktree", {
      cwd,
      refName: baseRef,
      newRefName,
      path: null,
    });
    await this.refreshGitStatus(threadId, true).catch(() => {});
    return result;
  }

  async updateThreadMetadata(
    threadId: string,
    patch: {
      branch?: string | null;
      worktreePath?: string | null;
      title?: string;
      linkedPullRequest?: ObjectValue | null;
    },
  ): Promise<Reply> {
    const id = this.request("orchestration.dispatchCommand", {
      type: "thread.metadata.update",
      commandId: crypto.randomUUID(),
      threadId,
      ...patch,
    });
    return new Promise((resolve) => this.replies.set(id, resolve));
  }

  async runGitAction(threadId: string, input: GitActionInput): Promise<ObjectValue> {
    const cwd = this.cwdForThread(threadId);
    const payload = {
      actionId: input.actionId,
      cwd,
      action: input.action,
      ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
      ...(input.featureBranch === undefined ? {} : { featureBranch: input.featureBranch }),
      ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
      threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    const id = this.request("git.runStackedAction", payload);
    this.gitOperations.set(id, { threadId, actionId: input.actionId, action: input.action });
    this.gitOperationStateByThread.set(threadId, {
      status: "running",
      actionId: input.actionId,
      action: input.action,
      phase: "",
      message: "Starting source control action",
    });
    const query = new Promise<ObjectValue>((resolve, reject) => this.queries.set(id, { resolve, reject }));
    try {
      const value = await query;
      const current = this.gitOperationStateByThread.get(threadId);
      const result = current?.status === "succeeded" ? current.result : value;
      this.gitOperationStateByThread.set(threadId, {
        status: "succeeded",
        actionId: input.actionId,
        action: input.action,
        result,
      });
      await this.refreshGitStatus(threadId, true).catch(() => {});
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git action failed.";
      this.gitOperationStateByThread.set(threadId, {
        status: "failed",
        actionId: input.actionId,
        action: input.action,
        error: message,
      });
      throw error;
    } finally {
      this.gitOperations.delete(id);
    }
  }



  private terminalKey(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  private terminalSummary(value: unknown, previous?: TerminalSession): TerminalSession | null {
    const summary = object(value);
    const threadId = string(summary.threadId) || previous?.threadId || "";
    const terminalId = string(summary.terminalId) || previous?.terminalId || "";
    if (!threadId || !terminalId) return null;
    return {
      threadId,
      terminalId,
      cwd: string(summary.cwd) || previous?.cwd || "",
      worktreePath: string(summary.worktreePath) || previous?.worktreePath || "",
      status: (string(summary.status) || previous?.status || "starting") as TerminalSession["status"],
      hasRunningSubprocess:
        typeof summary.hasRunningSubprocess === "boolean"
          ? summary.hasRunningSubprocess
          : (previous?.hasRunningSubprocess ?? false),
      label: terminalLabel(terminalId, string(summary.label) || previous?.label || ""),
      displayLabel: terminalLabel(
        terminalId,
        string(summary.label) || previous?.displayLabel || previous?.label || "",
      ),
      updatedAt: string(summary.updatedAt) || previous?.updatedAt || "",
      output: previous?.output || "",
      error: previous?.error || "",
    };
  }

  terminalSessions(threadId: string): TerminalSession[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.threadId === threadId)
      .sort((left, right) =>
        left.terminalId.localeCompare(right.terminalId, undefined, { numeric: true }),
      )
      .map((terminal) => ({ ...terminal }));
  }

  terminal(threadId: string, terminalId: string): TerminalSession | null {
    const value = this.terminals.get(this.terminalKey(threadId, terminalId));
    return value ? { ...value } : null;
  }

  terminalWorkspace(threadId: string): { cwd: string; worktreePath: string; projectRoot: string } | null {
    const thread = this.shells.get(threadId);
    if (!thread) return null;
    const project = this.projects.get(string(thread.projectId));
    const worktreePath = string(thread.worktreePath);
    const cwd = worktreePath || string(project?.workspaceRoot);
    return cwd ? { cwd, worktreePath, projectRoot: string(project?.workspaceRoot) } : null;
  }

  terminalProjectScripts(threadId: string): ProjectScript[] {
    const thread = this.shells.get(threadId);
    const project = thread ? this.projects.get(string(thread.projectId)) : undefined;
    const projectScripts = records(project?.scripts);
    const settings = object(this.config.settings);
    const projectId = string(project?.id);
    const projectOverride = object(object(settings.projectSettingsOverrides)[projectId]).defaultProjectScripts;
    const defaultScripts = records(settings.defaultProjectScripts);
    // Match Expo's project-script resolution, including the newer folded
    // settings and the legacy per-project override map.
    const scripts =
      projectOverride !== undefined
        ? records(projectOverride)
        : settings.projectSettingsFolded === true
          ? defaultScripts
          : (() => {
              const legacy = object(settings.projectScriptOverrides)[projectId];
              if (legacy === null) return defaultScripts;
              if (legacy !== undefined) return records(legacy);
              return projectScripts.length > 0 ? projectScripts : defaultScripts;
            })();
    return scripts.map((script, index) => ({
      id: string(script.id) || `script-${index + 1}`,
      label: projectScriptLabel(script, `Script ${index + 1}`),
      command: string(script.command),
      icon: string(script.icon) || "play",
      runOnWorktreeCreate: script.runOnWorktreeCreate === true,
      runOnSettle: script.runOnSettle === true,
      stopOnSettle: script.stopOnSettle === true,
    }));
  }

  attachTerminal(
    threadId: string,
    terminalId: string,
    input: { cwd?: string; worktreePath?: string; cols?: number; rows?: number } = {},
  ): TerminalSession {
    const key = this.terminalKey(threadId, terminalId);
    const current = this.terminals.get(key);
    if (!this.terminalRequestIds.has(key) && this.socket?.readyState === 1) {
      const requestId = this.request("terminal.attach", {
        threadId,
        terminalId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        ...(input.cols ? { cols: input.cols } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
        restartIfNotRunning: true,
      });
      this.terminalRequestIds.set(key, requestId);
      this.terminalRequests.set(requestId, { threadId, terminalId });
    }
    const next =
      current && (current.status === "exited" || current.status === "closed" || current.status === "error")
        ? { ...current, status: "starting" as const, error: "" }
        : current ??
      ({
        threadId,
        terminalId,
        cwd: input.cwd ?? this.terminalWorkspace(threadId)?.cwd ?? "",
        worktreePath: input.worktreePath ?? this.terminalWorkspace(threadId)?.worktreePath ?? "",
        status: "starting",
        hasRunningSubprocess: false,
        label: terminalLabel(terminalId, ""),
        displayLabel: terminalLabel(terminalId, ""),
        updatedAt: "",
        output: "",
        error: "",
      } satisfies TerminalSession);
    this.terminals.set(key, next);
    if (!this.terminalOutputStates.has(key)) this.terminalOutputStates.set(key, EMPTY_TERMINAL_OUTPUT);
    return { ...next };
  }

  observeTerminal(threadId: string, terminalId: string): TerminalSession {
    const key = this.terminalKey(threadId, terminalId);
    const current = this.terminals.get(key);
    if (!this.terminalRequestIds.has(key) && this.socket?.readyState === 1) {
      const requestId = this.request("terminal.observe", { threadId, terminalId });
      this.terminalRequestIds.set(key, requestId);
      this.terminalRequests.set(requestId, { threadId, terminalId });
    }
    const next =
      current ??
      ({
        threadId,
        terminalId,
        cwd: "",
        worktreePath: "",
        status: "starting",
        hasRunningSubprocess: false,
        label: terminalLabel(terminalId, ""),
        displayLabel: terminalLabel(terminalId, ""),
        updatedAt: "",
        output: "",
        error: "",
      } satisfies TerminalSession);
    this.terminals.set(key, next);
    if (!this.terminalOutputStates.has(key)) this.terminalOutputStates.set(key, EMPTY_TERMINAL_OUTPUT);
    return { ...next };
  }

  async openTerminal(
    threadId: string,
    terminalId: string,
    cwd: string,
    worktreePath: string,
    cols = 80,
    rows = 24,
    env: Record<string, string> = {},
    stopOnSettle = false,
  ): Promise<Reply> {
    try {
      await this.query("terminal.open", {
        threadId,
        terminalId,
        cwd,
        worktreePath: worktreePath || null,
        cols,
        rows,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(stopOnSettle ? { stopOnSettle: true } : {}),
      });
      this.attachTerminal(threadId, terminalId, { cwd, worktreePath, cols, rows });
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not open terminal." };
    }
  }

  async writeTerminal(threadId: string, terminalId: string, data: string): Promise<Reply> {
    try {
      await this.query("terminal.write", { threadId, terminalId, data });
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not write to terminal." };
    }
  }

  async resizeTerminal(threadId: string, terminalId: string, cols: number, rows: number): Promise<Reply> {
    try {
      await this.query("terminal.resize", { threadId, terminalId, cols, rows });
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not resize terminal." };
    }
  }

  async clearTerminal(threadId: string, terminalId: string): Promise<Reply> {
    try {
      await this.query("terminal.clear", { threadId, terminalId });
      const key = this.terminalKey(threadId, terminalId);
      this.terminalOutputStates.set(key, EMPTY_TERMINAL_OUTPUT);
      const current = this.terminals.get(key);
      if (current) this.terminals.set(key, { ...current, output: "" });
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not clear terminal." };
    }
  }

  async runTerminalScript(threadId: string, scriptId: string): Promise<Reply & { terminalId: string }> {
    const script = this.terminalProjectScripts(threadId).find((entry) => entry.id === scriptId);
    const workspace = this.terminalWorkspace(threadId);
    if (!script || !workspace) return { ok: false, error: "This project script is unavailable.", terminalId: "" };
    const sessions = this.terminalSessions(threadId);
    const ids = sessions.map((entry) => entry.terminalId);
    const hasRunningTerminal = sessions.some(
      (entry) => entry.status === "running" || entry.status === "starting",
    );
    let terminalId = "term-1";
    if (hasRunningTerminal) {
      let index = 1;
      while (ids.includes(`term-${index}`)) index += 1;
      terminalId = `term-${index}`;
    }
    const opened = await this.openTerminal(
      threadId,
      terminalId,
      workspace.cwd,
      workspace.worktreePath,
      80,
      24,
      {
        ...(workspace.projectRoot ? { T3CODE_PROJECT_ROOT: workspace.projectRoot } : {}),
        ...(workspace.worktreePath ? { T3CODE_WORKTREE_PATH: workspace.worktreePath } : {}),
      },
      script.stopOnSettle,
    );
    if (!opened.ok) return { ...opened, terminalId };
    // A leading space keeps the command out of Bash/zsh history when the host
    // enables HIST_IGNORE_SPACE, and carriage return matches the native PTY.
    return { ...(await this.writeTerminal(threadId, terminalId, ` ${script.command}\r`)), terminalId };
  }


  threadRefs() {
    return [...this.shells]
      .filter(([, thread]) => !thread.deletedAt)
      .map(([threadId]) => ({ environmentId: this.environment.id, threadId }));
  }

  async fileLinkPath(threadId: string, path: string): Promise<string> {
    const shell = this.shells.get(threadId);
    if (!shell) throw new Error("This thread is no longer available.");
    const cwd =
      string(shell.worktreePath) ||
      string(this.projects.get(string(shell.projectId))?.workspaceRoot);
    if (!cwd) throw new Error("This thread has no available workspace.");
    if (path.startsWith("~/")) {
      const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd)?.[1];
      if (home) return `${home}/${path.slice(2)}`;
    }
    if (/[\\/]/.test(path)) return path;
    const result = await this.query("projects.searchEntries", {
      cwd,
      query: path,
      limit: 100,
      kind: "file",
    });
    const matches = records(result.entries)
      .map((entry) => string(entry.path))
      .filter((entry) => entry.split("/").at(-1) === path);
    if (matches.includes(path)) return path;
    if (matches.length === 1 && result.truncated !== true) return matches[0]!;
    if (matches.length > 1 || result.truncated === true)
      throw new Error("This file name is ambiguous. Open a link with its full path.");
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
        items: sortInspectionItems(
          records(result.entries).map((entry) => ({
            id: string(entry.path),
            label: string(entry.path).split("/").at(-1) || string(entry.path),
            detail: entry.ignored === true ? "Ignored" : string(entry.path),
            kind: string(entry.kind),
          })),
        ),
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

  async turnDiff(threadId: string, turnCount: number): Promise<string> {
    if (!this.shells.has(threadId)) throw new Error("This thread is no longer available.");
    if (!Number.isSafeInteger(turnCount) || turnCount < 1)
      throw new Error("This checkpoint is unavailable.");
    const result = await this.query("orchestration.getTurnDiff", {
      threadId,
      fromTurnCount: turnCount - 1,
      toTurnCount: turnCount,
      ignoreWhitespace: false,
    });
    return string(result.diff);
  }

  open(socket: StreamSocket) {
    this.controlEpoch++;
    this.controlGrant = false;
    this.clearToolPanels();
    for (const history of this.transcripts.values()) history.disconnect();
    this.shellLive = false;
    this.terminalMetadataRequest = "";
    this.terminals.clear();
    this.terminalRequests.clear();
    this.terminalRequestIds.clear();
    this.terminalOutputStates.clear();
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
    try {
      this.terminalMetadataRequest = this.request("subscribeTerminalMetadata", {});
    } catch {
      this.terminalMetadataRequest = "";
    }
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
    if (!this.selected || this.threadRequest || !this.configReady || this.socket?.readyState !== 1)
      return;
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
      ...(completion && history.ready && history.sequence !== null
        ? { afterSequence: history.sequence }
        : {}),
      ...(completion ? { requestCompletionMarker: true } : {}),
      ...(this.config.threadSnapshotPagination === true ? { acceptBoundedSnapshot: true } : {}),
    });
  }

  history(threadId: string): HistorySummary {
    return (
      this.transcripts.get(threadId)?.summary() ?? {
        ready: false,
        synchronized: false,
        hasMore: false,
        loading: false,
        error: "",
      }
    );
  }

  controlAccessKey() {
    return this.socket?.readyState === 1
      ? JSON.stringify([this.environment.id, this.serial, this.controlEpoch])
      : "";
  }

  shellReady() {
    return this.shellLive;
  }

  installControlAccess(key: string, session: unknown): boolean {
    if (!key || key !== this.controlAccessKey()) return false;
    return (this.controlGrant = controlAccess(session));
  }

  hasControlAccess() {
    return this.controlGrant && this.controlAccessKey() !== "";
  }

  canForceStop() {
    return (
      this.hasControlAccess() &&
      this.configReady &&
      object(object(this.config.environment).capabilities).threadForceStop === true
    );
  }

  forceStopPending(threadId: string) {
    return this.forceStops.get(threadId)?.accessKey === this.controlAccessKey();
  }

  async forceStop(threadId: string, accessKey: string, runId: string): Promise<ForceStopResult> {
    if (!this.hasControlAccess() || accessKey !== this.controlAccessKey())
      throw new Error("Reconnect and check your permission before stopping this thread.");
    if (!this.canForceStop()) throw new Error("This environment does not support force stop.");
    const controls = this.controls(threadId);
    if (threadId !== this.selected || !controls.ready)
      throw new Error("Wait for this thread to finish reconnecting.");
    if (!runId || controls.stop.runId !== runId) throw new Error("This turn is no longer running.");
    if (controls.stop.state !== "unresponsive")
      throw new Error("Force stop is only available for an unresponsive turn.");
    if (this.forceStopPending(threadId))
      throw new Error("This turn is already being force stopped.");
    const operation = { accessKey };
    this.forceStops.set(threadId, operation);
    try {
      const result = await this.query("orchestration.forceStopThread", { threadId, runId });
      const { outcome, sharedWithThreadIds } = result;
      if (
        (outcome !== "killed" &&
          outcome !== "released" &&
          outcome !== "releasing" &&
          outcome !== "shared") ||
        !Array.isArray(sharedWithThreadIds) ||
        !sharedWithThreadIds.every((id): id is string => typeof id === "string")
      )
        throw new Error("The server returned an invalid force-stop response.");
      return { outcome, sharedWithThreadIds };
    } catch (error) {
      if (
        accessKey === this.controlAccessKey() &&
        error instanceof Error &&
        /permission|forbidden|unauthorized|scope|not authorized/i.test(error.message)
      ) {
        this.controlGrant = false;
        this.controlEpoch++;
      }
      throw error;
    } finally {
      if (this.forceStops.get(threadId) === operation) this.forceStops.delete(threadId);
    }
  }

  controls(threadId: string) {
    const controls =
      this.transcripts.get(threadId)?.controls(this.environment.id) ?? emptyControls();
    controls.accessKey = this.controlAccessKey();
    for (const key of controls.resolvedKeys) this.controlOperations.delete(key);
    for (const [key, operation] of this.controlOperations) {
      if (
        operation.threadId === threadId &&
        !operation.runId &&
        controls.ready &&
        !controls.pendingKeys.includes(key)
      )
        this.controlOperations.delete(key);
      if (
        operation.threadId === threadId &&
        operation.runId &&
        (operation.runId !== controls.stop.runId ||
          this.transcripts.get(threadId)?.interruptResult(operation.runId) !== operation.result)
      )
        this.controlOperations.delete(key);
    }
    for (const request of controls.requests) {
      const operation = this.controlOperations.get(request.key);
      if (operation) {
        request.pending = operation.pending;
        request.error = operation.error;
      }
    }
    const stopping = this.controlOperations.get(
      controlKey(this.environment.id, threadId, `stop:${controls.stop.runId}`),
    );
    if (stopping) {
      controls.stop.error = stopping.error;
      if (stopping.pending && controls.stop.state === "available") controls.stop.state = "stopping";
    }
    return controls;
  }

  async control(
    threadId: string,
    accessKey: string,
    kind: string,
    targetId: string,
    decision: string,
    drafts: QuestionDraft[],
    commandId: string,
    options: ControlOptions = {},
  ): Promise<Reply> {
    if (!this.hasControlAccess() || accessKey !== this.controlAccessKey())
      throw new Error("Reconnect and check your permission before responding.");
    const controls = this.controls(threadId);
    if (threadId !== this.selected || !controls.ready)
      throw new Error("Wait for this thread to finish reconnecting.");
    let payload: ObjectValue;
    let key = controlKey(this.environment.id, threadId, targetId);
    if (kind === "stop") {
      if (controls.stop.runId !== targetId || !targetId)
        throw new Error("This turn is no longer running.");
      if (controls.stop.state !== "available") throw new Error("This turn is already stopping.");
      key = controlKey(this.environment.id, threadId, `stop:${targetId}`);
      payload = { type: "run.interrupt", commandId, threadId, runId: targetId, holdQueue: true };
    } else {
      const request = controls.requests.find((request) => request.id === targetId);
      if (!request) throw new Error("This request is no longer pending.");
      if (request.pending) throw new Error("A response is already being sent.");
      if (request.unavailable && !(kind === "dismiss" && request.dismissible))
        throw new Error(request.unavailable);
      if ((kind === "approve" || kind === "redirect") && request.kind === "approval") {
        if (kind === "approve" && !request.options.some((option) => option.decision === decision))
          throw new Error("This approval option is no longer available.");
        if (request.capability !== "live" || (kind === "redirect" && decision !== "decline"))
          throw new Error("This approval can no longer be answered.");
        if (
          options.feedback !== undefined &&
          (!request.supportsFeedback || !options.feedback.trim() || decision !== "decline")
        )
          throw new Error("This request cannot receive approval feedback.");
        payload = {
          type: "runtime-request.respond",
          commandId,
          threadId,
          requestId: targetId,
          decision,
          ...(options.feedback === undefined ? {} : { feedback: options.feedback.trim() }),
        };
      } else if (kind === "answer" && request.kind === "question") {
        const attachmentsByQuestionId = options.attachmentsByQuestionId ?? {};
        if (
          Object.keys(attachmentsByQuestionId).some(
            (id) => !request.questions.some((question) => question.id === id),
          )
        )
          throw new Error("These attachments no longer belong to a pending question.");
        validateAttachments(
          Object.values(attachmentsByQuestionId).flat(),
          this.attachments.metadata().maxFileBytes,
          true,
        );
        const answers = answersFor(request.questions, drafts, key, attachmentsByQuestionId);
        if (!answers) throw new Error("Answer every question before submitting.");
        payload = {
          type: "runtime-request.respond",
          commandId,
          threadId,
          requestId: targetId,
          answers,
          ...(Object.keys(attachmentsByQuestionId).length ? { attachmentsByQuestionId } : {}),
        };
      } else if (kind === "dismiss" && request.dismissible) {
        payload = { type: "thread.user-input.dismiss", commandId, threadId, requestId: targetId };
      } else throw new Error("This response is not available.");
    }
    const operation = {
      pending: true,
      error: "",
      threadId,
      runId: kind === "stop" ? targetId : "",
      result: this.transcripts.get(threadId)?.interruptResult(targetId) ?? "",
    };
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

  async lifecycle(
    threadId: string,
    accessKey: string,
    action: string,
    commandId: string,
    nowMs: number,
  ): Promise<Reply> {
    if (!this.hasControlAccess() || accessKey !== this.controlAccessKey())
      throw new Error("Reconnect and check your permission before updating this thread.");
    if (threadId !== this.selected || !this.history(threadId).ready)
      throw new Error("Wait for this thread to finish reconnecting.");
    const status = this.threadStatus(threadId, nowMs, false);
    if (status?.kind !== "lifecycle" || status.action !== action)
      throw new Error("This thread action is no longer available.");
    const payload =
      action === "dismiss"
        ? { type: "thread.visit", commandId, threadId, visitedAt: status.actionTimestamp }
        : {
            type: action === "wake" ? "thread.unsnooze" : "thread.unsettle",
            commandId,
            threadId,
            reason: "user",
          };
    const id = this.request("orchestration.dispatchCommand", payload);
    const reply = await new Promise<Reply>((resolve) => this.replies.set(id, resolve));
    if (!reply.ok && /permission|forbidden|unauthorized|scope|not authorized/i.test(reply.error)) {
      this.controlGrant = false;
      this.controlEpoch++;
    }
    return reply;
  }

  async fork(
    threadId: string,
    rowId: string,
    accessKey: string,
    commandId: string,
    targetThreadId: string,
  ): Promise<Reply> {
    if (!this.hasControlAccess() || accessKey !== this.controlAccessKey())
      throw new Error("Reconnect and check your permission before forking this response.");
    const history = this.transcripts.get(threadId);
    if (threadId !== this.selected || !history?.ready || !history.synchronized)
      throw new Error("Wait for this thread to finish reconnecting.");
    const row = history.row(rowId);
    const point = history.forkPoint(rowId, this.transcripts.get(row?.sourceThreadId ?? ""));
    if (!point || !history.feed().find((entry) => entry.id === rowId)?.message?.canFork)
      throw new Error("This response can no longer be forked.");
    const id = this.request("orchestration.dispatchCommand", {
      type: "thread.fork",
      commandId,
      createdBy: "user",
      creationSource: "mobile",
      sourceThreadId: point.sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: point.runId },
      title: `${string(this.shells.get(threadId)?.title) || "Thread"} fork`,
    });
    const reply = await new Promise<Reply>((resolve) => this.replies.set(id, resolve));
    if (!reply.ok && /permission|forbidden|unauthorized|scope|not authorized/i.test(reply.error)) {
      this.controlGrant = false;
      this.controlEpoch++;
    }
    return reply;
  }

  timeline(threadId: string): readonly TimelineRow[] {
    return this.transcripts.get(threadId)?.visibleRows() ?? [];
  }

  private toolViewKey(threadId: string): string {
    return JSON.stringify([
      this.environment.id,
      this.serial,
      threadId,
      this.transcripts.get(threadId)?.generation ?? -1,
    ]);
  }

  markdownBlocks(
    threadId: string,
    viewKey: string,
    refs: { messageId: string; blockId: string }[],
    kind: "code" | "table",
  ) {
    if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return [];
    const history = this.transcripts.get(threadId);
    if (!history || history.deleted) return [];
    return refs.slice(-64).flatMap((ref) => {
      const expanded = this.tools.get(ref.messageId);
      const block =
        history.block(ref.messageId, ref.blockId) ??
        (expanded?.panel.state === "ready" && this.currentTool(expanded)
          ? expanded.panel.blocks.find((candidate) => candidate.id === ref.blockId)
          : undefined);
      return block?.kind === kind ? [block] : [];
    });
  }

  mediaTarget(threadId: string, viewKey: string, ref: MediaRef) {
    if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId)) return;
    const history = this.transcripts.get(threadId);
    if (!history || history.deleted) return;
    const expanded = this.tools.get(ref.messageId);
    const active =
      expanded?.panel.state === "ready" && this.currentTool(expanded) ? expanded : undefined;
    const parentBlockId = ref.blockId.replace(/:cell:\d+:\d+:image:\d+$/, "");
    const block =
      history.block(ref.messageId, parentBlockId) ??
      active?.panel.blocks.find((candidate) => candidate.id === parentBlockId) ??
      (ref.blockId === "viewed-image" && active
        ? viewedImageBlock(active.source.viewedImagePath)
        : undefined);
    const image =
      block?.kind === "image" && block.id === ref.blockId
        ? block
        : block?.kind === "table"
          ? block.cells
              .flatMap((cell) => cell.parts)
              .find((part) => part.id === ref.blockId && part.imageSource)
          : undefined;
    if (!image) return;
    const shell = this.shells.get(threadId);
    const root =
      string(shell?.worktreePath) ||
      string(this.projects.get(string(shell?.projectId))?.workspaceRoot);
    return resolveMediaTarget(
      ref,
      image.imageSource,
      image.imageAlt,
      threadId,
      root || null,
      ref.blockId === "viewed-image",
    );
  }

  mediaTargets(threadId: string, viewKey: string, messageId: string) {
    const history = this.transcripts.get(threadId);
    const expanded = this.tools.get(messageId);
    const blocks =
      history?.feed().find((row) => row.message?.id === messageId)?.message?.blocks ??
      expanded?.panel.blocks ??
      [];
    const refs = blocks.flatMap((block) =>
      block.kind === "image"
        ? [{ messageId, blockId: block.id }]
        : block.kind === "table"
          ? block.cells.flatMap((cell) =>
              cell.parts
                .filter((part) => part.imageSource)
                .map((part) => ({ messageId, blockId: part.id })),
            )
          : [],
    );
    if (expanded && viewedImageBlock(expanded.source.viewedImagePath))
      refs.unshift({ messageId, blockId: "viewed-image" });
    return refs.slice(0, 100).flatMap((ref) => {
      const target = this.mediaTarget(threadId, viewKey, ref);
      return target ? [target] : [];
    });
  }

  private currentTool(entry: ExpandedTool): TimelineRow | undefined {
    if (entry.threadId !== this.selected || entry.viewKey !== this.toolViewKey(entry.threadId))
      return;
    const history = this.transcripts.get(entry.threadId);
    const row = history?.row(entry.request.rowId);
    return !history?.deleted &&
      row &&
      toolSummary(row.item) &&
      toolRevision(row.item) === entry.request.revision
      ? row
      : undefined;
  }

  private removeTool(entry: ExpandedTool) {
    this.tools.delete(entry.request.rowId);
    if (entry.requestId && this.socket?.readyState === 1)
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: entry.requestId }));
    entry.resolve();
  }

  private hydrateToolImages(entry: ExpandedTool, now: number): Promise<void> | undefined {
    const row = this.currentTool(entry);
    if (
      !row ||
      this.tools.get(entry.request.rowId) !== entry ||
      entry.source.type !== "dynamic_tool" ||
      entry.panel.state !== "ready"
    )
      return;
    const images = entry.panel.images;
    if (entry.imageLoad?.images === images) return entry.imageLoad.promise;
    const pending = images
      .map((image, index) => ({ image, index }))
      .filter(
        ({ image }) =>
          !image.error &&
          !image.url.startsWith("data:") &&
          (!image.url || image.expiresAt <= now + 5 * 60_000),
      );
    if (pending.length === 0) return;
    const promise = Promise.all(
      pending.map(async ({ image, index }) => {
        try {
          const signed = await this.attachments.readToolImage({
            threadId: row.sourceThreadId,
            itemId: row.sourceItemId,
            index,
          });
          if (!Number.isFinite(signed.expiresAt) || signed.expiresAt <= now)
            throw new Error("The image URL has expired. Retry to load it.");
          return {
            image: { ...image, url: signed.url, expiresAt: signed.expiresAt, error: "" },
            index,
          };
        } catch (error) {
          return {
            image: {
              ...image,
              url: "",
              expiresAt: 0,
              error: error instanceof Error ? error.message : "This image could not be loaded.",
            },
            index,
          };
        }
      }),
    )
      .then((resolved) => {
        if (
          this.tools.get(entry.request.rowId) !== entry ||
          !this.currentTool(entry) ||
          entry.panel.images !== images
        )
          return;
        entry.panel = {
          ...entry.panel,
          images: images.map(
            (image, index) => resolved.find((item) => item.index === index)?.image ?? image,
          ),
        };
      })
      .finally(() => {
        if (entry.imageLoad?.promise === promise) entry.imageLoad = undefined;
      });
    entry.imageLoad = { images, promise };
    return promise;
  }

  toolImages(threadId: string, rowId: string) {
    const entry = this.tools.get(rowId);
    if (!entry || entry.threadId !== threadId || entry.panel.state !== "ready") return;
    const row = this.currentTool(entry);
    if (!row || entry.source.type !== "dynamic_tool") return;
    return {
      threadId: row.sourceThreadId,
      itemId: row.sourceItemId,
      images: entry.panel.images.map((image) => ({ ...image })),
    };
  }

  clearToolPanels() {
    for (const entry of this.tools.values()) this.removeTool(entry);
  }

  private pruneTools() {
    for (const entry of this.tools.values()) {
      const row = this.currentTool(entry);
      if (!row) {
        this.removeTool(entry);
        continue;
      }
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

  async toolPanels(
    threadId: string,
    viewKey: string,
    wanted: readonly ToolRequest[],
    now: number,
  ): Promise<ToolBatch> {
    if (threadId !== this.selected || viewKey !== this.toolViewKey(threadId))
      return { viewKey, panels: [] };
    this.pruneTools();
    for (const entry of this.tools.values()) {
      if (
        !wanted.some(
          (request) =>
            request.rowId === entry.request.rowId &&
            request.revision === entry.request.revision &&
            request.retry === entry.request.retry,
        )
      )
        this.removeTool(entry);
    }
    const entries: ExpandedTool[] = [];
    for (const request of wanted) {
      const row = this.transcripts.get(threadId)?.row(request.rowId);
      if (!row || !toolSummary(row.item) || toolRevision(row.item) !== request.revision) continue;
      let entry = this.tools.get(request.rowId);
      if (!entry) {
        let resolve = () => {};
        const first = new Promise<void>((done) => {
          resolve = done;
        });
        const streaming =
          row.item.type === "command_execution" &&
          object(object(this.config.environment).capabilities).commandOutputStreaming === true;
        entry = {
          threadId,
          viewKey,
          request,
          source: row.item,
          requestId: "",
          stream: streaming,
          terminal: EMPTY_TERMINAL_OUTPUT,
          first,
          resolve,
          panel: { ...request, state: "loading", ...toolBody(row.item), error: "" },
        };
        this.tools.set(request.rowId, entry);
        try {
          if (streaming) {
            entry.panel.output = "";
            entry.requestId = this.request("orchestration.subscribeCommandOutput", {
              threadId: row.sourceThreadId,
              itemId: row.sourceItemId,
            });
          } else if (toolNeedsDetail(row.item, false)) {
            entry.requestId = this.request("orchestration.getTurnItem", {
              threadId: row.sourceThreadId,
              itemId: row.sourceItemId,
              revision: request.revision,
            });
          } else {
            entry.panel.state = "ready";
            entry.resolve();
          }
        } catch (error) {
          entry.panel.state = "error";
          entry.panel.error =
            error instanceof Error ? error.message : "Could not load this activity.";
          entry.resolve();
        }
      }
      entries.push(entry);
    }
    if (entries.length) await Promise.race(entries.map((entry) => entry.first));
    await Promise.all(entries.map((entry) => this.hydrateToolImages(entry, now)));
    return {
      viewKey,
      panels: entries
        .filter((entry) => this.tools.get(entry.request.rowId) === entry && this.currentTool(entry))
        .map((entry) => {
          const image = viewedImageBlock(entry.source.viewedImagePath);
          return {
            ...entry.panel,
            blocks: image ? [image, ...entry.panel.blocks] : entry.panel.blocks,
          };
        }),
    };
  }

  private toolFrame(entry: ExpandedTool, frame: ObjectValue) {
    if (!this.currentTool(entry)) {
      this.removeTool(entry);
      return;
    }
    if (
      !entry.stream ||
      !["replace", "append"].includes(string(frame.kind)) ||
      typeof frame.text !== "string" ||
      typeof frame.running !== "boolean" ||
      typeof frame.truncated !== "boolean"
    ) {
      entry.panel.state = "error";
      entry.panel.error = "The server returned invalid command output.";
      entry.resolve();
      return;
    }
    const before = frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : entry.terminal;
    entry.terminal = appendTerminalOutput(before, frame.text);
    entry.panel = {
      ...entry.panel,
      state: "ready",
      output: terminalOutputPlainText(entry.terminal.text),
      truncated:
        entry.terminal.truncated ||
        frame.truncated ||
        (frame.kind === "append" && entry.panel.truncated),
      error: "",
    };
    entry.resolve();
  }

  private toolExit(entry: ExpandedTool, exit: ObjectValue, error: string) {
    if (!this.currentTool(entry)) {
      this.removeTool(entry);
      return;
    }
    entry.requestId = "";
    if (error) entry.panel = { ...entry.panel, state: "error", error };
    else if (entry.stream) entry.panel = { ...entry.panel, state: "ready" };
    else {
      const value = object(exit.value);
      const item = object(value.item);
      const current = this.currentTool(entry)!;
      if (value.item === null)
        entry.panel = {
          ...entry.panel,
          state: "missing",
          error: "This activity is no longer available.",
        };
      else if (
        item.id !== current.sourceItemId ||
        item.threadId !== current.sourceThreadId ||
        item.type !== current.item.type
      )
        entry.panel = {
          ...entry.panel,
          state: "error",
          error: "The server returned invalid activity detail.",
        };
      else if (entry.request.revision !== "live" && toolRevision(item) !== entry.request.revision)
        entry.panel = {
          ...entry.panel,
          state: "error",
          error: "This activity changed while its output loaded. Retry to load it again.",
        };
      else entry.panel = { ...entry.panel, ...toolBody(item), state: "ready", error: "" };
    }
    entry.resolve();
  }

  async loadEarlier(
    threadId: string,
    read: (relativePath: string) => Promise<unknown>,
  ): Promise<Reply> {
    const history = this.transcripts.get(threadId);
    if (
      !history?.ready ||
      history.deleted ||
      !history.hasMore ||
      !history.cursor ||
      history.loading
    )
      return { ok: true, error: "" };
    const generation = history.generation;
    const cursor = history.cursor;
    const current = () =>
      this.transcripts.get(threadId) === history &&
      history.generation === generation &&
      history.cursor === cursor;
    history.loading = true;
    history.error = "";
    try {
      const query = new URLSearchParams({ cursor });
      const page = object(
        await read(`/api/orchestration/threads/${encodeURIComponent(threadId)}/history?${query}`),
      );
      if (!current()) return { ok: true, error: "" };
      if (
        !Array.isArray(page.items) ||
        typeof page.hasMoreHistory !== "boolean" ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")
      )
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
    const view = projectThreadSettings(
      this.config,
      thread ?? { id: threadId },
      staged,
      this.settingsPolicy(thread),
    );
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
    if (!this.shells.has(threadId))
      return { ok: false, error: "This thread is no longer available." };
    const settings = this.config.settings;
    if (!settings) return { ok: false, error: "Model favorites are still loading." };
    const model = this.settings(threadId)
      .groups.flatMap((group) => group.models)
      .find((model) => model.id === modelId);
    const saved = !favorite
      ? records(object(settings).favorites).find(
          (entry) => `${string(entry.provider)}:${string(entry.model)}` === modelId,
        )
      : undefined;
    const target = model
      ? { provider: model.instanceId, model: model.slug }
      : saved
        ? { provider: string(saved.provider), model: string(saved.model) }
        : undefined;
    if (!target?.provider || !target.model)
      return { ok: false, error: "This model is no longer available." };
    try {
      const updated = await this.query("server.updateSettings", {
        patch: {
          setModelFavorites: [{ ...target, favorite }],
          ...(object(settings).favorites === null
            ? { migrateModelPreferences: { favorites: [] } }
            : {}),
        },
      });
      if (this.config.settings === settings) this.config.settings = updated;
      return { ok: true, error: "" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The favorite could not be updated.",
      };
    }
  }

  private settingsPolicy(thread: ObjectValue | undefined) {
    const projection = this.switching;
    if (thread && projection && projection.thread.id === thread.id)
      return { canSwitchProvider: supportsProviderHandoff(projection) };
    const backgroundHolds =
      thread?.status !== "failed" &&
      records(thread?.pendingBackgroundTasks).some(
        (task) =>
          task.awaited === true || task.kind === "subagent" || task.kind === "background_task",
      );
    return {
      canSwitchProvider:
        !thread ||
        (thread.latestRunId == null &&
          thread.latestUserMessageAt == null &&
          thread.activeProviderThreadId == null &&
          !backgroundHolds),
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

  approvalSend(threadId: string): ApprovalSend | null {
    return captureApprovalSend(this.controls(threadId).requests);
  }

  send(
    threadId: string,
    text: string,
    commandId: string,
    messageId: string,
    staged?: ThreadSettingsSelection | null,
    attachments: StoredAttachment[] = [],
    replayUnknown = false,
    options: { approval?: ApprovalSend | null; isCurrent?: () => boolean } = {},
  ): Promise<{ ok: boolean; error: string; state: string }> {
    const refused = (error: string) => ({
      ok: false,
      error,
      state: replayUnknown ? "unknown" : "rejected",
    });
    const approval =
      options.approval !== undefined
        ? options.approval
        : replayUnknown
          ? null
          : this.approvalSend(threadId);
    if (approval && !text.trim() && !attachments.length)
      return Promise.resolve(refused("Write a message or add an attachment first."));
    if (approval?.type === "feedback") {
      if (attachments.length)
        return Promise.resolve(
          refused("Send approval feedback without attachments or added context."),
        );
      if (!text.trim()) return Promise.resolve(refused("Write approval feedback before sending."));
    }
    try {
      validateAttachments(attachments, this.attachments.metadata().maxFileBytes, true);
    } catch (error) {
      return Promise.resolve(
        refused(error instanceof Error ? error.message : "Invalid attachments."),
      );
    }
    const dispatchMessage = (modelSelection?: ModelSelection) => {
      const shell = this.shells.get(threadId);
      return this.query("orchestration.dispatchCommand", {
        type: "message.dispatch",
        commandId,
        threadId,
        messageId,
        text,
        attachments,
        createdBy: "user",
        creationSource: "mobile",
        dispatchMode:
          approval?.type === "redirect" && shell?.activeRunId
            ? { type: "steer_active", targetRunId: shell.activeRunId }
            : { type: shell?.activeRunId ? "queue_after_active" : "start_immediately" },
        ...(approval?.type === "redirect" ? { deliveryIntent: "steer" } : {}),
        ...(modelSelection ? { modelSelection } : {}),
      }).then(
        () => ({ ok: true, error: "", state: "accepted" }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : "Delivery could not be confirmed.",
          state: !replayUnknown && error instanceof RpcFailure ? "rejected" : "unknown",
        }),
      );
    };
    const accessKey = this.controlAccessKey();
    const sendSocket = this.socket;
    const current = () =>
      threadId === this.selected &&
      this.controls(threadId).ready &&
      this.hasControlAccess() &&
      accessKey === this.controlAccessKey() &&
      options.isCurrent?.() !== false;
    const dispatch = async (modelSelection?: ModelSelection) => {
      if (!approval) return dispatchMessage(modelSelection);
      if (!current())
        return refused("The thread or draft changed. Review your message before sending again.");
      const controls = this.controls(threadId);
      if (!replayUnknown && controls.requests.some((request) => request.pending))
        return refused("Wait for the current response to finish sending.");
      const targets =
        approval.type === "feedback" ? approval.requests.slice(0, 1) : approval.requests;
      for (const target of targets) {
        if (!current())
          return refused("The thread or draft changed. Review your message before sending again.");
        if (!target.live) continue;
        const responseId = `${commandId}:approval:${target.id}`;
        const feedback = approval.type === "feedback" ? text.trim() : undefined;
        try {
          if (replayUnknown) {
            // Reuse the durable command identity even when its request has already resolved.
            await this.query("orchestration.dispatchCommand", {
              type: "runtime-request.respond",
              commandId: responseId,
              threadId,
              requestId: target.id,
              decision: "decline",
              ...(feedback === undefined ? {} : { feedback }),
            });
          } else {
            const reply = await this.control(
              threadId,
              accessKey,
              "redirect",
              target.id,
              "decline",
              [],
              responseId,
              { feedback },
            );
            if (!reply.ok)
              return {
                ...refused(reply.error),
                state:
                  this.socket === sendSocket && this.socket?.readyState === 1
                    ? "rejected"
                    : "unknown",
              };
          }
        } catch (error) {
          return refused(
            error instanceof Error ? error.message : "The approval response could not be sent.",
          );
        }
      }
      if (approval.type === "feedback") return { ok: true, error: "", state: "accepted" };
      if (!current())
        return refused("The thread or draft changed. Review your message before sending again.");
      if (
        this.controls(threadId).requests.some(
          (request) =>
            request.kind === "question" ||
            (request.kind === "approval" &&
              !approval.requests.some((sent) => sent.id === request.id)),
        )
      )
        return refused("A new request arrived. Review it before sending your message again.");
      return dispatchMessage(modelSelection);
    };
    if (approval?.type === "feedback") return dispatch();
    if (!staged) return dispatch();
    const validated = this.validateSettings(threadId, staged);
    if (!validated.ok || !validated.selection) return Promise.resolve(refused(validated.error));
    const selection = validated.selection;
    if (selection.runtimeMode === this.shells.get(threadId)?.runtimeMode)
      return dispatch(selection.modelSelection);
    return this.query("orchestration.dispatchCommand", {
      type: "thread.runtime-mode.set",
      commandId: `${commandId}:runtime-mode`,
      threadId,
      runtimeMode: selection.runtimeMode,
    }).then(
      () => {
        const latest = this.validateSettings(threadId, selection);
        if (!latest.ok || !latest.selection) return refused(latest.error);
        return dispatch(latest.selection.modelSelection);
      },
      (error: unknown) =>
        refused(error instanceof Error ? error.message : "The runtime mode could not be changed."),
    );
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

  disconnected(reason: string, status = reason) {
    this.controlEpoch++;
    this.controlGrant = false;
    this.clearToolPanels();
    this.attachments.clear();
    this.shellLive = false;
    this.shellRequest = "";
    this.switching = undefined;
    this.threadRequest = "";
    this.terminalMetadataRequest = "";
    this.terminals.clear();
    this.terminalRequests.clear();
    this.terminalRequestIds.clear();
    this.terminalOutputStates.clear();
    this.socket = undefined;
    this.gitOperations.clear();
    this.gitStatusByThread.clear();
    this.gitOperationStateByThread.clear();
    for (const history of this.transcripts.values()) history.disconnect();
    // Keep the transport error for pending commands while exposing the
    // reconnecting state to the catalog. A transient socket loss should not
    // turn an in-flight send into the misleading generic "Reconnecting" error.
    this.environment.status = status;
    for (const resolve of this.replies.values()) resolve({ ok: false, error: reason });
    this.replies.clear();
    for (const query of this.queries.values()) query.reject(new Error(reason));
    this.queries.clear();
  }

  private applyTerminalSummary(value: unknown) {
    const summary = this.terminalSummary(value);
    if (!summary) return;
    const key = this.terminalKey(summary.threadId, summary.terminalId);
    const current = this.terminals.get(key);
    this.terminals.set(key, this.terminalSummary(value, current) ?? summary);
  }

  private applyTerminalEvent(value: unknown, requestId: string) {
    const event = object(value);
    const target = this.terminalRequests.get(requestId);
    const threadId = string(event.threadId) || target?.threadId || "";
    const terminalId = string(event.terminalId) || target?.terminalId || "";
    if (!threadId || !terminalId) return;
    const key = this.terminalKey(threadId, terminalId);
    const current =
      this.terminals.get(key) ??
      ({
        threadId,
        terminalId,
        cwd: "",
        worktreePath: "",
        status: "starting",
        hasRunningSubprocess: false,
        label: terminalLabel(terminalId, ""),
        displayLabel: terminalLabel(terminalId, ""),
        updatedAt: "",
        output: "",
        error: "",
      } satisfies TerminalSession);
    const type = string(event.type);
    let next = current;
    if (type === "snapshot" || type === "started" || type === "restarted") {
      const snapshot = object(event.snapshot ?? event);
      const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, string(snapshot.history));
      this.terminalOutputStates.set(key, state);
      next = {
        ...current,
        ...(this.terminalSummary(snapshot, current) ?? {}),
        status: (string(snapshot.status) || "running") as TerminalSession["status"],
        output: terminalOutputPlainText(state.text),
        error: "",
      };
    } else if (type === "output") {
      const output = string(event.data);
      const state = appendTerminalOutput(
        this.terminalOutputStates.get(key) ?? EMPTY_TERMINAL_OUTPUT,
        output,
      );
      this.terminalOutputStates.set(key, state);
      next = { ...current, output: terminalOutputPlainText(state.text), error: "" };
    } else if (type === "cleared") {
      this.terminalOutputStates.set(key, EMPTY_TERMINAL_OUTPUT);
      next = { ...current, output: "", error: "" };
    } else if (type === "exited") {
      next = { ...current, status: "exited", hasRunningSubprocess: false, error: "" };
    } else if (type === "closed") {
      next = { ...current, status: "closed", hasRunningSubprocess: false };
    } else if (type === "error") {
      next = { ...current, status: "error", error: string(event.message) || "Terminal error" };
    } else if (type === "activity") {
      next = {
        ...current,
        hasRunningSubprocess:
          typeof event.hasRunningSubprocess === "boolean"
            ? event.hasRunningSubprocess
            : current.hasRunningSubprocess,
        label: string(event.label) || current.label,
        status: current.status === "starting" ? "running" : current.status,
      };
    }
    this.terminals.set(key, next);
  }

  receive(data: string) {
    const parsed: unknown = JSON.parse(data);
    for (const frame of records(Array.isArray(parsed) ? parsed : [parsed])) {
      const id = String(frame.requestId ?? "");
      const tool = [...this.tools.values()].find(
        (entry) => entry.requestId !== "" && entry.requestId === id,
      );
      if (frame._tag === "Chunk") {
        for (const item of records(frame.values)) {
          const git = this.gitOperations.get(id);
          if (git) this.gitProgress(git, item);
          if (tool) this.toolFrame(tool, item);
          if (id === this.shellRequest) this.shell(item);
          if (this.threadRequest && id === this.threadRequest) this.transcript(item);
          if (id === this.terminalMetadataRequest) {
            if (item.type === "snapshot") {
              this.terminals.clear();
              this.terminalOutputStates.clear();
              for (const terminal of records(item.terminals)) this.applyTerminalSummary(terminal);
            } else if (item.type === "upsert") this.applyTerminalSummary(item.terminal);
            else if (item.type === "remove") {
              this.terminals.delete(this.terminalKey(string(item.threadId), string(item.terminalId)));
              this.terminalOutputStates.delete(this.terminalKey(string(item.threadId), string(item.terminalId)));
            }
          }
          if (this.terminalRequests.has(id)) this.applyTerminalEvent(item, id);
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
        const terminalRequest = this.terminalRequests.get(id);
        if (terminalRequest) {
          if (error) this.applyTerminalEvent({ ...terminalRequest, type: "error", message: error }, id);
          this.terminalRequests.delete(id);
          this.terminalRequestIds.delete(this.terminalKey(terminalRequest.threadId, terminalRequest.terminalId));
        }
        if (tool) this.toolExit(tool, exit, error);
        if (threadEnded) {
          const history = this.transcripts.get(this.selected);
          history?.disconnect();
          if (history) history.error = error;
        }
        const query = this.queries.get(id);
        this.queries.delete(id);
        if (error)
          query?.reject(new RpcFailure(error, string(object(records(exit.cause)[0]?.error)._tag)));
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
        if (error && id === this.shellRequest) this.environment.status = error;
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
        if (this.switching && !this.shells.has(this.switching.thread.id))
          this.switching = undefined;
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

  private gitProgress(
    operation: { threadId: string; actionId: string; action: GitAction },
    item: ObjectValue,
  ) {
    const kind = string(item.kind);
    const current = this.gitOperationStateByThread.get(operation.threadId);
    if (!current || current.status !== "running" || current.actionId !== operation.actionId) return;
    if (kind === "phase_started" || kind === "hook_started") {
      const phase = string(item.phase);
      this.gitOperationStateByThread.set(operation.threadId, {
        ...current,
        phase:
          phase === "branch" || phase === "commit" || phase === "push" || phase === "pr"
            ? phase
            : current.phase,
        message: string(item.label) || string(item.message) || current.message,
      });
    } else if (kind === "hook_output") {
      const output = string(item.text) || string(item.output);
      if (output) this.gitOperationStateByThread.set(operation.threadId, { ...current, message: output });
    } else if (kind === "action_finished") {
      this.gitOperationStateByThread.set(operation.threadId, {
        status: "succeeded",
        actionId: operation.actionId,
        action: operation.action,
        result: object(item.result),
      });
    } else if (kind === "action_failed") {
      this.gitOperationStateByThread.set(operation.threadId, {
        status: "failed",
        actionId: operation.actionId,
        action: operation.action,
        error: string(item.message) || "Git action failed.",
      });
    }
  }

  private updateSwitching(event: ObjectValue) {
    const projection = this.switchingSnapshots.get(this.selected);
    if (!projection || event.threadId !== projection.thread.id) return;
    const payload = object(event.payload);
    const type = string(event.type);
    if (type === "thread.archived" || type === "thread.deleted") {
      this.switching = undefined;
      this.switchingSnapshots.delete(this.selected);
    } else if (
      type.startsWith("thread.") &&
      payload.id === projection.thread.id &&
      payload.modelSelection
    ) {
      projection.thread = switchingThread(payload);
    } else if (type === "run.created" || type === "run.updated") {
      projection.runs = upsertSwitchingRecord(projection.runs, switchingRun(payload));
    } else if (type === "provider-thread.updated") {
      projection.providerThreads = upsertSwitchingRecord(
        projection.providerThreads,
        switchingProviderThread(payload),
      );
    } else if (type === "provider-session.attached" || type === "provider-session.updated") {
      projection.providerSessions = upsertSwitchingRecord(
        projection.providerSessions,
        switchingSession(payload),
      );
    } else if (type === "provider-session.detached") {
      projection.providerSessions = projection.providerSessions.filter(
        (session) => session.id !== payload.providerSessionId,
      );
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

  threadStatus(threadId: string, nowMs: number, stopping: boolean) {
    if (threadId !== this.selected) return null;
    const shell = this.shells.get(threadId);
    if (!shell) return null;
    const state = this.environment.status;
    return projectThreadStatus({
      connection: {
        phase:
          state === "Connected"
            ? "connected"
            : state === "Connecting"
              ? "connecting"
              : state === "Reconnecting"
                ? "reconnecting"
                : state === "Disconnected"
                  ? "available"
                  : "error",
        label: this.environment.label,
        error:
          state === "Connected" ||
          state === "Connecting" ||
          state === "Reconnecting" ||
          state === "Disconnected"
            ? null
            : state,
      },
      history: this.history(threadId),
      controls: this.controls(threadId),
      lifecycle: threadLifecycleStatus(shell, nowMs),
      startedAt: threadWorkStartedAt(shell),
      compacting: threadIsCompacting(
        string(shell.activeRunId),
        this.transcripts
          .get(threadId)
          ?.visibleRows()
          .map((row) => row.item) ?? [],
      ),
      stopping,
      nowMs,
    });
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
        const history = this.transcripts.get(id);
        const rows = history
          ? history.feed().map((row) => {
              if (!row.message?.canFork) return row;
              const sourceId = history.row(row.id)?.sourceThreadId;
              const source =
                sourceId && sourceId !== id ? this.transcripts.get(sourceId) : undefined;
              return source && !history.forkPoint(row.id, source)
                ? { ...row, message: { ...row.message, canFork: false } }
                : row;
            })
          : [];
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
          modelRevision: JSON.stringify(thread.modelSelection ?? null),
          lastError: error.message,
          lastErrorTime: error.time,
          settled,
          working: working(thread),
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
