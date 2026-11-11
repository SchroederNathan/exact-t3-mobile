import { expect, test, spyOn } from "bun:test";
import {
  freezeGallery,
  freezeToolGallery,
  GalleryDownloads,
  galleryWorkKey,
  type AttachmentViewer,
  type GalleryCandidate,
  type GalleryWork,
} from "../attachment-gallery";
import { AttachmentSession } from "../attachment-session";
import { ownedPreviewPath } from "../attachments";
import { answer } from "../app";
import type { NativeModule, Storage, Store } from "../app.contract.d.ts";

const candidate = (id: string, mimeType = "image/png", localPath = ""): GalleryCandidate => ({
  item: { type: "file", id, name: `${id}.png`, mimeType, sizeBytes: 100, width: 600, height: 300 },
  localPath,
  sourceId: `image-message-${id}`,
});
const work = (index: number, attempt = 1): GalleryWork => ({
  presentationId: "gallery",
  threadId: "env:thread",
  accessKey: "access",
  origin: "https://host.example",
  index,
  attempt,
  item: {
    ...freezeGallery("gallery", candidate("first"), [candidate("first"), candidate("second")])
      .items[index]!,
    url: `https://host.example/api/assets/${index}`,
  },
});

test("gallery capture preserves selected image and message order, excludes documents, and freezes local identity", () => {
  const group = [
    candidate("a"),
    candidate("document", "application/pdf"),
    candidate("b", "image/jpeg"),
    candidate("a"),
    candidate("c", "image/gif"),
    candidate("d", "image/webp"),
  ];
  const clicked = { ...group[2]!, sourceId: "clicked-b" };
  const gallery = freezeGallery("gallery", clicked, group);
  expect(gallery.imageGallery).toBe(true);
  expect(gallery.selectedIndex).toBe(1);
  expect(gallery.items.map((item) => item.item.id)).toEqual(["a", "b", "c", "d"]);
  expect(gallery.items[1]!.sourceId).toBe("clicked-b");
  group[2]!.item.name = "changed after opening";
  group.reverse();
  expect(gallery.items[1]!.item.name).toBe("b.png");
  expect(
    gallery.items.every((item) => ownedPreviewPath(item.path) && item.state === "loading"),
  ).toBe(true);
  expect(ownedPreviewPath("app:/cache/attachment-previews/gallery/attachment-0.png/../file")).toBe(
    false,
  );
  const first = candidate("", "image/png", "app:/data/composer-attachments/one/content.png");
  const second = candidate("", "image/png", "app:/data/composer-attachments/two/content.png");
  expect(freezeGallery("draft", second, [first, second])).toMatchObject({
    selectedIndex: 1,
    items: [
      { path: first.localPath, state: "ready" },
      { path: second.localPath, state: "ready" },
    ],
  });
  expect(freezeGallery("single", candidate("pdf", "application/pdf"), group)).toMatchObject({
    imageGallery: false,
    selectedIndex: 0,
    items: [{ item: { id: "pdf" } }],
  });
  expect(freezeGallery("absent", candidate("missing"), group).selectedIndex).toBe(0);
  const images = [
    {
      url: "https://host.example/api/assets/first",
      alt: "First screenshot.txt",
      mimeType: "image/png",
    },
    {
      url: "https://host.example/api/assets/first",
      alt: "Second screenshot",
      mimeType: "image/jpeg",
    },
  ];
  const tools = freezeToolGallery("tool-gallery", "row", 1, {
    threadId: "parent-thread",
    itemId: "screenshot-call",
    images,
  });
  expect(tools.selectedIndex).toBe(1);
  expect(tools.items[0]!.path).toMatch(/attachment-0\.png$/);
  expect(tools.items[1]!.path).toMatch(/attachment-1\.jpg$/);
  expect(
    tools.items.map(({ toolImage, sourceId, url, state }) => ({ toolImage, sourceId, url, state })),
  ).toEqual([
    {
      toolImage: { threadId: "parent-thread", itemId: "screenshot-call", index: 0 },
      sourceId: "tool-image-row-0",
      url: "",
      state: "loading",
    },
    {
      toolImage: { threadId: "parent-thread", itemId: "screenshot-call", index: 1 },
      sourceId: "tool-image-row-1",
      url: "",
      state: "loading",
    },
  ]);
  images.reverse();
  expect(tools.items[1]!.item.name).toBe("Second screenshot");
  expect(() =>
    freezeToolGallery("invalid", "row", 2, {
      threadId: "parent-thread",
      itemId: "screenshot-call",
      images,
    }),
  ).toThrow("This tool image is unavailable.");
  const media = {
    ...candidate("same-label", "image/svg+xml"),
    item: { ...candidate("same-label", "image/svg+xml").item, name: "diagram.svg" },
    mediaFile: { threadId: "thread", path: "/workspace/diagram.svg" },
  };
  const otherThread = { ...media, mediaFile: { ...media.mediaFile, threadId: "other" } };
  const mediaGallery = freezeGallery("media", otherThread, [media, otherThread, media]);
  expect(mediaGallery.items.map((item) => item.mediaFile)).toEqual([
    { threadId: "thread", path: "/workspace/diagram.svg" },
    { threadId: "other", path: "/workspace/diagram.svg" },
  ]);
  expect(mediaGallery.selectedIndex).toBe(1);
  expect(mediaGallery.items[1]!.path).toMatch(/attachment-1\.svg$/);
  otherThread.mediaFile.path = "/workspace/replaced.svg";
  expect(mediaGallery.items[1]!.mediaFile?.path).toBe("/workspace/diagram.svg");
});

