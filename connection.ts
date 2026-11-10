import type { Result, StreamSocket } from "./app.contract.d.ts";
import { markdownBlocks } from "./markdown";

export type Catalog = Result<"loadCatalog">;
export type Environment = Catalog["environments"][number];
type Thread = Catalog["threads"][number];
type Message = Thread["messages"][number];
type Activity = Message["activities"][number];
type Reply = Result<"command">;
type ObjectValue = Record<string, unknown>;
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

const markdownBlockCache = new Map<string, Message["blocks"]>();

function cachedMarkdownBlocks(id: string, body: string): Message["blocks"] {
  const key = `${id}:${body}`;
  const cached = markdownBlockCache.get(key);
  if (cached) return cached;
  const blocks = markdownBlocks(body, id);
  markdownBlockCache.set(key, blocks);
  if (markdownBlockCache.size > 2048) {
    const oldest = markdownBlockCache.keys().next().value;
    if (oldest) markdownBlockCache.delete(oldest);
  }
  return blocks;
}

function message(value: ObjectValue): Message | null {
  const id = string(value.id);
  const role = string(value.role);
  if (!id || (role !== "user" && role !== "assistant" && role !== "system")) return null;
  const createdAt = string(value.createdAt);
  const date = new Date(createdAt);
  const timeLabel = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const body = string(value.text);
  return {
    id,
    role,
    body,
    createdAt,
    timeLabel,
    runId: string(value.runId),
    streaming: value.streaming === true,
    blocks: cachedMarkdownBlocks(id, body),
    activities: [],
  };
}

