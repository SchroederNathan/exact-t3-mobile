import { expect, spyOn, test } from "bun:test";
import { freezeGallery, GalleryDownloads, galleryWorkKey, type AttachmentViewer, type GalleryCandidate, type GalleryWork } from "./attachment-gallery";
import { AttachmentSession } from "./attachment-session";
import { ownedPreviewPath } from "./attachments";
import { answer } from "./app";
import type { NativeModule, Storage, Store } from "./app.contract.d.ts";

const candidate = (id: string, mimeType = "image/png", localPath = ""): GalleryCandidate => ({
  item: { type: "file", id, name: `${id}.png`, mimeType, sizeBytes: 100, width: 600, height: 300 }, localPath, sourceId: `image-message-${id}`,
});
const work = (index: number, attempt = 1): GalleryWork => ({ presentationId: "gallery", threadId: "env:thread", accessKey: "access", origin: "https://host.example", index, attempt,
  item: { ...freezeGallery("gallery", candidate("first"), [candidate("first"), candidate("second")]).items[index]!, url: `https://host.example/api/assets/${index}` },
});

test("gallery capture preserves selected image and message order, excludes documents, and freezes local identity", () => {
  const group = [candidate("a"), candidate("document", "application/pdf"), candidate("b", "image/jpeg"), candidate("a"), candidate("c", "image/gif"), candidate("d", "image/webp")];
  const clicked = { ...group[2]!, sourceId: "clicked-b" };
  const gallery = freezeGallery("gallery", clicked, group);
  expect(gallery.imageGallery).toBe(true);
  expect(gallery.selectedIndex).toBe(1);
  expect(gallery.items.map((item) => item.item.id)).toEqual(["a", "b", "c", "d"]);
  expect(gallery.items[1]!.sourceId).toBe("clicked-b");
  group[2]!.item.name = "changed after opening";
  group.reverse();
  expect(gallery.items[1]!.item.name).toBe("b.png");
  expect(gallery.items.every((item) => ownedPreviewPath(item.path) && item.state === "loading")).toBe(true);
  expect(ownedPreviewPath("app:/cache/attachment-previews/gallery/attachment-0.png/../file")).toBe(false);
  const first = candidate("", "image/png", "app:/data/composer-attachments/one/content.png");
  const second = candidate("", "image/png", "app:/data/composer-attachments/two/content.png");
  expect(freezeGallery("draft", second, [first, second])).toMatchObject({ selectedIndex: 1, items: [{ path: first.localPath, state: "ready" }, { path: second.localPath, state: "ready" }] });
  expect(freezeGallery("single", candidate("pdf", "application/pdf"), group)).toMatchObject({ imageGallery: false, selectedIndex: 0, items: [{ item: { id: "pdf" } }] });
  expect(freezeGallery("absent", candidate("missing"), group).selectedIndex).toBe(0);
});

test("one gallery transfer starts in its owned entry, preempts background work, and ignores stale cancellation", async () => {
  let inEntry = false;
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  using _fetch = spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    expect(inEntry).toBe(true);
    expect(init?.headers).toBeUndefined();
    expect(init?.exactBodyTo).toMatch(/^app:\/cache\/attachment-previews\/gallery\/attachment-[01]\.png$/);
    return new Promise((resolve, reject) => {
      const signal = init!.signal!;
      requests.push({ signal, resolve });
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  });
  const downloads = new GalleryDownloads();
  const start = (item: GalleryWork) => { inEntry = true; try { return downloads.download(item); } finally { inEntry = false; } };
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
  expect((await resumed).work.item).toMatchObject({ state: "error", error: "Attachment download failed (404)." });
  const closing = start(work(0, 3));
  downloads.cancel(galleryWorkKey(work(0, 3)));
  expect(requests[3]!.signal.aborted).toBe(true);
  await closing;
});

test("gallery metadata cancellation retires only its captured request and reuses the signed URL boundary", async () => {
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>();
  const cancelled: string[] = [];
  let serial = 0;
  const session = new AttachmentSession({ metadata: () => ({ accessKey: "key", origin: "https://host.example", allowed: true, uploads: true, maxFileBytes: 1000 }),
    resolve: () => undefined,
    query: () => { const id = String(++serial); return { id, promise: new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }; },
    cancel: (id) => { cancelled.push(id); pending.get(id)!.reject(new Error("Superseded")); },
  });
  const first = session.read(candidate("first").item, "gallery:0:1").catch((error: Error) => error.message);
  const selected = session.read(candidate("second").item, "gallery:1:2");
  session.cancelRead("gallery:0:1");
  expect(cancelled).toEqual(["1"]);
  pending.get("2")!.resolve({ relativeUrl: "/api/assets/selected", expiresAt: "2026-11-10T12:00:00Z" });
  expect((await selected).url).toBe("https://host.example/api/assets/selected");
  expect(await first).toBe("Superseded");
  session.cancelRead("gallery:1:2");
  expect(cancelled).toEqual(["1"]);
});

test("native gallery opens loading slots synchronously, reports selection, and holds its reply through explicit dismissal", async () => {
  const viewer: AttachmentViewer = { presentationId: "gallery", routeId: "route", threadId: "env:thread", accessKey: "", origin: "", state: "presented", error: "",
    ...freezeGallery("gallery", candidate("second"), [candidate("first"), candidate("second")]),
  };
  const store = {} as Store, storage = {} as Storage;
  const calls: Record<string, unknown>[] = [], watches: string[] = [];
  let inEntry = false, closed = false;
  let finish = (_value: unknown) => {};
  const native: NativeModule = { available: true, watch: (topic) => { watches.push(topic); },
    later: (request) => { expect(inEntry).toBe(true); calls.push(request); return new Promise((resolve) => { finish = resolve; }); },
    call: (request) => {
      expect(inEntry).toBe(true); calls.push(request);
      if (request.op === "attachments.selection") return { selectedIndex: 0 };
      if (request.op === "attachments.update" && request.state === "ready") throw new Error("Unsupported preview");
      return {};
    },
  };
  inEntry = true;
  const held = answer("presentAttachment", [viewer], store, storage, native).then((reply) => { closed = true; return reply; });
  inEntry = false;
  expect(calls[0]).toMatchObject({ op: "attachments.preview", selectedIndex: 1, imageGallery: true, items: [
    { state: "loading", path: "", sourceId: "image-message-first" }, { state: "loading", path: "", sourceId: "image-message-second" },
  ] });
  inEntry = true;
  const selection = answer("loadGallerySelection", [viewer], store, storage, native);
  const updated = answer("updateGalleryItem", [{ ...work(0), item: { ...work(0).item, state: "ready" } }], store, storage, native);
  const dismissed = answer("dismissAttachment", [viewer.presentationId], store, storage, native);
  inEntry = false;
  expect(await selection).toEqual({ presentationId: "gallery", selectedIndex: 0, valid: true });
  expect(watches).toContain("attachment-preview");
  expect((await updated).work.item).toMatchObject({ state: "error", error: "Unsupported preview" });
  expect(calls.slice(-2)).toEqual([{ op: "attachments.update", presentationId: "gallery", index: 0, path: "", state: "error" }, { op: "attachments.dismiss", presentationId: "gallery" }]);
  await dismissed;
  expect(closed).toBe(false);
  finish({ presentationId: "gallery", status: "dismissed" });
  expect((await held).viewer).toMatchObject({ state: "dismissed", items: viewer.items });
});
