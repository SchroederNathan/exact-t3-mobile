import { expect, test } from "bun:test";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
  resolveViewedImageAsset,
} from "../markdown-images";

test("image sources distinguish direct URLs from decoded host paths and unresolved destinations", () => {
  for (const uri of [
    "https://example.test/image",
    "http://host/plot.png",
    "//host/plot.png",
    "data:image/png;base64,AQID",
    "blob:https://host/id",
  ])
    expect(classifyMarkdownImageSource(` <${uri}> `)).toEqual({ _tag: "Direct", uri });
  for (const [source, root, path] of [
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/image%20one.png", null, "/workspace/image one.png"],
    ["file:///C:/work/image.png", null, "C:/work/image.png"],
    ["/tmp/chart%23one%3F100%25.png?download=1#preview", null, "/tmp/chart#one?100%.png"],
    ["./image%2520one.png", "/repo", "/repo/./image%20one.png"],
    ["<圖/plot.png>", "/repo", "/repo/圖/plot.png"],
  ] as const)
    expect(classifyMarkdownImageSource(source, root)).toEqual({ _tag: "WorkspaceFile", path });
  for (const source of [
    null,
    undefined,
    "",
    "#plot",
    "?image",
    "plot.png",
    "~/plot.png",
    "~\\plot.png",
    "javascript:alert(1)",
    "file://%",
  ])
    expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
  expect(markdownImageSourceFragment(" </tmp/a%23b.svg?raw=1#view> ")).toBe("#view");
});

test("automatic host image loading keeps network paths within the project share", () => {
  const root = "\\\\server\\share\\project";
  for (const source of [
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
    "\\\\server\\share\\project\\..\\secret.png",
  ])
    expect(classifyMarkdownImageSource(source, root)).toEqual({ _tag: "Blocked" });
  expect(classifyMarkdownImageSource("file://SERVER/share/project/images/cat.png", root)).toEqual({
    _tag: "WorkspaceFile",
    path: "\\\\server\\share\\project\\images\\cat.png",
  });
});

test("viewed images retain thread context without requiring a known workspace and preserve image formats", () => {
  expect(classifyMarkdownImageSource("result.png")).toEqual({ _tag: "Blocked" });
  expect(resolveViewedImageAsset("result.png", { threadId: "displayed" })).toEqual({
    resource: { _tag: "media-file", threadId: "displayed", path: "result.png" },
    alt: "result.png",
    mimeType: "image/png",
    srcFragment: "",
  });
  expect(
    resolveViewedImageAsset("plot%23one.svg#preview", {
      threadId: "displayed",
      workspaceRoot: "/work",
    }),
  ).toEqual({
    resource: { _tag: "media-file", threadId: "displayed", path: "/work/plot#one.svg" },
    alt: "plot#one.svg",
    mimeType: "image/svg+xml",
    srcFragment: "#preview",
  });
  for (const [extension, mimeType] of [
    ["avif", "image/avif"],
    ["bmp", "image/bmp"],
    ["gif", "image/gif"],
    ["heic", "image/heic"],
    ["heif", "image/heif"],
    ["ico", "image/x-icon"],
    ["jpeg", "image/jpeg"],
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["svg", "image/svg+xml"],
    ["tif", "image/tiff"],
    ["tiff", "image/tiff"],
    ["webp", "image/webp"],
  ])
    expect(
      resolveViewedImageAsset(`/tmp/image.${extension!.toUpperCase()}`, { threadId: "t" })
        ?.mimeType,
    ).toBe(mimeType);
  for (const source of [
    "https://host/image.png",
    "data:image/png;base64,AQID",
    "script.ts",
    "file.constructor",
    "~/plot.png",
  ])
    expect(resolveViewedImageAsset(source, { threadId: "t" })).toBeNull();
});
