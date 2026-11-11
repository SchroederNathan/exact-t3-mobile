import {
  signedAttachmentUrl,
  validateAttachments,
  type AttachmentDemand,
  type AttachmentPreview,
  type DisplayAttachment,
  type DraftAttachment,
} from "./attachments";
import type { ToolImageIdentity } from "./attachment-gallery";
import type { MediaFileIdentity } from "./markdown-images";

export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly tag: string,
  ) {
    super(message);
  }
}
interface Metadata {
  accessKey: string;
  origin: string;
  allowed: boolean;
  uploads: boolean;
  maxFileBytes: number;
}
interface Query {
  id: string;
  promise: Promise<Record<string, unknown>>;
}
interface Boundary {
  metadata(): Metadata;
  query(tag: string, payload: unknown): Query;
  cancel(id: string): void;
  resolve(
    threadId: string,
    viewKey: string,
    demand: AttachmentDemand,
  ): DisplayAttachment | undefined;
}
interface Entry {
  key: string;
  requestId: string;
  accessKey: string;
  preview: AttachmentPreview;
  first: Promise<void>;
  resolve(): void;
}
const dimensions = (input: unknown, fallback: { width: number; height: number }) => {
  const size =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    width:
      typeof size.width === "number" && Number.isFinite(size.width) && size.width > 0
        ? size.width
        : fallback.width,
    height:
      typeof size.height === "number" && Number.isFinite(size.height) && size.height > 0
        ? size.height
        : fallback.height,
  };
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const assetExpiry = (value: unknown) =>
  typeof value === "number" ? value : Date.parse(text(value)) || 0;

export class AttachmentSession {
  private entries = new Map<string, Entry>();
  private ownedRead: { owner: string; id: string } | undefined;
  constructor(private readonly boundary: Boundary) {}

  metadata() {
    return this.boundary.metadata();
  }

  assertAccess(accessKey: string, origin?: string) {
    const metadata = this.metadata();
    if (
      !metadata.accessKey ||
      accessKey !== metadata.accessKey ||
      (origin && origin !== metadata.origin) ||
      !metadata.allowed
    )
      throw new Error("Reconnect and check your attachment upload permission.");
    if (!metadata.uploads) throw new Error("This environment does not support attachment uploads.");
    return metadata;
  }

