import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

type RecordValue = Record<string, unknown>;
type Socket = { send(data: string): unknown; close?(code?: number, reason?: string): unknown };
type Attachment = { type: string; id: string; name: string; mimeType: string; sizeBytes: number };
type Asset = {
  attachment: Attachment;
  bytes?: Uint8Array;
  pending: boolean;
  dimensions?: { width: number; height: number };
};
type Upload = { attachmentId: string; ticket: string; expiresAt: number; expired: boolean };
type ReadTicket = {
  attachmentId: string;
  ticket: string;
  expiresAt: number;
  expired: boolean;
  fileName: string;
  disposition: string;
};
type Item = RecordValue & {
  id: string;
  messageId: string;
  threadId: string;
  ordinal: number;
  attachments: Attachment[];
};
type HeldPreview = { socket: Socket; requestId: string; resource: RecordValue };
type HeldUpload = { attachmentId: string; finish(status: number): void };
type Options = {
  threadChanged?(thread: RecordValue, sequence: number): void;
  disconnect?(): number;
  configChanged?(): void;
  authorization?: { get(): boolean; set(allowed: boolean): Promise<void> };
  now?: number;
};

const object = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const hash = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "access-control-allow-origin": "*" } });
const success = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));
const failure = (
  socket: Socket,
  requestId: string,
  message: string,
  tag = "FixtureValidationError",
  fields: RecordValue = {},
) =>
  socket.send(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: tag, message, ...fields } }],
      },
    }),
  );
const chunk = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const MiB = 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const threadNames = new Map([
  ["attachments-showcase", "Attachment showcase"],
  ["attachments-long", "Long attachment history"],
  ["attachments-compose", "Attachment composer"],
  ["attachments-legacy", "Legacy attachment history"],
  ["attachments-media", "Embedded screenshots"],
]);
const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "fixture-session",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

function png(environmentId: string) {
  const width = 320,
    height = 180;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rows[offset] = environmentId === "fixture" ? 36 + Math.floor(x / 3) : 190 + Math.floor(y / 4);
      rows[offset + 1] = 70 + Math.floor(y / 2);
      rows[offset + 2] = environmentId === "fixture" ? 220 : 45 + Math.floor(x / 4);
    }
  const part = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4),
      suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, body, suffix]);
  };
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(width);
  dimensions.writeUInt32BE(height, 4);
  dimensions[8] = 8;
  dimensions[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    part("IHDR", dimensions),
    part("IDAT", NodeZlib.deflateSync(rows)),
    part("IEND", Buffer.alloc(0)),
  ]);
}

function pdf(environmentId: string) {
  const content = `BT /F1 20 Tf 48 730 Td (T3 attachment fixture) Tj 0 -32 Td (${environmentId.replace(/[^a-z0-9_-]/gi, "_")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((entry, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${entry}\nendobj\n`;
  });
  const xref = source.length;
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

export class AttachmentFixture {
  private sequence = 500;
  private clock: number;
  private nextUpload = 0;
  private nextRead = 0;
  private operate = true;
  private online = true;
  private uploadsEnabled = true;
  private fileMaximum = 50 * MiB;
  private assets = new Map<string, Asset>();
  private uploads = new Map<string, Upload>();
  private readTickets = new Map<string, ReadTicket>();
  private items = new Map<string, Item[]>();
  private subscriptions = new Map<Socket, Map<string, string>>();
  private heldUploads = new Set<HeldUpload>();
  private holdingUploads = new Set<string>();
  private failUploads = new Set<string>();
  private holdPreviews = false;
  private previews: HeldPreview[] = [];
  private maximumPreviews = 0;
  private cancelledPreviews = 0;
  private activeUploads = 0;
  private maximumUploads = 0;
  private uploadBodies: RecordValue[] = [];
  private readRequests: RecordValue[] = [];
  private httpReads: RecordValue[] = [];
  private deletions: string[] = [];
  private dispatches: RecordValue[] = [];
  private commands = new Map<string, { fingerprint: string; sequence: number }>();
  private messages = new Map<string, { fingerprint: string; sequence: number }>();
  private dropReceipt = false;
  private listeners = new Set<() => void>();