test("one gallery transfer starts in its owned entry, preempts background work, and ignores stale cancellation", async () => {
  let inEntry = false;
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  using _fetch = spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    expect(inEntry).toBe(true);
    expect(init?.headers).toBeUndefined();
    expect(init?.exactBodyTo).toMatch(
      /^app:\/cache\/attachment-previews\/gallery\/attachment-[01]\.png$/,
    );
    return new Promise((resolve, reject) => {
      const signal = init!.signal!;
      requests.push({ signal, resolve });
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  });
  const downloads = new GalleryDownloads();
  const start = (item: GalleryWork) => {
    inEntry = true;
    try {
      return downloads.download(item);
    } finally {
      inEntry = false;
    }
  };
  const background = start(work(0));
  const selected = start(work(1));
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(false);
  downloads.cancel(galleryWorkKey(work(0)));
  expect(requests[1]!.signal.aborted).toBe(false);
  requests[1]!.resolve(new Response("", { status: 200 }));
  expect((await selected).work.item.state).toBe("ready");
  expect((await background).work.item.state).toBe("error");
  const resumed = start(work(0, 2));
  expect(requests).toHaveLength(3);
  requests[2]!.resolve(new Response("", { status: 404 }));
  expect((await resumed).work.item).toMatchObject({
    state: "error",
    error: "Attachment download failed (404).",
  });
  const closing = start(work(0, 3));
  downloads.cancel(galleryWorkKey(work(0, 3)));
  expect(requests[3]!.signal.aborted).toBe(true);
  await closing;
});

test("gallery metadata cancellation retires only its captured request and reuses the signed URL boundary", async () => {
  const pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }
  >();
  const cancelled: string[] = [];
  const resources: unknown[] = [];
  let serial = 0;
  let accessKey = "key";
  const session = new AttachmentSession({
    metadata: () => ({
      accessKey,
      origin: "https://host.example",
      allowed: false,
      uploads: false,
      maxFileBytes: 1000,
    }),
    resolve: () => undefined,
    query: (_tag, payload) => {
      resources.push(payload);
      const id = String(++serial);
      return {
        id,
        promise: new Promise((resolve, reject) => pending.set(id, { resolve, reject })),
      };
    },
    cancel: (id) => {
      cancelled.push(id);
      pending.get(id)!.reject(new Error("Superseded"));
    },
  });
  const first = session
    .read(candidate("first").item, "gallery:0:1")
    .catch((error: Error) => error.message);
  const selected = session.read(candidate("second").item, "gallery:1:2");
  session.cancelRead("gallery:0:1");
  expect(cancelled).toEqual(["1"]);
  pending
    .get("2")!
    .resolve({ relativeUrl: "/api/assets/selected", expiresAt: "2026-11-10T12:00:00Z" });
  expect((await selected).url).toBe("https://host.example/api/assets/selected");
  expect(await first).toBe("Superseded");
  session.cancelRead("gallery:1:2");
  expect(cancelled).toEqual(["1"]);
  const toolImage = session.readToolImage(
    { threadId: "parent", itemId: "screenshot", index: 1 },
    "gallery:1:3",
  );
  expect(resources.at(-1)).toEqual({
    resource: { _tag: "tool-output-image", threadId: "parent", itemId: "screenshot", index: 1 },
  });
  pending
    .get("3")!
    .resolve({ relativeUrl: "/api/assets/fresh-tool-image", expiresAt: 1794312000000 });
  expect(await toolImage).toEqual({
    url: "https://host.example/api/assets/fresh-tool-image",
    expiresAt: 1794312000000,
  });
  const cancelledImage = session
    .readToolImage({ threadId: "parent", itemId: "screenshot", index: 0 }, "gallery:0:4")
    .catch((error: Error) => error.message);
  session.cancelRead("gallery:0:4");
  expect(await cancelledImage).toBe("Superseded");
  expect(cancelled).toEqual(["1", "4"]);
  const media = session.readMediaFile({ threadId: "displayed", path: "/tmp/plot.svg" }, "media:1");
  expect(resources.at(-1)).toEqual({
    resource: { _tag: "media-file", threadId: "displayed", path: "/tmp/plot.svg" },
  });
  pending.get("5")!.resolve({
    relativeUrl: "/api/assets/plot.svg",
    expiresAt: 1794312000000,
    imageDimensions: { width: 640, height: 360 },
    fileRevision: "revision-1",
  });
  expect(await media).toEqual({
    url: "https://host.example/api/assets/plot.svg",
    expiresAt: 1794312000000,
    imageDimensions: { width: 640, height: 360 },
    fileRevision: "revision-1",
  });
  const invalid = session
    .readMediaFile({ threadId: "displayed", path: "/tmp/plot.svg" })
    .catch((error: Error) => error.message);
  pending.get("6")!.resolve({ relativeUrl: "https://different.example/api/assets/plot.svg" });
  expect(await invalid).toBe("The server returned an invalid attachment URL.");
  const stale = session
    .readMediaFile({ threadId: "displayed", path: "/tmp/plot.svg" }, "media:2")
    .catch((error: Error) => error.message);
  accessKey = "replacement-key";
  pending.get("7")!.resolve({ relativeUrl: "/api/assets/plot.svg" });
  expect(await stale).toBe("The attachment connection changed. Retry to load it.");
  const cancelledMedia = session
    .readMediaFile({ threadId: "displayed", path: "/tmp/plot.svg" }, "media:3")
    .catch((error: Error) => error.message);
  session.cancelRead("media:3");
  expect(await cancelledMedia).toBe("Superseded");
  expect(cancelled).toEqual(["1", "4", "8"]);
});

