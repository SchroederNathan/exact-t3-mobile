import type { Result, StreamSocket } from "./app.contract.d.ts";

export type Catalog = Result<"loadCatalog">;
export type Environment = Catalog["environments"][number];
type Thread = Catalog["threads"][number];
type Message = Thread["messages"][number];
type Reply = Result<"command">;
type ObjectValue = Record<string, unknown>;

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

export function parsePairingAddress(
  address: string,
  code: string,
): { origin: string; credential: string } {
  let input = address.trim();
  if (!input) throw new Error("Enter your server address or pairing URL.");
  if (!input.includes("://")) {
    const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?::|\/|$)/i.test(input);
    input = `${local ? "http" : "https"}://${input}`;
  }
  let url = new URL(input);
  const nested = url.searchParams.get("pairingUrl");
  if (nested && url.protocol.startsWith("t3code")) return parsePairingAddress(nested, code);
  const credential =
    code.trim() ||
    new URLSearchParams(url.hash.slice(1)).get("token") ||
    url.searchParams.get("token") ||
    "";
  const host = url.searchParams.get("host");
  if (host) url = new URL(host);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Use an HTTP or HTTPS server address.");
  if (url.username || url.password)
    throw new Error("Use a pairing code instead of credentials in the address.");
  if (!credential) throw new Error("Enter the pairing code from T3 Code on your computer.");
  return { origin: url.origin, credential };
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

function message(value: ObjectValue): Message | null {
  const id = string(value.id);
  const role = string(value.role);
  if (!id || (role !== "user" && role !== "assistant" && role !== "system")) return null;
  return { id, role, body: string(value.text), createdAt: string(value.createdAt) };
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

export class DirectSession {
  readonly environment: Environment;
  private socket: StreamSocket | undefined;
  private nextId = 0;
  private shellRequest = "";
  private threadRequest = "";
  private selected = "";
  private projects = new Map<string, string>();
  private shells = new Map<string, ObjectValue>();
  private transcripts = new Map<string, Message[]>();
  private replies = new Map<string, (reply: Reply) => void>();

  constructor(environment: Environment) {
    this.environment = { ...environment, status: "Connecting" };
  }

  private request(tag: string, payload: unknown): string {
    if (!this.socket || this.socket.readyState !== 1)
      throw new Error("This environment is disconnected. Reconnect before sending.");
    const id = String(++this.nextId);
    this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return id;
  }

  open(socket: StreamSocket) {
    this.socket = socket;
    this.environment.status = "Connected";
    this.shellRequest = this.request("orchestration.subscribeShell", {});
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

  disconnected(reason: string) {
    this.socket = undefined;
    this.environment.status = reason;
    for (const resolve of this.replies.values()) resolve({ ok: false, error: reason });
    this.replies.clear();
  }

  receive(data: string) {
    const parsed: unknown = JSON.parse(data);
    for (const frame of records(Array.isArray(parsed) ? parsed : [parsed])) {
      const id = String(frame.requestId ?? "");
      if (frame._tag === "Chunk") {
        for (const item of records(frame.values)) {
          if (id === this.shellRequest) this.shell(item);
          if (id === this.threadRequest) this.transcript(item);
        }
        this.socket?.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit") {
        const exit = object(frame.exit);
        const error = exit._tag === "Success" ? "" : failure(exit);
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
      this.projects = new Map(
        records(snapshot.projects).map((project) => [string(project.id), string(project.title)]),
      );
      this.shells = new Map(records(snapshot.threads).map((thread) => [string(thread.id), thread]));
    } else if (item.kind === "project.updated") {
      const project = object(item.project);
      this.projects.set(string(project.id), string(project.title));
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

  private transcript(item: ObjectValue) {
    if (item.kind === "snapshot") {
      const projection = object(item.projection);
      const messages = records(projection.messages)
        .map(message)
        .filter((value): value is Message => value !== null);
      this.transcripts.set(this.selected, messages);
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
            : messages.map((value) => (value.id === updated.id ? updated : value)),
        );
      }
    }
  }

  threads(): Thread[] {
    return [...this.shells.entries()]
      .filter(
        ([, thread]) =>
          !thread.deletedAt &&
          !thread.archivedAt &&
          object(thread.lineage).relationshipToParent !== "subagent" &&
          object(thread.lineage).sideChat !== true,
      )
      .sort(([, left], [, right]) => string(right.updatedAt).localeCompare(string(left.updatedAt)))
      .map(([id, thread]) => ({
        id: scopedThreadId(this.environment.id, id),
        environmentId: this.environment.id,
        project: this.projects.get(string(thread.projectId)) || "Project",
        title: string(thread.title),
        status: status(thread),
        updatedAt: string(thread.updatedAt),
        messages: this.transcripts.get(id) ?? [],
      }));
  }
}