  constructor(
    readonly environmentId: string,
    readonly projectId: string,
    private readonly options: Options = {},
  ) {
    this.clock = options.now ?? Date.now();
    const picture = png(environmentId),
      document = pdf(environmentId),
      note = new TextEncoder().encode(`Attachment bytes from ${environmentId}.\n`);
    for (const [id, type, name, mimeType, bytes] of [
      ["shared-image", "image", "Landscape.png", "image/png", picture],
      ["shared-pdf", "file", "Fixture report.pdf", "application/pdf", document],
      ["shared-text", "file", "Fixture notes.txt", "text/plain", note],
    ] as const)
      this.assets.set(id, {
        attachment: { id, type, name, mimeType, sizeBytes: bytes.length },
        bytes,
        pending: false,
        ...(type === "image" ? { dimensions: { width: 320, height: 180 } } : {}),
      });
    const attachment = (id: string) => ({ ...this.assets.get(id)!.attachment });
    this.items.set("attachments-media", [
      this.item(
        "attachments-media",
        0,
        "markdown-media",
        `Workspace screenshot:\n\n![Workspace screenshot](/fixture/reference.png)\n\nInline image:\n\n![Inline screenshot](data:image/png;base64,${Buffer.from(picture).toString("base64")})\n\nMissing image with retry:\n\n![Missing screenshot](/fixture/missing.png)`,
        [],
      ),
      {
        ...this.item("attachments-media", 1, "viewed-media", "", []),
        type: "dynamic_tool",
        toolName: "view_image",
        title: "Viewed screenshot",
        viewedImagePath: "/fixture/reference.png",
      },
    ]);
    this.items.set("attachments-compose", [
      this.item(
        "attachments-compose",
        0,
        "composer-intro",
        "Choose a photo or file, then send it to this environment.",
        [],
      ),
    ]);
    this.items.set("attachments-showcase", [
      this.item("attachments-showcase", 0, "image-only", "", [attachment("shared-image")]),
      this.item("attachments-showcase", 1, "mixed-files", `Files from **${environmentId}**.`, [
        attachment("shared-pdf"),
        attachment("shared-text"),
      ]),
      this.item("attachments-showcase", 2, "missing-file", "This file is no longer available.", [
        {
          type: "file",
          id: "missing-file",
          name: "Missing notes.txt",
          mimeType: "text/plain",
          sizeBytes: 24,
        },
      ]),
      this.item(
        "attachments-showcase",
        3,
        "unknown-file",
        "A future attachment type keeps its name.",
        [
          {
            type: "future-document",
            id: "future-file",
            name: "Future attachment.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 16,
          },
        ],
      ),
      this.item(
        "attachments-showcase",
        4,
        "three-images",
        "Three image collage",
        ["collage-a", "collage-b", "collage-c"].map((id) => {
          const asset = this.assets.get("shared-image")!;
          this.assets.set(id, { ...asset, attachment: { ...asset.attachment, id } });
          return { ...asset.attachment, id };
        }),
      ),
    ]);
    this.items.set("attachments-legacy", [
      this.item("attachments-legacy", 0, "legacy-image", "", [attachment("shared-image")]),
      this.item("attachments-legacy", 1, "legacy-file", "Legacy PDF", [attachment("shared-pdf")]),
    ]);
    this.items.set(
      "attachments-long",
      Array.from({ length: 240 }, (_, ordinal) => {
        const id = `history-image-${ordinal}`,
          asset = this.assets.get("shared-image")!;
        const meta = { ...asset.attachment, id, name: `History image ${ordinal + 1}.png` };
        this.assets.set(id, { ...asset, attachment: meta });
        return this.item(
          "attachments-long",
          ordinal,
          `history-${ordinal}`,
          `Attachment ${ordinal + 1} of 240`,
          [meta],
        );
      }),
    );
  }

