export interface MediaFileIdentity {
  threadId: string;
  path: string;
}

export type MarkdownImageSource =
  | { _tag: "Direct"; uri: string }
  | { _tag: "WorkspaceFile"; path: string }
  | { _tag: "Blocked" };

const normalize = (value: string) => value.trim().replace(/^<(.*)>$/s, "$1");
const windowsPath = (value: string) =>
  value.startsWith("\\\\") || /^[A-Za-z]:([/\\]|$)/.test(value);
const networkPath = (value: string) => /^[\\/]{2}/.test(value);
const stripDriveSlash = (value: string) => value.replace(/^\/([A-Za-z]:[\\/])/, "$1");
const basename = (value: string) =>
  value
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? "";
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function markdownImageSourceFragment(source: string): string {
  const value = normalize(source);
  const index = value.indexOf("#");
  return index < 0 ? "" : value.slice(index);
}

function hostPath(source: string): string | null {
  let path: string;
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      path =
        url.hostname && url.hostname.toLowerCase() !== "localhost"
          ? `\\\\${url.hostname}${url.pathname.replaceAll("/", "\\")}`
          : url.pathname;
    } catch {
      return null;
    }
  } else path = source.split(/[?#]/, 1)[0] ?? "";
  return path ? stripDriveSlash(decode(path)) : null;
}

function withinWorkspace(path: string, root: string | null | undefined): boolean {
  if (!root) return false;
  const insensitive =
    windowsPath(stripDriveSlash(root)) || (networkPath(root) && path.startsWith("\\\\"));
  const normalized = (value: string) =>
    insensitive ? stripDriveSlash(value.replaceAll("\\", "/")).toLowerCase() : value;
  const comparedPath = normalized(path);
  const comparedRoot = normalized(root).replace(/\/+$/, "");
  if (comparedPath.replace(/\/+$/, "") === comparedRoot) return true;
  if (!comparedPath.startsWith(`${comparedRoot}/`)) return false;
  let depth = 0;
  for (const part of comparedPath.slice(comparedRoot.length + 1).split("/")) {
    if (part === "..") depth--;
    else if (part && part !== ".") depth++;
    if (depth < 0) return false;
  }
  return true;
}

export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  const source = value == null ? "" : normalize(value);
  if (!source || source.startsWith("#") || source.startsWith("?")) return { _tag: "Blocked" };
  if (/^(https?:|data:|blob:|\/\/)/i.test(source)) return { _tag: "Direct", uri: source };
  const path = hostPath(source);
  if (!path) return { _tag: "Blocked" };
  if (/^file:/i.test(source) || path.startsWith("/") || windowsPath(path)) {
    return networkPath(path) && !withinWorkspace(path, workspaceRoot)
      ? { _tag: "Blocked" }
      : { _tag: "WorkspaceFile", path };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /^~[\\/]/.test(path) || !workspaceRoot)
    return { _tag: "Blocked" };
  const separator = windowsPath(workspaceRoot) ? "\\" : "/";
  return {
    _tag: "WorkspaceFile",
    path: `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${path.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "")}`,
  };
}

const imageMimeTypes: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

export function workspaceImageMimeType(path: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(basename(path))?.[1]?.toLowerCase() ?? "";
  return Object.hasOwn(imageMimeTypes, extension) ? imageMimeTypes[extension]! : null;
}

export function resolveViewedImageAsset(
  source: string,
  input: { threadId: string; workspaceRoot?: string | null },
) {
  const classified = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (classified._tag !== "WorkspaceFile") return null;
  const path = (
    input.workspaceRoot == null ? classified.path.replace(/^\.\//, "") : classified.path
  ).replace(/:\d+(?::\d+)?$/, "");
  const mimeType = workspaceImageMimeType(path);
  if (!mimeType) return null;
  return {
    resource: { _tag: "media-file" as const, threadId: input.threadId, path },
    alt: basename(path),
    mimeType,
    srcFragment: markdownImageSourceFragment(source),
  };
}
