import { expect, test } from "bun:test";
import type { Storage, Store } from "../app.contract.d.ts";
import { mediaSources } from "../media-sources";
import {
  MediaPreviews,
  decodeImageData,
  freezeMediaGallery,
  resolveMediaTarget,
} from "../media-preview";

test("media demand bounds signing, keeps cached URLs until expiry, and discards stale scopes", async () => {
  const cache = new MediaPreviews();
  const requests: { resolve(value: { url: string; expiresAt: number }): void }[] = [];
  const read = () => {
    const request = Promise.withResolvers<{ url: string; expiresAt: number }>();
    requests.push(request);
    return request.promise;
  };
  const refs = Array.from({ length: 100 }, (_, index) => ({
    threadId: "environment:thread",
    viewKey: "view",
    messageId: "m",
    blockId: String(index),
    attempt: 0,
  }));
  const resolve = (ref: (typeof refs)[number]) =>
    resolveMediaTarget(ref, `/tmp/${ref.blockId}.png`, "", "thread", null);
  const first = cache.load("scope", refs, 1000, resolve, read);
  expect(requests).toHaveLength(6);
  for (const request of requests)
    request.resolve({ url: "https://host/api/assets/one", expiresAt: 100000 });
  const previews = await first;
  expect(previews).toHaveLength(100);
  expect(previews.map((preview) => preview.blockId)).toEqual(refs.map((ref) => ref.blockId));
  expect(previews.filter((preview) => preview.state === "ready")).toHaveLength(6);
  expect(Object.keys(previews[0]!).sort()).toEqual(
    [
      "messageId",
      "blockId",
      "attempt",
      "version",
      "url",
      "state",
      "error",
      "width",
      "height",
      "expiresAt",
      "fileRevision",
    ].sort(),
  );
  const next = cache.load("scope", refs, 2000, resolve, read);
  expect(requests).toHaveLength(12);
  for (const request of requests.slice(6))
    request.resolve({ url: "https://host/api/assets/two", expiresAt: 100000 });
  await next;
  const third = cache.load("scope", refs, 3000, resolve, read);
  expect(requests).toHaveLength(18);
  for (const request of requests.slice(12))
    request.resolve({ url: "https://host/api/assets/three", expiresAt: 100000 });
  expect(await third).toHaveLength(100);
  expect(requests).toHaveLength(18);
  const expired = cache.load("scope", refs.slice(-1), 100001, resolve, read);
  expect(requests).toHaveLength(19);
  cache.clear();
  expect(await expired).toEqual([]);
  requests.at(-1)!.resolve({ url: "https://host/api/assets/stale", expiresAt: 200000 });
  expect(await cache.load("other", [], 100001, resolve, read)).toEqual([]);
});

test("media errors remain visible until retry and direct images need no signing", async () => {
  const cache = new MediaPreviews();
  const ref = { messageId: "m", blockId: "i", attempt: 0 };
  let calls = 0;
  const read = async () => {
    calls++;
    throw new Error("File access denied");
  };
  const resolve = () => resolveMediaTarget(ref, "/tmp/plot.svg", "plot", "thread", null);
  expect(await cache.load("scope", [ref], 0, resolve, read)).toMatchObject([
    { state: "error", error: "File access denied" },
  ]);
  await cache.load("scope", [ref], 1, resolve, read);
  expect(calls).toBe(1);
  await cache.load("scope", [{ ...ref, attempt: 1 }], 1, resolve, read);
  expect(calls).toBe(2);
  const direct = () => resolveMediaTarget(ref, "//host/plot.png", "plot", "thread", null);
  expect(await cache.load("scope", [ref], 2, direct, read)).toMatchObject([
    { state: "ready", url: "https://host/plot.png" },
  ]);
  expect(calls).toBe(2);
  const blocked = () => resolveMediaTarget(ref, "javascript:alert(1)", "plot", "thread", null);
  expect(await cache.load("scope", [ref], 2, blocked, read)).toMatchObject([{ state: "error" }]);
  const sources = mediaSources({
    sessionFor: () => {
      throw new Error("Disconnected");
    },
    sync: () => {},
    awaitReply: async (operation) => operation,
  });
  const failure = await sources.loadMediaPreviews(
    ["env:thread", "view", [{ ...ref, threadId: "env:thread", viewKey: "view" }], 0, 0, [], 0],
    {} as Store,
    {} as Storage,
    null,
  );
  expect(failure.previews).toEqual([
    {
      ...ref,
      version: -1,
      state: "error",
      error: "Disconnected",
      url: "",
      width: 0,
      height: 0,
      expiresAt: 0,
      fileRevision: "",
    },
  ]);
});

test("media gallery freezes resources without signing or downloading and decodes only image data", () => {
  const first = resolveMediaTarget(
    { messageId: "m", blockId: "1" },
    "/tmp/one.svg",
    "First",
    "displayed",
    null,
  );
  const second = resolveMediaTarget(
    { messageId: "m", blockId: "2" },
    "https://host/two.png",
    "Second",
    "displayed",
    null,
  );
  const gallery = freezeMediaGallery("gallery", second, [first, second]);
  expect(gallery.selectedIndex).toBe(1);
  expect(gallery.items).toMatchObject([
    { mediaFile: { threadId: "displayed", path: "/tmp/one.svg" }, state: "loading", url: "" },
    { mediaFile: null, state: "loading", url: "https://host/two.png" },
  ]);
  expect(gallery.items[0]!.path.endsWith(".svg")).toBe(true);
  expect(decodeImageData("data:image/png;base64,AQID")).toEqual(new Uint8Array([1, 2, 3]));
  expect(new TextDecoder().decode(decodeImageData("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"))).toBe(
    "<svg></svg>",
  );
  expect(() => decodeImageData("data:text/html;base64,AQID")).toThrow();
  expect(() => decodeImageData("data:image/png;base64,?")).toThrow();
});