  get config() {
    return {
      attachmentUploads: this.uploadsEnabled,
      ...(this.fileMaximum > 0 ? { fileAttachments: { maxUploadBytes: this.fileMaximum } } : {}),
    };
  }
  private allowed() {
    return this.options.authorization?.get() ?? this.operate;
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private date() {
    return new Date(this.clock + this.sequence).toISOString();
  }
  get threads() {
    return [...threadNames].map(([id, title]) => ({
      id,
      title,
      projectId: this.projectId,
      status: "idle",
      runtimeMode: "full-access",
      updatedAt: this.date(),
      latestUserMessageAt: this.date(),
      modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
    }));
  }

  private item(
    threadId: string,
    ordinal: number,
    messageId: string,
    body: string,
    attachments: Attachment[],
  ): Item {
    return {
      id: `${threadId}:${messageId}`,
      messageId,
      threadId,
      ordinal,
      runId: `${threadId}-run`,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      type: "user_message",
      status: "completed",
      streaming: false,
      title: null,
      text: body,
      attachments,
      inputIntent: "turn_start",
      startedAt: this.date(),
      completedAt: this.date(),
      updatedAt: this.date(),
    };
  }

  private row(item: Item, position = item.ordinal) {
    return {
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    };
  }

  private snapshot(socket: Socket, requestId: string, threadId: string) {
    const all = this.items.get(threadId)!,
      thread = this.threads.find((entry) => entry.id === threadId)!;
    const start = threadId === "attachments-long" ? Math.max(0, all.length - 20) : 0;
    const visible = all.slice(start),
      legacy = threadId === "attachments-legacy";
    const rows: RecordValue[] = visible.map((item) => this.row(item));
    if (threadId === "attachments-showcase") {
      const inherited = this.item(
        "attachment-ancestor",
        5,
        "inherited-image",
        "Inherited attachment",
        [{ ...this.assets.get("shared-image")!.attachment }],
      );
      rows.push({ ...this.row(inherited), visibility: "inherited" });
    }
    chunk(socket, requestId, {
      kind: "snapshot",
      snapshotSequence: this.sequence,
      historyCursor: start ? `before:${start}` : null,
      hasMoreHistory: start > 0,
      latestLocalTurnOrdinal: all.length - 1,
      projection: {
        thread,
        runs: [{ id: `${threadId}-run`, threadId, ordinal: 0, status: "completed" }],
        attempts: [],
        runtimeRequests: [],
        ...(legacy
          ? {
              messages: visible.map((item) => ({
                id: item.messageId,
                role: "user",
                text: item.text,
                attachments: item.attachments,
                createdAt: item.startedAt,
              })),
            }
          : { messages: [], turnItems: visible, visibleTurnItems: rows }),
      },
    });
    chunk(socket, requestId, { kind: "synchronized" });
  }

  private emit(item: Item) {
    const sequence = ++this.sequence;
    for (const [socket, entries] of this.subscriptions)
      for (const [requestId, threadId] of entries)
        if (threadId === item.threadId) {
          chunk(socket, requestId, {
            kind: "event",
            sequence,
            event: { type: "turn-item.updated", threadId, payload: item },
          });
        }
    const thread = this.threads.find((entry) => entry.id === item.threadId);
    if (thread) this.options.threadChanged?.(thread, sequence);
  }

  receive(socket: Socket, input: unknown): boolean {
    const frame = object(input),
      requestId = text(frame.id),
      payload = object(frame.payload);
    if (frame._tag === "Interrupt") {
      const before = this.previews.length;
      this.previews = this.previews.filter(
        (entry) => entry.socket !== socket || entry.requestId !== frame.requestId,
      );
      this.cancelledPreviews += before - this.previews.length;
      const removed = this.subscriptions.get(socket)?.delete(text(frame.requestId)) ?? false;
      if (before !== this.previews.length || removed) {
        this.changed();
        return true;
      }
      return false;
    }
    if (frame._tag !== "Request") return false;
    if (frame.tag === "attachments.createUploadUrl") {
      this.mint(socket, requestId, payload);
    } else if (frame.tag === "attachments.delete") {
      if (!this.allowed())
        failure(
          socket,
          requestId,
          "Permission denied: orchestration:operate is required.",
          "RpcPermissionDeniedError",
        );
      else if (
        !text(payload.attachmentId) ||
        Object.keys(payload).some((key) => key !== "attachmentId")
      )
        failure(socket, requestId, "Expected attachmentId only.");
      else {
        const id = text(payload.attachmentId);
        this.deletions.push(id);
        if (this.assets.get(id)?.pending) this.assets.delete(id);
        success(socket, requestId, {});
      }
    } else if (
      frame.tag === "assets.createUrl" &&
      ["attachment", "media-file"].includes(text(object(payload.resource)._tag))
    ) {
      const resource = object(payload.resource);
      this.readRequests.push({
        environmentId: this.environmentId,
        requestId,
        resource: structuredClone(resource),
      });
      const preview = { socket, requestId, resource };
      this.previews.push(preview);
      this.maximumPreviews = Math.max(this.maximumPreviews, this.previews.length);
      if (!this.holdPreviews) this.finishPreview(preview);
    } else if (
      frame.tag === "orchestration.subscribeThread" &&
      this.items.has(text(payload.threadId))
    ) {
      let entries = this.subscriptions.get(socket);
      if (!entries) this.subscriptions.set(socket, (entries = new Map()));
      entries.set(requestId, text(payload.threadId));
      this.snapshot(socket, requestId, text(payload.threadId));
    } else if (
      frame.tag === "orchestration.getTurnItem" &&
      this.items.has(text(payload.threadId))
    ) {
      success(socket, requestId, {
        item:
          this.items.get(text(payload.threadId))!.find((item) => item.id === payload.itemId) ??
          null,
      });
    } else if (
      frame.tag === "orchestration.dispatchCommand" &&
      payload.type === "message.dispatch" &&
      this.items.has(text(payload.threadId))
    ) {
      this.dispatch(socket, requestId, payload);
    } else return false;
    this.changed();
    return true;
  }

  private metadata(input: RecordValue, stored: boolean): string {
    const type = input.type ?? "image",
      mime = text(input.mimeType);
    if (!["image", "file"].includes(text(type)))
      return "Attachments must be image or file references.";
    if (
      !text(input.name).trim() ||
      text(input.name).trim() !== input.name ||
      text(input.name).length > 255
    )
      return "Attachment name must be trimmed and contain 1–255 characters.";
    if (
      !mime.trim() ||
      mime !== mime.trim() ||
      mime.length > 100 ||
      (type === "image" && !imageTypes.has(mime))
    )
      return "Unsupported attachment MIME type.";
    const maximum = type === "image" ? 10 * MiB : Math.min(this.fileMaximum, 50 * MiB);
    if (type === "file" && this.fileMaximum === 0) return "File attachments are unavailable.";
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      Number(input.sizeBytes) <= 0 ||
      Number(input.sizeBytes) > maximum
    )
      return "Attachment size exceeds the advertised limit.";
    const keys = stored
      ? ["id", "type", "name", "mimeType", "sizeBytes", "source"]
      : ["type", "name", "mimeType", "sizeBytes"];
    if (Object.keys(input).some((key) => !keys.includes(key)))
      return "Attachment payload must contain metadata only.";
    if (
      stored &&
      (!/^[a-z0-9_-]{1,128}$/i.test(text(input.id)) ||
        !["image", "file"].includes(text(input.type)))
    )
      return "Stored attachment identity is invalid.";
    return "";
  }

