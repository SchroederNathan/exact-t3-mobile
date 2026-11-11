import type { NativeModule, Sources, Storage } from "./app.contract.d.ts";
import { type DirectSession, threadIdentity } from "./connection";
import type { GalleryWork } from "./attachment-gallery";
import { ownedPreviewPath, PREVIEW_DIRECTORY } from "./attachments";
import { decodeImageData, freezeMediaGallery, MediaPreviews } from "./media-preview";

export function mediaSources(boundary: {
  sessionFor(id: string): DirectSession;
  sync(native: NativeModule): void;
  awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T>;
}): Pick<Sources, "loadMediaPreviews" | "prepareMediaViewer"> {
  const cache = new MediaPreviews();
  return {
    loadMediaPreviews: async (
      [id, viewKey, refs, _clock, _revision, _blocks, now],
      _store,
      _storage,
      native,
    ) => {
      const empty = { threadId: id, viewKey, previews: [] };
      native?.watch("connections");
      if (native?.available) boundary.sync(native);
      if (!id) {
        cache.clear();
        return empty;
      }
      try {
        const identity = threadIdentity(id);
        const session = boundary.sessionFor(identity.environmentId);
        const metadata = session.attachments.metadata();
        const previews = await boundary.awaitReply(
          cache.load(
            JSON.stringify([id, viewKey, metadata.accessKey]),
            refs,
            now,
            (ref) => session.mediaTarget(identity.threadId, viewKey, ref),
            (media) => session.attachments.readMediaFile(media),
          ),
          native,
        );
        return { threadId: id, viewKey, previews };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Images could not be loaded.";
        return {
          ...empty,
          previews: refs.map((ref) => ({
            messageId: ref.messageId,
            blockId: ref.blockId,
            attempt: ref.attempt,
            version: -1,
            state: "error",
            error: message,
            url: "",
            width: 0,
            height: 0,
            expiresAt: 0,
            fileRevision: "",
          })),
        };
      }
    },
    prepareMediaViewer: async ([id, routeId, viewKey, messageId, blockId], _store, storage) => {
      const identity = threadIdentity(id);
      const session = boundary.sessionFor(identity.environmentId);
      const selected = session.mediaTarget(identity.threadId, viewKey, { messageId, blockId });
      if (!selected) throw new Error("This image is no longer available.");
      const metadata = session.attachments.metadata();
      if (!metadata.accessKey) throw new Error("This environment is disconnected.");
      const presentationId = crypto.randomUUID();
      const gallery = freezeMediaGallery(
        presentationId,
        selected,
        session.mediaTargets(identity.threadId, viewKey, messageId),
      );
      await storage.fs.mkdir(`${PREVIEW_DIRECTORY}${presentationId}`);
      return {
        viewer: {
          presentationId,
          threadId: id,
          routeId,
          accessKey: metadata.accessKey,
          origin: metadata.origin,
          ...gallery,
          state: "loading",
          error: "",
        },
      };
    },
  };
}

export async function writeMediaData(work: GalleryWork, storage: Storage) {
  try {
    if (!ownedPreviewPath(work.item.path)) throw new Error("This image preview path is invalid.");
    await storage.fs.atomicWriteFile(work.item.path, decodeImageData(work.item.url));
    return { work: { ...work, item: { ...work.item, state: "ready", error: "" } } };
  } catch (error) {
    return {
      work: {
        ...work,
        item: {
          ...work.item,
          state: "error",
          error: error instanceof Error ? error.message : "This image could not be opened.",
        },
      },
    };
  }
}