function activityRow(
  value: ObjectValue,
  metadata: { position?: unknown; sourceThreadId?: unknown; sourceItemId?: unknown } = {},
): Activity | null {
  const id = string(value.id);
  const kind = string(value.type) || "activity";
  if (!id) return null;
  const status = string(value.status) || "idle";
  const title =
    string(value.title).trim() ||
    string(value.toolName).trim() ||
    (kind === "reasoning"
      ? "Thinking"
      : kind === "command_execution"
        ? "Command"
        : kind === "file_change"
          ? "Changed files"
          : kind === "file_search"
            ? "Searched files"
            : kind === "web_search"
              ? "Searched the web"
              : kind === "dynamic_tool"
                ? "Tool call"
                : kind.replaceAll("_", " "));
  const input = string(value.input);
  const output =
    typeof value.output === "string"
      ? value.output
      : value.output === undefined
        ? ""
        : JSON.stringify(value.output, null, 2);
  const detail =
    string(value.text) ||
    string(value.detail) ||
    string(value.fileName) ||
    string(value.pattern) ||
    (input ? `Input\n${input}${output ? `\n\nOutput\n${output}` : ""}` : output) ||
    title;
  return {
    id,
    kind,
    title,
    detail,
    status,
    startedAt: string(value.startedAt) || string(value.updatedAt),
    runId: string(value.runId),
    position: Number(metadata.position ?? value.position ?? value.ordinal ?? 0),
    sourceThreadId: string(metadata.sourceThreadId ?? value.sourceThreadId),
    sourceItemId: string(metadata.sourceItemId ?? value.sourceItemId) || id,
  };
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

function status(thread: ObjectValue): string {
  if (thread.pendingRuntimeRequest) return "Waiting";
  switch (thread.status) {
    case "preparing":
    case "starting":
    case "running":
      return "Working";
    case "waiting":
    case "queued":
      return "Waiting";
    case "failed":
      return "Error";
    default:
      return "Done";
  }
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

export class DirectSession {
  readonly environment: Environment;
  private socket: StreamSocket | undefined;
  private nextId = 0;
  private shellRequest = "";
  private configRequest = "";
  private threadRequest = "";
  private selected = "";
  private projects = new Map<string, ObjectValue>();
  private config: ObjectValue = {};
  private faviconRequests = new Map<string, string>();
  private favicons = new Map<string, { revision: string; url: string }>();
  private shells = new Map<string, ObjectValue>();
  private transcripts = new Map<string, Message[]>();
  private replies = new Map<string, (reply: Reply) => void>();
  private queries = new Map<
    string,
    { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }
  >();

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
    this.socket = socket;
    this.environment.status = "Connected";
    this.shellRequest = this.request("orchestration.subscribeShell", {});
    this.configRequest = this.request("subscribeServerConfig", {
      workspaceSnapshotsOnDemand: true,
      providerCatalogsOnDemand: true,
    });
    if (this.selected)
      this.threadRequest = this.request("orchestration.subscribeThread", {
        threadId: this.selected,
      });
  }

  select(threadId: string) {
    if (threadId === this.selected && this.threadRequest) return;
    this.selected = threadId;
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.threadRequest)
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: this.threadRequest }));
    this.threadRequest = this.request("orchestration.subscribeThread", { threadId });
  }

  send(threadId: string, text: string, commandId: string, messageId: string): Promise<Reply> {
    const shell = this.shells.get(threadId);
    const id = this.request("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId,
      threadId,
      messageId,
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
      dispatchMode: { type: shell?.activeRunId ? "queue_after_active" : "start_immediately" },
    });
    return new Promise((resolve) => this.replies.set(id, resolve));
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
    this.socket = undefined;
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
      if (frame._tag === "Chunk") {
        for (const item of records(frame.values)) {
          if (id === this.shellRequest) this.shell(item);
          if (id === this.threadRequest) this.transcript(item);
          if (id === this.configRequest) {
            if (item.type === "snapshot") this.config = object(item.config);
            if (item.type === "providerStatuses")
              this.config.providers = object(item.payload).providers;
            if (item.type === "settingsUpdated")
              this.config.settings = object(item.payload).settings;
            this.environment.machineSymbol = machineSymbol(this.config);
          }
        }
        this.socket?.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit") {
        const exit = object(frame.exit);
        const error = exit._tag === "Success" ? "" : failure(exit);
        const query = this.queries.get(id);
        this.queries.delete(id);
        if (error) query?.reject(new Error(error));
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
        if (error && (id === this.shellRequest || id === this.threadRequest))
          this.environment.status = error;
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
        this.projects = new Map(projects.map((project) => [string(project.id), project]));
        this.shells = new Map(
          records(snapshot.threads).map((thread) => [string(thread.id), thread]),
        );
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
      this.shells.delete(string(item.threadId));
      this.transcripts.delete(string(item.threadId));
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
    if (item.kind === "snapshot") {
      const projection = object(item.projection);
      const messages = records(projection.messages)
        .map(message)
        .filter((value): value is Message => value !== null);
      const activityRows = records(
        projection.visibleTurnItems ?? projection.turnItems ?? projection.items,
      )
        .map((row) => {
          const item = object(row.item);
          const source = string(item.id) ? item : row;
          return {
            row: string(item.id) ? row : { item: row, position: row.position ?? row.ordinal },
            activity: activityRow(source, {
              position: row.position,
              sourceThreadId: row.sourceThreadId,
              sourceItemId: row.sourceItemId,
            }),
          };
        })
        .filter((value): value is { row: ObjectValue; activity: Activity } => value.activity !== null)
        .sort(
          (left, right) =>
            Number(left.row.position ?? object(left.row.item).ordinal ?? 0) -
            Number(right.row.position ?? object(right.row.item).ordinal ?? 0),
        );
      this.transcripts.set(this.selected, this.attachActivities(messages, activityRows));
    } else if (item.kind === "event") {
      const event = object(item.event);
      if (event.type === "message.updated") {
        const updated = message(object(event.payload));
        if (!updated) return;
        const messages = this.transcripts.get(this.selected) ?? [];
        const index = messages.findIndex((value) => value.id === updated.id);
        this.transcripts.set(
          this.selected,
          index < 0
            ? [...messages, updated]
            : messages.map((value) =>
                value.id === updated.id ? { ...updated, activities: value.activities } : value,
              ),
        );
      } else if (event.type === "turn-item.updated") {
        const payload = object(event.payload);
        const updated = activityRow(object(payload.item).id ? object(payload.item) : payload);
        if (!updated) return;
        const messages = this.transcripts.get(this.selected) ?? [];
        const found = messages.some((message) =>
          message.activities.some((candidate) => candidate.id === updated.id),
        );
        if (found) {
          this.transcripts.set(
            this.selected,
            messages.map((message) => ({
              ...message,
              activities: message.activities.map((candidate) =>
                candidate.id === updated.id ? updated : candidate,
              ),
            })),
          );
        } else {
          this.transcripts.set(
            this.selected,
            this.attachActivities(messages, [{ row: object(event.payload), activity: updated }]),
          );
        }
      }
    }
  }

  private attachActivities(
    source: Message[],
    rows: { row: ObjectValue; activity: Activity }[],
  ): Message[] {
    const messages = source.map((message) => ({ ...message, activities: [...message.activities] }));
    for (const { row, activity: next } of rows) {
      const item = object(row.item);
      const runId = next.runId || string(item.runId) || string(row.runId);
      let index = messages.findLastIndex(
        (message) =>
          message.role === "assistant" && (!runId || !message.runId || message.runId === runId),
      );
      if (index < 0) index = messages.findLastIndex((message) => message.role === "assistant");
      if (index < 0) {
        messages.push({
          id: `activity:${next.id}`,
          role: "assistant",
          body: "",
          createdAt: next.startedAt,
          timeLabel: "",
          runId,
          streaming: false,
          blocks: [],
          activities: [next],
        });
      } else {
        const current = messages[index]!;
        const existing = current.activities.findIndex((candidate) => candidate.id === next.id);
        messages[index] = {
          ...current,
          activities:
            existing < 0
              ? [...current.activities, next]
              : current.activities.map((candidate) => (candidate.id === next.id ? next : candidate)),
        };
      }
    }
    return messages;
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
      .filter(
        ([, thread]) =>
          !thread.deletedAt &&
          !thread.archivedAt &&
          object(thread.lineage).relationshipToParent !== "subagent" &&
          object(thread.lineage).sideChat !== true,
      )
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
        const transcript = this.transcripts.get(id) ?? [];
        const error = errorDetails(thread);
        return {
          id: scopedThreadId(this.environment.id, id),
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
          updatedAt: relativeTime(activityAt, now),
          messages: transcript,
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