  private mint(socket: Socket, requestId: string, payload: RecordValue) {
    const error = this.metadata(payload, false);
    if (!this.allowed()) {
      failure(
        socket,
        requestId,
        "Permission denied: orchestration:operate is required.",
        "RpcPermissionDeniedError",
      );
      return;
    }
    if (!this.uploadsEnabled || error) {
      failure(socket, requestId, error || "Raw attachment uploads are unavailable.");
      return;
    }
    const number = ++this.nextUpload,
      attachmentId = `pending-${number}`,
      ticket = `${this.environmentId}-upload-${number}`;
    const attachment: Attachment = {
      id: attachmentId,
      type: text(payload.type) || "image",
      name: text(payload.name),
      mimeType: text(payload.mimeType),
      sizeBytes: Number(payload.sizeBytes),
    };
    this.assets.set(attachmentId, { attachment, pending: true });
    const upload: Upload = {
      attachmentId,
      ticket,
      expiresAt: this.clock + 10 * 60_000,
      expired: false,
    };
    this.uploads.set(ticket, upload);
    success(socket, requestId, {
      attachmentId,
      relativeUrl: `/api/attachments/upload/${ticket}`,
      expiresAt: upload.expiresAt,
    });
  }

  private finishPreview(preview: HeldPreview) {
    this.previews = this.previews.filter((entry) => entry !== preview);
    const { socket, requestId, resource } = preview,
      media = resource._tag === "media-file",
      id = media
        ? resource.path === "/fixture/reference.png"
          ? "shared-image"
          : "missing-image"
        : text(resource.attachmentId),
      asset = this.assets.get(id);
    if (
      !id ||
      (media && (!this.items.has(text(resource.threadId)) || !text(resource.path))) ||
      Object.keys(resource).some(
        (key) =>
          !(
            media
              ? ["_tag", "threadId", "path"]
              : ["_tag", "attachmentId", "fileName", "mimeType", "disposition", "renderIntent"]
          ).includes(key),
      ) ||
      (resource.disposition !== undefined &&
        !["inline", "attachment"].includes(text(resource.disposition)))
    ) {
      failure(socket, requestId, "Invalid attachment asset resource.");
      return;
    }
    if (!asset?.bytes) {
      failure(socket, requestId, "Attachment was not found.", "AssetAttachmentNotFoundError", {
        resource,
      });
      return;
    }
    const ticket = `${this.environmentId}-read-${++this.nextRead}`,
      fileName = text(resource.fileName) || asset.attachment.name;
    const read: ReadTicket = {
      attachmentId: id,
      ticket,
      expiresAt: this.clock + 60 * 60_000,
      expired: false,
      fileName,
      disposition: text(resource.disposition) || "attachment",
    };
    this.readTickets.set(ticket, read);
    success(socket, requestId, {
      relativeUrl: `/api/attachments/${ticket}/${encodeURIComponent(fileName)}`,
      expiresAt: read.expiresAt,
      ...(asset.dimensions ? { imageDimensions: asset.dimensions } : {}),
      fileRevision: hash(asset.bytes),
    });
  }

