import { expect, test } from "bun:test";
import { displayAttachments, FILE_LIMIT, IMAGE_LIMIT, ownedAttachmentPath, parseDraftAttachment, preparation, signedAttachmentUrl, stageAttachments, uploadEvent, validateAttachments, type DraftAttachment } from "./attachments";
import type { Storage } from "./app.contract.d.ts";

const image: DraftAttachment = { type: "image", id: "", localId: "photo", path: "app:/data/composer-attachments/photo/content.png", name: "photo.png", mimeType: "image/png", sizeBytes: 100, width: 20, height: 20, state: "local", attempt: 1, error: "", insertionRevision: 2 };

test("picked images normalize format and names while supported animated bytes remain unchanged", () => {
  const file = { path: "app:/tmp/picked/photo", name: "IMG_001.HEIC", type: "image/heic", size: 1500 };
  expect(preparation(file, true, FILE_LIMIT)).toEqual({ compress: true, type: "image", mimeType: "image/jpeg", name: "IMG_001.jpg" });
  expect(preparation({ ...file, name: "transparent.png", type: "image/png" }, true, FILE_LIMIT)).toEqual({ compress: true, type: "image", mimeType: "image/png", name: "transparent.png" });
  for (const mime of ["image/gif", "image/webp"]) {
    expect(preparation({ ...file, type: mime }, true, FILE_LIMIT)).toMatchObject({ compress: false, type: "image", mimeType: mime });
    expect(() => preparation({ ...file, type: mime, size: IMAGE_LIMIT + 1 }, true, FILE_LIMIT)).toThrow("10 MB");
  }
  expect(preparation({ ...file, name: "chart.png", type: "image/png" }, false, FILE_LIMIT)).toMatchObject({ compress: false, type: "image" });
  expect(preparation({ ...file, name: "notes.txt", type: "" }, false, FILE_LIMIT)).toEqual({ compress: false, type: "file", mimeType: "application/octet-stream", name: "notes.txt" });
  expect(() => preparation({ ...file, path: "app:/data/secret" }, true, FILE_LIMIT)).toThrow("could not be read");
});

test("attachment limits include file-shaped images and reject duplicated uploaded references", () => {
  expect(() => validateAttachments([{ ...image, sizeBytes: 0 }], FILE_LIMIT)).toThrow("invalid metadata");
  expect(() => validateAttachments([{ ...image, type: "file", sizeBytes: 50 }], 40)).toThrow("attachment limit");
  expect(() => validateAttachments(Array.from({ length: 101 }, () => image), FILE_LIMIT)).toThrow("100 attachments");
  expect(() => validateAttachments(Array.from({ length: 9 }, () => ({ ...image, type: "file", sizeBytes: IMAGE_LIMIT })), FILE_LIMIT)).toThrow("80 MB");
  expect(() => validateAttachments([{ ...image, id: "same" }, { ...image, id: "same" }], FILE_LIMIT, true)).toThrow("same attachment");
  expect(() => validateAttachments([image], FILE_LIMIT, true)).toThrow("not finished uploading");
  expect(() => parseDraftAttachment({ ...image, path: "app:/data/composer-attachments/other/content.png" })).toThrow("could not be read");
  expect(ownedAttachmentPath("app:/data/composer-attachments/photo/../secret")).toBe(false);
});

test("staging measures actual bytes and keeps a safe extension for native document previews", async () => {
  const copied: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  const fs = { mkdir: async () => {}, copyFile: async (from: string, to: string) => { copied.push({ from, to }); }, stat: async () => ({ size: 23 }), rm: async (path: string) => { removed.push(path); } };
  const result = await stageAttachments({ fs } as unknown as Storage, [{ path: "app:/tmp/picked/report.pdf", name: "../../report.pdf", type: "application/pdf", size: 100 }], false, FILE_LIMIT, [], 7);
  expect(result.error).toBe("");
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]).toMatchObject({ type: "file", name: "../../report.pdf", sizeBytes: 23, insertionRevision: 7, state: "local" });
  expect(result.attachments[0]!.path).toMatch(/^app:\/data\/composer-attachments\/[a-z0-9-]+\/content\.pdf$/);
  expect(copied).toEqual([{ from: "app:/tmp/picked/report.pdf", to: result.attachments[0]!.path }]);
  expect(removed).toEqual([]);
});

test("signed URLs remain on the captured environment and upload reaches ready only on a 204 response", () => {
  expect(signedAttachmentUrl("https://a.example", "/api/attachments/upload/ticket", true)).toBe("https://a.example/api/attachments/upload/ticket");
  expect(() => signedAttachmentUrl("https://a.example", "https://b.example/api/attachments/upload/ticket", true)).toThrow("invalid attachment URL");
  expect(() => signedAttachmentUrl("https://a.example", "/account", true)).toThrow("invalid attachment URL");
  const ticket = { threadId: "a:thread", localId: "photo", attempt: 2, path: image.path, mimeType: image.mimeType, accessKey: "a-epoch", origin: "https://a.example", attachmentId: "pending", url: "https://a.example/api/attachments/upload/ticket", revision: 3 };
  const event = { data: "", lastEventId: "", coalesced: 0 };
  expect(uploadEvent(ticket, { ...event, type: "progress", loaded: 100, total: 100 })).toMatchObject({ state: "uploading", progress: 100 });
  expect(uploadEvent(ticket, { ...event, type: "load", status: 204 })).toMatchObject({ state: "uploaded", progress: 100 });
  expect(uploadEvent(ticket, { ...event, type: "load", status: 200 })).toMatchObject({ state: "failed" });
  expect(uploadEvent(ticket, { ...event, type: "load", status: 404 }).error).toContain("expired");
  expect(displayAttachments([{ type: "future", id: "new", name: "Future format" }])).toEqual([{ type: "unknown", id: "new", name: "Future format", mimeType: "application/octet-stream", sizeBytes: 0, width: 0, height: 0 }]);
});
