import type { Storage, StreamEvent } from "./app.contract.d.ts";

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const FILE_LIMIT = 50 * 1024 * 1024;
export const IMAGE_TOTAL_LIMIT = 80 * 1024 * 1024;
export const ATTACHMENT_DIRECTORY = "app:/data/composer-attachments/";
export const PREVIEW_DIRECTORY = "app:/cache/attachment-previews/";
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const value = (input: unknown): Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const text = (input: unknown) => typeof input === "string" ? input : "";
const natural = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0;

export interface StoredAttachment {
  type: string;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
export interface DisplayAttachment extends StoredAttachment {
  width: number;
  height: number;
}
export type AttachmentState = "local" | "uploading" | "uploaded" | "failed";
export interface DraftAttachment extends DisplayAttachment {
  type: "image" | "file";
  localId: string;
  path: string;
  state: AttachmentState;
  attempt: number;
  error: string;
  insertionRevision: number;
}
export interface PickedFile {
  path: string;
  name: string;
  type: string;
  size: number;
  width?: number | null;
  height?: number | null;
}
export interface AttachmentOperation {
  threadId: string;
  localId: string;
  attempt: number;
  accessKey: string;
  origin: string;
}
export interface AttachmentTicket extends AttachmentOperation {
  path: string;
  mimeType: string;
  attachmentId: string;
  url: string;
  revision: number;
}
export interface UploadProgress {
  threadId: string;
  localId: string;
  attempt: number;
  state: string;
  progress: number;
  error: string;
}
export interface AttachmentDemand {
  threadId: string;
  viewKey: string;
  messageId: string;
  attachmentId: string;
  attempt: number;
}
export interface AttachmentPreview {
  width: number;
  height: number;
  attachmentId: string;
  attempt: number;
  url: string;
  expiresAt: number;
  state: string;
  error: string;
}

export function ownedAttachmentPath(path: string) {
  return /^app:\/data\/composer-attachments\/[A-Za-z0-9_-]+\/content(?:\.[A-Za-z0-9]+)?$/.test(path);
}

export function ownedPreviewPath(path: string) {
  return /^app:\/cache\/attachment-previews\/[A-Za-z0-9_-]+\/attachment(?:-[0-9]+)?\.[A-Za-z0-9]+$/.test(path);
}

export function storedReference(item: StoredAttachment): StoredAttachment {
  return { type: item.type, id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes };
}

export function displayAttachments(input: unknown): DisplayAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry, index) => {
    const item = value(entry);
    const type = text(item.type);
    return [{
      type: type === "image" || type === "file" ? type : "unknown",
      id: text(item.id) || `unknown-${index}`,
      name: text(item.name) || "Attachment",
      mimeType: text(item.mimeType) || "application/octet-stream",
      sizeBytes: natural(item.sizeBytes) ? item.sizeBytes as number : 0,
      width: natural(item.width) ? item.width as number : 0,
      height: natural(item.height) ? item.height as number : 0,
    }];
  });
}

export function parseDraftAttachment(input: unknown): DraftAttachment {
  const item = value(input);
  if (!/^[A-Za-z0-9_-]+$/.test(text(item.localId)) || !ownedAttachmentPath(text(item.path)) ||
      !text(item.path).startsWith(`${ATTACHMENT_DIRECTORY}${item.localId}/`) ||
      !["image", "file"].includes(text(item.type)) || !["local", "uploading", "uploaded", "failed"].includes(text(item.state)) ||
      !natural(item.attempt) || !natural(item.insertionRevision) || !natural(item.width) || !natural(item.height) ||
      typeof item.error !== "string" || typeof item.id !== "string") throw new Error("A saved attachment could not be read.");
  const result: DraftAttachment = { ...storedReference(item as unknown as DisplayAttachment), type: item.type as "image" | "file",
    localId: item.localId as string, path: item.path as string, state: item.state as AttachmentState,
    attempt: item.attempt as number, error: item.error, insertionRevision: item.insertionRevision as number,
    width: item.width as number, height: item.height as number,
  };
  validateAttachments([result], FILE_LIMIT, result.state === "uploaded");
  if (result.id && !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)) throw new Error("A saved attachment has an invalid identifier.");
  return result;
}