  private dispatch(socket: Socket, requestId: string, payload: RecordValue) {
    const threadId = text(payload.threadId),
      commandId = text(payload.commandId),
      messageId = text(payload.messageId);
    const fingerprint = canonical(payload),
      { commandId: _commandId, ...messagePayload } = payload,
      messageFingerprint = canonical(messagePayload);
    const previous = this.commands.get(commandId),
      sameMessage = this.messages.get(`${threadId}/${messageId}`);
    if (previous || sameMessage) {
      if (
        (previous && previous.fingerprint !== fingerprint) ||
        (sameMessage && sameMessage.fingerprint !== messageFingerprint)
      )
        failure(
          socket,
          requestId,
          "An idempotency identity was reused with different content.",
          "CommandIdempotencyConflictError",
        );
      else success(socket, requestId, { sequence: (previous ?? sameMessage)!.sequence });
      return;
    }
    const references = Array.isArray(payload.attachments)
      ? payload.attachments.map(object)
      : undefined;
    let error = !this.allowed()
      ? "Permission denied: orchestration:operate is required."
      : !commandId || !messageId
        ? "A stable commandId and messageId are required."
        : typeof payload.text !== "string" ||
            !references ||
            (!text(payload.text).trim() && references.length === 0)
          ? "A message needs text or attachments."
          : payload.createdBy !== "user" || payload.creationSource !== "mobile"
            ? "Expected a user message from mobile."
            : !["start_immediately", "queue_after_active"].includes(
                  text(object(payload.dispatchMode).type),
                )
              ? "Invalid message dispatch mode."
              : references.length > 100
                ? "A message can contain at most 100 attachments."
                : "";
    if (!error && references) {
      if (new Set(references.map((entry) => entry.id)).size !== references.length)
        error = "A message cannot contain duplicate attachment IDs.";
      else if (
        references.reduce(
          (sum, entry) =>
            sum +
            (imageTypes.has(text(entry.mimeType).toLowerCase()) ? Number(entry.sizeBytes) : 0),
          0,
        ) >
        80 * MiB
      )
        error = "Total image content exceeds 80 MiB.";
      for (const reference of references) {
        if (error) break;
        error = this.metadata(reference, true);
        const asset = this.assets.get(text(reference.id));
        if (!error && !asset?.bytes)
          error = "Attachment bytes have not been uploaded to this environment.";
        if (
          !error &&
          asset &&
          ["type", "name", "mimeType", "sizeBytes"].some(
            (key) => reference[key] !== object(asset.attachment)[key],
          )
        )
          error = "Stored attachment metadata does not match the upload.";
      }
    }
    if (error) {
      this.dispatches.push({
        environmentId: this.environmentId,
        command: structuredClone(payload),
        outcome: "rejected",
        error,
      });
      failure(socket, requestId, error);
      return;
    }
    const attachments = references!.map((reference, index) => {
      const asset = this.assets.get(text(reference.id))!,
        id = `final-${hash(`${threadId}/${messageId}/${index}`).slice(0, 32)}`;
      const attachment = { ...asset.attachment, id };
      this.assets.set(id, { ...asset, attachment, pending: false });
      return attachment;
    });
    const items = this.items.get(threadId)!,
      item = this.item(threadId, items.length, messageId, text(payload.text), attachments);
    items.push(item);
    this.emit(item);
    this.commands.set(commandId, { fingerprint, sequence: this.sequence });
    this.messages.set(`${threadId}/${messageId}`, {
      fingerprint: messageFingerprint,
      sequence: this.sequence,
    });
    this.dispatches.push({
      environmentId: this.environmentId,
      command: structuredClone(payload),
      outcome: "accepted",
      attachments,
    });
    if (this.dropReceipt) {
      this.dropReceipt = false;
      if (this.options.disconnect) this.options.disconnect();
      else socket.close?.(1012, "Fixture dropped the committed message receipt");
    } else success(socket, requestId, { sequence: this.sequence });
  }