  createUpload(accessKey: string, item: DraftAttachment) {
    const metadata = this.assertAccess(accessKey);
    validateAttachments([item], metadata.maxFileBytes);
    const query = this.boundary.query("attachments.createUploadUrl", {
      type: item.type,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
    });
    return query.promise.then((reply) => {
      const attachmentId = text(reply.attachmentId);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId))
        throw new Error("The server returned an invalid attachment identifier.");
      return {
        attachmentId,
        url: signedAttachmentUrl(metadata.origin, text(reply.relativeUrl), true),
        origin: metadata.origin,
        accessKey,
      };
    });
  }

  remove(accessKey: string, attachmentId: string) {
    this.assertAccess(accessKey);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId))
      throw new Error("This attachment identifier is invalid.");
    return this.boundary.query("attachments.delete", { attachmentId }).promise;
  }

  cancelRead(owner: string) {
    if (this.ownedRead?.owner !== owner) return;
    this.boundary.cancel(this.ownedRead.id);
    this.ownedRead = undefined;
  }

  read(item: DisplayAttachment, owner?: string) {
    return this.readResource(
      {
        _tag: "attachment",
        attachmentId: item.id,
        fileName: item.name,
        mimeType: item.mimeType,
        disposition: "inline",
      },
      owner,
    );
  }

  readToolImage(image: ToolImageIdentity, owner?: string) {
    return this.readResource({ _tag: "tool-output-image", ...image }, owner);
  }

  readMediaFile(media: MediaFileIdentity, owner?: string) {
    return this.readResource(
      { _tag: "media-file", threadId: media.threadId, path: media.path },
      owner,
    );
  }

  private readResource(resource: Record<string, unknown>, owner?: string) {
    const metadata = this.metadata();
    if (!metadata.accessKey) throw new Error("This environment is disconnected.");
    if (owner && this.ownedRead) this.cancelRead(this.ownedRead.owner);
    const query = this.boundary.query("assets.createUrl", { resource });
    if (owner) this.ownedRead = { owner, id: query.id };
    return query.promise
      .then((reply) => {
        if (metadata.accessKey !== this.metadata().accessKey)
          throw new Error("The attachment connection changed. Retry to load it.");
        const imageDimensions = dimensions(reply.imageDimensions, { width: 0, height: 0 });
        const fileRevision = text(reply.fileRevision).trim();
        return {
          url: signedAttachmentUrl(metadata.origin, text(reply.relativeUrl)),
          expiresAt: assetExpiry(reply.expiresAt),
          ...(imageDimensions.width > 0 && imageDimensions.height > 0 ? { imageDimensions } : {}),
          ...(fileRevision ? { fileRevision } : {}),
        };
      })
      .finally(() => {
        if (owner && this.ownedRead?.owner === owner) this.ownedRead = undefined;
      });
  }

  private removeEntry(entry: Entry) {
    this.entries.delete(entry.key);
    if (entry.requestId) this.boundary.cancel(entry.requestId);
    entry.resolve();
  }

  clear() {
    for (const entry of this.entries.values()) this.removeEntry(entry);
  }

  async previews(
    threadId: string,
    viewKey: string,
    wanted: readonly AttachmentDemand[],
    now: number,
  ) {
    const metadata = this.metadata();
    const desired = wanted.flatMap((demand) => {
      const item = this.boundary.resolve(threadId, viewKey, demand);
      return item && item.type !== "unknown"
        ? [{ demand, item, key: JSON.stringify([metadata.accessKey, item.id, demand.attempt]) }]
        : [];
    });
    const desiredKeys = new Set(desired.map(({ key }) => key));
    for (const entry of this.entries.values()) {
      if (
        entry.accessKey !== metadata.accessKey ||
        (entry.preview.state === "loading" && !desiredKeys.has(entry.key)) ||
        (entry.preview.state === "ready" && entry.preview.expiresAt <= now + 5000)
      )
        this.removeEntry(entry);
    }
    let pendingCount = [...this.entries.values()].filter((entry) => entry.requestId).length;
    const result: Entry[] = [];
    for (const { demand, item, key } of desired) {
      let entry = this.entries.get(key);
      if (!entry) {
        let resolve = () => {};
        const first = new Promise<void>((done) => {
          resolve = done;
        });
        entry = {
          key,
          requestId: "",
          accessKey: metadata.accessKey,
          first,
          resolve,
          preview: {
            width: item.width,
            height: item.height,
            attachmentId: item.id,
            attempt: demand.attempt,
            url: "",
            expiresAt: 0,
            state: "loading",
            error: "",
          },
        };
        this.entries.set(key, entry);
      }
      if (entry.preview.state === "loading" && !entry.requestId && pendingCount < 12) {
        const captured = entry;
        try {
          if (!metadata.accessKey) throw new Error("This environment is disconnected.");
          const query = this.boundary.query("assets.createUrl", {
            resource: {
              _tag: "attachment",
              attachmentId: item.id,
              fileName: item.name,
              mimeType: item.mimeType,
              disposition: "inline",
            },
          });
          entry.requestId = query.id;
          pendingCount++;
          query.promise
            .then((reply) => {
              if (this.entries.get(key) !== captured) return;
              captured.preview = {
                ...captured.preview,
                ...dimensions(reply.imageDimensions, item),
                state: "ready",
                url: signedAttachmentUrl(metadata.origin, text(reply.relativeUrl)),
                expiresAt: assetExpiry(reply.expiresAt),
              };
            })
            .catch((error) => {
              if (this.entries.get(key) !== captured) return;
              captured.preview = {
                ...captured.preview,
                state:
                  error instanceof RpcFailure && error.tag === "AssetAttachmentNotFoundError"
                    ? "missing"
                    : "error",
                error:
                  error instanceof Error ? error.message : "This attachment could not be loaded.",
              };
            })
            .finally(() => {
              captured.requestId = "";
              captured.resolve();
            });
        } catch (error) {
          entry.preview = {
            ...entry.preview,
            state: "error",
            error: error instanceof Error ? error.message : "This attachment could not be loaded.",
          };
          entry.resolve();
        }
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
      result.push(entry);
    }
    for (const entry of this.entries.values()) {
      if (this.entries.size <= 64) break;
      if (!entry.requestId && !desiredKeys.has(entry.key)) this.removeEntry(entry);
    }
    const pending = result.filter((entry) => entry.requestId);
    if (pending.length) await Promise.race(pending.map((entry) => entry.first));
    return {
      threadId,
      viewKey,
      previews: result
        .filter((entry) => this.entries.get(entry.key) === entry)
        .map((entry) => ({ ...entry.preview })),
    };
  }
}
