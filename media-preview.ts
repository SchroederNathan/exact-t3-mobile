import { freezeGallery, type GalleryCandidate } from "./attachment-gallery";
import { FILE_LIMIT } from "./attachments";
import type { MarkdownBlock } from "./markdown";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
  resolveViewedImageAsset,
  workspaceImageMimeType,
  type MediaFileIdentity,
} from "./markdown-images";

export interface MediaRef {
  messageId: string;
  blockId: string;
}
export interface MediaDemand extends MediaRef {
  attempt: number;
}
export interface MediaTarget extends MediaRef {
  source: string;
  name: string;
  mimeType: string;
  mediaFile: MediaFileIdentity | null;
  directUrl: string;
  fragment: string;
  error: string;
}
export interface MediaPreview extends MediaDemand {
  version: number;
  url: string;
  state: string;
  error: string;
  width: number;
  height: number;
  expiresAt: number;
  fileRevision: string;
}
interface AssetRead {
  url: string;
  expiresAt: number;
  imageDimensions?: { width: number; height: number };
  fileRevision?: string;
}
interface Entry {
  target: MediaTarget;
  preview: MediaPreview;
  pending: boolean;
  first: Promise<void>;
  resolve(): void;
}

const dataMime = (source: string) =>
  /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i.exec(source)?.[1]?.toLowerCase();
const imageName = (path: string) => path.split(/[\\/]/).at(-1) || "Image";

export function resolveMediaTarget(
  ref: MediaRef,
  source: string,
  alt: string,
  threadId: string,
  workspaceRoot?: string | null,
  viewed = false,
): MediaTarget {
  const result: MediaTarget = {
    ...ref,
    source,
    name: alt || "Image",
    mimeType: "image/png",
    mediaFile: null,
    directUrl: "",
    fragment: "",
    error: "",
  };
  if (viewed) {
    const image = resolveViewedImageAsset(source, { threadId, workspaceRoot });
    return image
      ? {
          ...result,
          mediaFile: image.resource,
          mimeType: image.mimeType,
          name: image.alt,
          fragment: image.srcFragment,
        }
      : { ...result, error: "This image source is unavailable." };
  }
  const classified = classifyMarkdownImageSource(source, workspaceRoot);
  if (classified._tag === "WorkspaceFile") {
    return {
      ...result,
      name: imageName(classified.path),
      mediaFile: { threadId, path: classified.path },
      mimeType: workspaceImageMimeType(classified.path) ?? "image/png",
      fragment: markdownImageSourceFragment(source),
    };
  }
  if (classified._tag === "Direct") {
    const url = classified.uri.startsWith("//") ? `https:${classified.uri}` : classified.uri;
    if (/^https?:/i.test(url)) {
      try {
        const path = new URL(url).pathname;
        return {
          ...result,
          name: imageName(path),
          directUrl: url,
          mimeType: workspaceImageMimeType(path) ?? "image/png",
        };
      } catch {
        return { ...result, error: "This image URL is invalid." };
      }
    }
    const mimeType = dataMime(url);
    if (mimeType && url.length <= Math.ceil((FILE_LIMIT * 4) / 3) + 512)
      return { ...result, directUrl: url, mimeType };
  }
  return { ...result, error: "This image source cannot be loaded." };
}

export function viewedImageBlock(source: unknown): MarkdownBlock | null {
  if (
    typeof source !== "string" ||
    /[\r\n]/.test(source) ||
    !resolveViewedImageAsset(source, { threadId: "preview" })
  )
    return null;
  return {
    id: "viewed-image",
    kind: "image",
    body: "",
    imageSource: source.trim(),
    imageAlt: "Viewed image",
    marker: "",
    gutter: 0,
    depth: 0,
    quoteDepth: 0,
    language: "",
    languageLabel: "",
    headingLevel: 0,
    spacingAfter: 6,
    runs: [],
    cells: [],
    columns: 0,
    tableSignature: "",
    pending: false,
  };
}

export class MediaPreviews {
  private entries = new Map<string, Entry>();
  private active = new Set<Entry>();
  private scope = "";
  private serial = 0;

  clear() {
    for (const entry of this.entries.values()) entry.resolve();
    this.entries.clear();
  }

