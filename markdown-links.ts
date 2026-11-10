export interface ThreadLink { environmentId: string | null; threadId: string }
export interface FileLink { path: string; line: number; column: number }
export interface ThreadRef { environmentId: string; threadId: string }

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
const validId = (value: string) => value.length > 0 && !/[\s\u0000-\u001f]/u.test(value);

export function parseThreadLink(href: string): ThreadLink | null {
  const hosted = /^https:\/\/app\.t3\.codes\/threads\/([^/?#]+)\/([^/?#]+)$/.exec(href);
  if (hosted) {
    const environmentId = decode(hosted[1]!);
    const threadId = decode(hosted[2]!);
    return validId(environmentId) && validId(threadId) ? { environmentId, threadId } : null;
  }
  if (href.startsWith("t3-thread://v1/")) {
    const threadId = href.slice(15);
    return validId(threadId) ? { environmentId: null, threadId } : null;
  }
  const scoped = /^t3-thread:\/\/v2\/([^/]+)\/(.+)$/.exec(href);
  return scoped && validId(scoped[1]!) && validId(scoped[2]!) ? { environmentId: scoped[1]!, threadId: scoped[2]! } : null;
}

export function resolveThreadLink(link: ThreadLink, originEnvironment: string, refs: ThreadRef[]): ThreadRef {
  const candidates = [...new Set([link.threadId, decode(link.threadId)])];
  const environment = link.environmentId ?? originEnvironment;
  for (const threadId of candidates) {
    const scoped = refs.find((ref) => ref.environmentId === environment && ref.threadId === threadId);
    if (scoped) return scoped;
  }
  if (link.environmentId === null) {
    for (const threadId of candidates) {
      const matches = refs.filter((ref) => ref.threadId === threadId);
      if (matches.length > 1) throw new Error("This thread link matches more than one environment.");
      if (matches[0]) return matches[0];
    }
  }
  throw new Error("This thread is unavailable. Check that its environment is connected.");
}

const extensionlessFiles = new Set([
  "Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile", "Justfile", "justfile", "Rakefile",
  "Gemfile", "Procfile", "Brewfile", "Caddyfile", "Vagrantfile", "Jenkinsfile", "Podfile", "Fastfile", "BUILD",
  "WORKSPACE", "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS", "CONTRIBUTORS", "CHANGELOG", "README", "CODEOWNERS",
]);

export function parseFileLink(href: string): FileLink | null {
  let source = href.trim().replace(/^<(.*)>$/, "$1");
  if (!source || source.startsWith("#") || source.startsWith("//")) return null;
  let hash = "";
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.host && url.host !== "localhost") return null;
      source = url.pathname;
      hash = url.hash;
    } catch { return null; }
  } else {
    const at = source.indexOf("#");
    hash = at < 0 ? "" : source.slice(at);
    source = (at < 0 ? source : source.slice(0, at)).split("?")[0]!;
  }
  source = decode(source).replace(/^\/([A-Za-z]:[\\/])/, "$1");
  const suffix = /:(\d+)(?::(\d+))?$/.exec(source);
  const path = suffix ? source.slice(0, -suffix[0].length) : source;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  if (!path || /[\u0000-\u001f]/.test(path) || (!/[\\/]/.test(path) && !/\.[\p{L}\p{N}_-]+$/u.test(path) && !extensionlessFiles.has(path))) return null;
  const position = suffix ?? /^#L(\d+)(?:C(\d+))?$/i.exec(decode(hash));
  const line = Number(position?.[1] ?? 0);
  const column = Number(position?.[2] ?? 0);
  return { path, line: Number.isSafeInteger(line) && line > 0 ? line : 0, column: Number.isSafeInteger(column) && column > 0 ? column : 0 };
}

export function markdownLinkKind(href: string): string {
  if (parseThreadLink(href) || href.startsWith("t3-thread:")) return "thread";
  if (/^(https?:|mailto:|tel:)/i.test(href)) return "external";
  return parseFileLink(href) ? "file" : "";
}
