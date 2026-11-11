import { FILE_LIMIT, PREVIEW_DIRECTORY, ownedAttachmentPath, ownedPreviewPath, type DisplayAttachment } from "./attachments";

export interface GalleryCandidate { item: DisplayAttachment; localPath: string; sourceId: string }
export interface GalleryItem extends GalleryCandidate { index: number; path: string; url: string; state: string; error: string }
export interface AttachmentViewer {
  presentationId: string; routeId: string; threadId: string; accessKey: string; origin: string;
  items: GalleryItem[]; selectedIndex: number; imageGallery: boolean; state: string; error: string;
}
export interface GalleryWork {
  presentationId: string; threadId: string; accessKey: string; origin: string;
  index: number; attempt: number; item: GalleryItem;
}
export const imageAttachment = (item: DisplayAttachment) => item.type === "image" || ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(item.mimeType.toLowerCase());
export const galleryWorkKey = (work: GalleryWork) => `${work.presentationId}:${work.index}:${work.attempt}`;

export function freezeGallery(presentationId: string, selected: GalleryCandidate, candidates: readonly GalleryCandidate[]) {
  const imageGallery = imageAttachment(selected.item);
  const identity = (candidate: GalleryCandidate) => candidate.localPath || candidate.item.id;
  const seen = new Set<string>();
  const items = (imageGallery ? candidates.filter((candidate) => imageAttachment(candidate.item)) : [selected]).flatMap((candidate) => {
    const key = identity(candidate);
    if (seen.has(key)) return [];
    seen.add(key);
    return [key === identity(selected) ? selected : candidate];
  });
  if (!seen.has(identity(selected))) items.unshift(selected);
  return { imageGallery, selectedIndex: items.findIndex((candidate) => identity(candidate) === identity(selected)), items: items.map((candidate, index): GalleryItem => {
    if (candidate.localPath && !ownedAttachmentPath(candidate.localPath)) throw new Error("This attachment file is unavailable.");
    const extension = /\.([a-zA-Z0-9]{1,10})$/.exec(candidate.item.name)?.[1] ?? ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "text/plain": "txt" } as Record<string, string>)[candidate.item.mimeType] ?? "bin";
    return { ...candidate, item: { ...candidate.item }, index, path: candidate.localPath || `${PREVIEW_DIRECTORY}${presentationId}/attachment-${index}.${extension}`, url: "", state: candidate.localPath ? "ready" : "loading", error: "" };
  }) };
}

export class GalleryDownloads {
  private active: { key: string; abort: AbortController } | undefined;
  cancel(key: string) {
    if (this.active?.key !== key) return;
    this.active.abort.abort();
    this.active = undefined;
  }
  download(work: GalleryWork) {
    if (!ownedPreviewPath(work.item.path)) throw new Error("This attachment preview path is invalid.");
    if (this.active) this.cancel(this.active.key);
    const current = { key: galleryWorkKey(work), abort: new AbortController() };
    this.active = current;
    return fetch(work.item.url, { signal: current.abort.signal, exactBodyTo: work.item.path,
      exactIndependentHttp: { maxResponseBytes: Math.min(FILE_LIMIT, Math.max(1, work.item.item.sizeBytes)) }, exactTimeout: 300000 })
      .then((response) => {
        if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
        return { work: { ...work, item: { ...work.item, state: "ready", error: "" } } };
      }).catch((error: unknown) => ({ work: { ...work, item: { ...work.item, state: "error", error: error instanceof Error ? error.message : "This attachment could not be downloaded." } } }))
      .finally(() => { if (this.active === current) this.active = undefined; });
  }
}