test("native gallery opens loading slots synchronously, reports selection, and holds its reply through explicit dismissal", async () => {
  const viewer: AttachmentViewer = {
    presentationId: "gallery",
    routeId: "route",
    threadId: "env:thread",
    accessKey: "",
    origin: "",
    state: "presented",
    error: "",
    ...freezeGallery("gallery", candidate("second"), [candidate("first"), candidate("second")]),
  };
  const store = {} as Store,
    storage = {} as Storage;
  const calls: Record<string, unknown>[] = [],
    watches: string[] = [];
  let inEntry = false,
    closed = false;
  let finish = (_value: unknown) => {};
  const native: NativeModule = {
    available: true,
    watch: (topic) => {
      watches.push(topic);
    },
    later: (request) => {
      expect(inEntry).toBe(true);
      calls.push(request);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    call: (request) => {
      expect(inEntry).toBe(true);
      calls.push(request);
      if (request.op === "attachments.selection") return { selectedIndex: 0 };
      if (request.op === "attachments.update" && request.state === "ready")
        throw new Error("Unsupported preview");
      return {};
    },
  };
  inEntry = true;
  const held = answer("presentAttachment", [viewer], store, storage, native).then((reply) => {
    closed = true;
    return reply;
  });
  inEntry = false;
  expect(calls[0]).toMatchObject({
    op: "attachments.preview",
    selectedIndex: 1,
    imageGallery: true,
    items: [
      { state: "loading", path: "", sourceId: "image-message-first" },
      { state: "loading", path: "", sourceId: "image-message-second" },
    ],
  });
  inEntry = true;
  const selection = answer("loadGallerySelection", [viewer], store, storage, native);
  const updated = answer(
    "updateGalleryItem",
    [{ ...work(0), item: { ...work(0).item, state: "ready" } }],
    store,
    storage,
    native,
  );
  const dismissed = answer("dismissAttachment", [viewer.presentationId], store, storage, native);
  inEntry = false;
  expect(await selection).toEqual({ presentationId: "gallery", selectedIndex: 0, valid: true });
  expect(watches).toContain("attachment-preview");
  expect((await updated).work.item).toMatchObject({ state: "error", error: "Unsupported preview" });
  expect(calls.slice(-2)).toEqual([
    { op: "attachments.update", presentationId: "gallery", index: 0, path: "", state: "error" },
    { op: "attachments.dismiss", presentationId: "gallery" },
  ]);
  await dismissed;
  expect(closed).toBe(false);
  finish({ presentationId: "gallery", status: "dismissed" });
  expect((await held).viewer).toMatchObject({ state: "dismissed", items: viewer.items });
});