  async load(
    scope: string,
    refs: readonly MediaDemand[],
    now: number,
    resolveTarget: (ref: MediaRef) => MediaTarget | undefined,
    read: (media: MediaFileIdentity) => Promise<AssetRead>,
  ): Promise<MediaPreview[]> {
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
    }
    const targets = refs.flatMap((ref) => {
      const target = resolveTarget(ref);
      return target
        ? [{ ref, target, key: JSON.stringify([ref.messageId, ref.blockId, ref.attempt]) }]
        : [];
    });
    const desiredKeys = new Set(targets.map((target) => target.key));
    for (const [key, entry] of this.entries) {
      if (
        (entry.preview.state === "loading" && !desiredKeys.has(key)) ||
        (entry.preview.state === "ready" && entry.preview.expiresAt <= now + 5000)
      ) {
        this.entries.delete(key);
        entry.resolve();
      }
    }
    const result: { key: string; entry: Entry }[] = [];
    for (const { ref, target, key } of targets) {
      let entry = this.entries.get(key);
      if (
        entry &&
        (entry.target.source !== target.source ||
          entry.target.mediaFile?.path !== target.mediaFile?.path)
      ) {
        entry.resolve();
        this.entries.delete(key);
        entry = undefined;
      }
      if (!entry) {
        const first = Promise.withResolvers<void>();
        entry = {
          target,
          pending: false,
          first: first.promise,
          resolve: () => first.resolve(),
          preview: {
            messageId: ref.messageId,
            blockId: ref.blockId,
            attempt: ref.attempt,
            version: ++this.serial,
            url: target.directUrl,
            state: target.error ? "error" : target.directUrl ? "ready" : "loading",
            error: target.error,
            width: 0,
            height: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            fileRevision: "",
          },
        };
        this.entries.set(key, entry);
        if (entry.preview.state !== "loading") entry.resolve();
      }
      const captured = entry;
      if (
        entry.preview.state === "loading" &&
        !entry.pending &&
        target.mediaFile &&
        this.active.size < 6
      ) {
        entry.pending = true;
        this.active.add(entry);
        try {
          read(target.mediaFile)
            .then((asset) => {
              if (this.entries.get(key) !== captured) return;
              captured.preview = {
                ...captured.preview,
                state: "ready",
                url: asset.url + target.fragment,
                expiresAt: asset.expiresAt,
                width: asset.imageDimensions?.width ?? 0,
                height: asset.imageDimensions?.height ?? 0,
                fileRevision: asset.fileRevision ?? "",
              };
            })
            .catch((error: unknown) => {
              if (this.entries.get(key) === captured)
                captured.preview = {
                  ...captured.preview,
                  state: "error",
                  error: error instanceof Error ? error.message : "This image could not be loaded.",
                };
            })
            .finally(() => {
              this.active.delete(captured);
              captured.pending = false;
              captured.resolve();
            });
        } catch (error) {
          this.active.delete(entry);
          entry.pending = false;
          entry.preview = {
            ...entry.preview,
            state: "error",
            error: error instanceof Error ? error.message : "This image could not be loaded.",
          };
          entry.resolve();
        }
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
      result.push({ key, entry });
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 64) break;
      if (!entry.pending && !desiredKeys.has(key)) this.entries.delete(key);
    }
    const pending = result.filter(({ entry }) => entry.pending).map(({ entry }) => entry.first);
    if (pending.length) await Promise.race(pending);
    else if (this.active.size && result.some(({ entry }) => entry.preview.state === "loading"))
      await Promise.race([...this.active].map((entry) => entry.first));
    return result
      .filter(({ key, entry }) => this.entries.get(key) === entry)
      .map(({ entry }) => ({ ...entry.preview }));
  }
}

export function freezeMediaGallery(
  presentationId: string,
  selected: MediaTarget,
  targets: readonly MediaTarget[],
) {
  if (selected.error) throw new Error(selected.error);
  const id = (target: MediaTarget) => JSON.stringify([target.messageId, target.blockId]);
  const candidate = (target: MediaTarget): GalleryCandidate => ({
    item: {
      id: id(target),
      type: "image",
      name: target.name,
      mimeType: target.mimeType,
      sizeBytes: FILE_LIMIT,
      width: 0,
      height: 0,
    },
    mediaFile: target.mediaFile,
    directUrl: target.directUrl,
    localPath: "",
    sourceId: `media-${target.messageId}-${target.blockId}`,
  });
  const source = targets.filter((target) => !target.error).slice(0, 100);
  const gallery = freezeGallery(presentationId, candidate(selected), source.map(candidate));
  return {
    ...gallery,
    items: gallery.items.map((item) => ({
      ...item,
      url: [selected, ...source].find((target) => id(target) === item.item.id)?.directUrl ?? "",
    })),
  };
}

export function decodeImageData(source: string): Uint8Array {
  if (!dataMime(source) || source.length > Math.ceil((FILE_LIMIT * 4) / 3) + 512)
    throw new Error("This image data is invalid or too large.");
  const comma = source.indexOf(",");
  const bytes = /;base64$/i.test(source.slice(0, comma))
    ? Uint8Array.from(atob(source.slice(comma + 1)), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(source.slice(comma + 1)));
  if (!bytes.length || bytes.length > FILE_LIMIT)
    throw new Error("This image data is invalid or too large.");
  return bytes;
}