  close(socket: Socket) {
    this.subscriptions.delete(socket);
    const before = this.previews.length;
    this.previews = this.previews.filter((entry) => entry.socket !== socket);
    this.cancelledPreviews += before - this.previews.length;
    this.changed();
  }

  state() {
    return {
      environmentId: this.environmentId,
      online: this.online,
      operate: this.allowed(),
      capabilities: this.config,
      mintedUploads: [...this.uploads.values()],
      stored: [...this.assets.values()]
        .filter((asset) => asset.pending)
        .map(({ attachment, bytes }) => ({
          ...attachment,
          uploaded: !!bytes,
          sha256: bytes ? hash(bytes) : "",
        })),
      uploadBodies: this.uploadBodies,
      activeUploads: this.activeUploads,
      maximumUploads: this.maximumUploads,
      heldUploads: this.heldUploads.size,
      deletions: this.deletions,
      readRequests: this.readRequests,
      readTickets: [...this.readTickets.values()],
      httpReads: this.httpReads,
      activePreviews: this.previews.length,
      maximumPreviews: this.maximumPreviews,
      cancelledPreviews: this.cancelledPreviews,
      dispatches: this.dispatches,
      committedMessages: this.messages.size,
      subscriptions: [...this.subscriptions.values()].flatMap((entries) => [...entries.values()]),
      threads: [...this.items].map(([id, items]) => ({ id, itemCount: items.length })),
    };
  }

