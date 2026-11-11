import {
  FILE_LIMIT,
  PREVIEW_DIRECTORY,
  ownedAttachmentPath,
  ownedPreviewPath,
  type DisplayAttachment,
} from "./attachments";
import type { MediaFileIdentity } from "./markdown-images";

export interface GalleryCandidate {
  item: DisplayAttachment;
  localPath: string;
  sourceId: string;
  mediaFile?: MediaFileIdentity | null;
  directUrl?: string;
}
export interface ToolImageIdentity {
  threadId: string;
  itemId: string;
  index: number;
}
export interface GalleryItem extends GalleryCandidate {
  mediaFile: MediaFileIdentity | null;
  directUrl: string;
  toolImage: ToolImageIdentity | null;
  index: number;
  path: string;
  url: string;
  state: string;
  error: string;
}
export interface AttachmentViewer {
  presentationId: string;
  routeId: string;
  threadId: string;
  accessKey: string;
  origin: string;
  items: GalleryItem[];
  selectedIndex: number;
  imageGallery: boolean;
  state: string;
  error: string;
}
export interface GalleryWork {
  presentationId: string;
  threadId: string;
  accessKey: string;
  origin: string;
  index: number;
  attempt: number;
  item: GalleryItem;
}
export const imageAttachment = (item: DisplayAttachment) => {
  const mimeType = item.mimeType.toLowerCase();
  return (
    item.type === "image" || (mimeType.startsWith("image/") && Object.hasOwn(extensions, mimeType))
  );
};
export const galleryWorkKey = (work: GalleryWork) =>
  `${work.presentationId}:${work.index}:${work.attempt}`;
const extensions: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/x-icon": "ico",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "text/plain": "txt",
};

export function freezeGallery(
  presentationId: string,
  selected: GalleryCandidate,
  candidates: readonly GalleryCandidate[],
) {
  const imageGallery = imageAttachment(selected.item);
  const identity = (candidate: GalleryCandidate) =>
    JSON.stringify(
      candidate.localPath
        ? ["local", candidate.localPath]
        : candidate.mediaFile
          ? ["media-file", candidate.mediaFile.threadId, candidate.mediaFile.path]
          : ["attachment", candidate.item.id],
    );
  const seen = new Set<string>();
  const items = (
    imageGallery ? candidates.filter((candidate) => imageAttachment(candidate.item)) : [selected]
  ).flatMap((candidate) => {
    const key = identity(candidate);
    if (seen.has(key)) return [];
    seen.add(key);
    return [key === identity(selected) ? selected : candidate];
  });
  if (!seen.has(identity(selected))) items.unshift(selected);
  return {
    imageGallery,
    selectedIndex: items.findIndex((candidate) => identity(candidate) === identity(selected)),
    items: items.map((candidate, index): GalleryItem => {
      if (candidate.localPath && !ownedAttachmentPath(candidate.localPath))
        throw new Error("This attachment file is unavailable.");
      const mimeExtension = extensions[candidate.item.mimeType.toLowerCase()];
      const extension =
        (imageGallery ? mimeExtension : undefined) ??
        /\.([a-zA-Z0-9]{1,10})$/.exec(candidate.item.name)?.[1] ??
        mimeExtension ??
        "bin";
      return {
        ...candidate,
        mediaFile: candidate.mediaFile ? { ...candidate.mediaFile } : null,
        directUrl: candidate.directUrl ?? "",
        toolImage: null,
        item: { ...candidate.item },
        index,
        path:
          candidate.localPath ||
          `${PREVIEW_DIRECTORY}${presentationId}/attachment-${index}.${extension}`,
        url: "",
        state: candidate.localPath ? "ready" : "loading",
        error: "",
      };
    }),
  };
}

export function freezeToolGallery(
  presentationId: string,
  rowId: string,
  selectedIndex: number,
  source: {
    threadId: string;
    itemId: string;
    images: readonly { alt: string; mimeType: string }[];
  },
) {
  const candidates = source.images.map((image, index): GalleryCandidate => ({
    item: {
      id: `tool-image-${index}`,
      type: "image",
      name: image.alt || `Tool output image ${index + 1}`,
      mimeType: image.mimeType,
      sizeBytes: FILE_LIMIT,
      width: 0,
      height: 0,
    },
    localPath: "",
    sourceId: `tool-image-${rowId}-${index}`,
  }));
  const selected = candidates[selectedIndex];
  if (!selected) throw new Error("This tool image is unavailable.");
  const gallery = freezeGallery(presentationId, selected, candidates);
  return {
    ...gallery,
    items: gallery.items.map((item, index) => ({
      ...item,
      toolImage: { threadId: source.threadId, itemId: source.itemId, index },
    })),
  };
}

export class GalleryDownloads {
  private active: { key: string; abort: AbortController } | undefined;
  cancel(key: string) {
    if (this.active?.key !== key) return;
    this.active.abort.abort();
    this.active = undefined;
  }
  download(work: GalleryWork) {
    if (!ownedPreviewPath(work.item.path))
      throw new Error("This attachment preview path is invalid.");
    if (this.active) this.cancel(this.active.key);
    const current = { key: galleryWorkKey(work), abort: new AbortController() };
    this.active = current;
    return fetch(work.item.url, {
      signal: current.abort.signal,
      exactBodyTo: work.item.path,
      exactIndependentHttp: {
        maxResponseBytes: Math.min(FILE_LIMIT, Math.max(1, work.item.item.sizeBytes)),
      },
      exactTimeout: 300000,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
        return { work: { ...work, item: { ...work.item, state: "ready", error: "" } } };
      })
      .catch((error: unknown) => ({
        work: {
          ...work,
          item: {
            ...work.item,
            state: "error",
            error:
              error instanceof Error ? error.message : "This attachment could not be downloaded.",
          },
        },
      }))
      .finally(() => {
        if (this.active === current) this.active = undefined;
      });
  }
}