export function validateAttachments(items: readonly StoredAttachment[], maxFileBytes: number, requireUploaded = false) {
  if (items.length > 100) throw new Error("A message can have at most 100 attachments.");
  let imageBytes = 0;
  const ids = new Set<string>();
  for (const item of items) {
    if (!["image", "file"].includes(item.type) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 255 ||
        typeof item.mimeType !== "string" || !item.mimeType.trim() || item.mimeType.length > 100 || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0)
      throw new Error("An attachment has invalid metadata.");
    if (item.type === "image" && !imageTypes.has(item.mimeType)) throw new Error(`${item.name} is not a supported image format.`);
    const limit = item.type === "image" ? IMAGE_LIMIT : Math.min(FILE_LIMIT, maxFileBytes);
    if (item.sizeBytes > limit) throw new Error(`${item.name} exceeds the ${Math.floor(limit / 1024 / 1024)} MB attachment limit.`);
    if (imageTypes.has(item.mimeType)) imageBytes += item.sizeBytes;
    if (requireUploaded && !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)) throw new Error(`${item.name} has not finished uploading.`);
    if (item.id && ids.has(item.id)) throw new Error("The same attachment cannot be sent twice in one message.");
    if (item.id) ids.add(item.id);
  }
  if (imageBytes > IMAGE_TOTAL_LIMIT) throw new Error("Images in a message must total 80 MB or less.");
}

export function preparation(file: PickedFile, photos: boolean, maxFileBytes: number) {
  if (!file.path.startsWith("app:/tmp/picked/") || file.path.split("/").some((part) => part === "." || part === "..") || file.path.includes("\\") || file.path.includes("\0") || !Number.isSafeInteger(file.size) || file.size <= 0)
    throw new Error(`${file.name || "This file"} could not be read.`);
  const mime = file.type.toLowerCase().split(";")[0]!.trim();
  const image = photos || imageTypes.has(mime);
  const compress = image && (mime !== "image/gif" && mime !== "image/webp") && (photos || !imageTypes.has(mime) || file.size > IMAGE_LIMIT);
  const mimeType = compress ? mime === "image/png" ? "image/png" : "image/jpeg" : mime || "application/octet-stream";
  const type: "image" | "file" = image ? "image" : "file";
  let name = file.name.trim().slice(0, 255) || "Attachment";
  if (compress) name = name.replace(/\.[^.]+$/, "").slice(0, 250) + (mimeType === "image/png" ? ".png" : ".jpg");
  if (!compress) validateAttachments([{ type, id: "", name, mimeType, sizeBytes: file.size }], maxFileBytes);
  return { compress, type, mimeType, name };
}

export async function stageAttachments(storage: Storage, files: readonly PickedFile[], photos: boolean, maxFileBytes: number, existing: readonly DraftAttachment[], revision: number) {
  const attachments: DraftAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    let path = "";
    try {
      if (existing.length + attachments.length >= 100) throw new Error("A message can have at most 100 attachments.");
      const plan = preparation(file, photos, maxFileBytes);
      const localId = crypto.randomUUID();
      const directory = `${ATTACHMENT_DIRECTORY}${localId}`;
      await storage.fs.mkdir(directory);
      const extension = /\.([a-zA-Z0-9]{1,10})$/.exec(plan.name)?.[1] ?? "bin";
      path = `${directory}/content.${extension}`;
      let sizeBytes = file.size;
      let width = file.width ?? 0;
      let height = file.height ?? 0;
      if (plan.compress) {
        const output = await storage.fs.compressImage(file.path, path, { maxDimension: 2000, maxBytes: IMAGE_LIMIT, type: plan.mimeType as "image/jpeg" | "image/png" });
        sizeBytes = output.size; width = output.width; height = output.height;
      } else {
        await storage.fs.copyFile(file.path, path);
        sizeBytes = (await storage.fs.stat(path)).size;
      }
      const item: DraftAttachment & { compress: boolean } = { ...plan, id: "", localId, path, sizeBytes, width, height, state: "local", attempt: 0, error: "", insertionRevision: revision };
      const { compress: _compress, ...record } = item as DraftAttachment & { compress: boolean };
      validateAttachments([...existing, ...attachments, record], maxFileBytes);
      attachments.push(record);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${file.name} could not be prepared.`);
      if (path) await storage.fs.rm(path).catch(() => {});
    }
  }
  return { attachments, error: errors.join("\n") };
}

export function signedAttachmentUrl(origin: string, relative: string, upload = false) {
  const url = new URL(relative, origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password ||
      !(upload ? url.pathname.startsWith("/api/attachments/upload/") : url.pathname.startsWith("/api/assets/") || url.pathname.startsWith("/api/attachments/")))
    throw new Error("The server returned an invalid attachment URL.");
  return url.toString();
}

export function uploadEvent(ticket: AttachmentTicket, event: StreamEvent): UploadProgress {
  const base = { threadId: ticket.threadId, localId: ticket.localId, attempt: ticket.attempt };
  if (event.type === "progress") return { ...base, state: "uploading", progress: Math.floor(Math.max(0, Math.min(1, (event.loaded ?? 0) / Math.max(1, event.total ?? 1))) * 20) * 5, error: "" };
  if (event.type === "load" && event.status === 204) return { ...base, state: "uploaded", progress: 100, error: "" };
  return { ...base, state: "failed", progress: 0, error: event.message || (event.status === 404 ? "This upload expired. Retry to upload it again." : `Upload failed${event.status ? ` (${event.status})` : ""}. Retry or remove this attachment.`) };
}