  private barrier(request: Request, payload: RecordValue) {
    const milestone = text(payload.milestone),
      count =
        Number.isSafeInteger(payload.count) && Number(payload.count) > 0
          ? Number(payload.count)
          : 1;
    const id = text(payload.attachmentId);
    if (
      ![
        "body-received",
        "command-committed",
        "preview-count",
        "active-uploads",
        "active-previews",
      ].includes(milestone)
    )
      return json({ error: "Unknown attachment milestone." }, 400);
    const reached = () => {
      const value =
        milestone === "body-received"
          ? this.uploadBodies.filter((body) => !id || body.attachmentId === id).length
          : milestone === "command-committed"
            ? this.messages.size
            : milestone === "preview-count"
              ? this.readRequests.length
              : milestone === "active-uploads"
                ? this.activeUploads
                : this.previews.length;
      return value >= count;
    };
    if (reached()) return json(this.state());
    return new Promise<Response>((resolve) => {
      const finish = (response: Response) => {
        this.listeners.delete(notify);
        request.signal.removeEventListener("abort", abort);
        resolve(response);
      };
      const notify = () => {
        if (reached()) finish(json(this.state()));
      };
      const abort = () => finish(json({ error: "Attachment barrier cancelled." }, 499));
      this.listeners.add(notify);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }

  private async upload(request: Request, ticket: string) {
    const upload = this.uploads.get(ticket),
      asset = upload && this.assets.get(upload.attachmentId);
    if (!upload || !asset || upload.expired || upload.expiresAt <= this.clock)
      return json({ error: "Upload URL expired or unavailable." }, 404);
    if (request.method !== "POST")
      return json({ error: "Use POST for raw attachment bytes." }, 405);
    this.activeUploads++;
    this.maximumUploads = Math.max(this.maximumUploads, this.activeUploads);
    this.changed();
    try {
      const bytes = new Uint8Array(await request.arrayBuffer()),
        mime = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const leakedCredentials =
        request.headers.has("authorization") || request.headers.has("cookie");
      const contentLength = request.headers.get("content-length");
      this.uploadBodies.push({
        attachmentId: upload.attachmentId,
        bytes: bytes.length,
        sha256: hash(bytes),
        mimeType: mime,
        leakedCredentials,
        environmentId: this.environmentId,
      });
      this.changed();
      if (
        leakedCredentials ||
        mime !== asset.attachment.mimeType.toLowerCase() ||
        bytes.length !== asset.attachment.sizeBytes ||
        (contentLength !== null && Number(contentLength) !== bytes.length)
      )
        return json(
          { error: "Expected exact raw bytes, MIME, and no credentials on a signed upload." },
          400,
        );
      if (this.holdingUploads.has("*") || this.holdingUploads.has(upload.attachmentId)) {
        const status = await new Promise<number>((resolve) => {
          const held: HeldUpload = {
            attachmentId: upload.attachmentId,
            finish: (status) => {
              this.heldUploads.delete(held);
              request.signal.removeEventListener("abort", abort);
              resolve(status);
            },
          };
          const abort = () => held.finish(499);
          this.heldUploads.add(held);
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
          this.changed();
        });
        if (status !== 204) return json({ error: "Upload cancelled." }, status);
      }
      if (request.signal.aborted) return json({ error: "Upload cancelled." }, 499);
      if (
        upload.expired ||
        upload.expiresAt <= this.clock ||
        this.assets.get(upload.attachmentId) !== asset
      )
        return json({ error: "Upload URL expired or removed." }, 404);
      const failing = this.failUploads.has(upload.attachmentId)
        ? upload.attachmentId
        : this.failUploads.has("*")
          ? "*"
          : "";
      if (failing) {
        this.failUploads.delete(failing);
        return json({ error: "Fixture rejected this upload once." }, 503);
      }
      if (asset.bytes && hash(asset.bytes) !== hash(bytes))
        return json({ error: "An upload with different bytes already exists." }, 409);
      asset.bytes = bytes;
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    } catch (error) {
      if (request.signal.aborted) return json({ error: "Upload cancelled." }, 499);
      throw error;
    } finally {
      this.activeUploads--;
      this.changed();
    }
  }

  async http(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url),
      path = url.pathname;
    if (!this.online && ["/ws", "/api/auth/websocket-ticket/rpc"].includes(path))
      return json({ error: "Fixture is disconnected." }, 503);
    if (path === "/api/auth/session" && !this.options.authorization) {
      if (request.method !== "GET") return json({ error: "Use GET for session state." }, 405);
      if (request.headers.get("authorization") !== "Bearer fixture-access")
        return json({ error: "Invalid fixture access." }, 401);
      return json({
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:operate"],
        permissions: ["orchestration:read", ...(this.allowed() ? ["orchestration:operate"] : [])],
        auth: authDescriptor,
        sessionMethod: "bearer-access-token",
      });
    }
    const upload = /^\/api\/attachments\/upload\/([^/]+)$/.exec(path);
    if (upload) return this.upload(request, upload[1]!);
    const read = /^\/api\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
    if (read) {
      const ticket = this.readTickets.get(read[1]!),
        asset = ticket && this.assets.get(ticket.attachmentId);
      this.httpReads.push({
        ticket: read[1],
        attachmentId: ticket?.attachmentId,
        leakedCredentials: request.headers.has("authorization") || request.headers.has("cookie"),
      });
      if (request.method !== "GET") return json({ error: "Use GET for attachment bytes." }, 405);
      if (
        !ticket ||
        !asset?.bytes ||
        ticket.expired ||
        ticket.expiresAt <= this.clock ||
        decodeURIComponent(read[2]!) !== ticket.fileName
      )
        return json({ error: "Attachment URL expired or unavailable." }, 404);
      return new Response(asset.bytes, {
        headers: {
          "content-type": asset.attachment.mimeType,
          "content-length": String(asset.bytes.length),
          "content-disposition": `${ticket.disposition}; filename*=UTF-8''${encodeURIComponent(ticket.fileName)}`,
          "access-control-allow-origin": "*",
        },
      });
    }
    const history = /^\/api\/orchestration\/threads\/([^/]+)\/history$/.exec(path);
    if (history && this.items.has(decodeURIComponent(history[1]!))) {
      if (request.method !== "GET") return json({ error: "Use GET for history." }, 405);
      if (request.headers.get("authorization") !== "Bearer fixture-access")
        return json({ error: "Invalid fixture access." }, 401);
      const cursor = url.searchParams.get("cursor") ?? "",
        all = this.items.get(decodeURIComponent(history[1]!))!;
      const before = /^before:\d+$/.test(cursor) ? Number(cursor.slice(7)) : 0;
      if (before <= 0 || before > all.length)
        return json({ error: "Unknown attachment history cursor." }, 400);
      const start = Math.max(0, before - 40);
      return json({
        items: all.slice(start, before).map((item) => this.row(item)),
        nextCursor: start ? `before:${start}` : null,
        hasMoreHistory: start > 0,
      });
    }
    if (path === "/attachments/state" && request.method === "GET") return json(this.state());
    if (!["/attachments/control", "/attachments/await"].includes(path)) return;
    if (request.method !== "POST") return json({ error: "Use POST for attachment controls." }, 405);
    let payload: RecordValue;
    try {
      payload = object(await request.json());
    } catch {
      return json({ error: "Expected a JSON object." }, 400);
    }
    if (payload.environmentId !== undefined && payload.environmentId !== this.environmentId)
      return json({ error: "Attachment control environment mismatch." }, 409);
    if (path === "/attachments/await") return this.barrier(request, payload);
    const action = text(payload.action),
      id = text(payload.attachmentId) || "*";
    if (action === "hold-upload") this.holdingUploads.add(id);
    else if (action === "release-upload") {
      this.holdingUploads.delete(id);
      for (const held of Array.from(this.heldUploads))
        if (id === "*" || held.attachmentId === id) held.finish(204);
    } else if (action === "fail-upload-once") this.failUploads.add(id);
    else if (action === "expire-upload" || action === "expire-read") {
      for (const ticket of action === "expire-upload"
        ? this.uploads.values()
        : this.readTickets.values())
        if (id === "*" || ticket.attachmentId === id) ticket.expired = true;
    } else if (action === "advance-time") {
      if (!Number.isSafeInteger(payload.milliseconds) || Number(payload.milliseconds) < 0)
        return json({ error: "Use a nonnegative whole millisecond count." }, 400);
      this.clock += Number(payload.milliseconds);
    } else if (action === "hold-previews") this.holdPreviews = true;
    else if (action === "release-previews") {
      this.holdPreviews = false;
      for (const preview of Array.from(this.previews))
        if (id === "*" || preview.resource.attachmentId === id) this.finishPreview(preview);
    } else if (action === "drop-next-dispatch-receipt") this.dropReceipt = true;
    else if (action === "set-operate") {
      if (typeof payload.allowed !== "boolean")
        return json({ error: "Supply allowed as a boolean." }, 400);
      this.operate = payload.allowed;
      await this.options.authorization?.set(payload.allowed);
    } else if (action === "set-capabilities") {
      if (typeof payload.attachmentUploads === "boolean")
        this.uploadsEnabled = payload.attachmentUploads;
      if (payload.fileAttachments === false) this.fileMaximum = 0;
      else if (payload.maxUploadBytes !== undefined) {
        if (
          !Number.isSafeInteger(payload.maxUploadBytes) ||
          Number(payload.maxUploadBytes) < 1 ||
          Number(payload.maxUploadBytes) > 50 * MiB
        )
          return json({ error: "Use a file maximum from 1 byte to 50 MiB." }, 400);
        this.fileMaximum = Number(payload.maxUploadBytes);
      } else if (payload.fileAttachments === true) this.fileMaximum = 50 * MiB;
      this.options.configChanged?.();
    } else if (action === "disconnect") {
      this.online = false;
      this.options.disconnect?.();
    } else if (action === "reconnect") this.online = true;
    else if (action === "promote-id") {
      const nextId = text(payload.nextId),
        threadId = text(payload.threadId),
        asset = this.assets.get(id);
      if (!asset || !/^[a-z0-9_-]{1,128}$/i.test(nextId) || !this.items.has(threadId))
        return json(
          { error: "Supply a valid attachmentId, nextId, and attachment threadId." },
          400,
        );
      this.assets.set(nextId, {
        ...asset,
        pending: false,
        attachment: { ...asset.attachment, id: nextId },
      });
      for (const item of this.items.get(threadId)!)
        if (item.attachments.some((entry) => entry.id === id)) {
          item.attachments = item.attachments.map((entry) =>
            entry.id === id ? { ...entry, id: nextId } : entry,
          );
          item.updatedAt = this.date();
          this.emit(item);
        }
    } else return json({ error: "Unknown attachment control." }, 400);
    this.changed();
    return json(this.state());
  }
}
