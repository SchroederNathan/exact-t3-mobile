import type {
  BrowseEntry,
  BrowseOutcome,
  CloneSnapshot,
  CloneStage,
  RepositoryInfo,
  SourceControlDiscovery,
} from "./project-rpc";

export type ConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface AddProjectEnvironment {
  readonly id: string;
  readonly label: string;
  readonly machineSymbol: string;
  /** The server's `environment.platform.os`: "darwin", "linux", "windows", or "" when unknown. */
  readonly os: string;
  /** `settings.addProjectBaseDirectory`; "" when unset. */
  readonly baseDirectory: string;
  readonly newProjectsRoot: string | null;
  readonly ghqCloneLayout: boolean;
  readonly phase: ConnectionPhase;
  readonly error: string | null;
  /** The session grants `orchestration:operate`. */
  readonly canOperate: boolean;
  /** The session grants `source-control:write`. */
  readonly canWriteSourceControl: boolean;
}

export type RowKind =
  | "environment"
  | "source"
  | "browse-up"
  | "folder"
  | "publish"
  | "publish-target"
  | "existing";

/** One row of an Add Project list section, whatever screen it is on. */
export interface AddProjectRow {
  readonly kind: RowKind;
  /** Environment id, source ("new", "local", "url" or a provider kind), folder name or provider kind. */
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  /** `symbol:sf/<name>` or an `assets/…svg` logo. */
  readonly icon: string;
  readonly iconSize: number;
  /** "icon", "icon-muted", or "" for a logo drawn in its own colours. */
  readonly iconTint: string;
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly trailing: "chevron" | "check" | "switch" | "none";
  /** Folder rows: the path field's text once the tap commits. */
  readonly path: string;
  /** Folder rows: the directory to load before committing the tap. */
  readonly browsePath: string;
}

export interface Alert {
  readonly title: string;
  readonly message: string;
}

export const NOT_REACHED_YET =
  "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.";
export const CLONE_BLOCK_REASON = "Wait for the project clone to finish.";
export const CANCEL_CLONE_FAILED = "Failed to cancel clone";
export const RETRY_CLONE_FAILED = "Failed to retry clone";
export const REMOVE_PROJECT_FAILED = "Failed to remove project";
const CANNOT_ADD = "This connection cannot add projects.";
const CANNOT_CLONE = "This connection cannot clone projects.";

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : "An error occurred.";
}

// Providers in upstream definition order (pkg/source-control-definitions/src/registry.ts).
interface ProviderDefinition {
  readonly kind: string;
  readonly label: string;
  readonly pickerLabel: string;
  readonly pathHint: string;
  readonly transport: "https" | "ssh";
  readonly icon: string;
  readonly monochrome: boolean;
  readonly newRepositoryOwner: (account: string | null) => { readonly owner: string | null } | null;
  readonly recognizes: (hostname: string) => boolean;
  readonly repositoryFromPage?: (url: URL, known: boolean) => string | null;
}

function repositoryUrlFromPagePath(url: URL, route: RegExp): string | null {
  const repository = route.exec(url.pathname)?.[1];
  if (!repository) return null;
  const repositoryUrl = new URL(url);
  repositoryUrl.pathname = `/${repository}`;
  repositoryUrl.search = "";
  repositoryUrl.hash = "";
  return repositoryUrl.href;
}

const labelsOf = (hostname: string) => hostname.split(".");
const isGitHubHost = (hostname: string) =>
  hostname === "github.com" || hostname.endsWith(".ghe.com") || labelsOf(hostname).includes("github");
const isBitbucketHost = (hostname: string) =>
  hostname === "bitbucket.org" || hostname.endsWith(".bitbucket.org") || labelsOf(hostname).includes("bitbucket");
const GITCAFE_HOSTS = new Set(["git.cafe", "staging.git.cafe"]);
const FORGEJO_PAGE = /^\/([^/]+(?:\/[^/]+)+?)\/src\/(?:branch|tag|commit)\/[^/]/u;

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    kind: "github",
    label: "GitHub",
    pickerLabel: "GitHub",
    pathHint: "owner/repo",
    transport: "https",
    icon: "assets/source-control-github.svg",
    monochrome: true,
    newRepositoryOwner: (account) => ({ owner: account }),
    recognizes: isGitHubHost,
    repositoryFromPage: (url) =>
      isGitHubHost(url.hostname.toLowerCase())
        ? repositoryUrlFromPagePath(url, /^\/([^/]+\/[^/]+)\/(?:tree|blob)\/[^/]/u)
        : null,
  },
  {
    kind: "cursor-origin",
    label: "Cursor Origin",
    pickerLabel: "Cursor Origin",
    pathHint: "owner/repo",
    transport: "https",
    icon: "assets/source-control-cursor-origin.svg",
    monochrome: true,
    newRepositoryOwner: (account) => ({ owner: account }),
    recognizes: (hostname) => hostname === "origin.cursor.com",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    pickerLabel: "GitLab",
    pathHint: "group/project",
    transport: "ssh",
    icon: "assets/source-control-gitlab.svg",
    monochrome: false,
    newRepositoryOwner: (account) => ({ owner: account }),
    recognizes: (hostname) => hostname === "gitlab.com" || labelsOf(hostname).includes("gitlab"),
    repositoryFromPage: (url) => repositoryUrlFromPagePath(url, /^\/([^/]+(?:\/[^/]+)+?)\/-\//u),
  },
  {
    kind: "gitcafe",
    label: "GitCafe",
    pickerLabel: "GitCafe",
    pathHint: "owner/repo",
    transport: "ssh",
    icon: "assets/source-control-gitcafe.svg",
    monochrome: false,
    newRepositoryOwner: (account) => (account ? { owner: account } : null),
    recognizes: (hostname) => GITCAFE_HOSTS.has(hostname),
    repositoryFromPage: (url) =>
      GITCAFE_HOSTS.has(url.hostname.toLowerCase())
        ? repositoryUrlFromPagePath(url, /^\/([^/]+\/[^/]+)\/(?:tree|blob)\/[^/]/u)
        : null,
  },
  {
    kind: "forgejo",
    label: "Forgejo",
    pickerLabel: "Forgejo / Gitea",
    pathHint: "owner/repo",
    transport: "https",
    icon: "assets/source-control-forgejo.svg",
    monochrome: false,
    newRepositoryOwner: (account) => (account ? { owner: account } : null),
    recognizes: (hostname) =>
      hostname === "codeberg.org" || labelsOf(hostname).includes("forgejo") || labelsOf(hostname).includes("gitea"),
    repositoryFromPage: (url, known) => {
      if (url.pathname.replace(/\/$/u, "").endsWith(".git")) return null;
      const repositoryUrl = repositoryUrlFromPagePath(url, FORGEJO_PAGE);
      // Off a known Forgejo host the same path can be a GitLab project nested under `src`.
      return repositoryUrl === null || known ? repositoryUrl : url.href;
    },
  },
  {
    kind: "bitbucket",
    label: "Bitbucket",
    pickerLabel: "Bitbucket",
    pathHint: "workspace/repository",
    transport: "ssh",
    icon: "assets/source-control-bitbucket.svg",
    monochrome: false,
    newRepositoryOwner: () => null,
    recognizes: (hostname) => hostname === "bitbucket.org" || labelsOf(hostname).includes("bitbucket"),
    repositoryFromPage: (url) =>
      isBitbucketHost(url.hostname.toLowerCase())
        ? repositoryUrlFromPagePath(url, /^\/([^/]+\/[^/]+)\/src\/[^/]/u)
        : null,
  },
  {
    kind: "azure-devops",
    label: "Azure DevOps",
    pickerLabel: "Azure DevOps",
    pathHint: "project/repository",
    transport: "ssh",
    icon: "assets/source-control-azure-devops.svg",
    monochrome: false,
    newRepositoryOwner: () => null,
    recognizes: (hostname) =>
      hostname === "dev.azure.com" || hostname.endsWith(".dev.azure.com") || hostname.endsWith(".visualstudio.com"),
  },
];

const byKind = (kind: string) => PROVIDERS.find((provider) => provider.kind === kind);
const providerOrder = (kinds: readonly string[]) => kinds.map((kind) => byKind(kind)!);
const RECOGNITION_ORDER = providerOrder(["gitcafe", "cursor-origin", "forgejo", "github", "gitlab", "azure-devops", "bitbucket"]);
const CLAIM_ORDER = providerOrder(["gitcafe", "cursor-origin", "azure-devops", "github", "gitlab", "forgejo", "bitbucket"]);

/** "url" or a provider kind; anything else reads as "url", as upstream's route param does. */
export function addProjectSource(value: string | null | undefined): string {
  return value && byKind(value) ? value : "url";
}

function sourceLabel(source: string): string {
  return source === "url" ? "Git URL" : (byKind(source)?.pickerLabel ?? "source control");
}

function sourcePathHint(source: string): string {
  return source === "url" ? "URL" : (byKind(source)?.pathHint ?? "URL");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


const isWindowsDrivePath = (value: string) => /^[a-zA-Z]:([/\\]|$)/.test(value);
const isUncPath = (value: string) => value.startsWith("\\\\");
const isWindowsAbsolutePath = (value: string) => isUncPath(value) || isWindowsDrivePath(value);
const isWindowsPlatform = (platform: string) => /^win(dows)?/i.test(platform);
const isExplicitRelativePath = (value: string) =>
  value === "." ||
  value === ".." ||
  value.startsWith("./") ||
  value.startsWith("../") ||
  value.startsWith(".\\") ||
  value.startsWith("..\\");

function absolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) return "windows";
  return value.startsWith("/") ? "unix" : null;
}

function preferredSeparator(value: string): "/" | "\\" {
  const kind = absolutePathKind(value);
  if (kind === "windows") return "\\";
  if (kind === "unix") return "/";
  return value.includes("\\") ? "\\" : "/";
}

function hasTrailingSeparator(value: string): boolean {
  return (absolutePathKind(value) === "unix" ? /\/$/ : /[\\/]$/).test(value);
}

function lastSeparatorIndex(value: string): number {
  return absolutePathKind(value) === "unix"
    ? value.lastIndexOf("/")
    : Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function splitSegments(value: string, separator: "/" | "\\"): string[] {
  return value.split(separator === "/" ? /\/+/ : /[\\/]+/).filter(Boolean);
}

function splitAbsolutePath(value: string): { root: string; separator: "/" | "\\"; segments: string[] } | null {
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    return { root, separator: "\\", segments: splitSegments(value.slice(root.length), "\\") };
  }
  if (isUncPath(value)) {
    const [server, share, ...rest] = splitSegments(value, "\\");
    if (!server || !share) return null;
    return { root: `\\\\${server}\\${share}\\`, separator: "\\", segments: rest };
  }
  if (value.startsWith("/")) return { root: "/", separator: "/", segments: splitSegments(value.slice(1), "/") };
  return null;
}

function trimTrailingSeparators(value: string): string {
  if (value.length === 0 || value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value)) return value;
  const trimmed = value.startsWith("/") ? value.replace(/\/+$/g, "") : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) return value;
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

const normalizeForDispatch = (value: string) => trimTrailingSeparators(value.trim());

function normalizeForComparison(value: string): string {
  const normalized = normalizeForDispatch(value);
  return isWindowsDrivePath(normalized) || isUncPath(normalized)
    ? normalized.replaceAll("/", "\\").toLowerCase()
    : normalized;
}

function isBrowseQuery(value: string, platform: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    (isWindowsPlatform(platform) && isWindowsAbsolutePath(value))
  );
}

function browseDirectoryPath(path: string): string {
  if (hasTrailingSeparator(path)) return path;
  const index = lastSeparatorIndex(path);
  return index < 0 ? path : path.slice(0, index + 1);
}

function ensureDirectoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0 || hasTrailingSeparator(trimmed)) return trimmed;
  return `${trimmed}${preferredSeparator(trimmed)}`;
}

function appendSegment(path: string, segment: string): string {
  return `${browseDirectoryPath(path)}${segment}${preferredSeparator(path)}`;
}

function browseParentPath(path: string): string | null {
  const trimmed = normalizeForDispatch(path);
  const absolute = splitAbsolutePath(trimmed);
  if (absolute) {
    if (absolute.segments.length === 0) return null;
    if (absolute.segments.length === 1) return absolute.root;
    return `${absolute.root}${absolute.segments.slice(0, -1).join(absolute.separator)}${absolute.separator}`;
  }
  const separator = preferredSeparator(path);
  const index = lastSeparatorIndex(trimmed);
  if (index < 0) return null;
  if (index === 2 && /^[a-zA-Z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}${separator}`;
  return trimmed.slice(0, index + 1);
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeForDispatch(value);
  const absolute = splitAbsolutePath(normalized);
  if (absolute) return absolute.segments.findLast(Boolean) ?? normalized;
  return normalized.split(/[/\\]/).findLast(Boolean) ?? normalized;
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

const isHostPath = (value: string) => value.startsWith("/") || isWindowsAbsolutePath(value) || value.startsWith("~/");
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

/**
 * The path field's text after an edit. A full path pasted or dropped replaces the field, even after
 * text already there, and Finder's shell quoting is undone.
 */
export function pastedPathInput(previous: string, next: string): string {
  const isTyping = next.startsWith(previous) ? next.length === previous.length + 1 : previous.startsWith(next);
  if (isTyping) return next;
  const match = QUOTED_PATH_AT_END.exec(next);
  if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
    const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? "";
    if (isHostPath(quoted)) return quoted;
  }
  const afterFolder = /[/\\]$/.test(previous) && next.startsWith(previous);
  const path = afterFolder ? next.slice(previous.length) : next;
  if (!isHostPath(path)) return next;
  return isWindowsAbsolutePath(path) ? path : path.replace(SHELL_ESCAPE, "$1");
}

export function resolveAddProjectPath(
  rawPath: string,
  platform: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return { ok: false, error: "Enter a project path." };
  if (isWindowsAbsolutePath(trimmed) && !isWindowsPlatform(platform))
    return { ok: false, error: "Windows-style paths are only supported on Windows environments." };
  // Add Project has no current project, so an explicit relative path never resolves.
  if (isExplicitRelativePath(trimmed))
    return { ok: false, error: "Relative paths require an active project in this environment." };
  const path = normalizeForDispatch(trimmed);
  return path.length === 0 ? { ok: false, error: "Enter a project path." } : { ok: true, path };
}


const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;
const INCOMPLETE_OWNER_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/;

/** `owner/name` on GitHub, the host a repository with no host reads as. */
function defaultHostCloneUrl(repository: string): string {
  return `https://github.com/${repository.endsWith(".git") ? repository : `${repository}.git`}`;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function repositoryUrlFromPage(value: string): string | null {
  const url = httpUrl(value);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  const owner = RECOGNITION_ORDER.find((provider) => provider.recognizes(hostname));
  if (owner) return owner.repositoryFromPage?.(url, true) ?? null;
  if (url.pathname.replace(/\/$/u, "").endsWith(".git")) return null;
  // On an unknown host, rewrite only when every route that matches agrees.
  const [repositoryUrl, ...others] = new Set(
    CLAIM_ORDER.flatMap((provider) => provider.repositoryFromPage?.(url, false) ?? []),
  );
  return repositoryUrl !== undefined && repositoryUrl !== url.href && others.length === 0 ? repositoryUrl : null;
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  if (REPOSITORY_SHORTHAND.test(trimmed)) return defaultHostCloneUrl(trimmed);
  return repositoryUrlFromPage(trimmed) ?? trimmed;
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + 3) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) return "";
  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) return "";
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
}

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s[\]]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const UNSAFE_SEGMENT = /^\.{1,2}$|[\\:*?"<>|\p{Cc}]|[ .]$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.| *$)/i;

/** The `<host>/<owner>/<repo>` folders ghq clones a URL into, or null when unsafe. */
function cloneUrlRepositoryPath(url: string): string | null {
  const trimmed = url.trim();
  if (isWindowsDrivePath(trimmed)) return null;
  const parsed = SSH_URL.exec(trimmed) ?? HTTPS_URL.exec(trimmed);
  const scp = parsed ? null : SCP_LIKE_URL.exec(trimmed);
  const host = parsed?.[1] ?? scp?.[1];
  const path = parsed?.[3] ?? scp?.[2];
  if (host === undefined || path === undefined) return null;
  const segments = [host, ...path.split(/[?#]/)[0]!.split("/").filter(Boolean)];
  const last = segments.at(-1)!;
  if (last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -4);
  if (segments.length < 2 || segments.some((s) => s === "" || UNSAFE_SEGMENT.test(s) || WINDOWS_DEVICE_NAME.test(s)))
    return null;
  return segments.join("/");
}

function joinCloneFolder(directoryPath: string, directoryName: string): string {
  const name = directoryName.trim();
  if (name.length === 0) return directoryPath;
  const base = ensureDirectoryPath(directoryPath);
  return `${base}${base.endsWith("\\") ? name.replaceAll("/", "\\") : name}`;
}

function initialPath(baseDirectory: string): string {
  const trimmed = baseDirectory.trim();
  return trimmed.length === 0 ? "~/" : ensureDirectoryPath(trimmed);
}

function defaultCloneUrl(repository: RepositoryInfo): string {
  // Unknown providers clone over SSH, as upstream's fallback definition does.
  return (byKind(repository.provider)?.transport ?? "ssh") === "https" ? repository.url : repository.sshUrl;
}


function platformFromOs(os: string): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "";
}

export function connectionStatusText(phase: ConnectionPhase, error: string | null): string {
  switch (phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return error ? `Failed to connect. Reconnecting... Reason: ${error}` : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return error ? `Connection failed. Reason: ${error}` : "Connection failed";
  }
}

const connected = (environment: AddProjectEnvironment | null | undefined) => environment?.phase === "connected";

/** Environments that can take a project, plus `keepId` when it cannot, sorted by label. */
export function environmentOptions(
  environments: readonly AddProjectEnvironment[],
  keepId: string | null,
): AddProjectEnvironment[] {
  return environments
    .filter((environment) => connected(environment) || environment.id === keepId)
    .sort((left, right) => compareText(left.label, right.label));
}

/** The requested environment only while connected; with no request, the first connected one. */
export function resolveAddProjectEnvironment(
  options: readonly AddProjectEnvironment[],
  requestedId: string | null,
): AddProjectEnvironment | null {
  return options.find((environment) => (requestedId === null || environment.id === requestedId) && connected(environment)) ?? null;
}

const row = (fields: Partial<AddProjectRow> & Pick<AddProjectRow, "kind" | "id" | "title">): AddProjectRow => ({
  subtitle: "",
  icon: "",
  iconSize: 17,
  iconTint: "icon",
  selected: false,
  enabled: true,
  trailing: "chevron",
  path: "",
  browsePath: "",
  ...fields,
});

function environmentRow(environment: AddProjectEnvironment, selected: boolean, enabled: boolean, subtitle: string): AddProjectRow {
  return row({
    kind: "environment",
    id: environment.id,
    title: environment.label,
    subtitle,
    icon: `symbol:sf/${environment.machineSymbol}`,
    selected,
    enabled,
    trailing: selected ? "check" : "none",
  });
}

function providerIcon(provider: ProviderDefinition) {
  return { icon: provider.icon, iconTint: provider.monochrome ? "icon" : "" };
}


interface Readiness {
  readonly ready: boolean;
  readonly hint: string | null;
}

function readinessOf(discovery: SourceControlDiscovery | null): (source: string) => Readiness {
  return (source) => {
    if (source === "url") return { ready: true, hint: null };
    const provider = discovery?.providers.find((candidate) => candidate.kind === source);
    if (!provider) return { ready: false, hint: "Provider status unavailable. Open Source Control settings and rescan." };
    if (!provider.available) return { ready: false, hint: provider.installHint };
    if (provider.auth.status === "unauthenticated")
      return {
        ready: false,
        hint:
          provider.auth.detail ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      };
    return { ready: true, hint: null };
  };
}

export interface SourceChooserModel {
  readonly environmentId: string | null;
  readonly empty: boolean;
  readonly environmentRows: readonly AddProjectRow[];
  readonly sourceRows: readonly AddProjectRow[];
  readonly loading: boolean;
}

export function presentSourceChooser(input: {
  readonly environments: readonly AddProjectEnvironment[];
  /** The tapped environment, else the route's `environmentId`. */
  readonly selectedId: string | null;
  readonly discovery: SourceControlDiscovery | null;
  readonly discoveryPending: boolean;
}): SourceChooserModel {
  const options = environmentOptions(input.environments, input.selectedId);
  const selected = options.find((environment) => environment.id === input.selectedId) ?? options.find(connected) ?? null;
  const isConnected = connected(selected);
  const environmentRows =
    options.length > 1 || (selected !== null && !isConnected)
      ? options.map((environment) =>
          environmentRow(
            environment,
            environment.id === selected?.id,
            connected(environment),
            connected(environment) ? "" : connectionStatusText(environment.phase, environment.error),
          ),
        )
      : [];
  if (selected === null)
    return { environmentId: null, empty: true, environmentRows, sourceRows: [], loading: false };

  const canClone = isConnected && selected.canWriteSourceControl && selected.canOperate;
  const readiness = readinessOf(input.discovery);
  const providers = [...PROVIDERS].sort(
    (left, right) =>
      Number(readiness(right.kind).ready) - Number(readiness(left.kind).ready) ||
      compareText(left.pickerLabel, right.pickerLabel),
  );
  const navigable = (enabled: boolean) => ({ enabled, trailing: enabled ? ("chevron" as const) : ("none" as const) });
  const sourceRows: AddProjectRow[] = [];
  if (selected.newProjectsRoot !== null)
    sourceRows.push(
      row({
        kind: "source",
        id: "new",
        title: "New project",
        subtitle: "Start a new Git repository from a name",
        icon: "symbol:sf/plus",
        ...navigable(isConnected),
      }),
    );
  sourceRows.push(
    row({
      kind: "source",
      id: "local",
      title: "Local folder",
      subtitle: selected.canOperate ? "Browse a folder on disk" : CANNOT_ADD,
      icon: "symbol:sf/folder.badge.plus",
      ...navigable(isConnected && selected.canOperate),
    }),
  );
  for (const source of ["url", ...providers.map((provider) => provider.kind)]) {
    const provider = byKind(source);
    const state = readiness(source);
    const ready = canClone && state.ready;
    const hint = !canClone ? CANNOT_CLONE : state.ready ? sourcePathHint(source) : (state.hint ?? "");
    sourceRows.push(
      row({
        kind: "source",
        id: source,
        title: provider ? `${provider.pickerLabel} repository` : "Git URL",
        subtitle: !ready ? hint : provider ? `Clone ${provider.pickerLabel} ${hint}` : "Clone from a remote URL",
        ...(provider ? { ...providerIcon(provider), iconSize: 18 } : { icon: "symbol:sf/link" }),
        ...navigable(ready),
      }),
    );
  }
  return {
    environmentId: selected.id,
    empty: false,
    environmentRows,
    sourceRows,
    loading: input.discoveryPending,
  };
}


export interface CloneDestinationRequest {
  readonly source: string;
  readonly remoteUrl: string;
  readonly repositoryTitle: string;
  readonly repositoryName: string;
}

export interface RepositoryInputModel {
  readonly title: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly buttonEnabled: boolean;
}

export function presentRepositoryInput(input: {
  readonly source: string;
  readonly text: string;
  readonly submitting: boolean;
}): RepositoryInputModel {
  const url = input.source === "url";
  return {
    title: sourceLabel(input.source),
    placeholder: url ? defaultHostCloneUrl("org/repo") : sourcePathHint(input.source),
    buttonLabel: url ? "Continue" : "Lookup repository",
    buttonEnabled: !input.submitting && input.text.trim().length > 0,
  };
}

export type RepositorySubmit =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "destination"; readonly destination: CloneDestinationRequest }
  | { readonly kind: "lookup"; readonly provider: string; readonly repository: string };

export function planRepositorySubmit(source: string, text: string): RepositorySubmit {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  if (source === "github" && INCOMPLETE_OWNER_PATH.test(trimmed))
    return { kind: "error", message: "Enter the full owner/repository name." };
  if (source !== "url") return { kind: "lookup", provider: source, repository: trimmed };
  const remoteUrl = normalizePastedCloneUrl(text);
  return {
    kind: "destination",
    destination: { source, remoteUrl, repositoryTitle: remoteUrl, repositoryName: getCloneDirectoryName(remoteUrl) },
  };
}

export function destinationFromRepository(source: string, repository: RepositoryInfo): CloneDestinationRequest {
  return {
    source,
    remoteUrl: defaultCloneUrl(repository),
    repositoryTitle: repository.nameWithOwner,
    repositoryName: getCloneDirectoryName(repository.nameWithOwner),
  };
}


export interface PathField {
  /** The folder name kept at the end of the path while browsing ("" on Local folder). */
  readonly pinnedName: string;
  /** The field's text before the person edits it for this environment. */
  readonly seed: string;
}

export function localFolderPath(environment: AddProjectEnvironment | null): PathField {
  return { pinnedName: "", seed: initialPath(environment?.baseDirectory ?? "") };
}

export function cloneDestinationPath(
  environment: AddProjectEnvironment | null,
  remoteUrl: string | null,
  repositoryName: string | null,
): PathField {
  const name = repositoryName?.trim() ?? "";
  const ghqPath =
    remoteUrl && environment?.ghqCloneLayout ? (cloneUrlRepositoryPath(remoteUrl) ?? getCloneDirectoryName(name)) : null;
  return {
    pinnedName: ghqPath?.split("/").at(-1) ?? name,
    seed: joinCloneFolder(initialPath(environment?.baseDirectory ?? ""), ghqPath ?? name),
  };
}


export interface CloneDestinationModel {
  readonly empty: boolean;
  readonly repositoryTitle: string;
  readonly remoteUrl: string;
  readonly buttonEnabled: boolean;
  /** "This connection cannot clone projects." under the button, or "". */
  readonly notice: string;
}

export function presentCloneDestination(input: {
  readonly environment: AddProjectEnvironment | null;
  readonly remoteUrl: string | null;
  readonly repositoryTitle: string | null;
  readonly navigating: boolean;
  readonly submitting: boolean;
}): CloneDestinationModel {
  const environment = input.environment;
  const canClone = environment !== null && environment.canWriteSourceControl && environment.canOperate;
  return {
    empty: environment === null,
    repositoryTitle: input.repositoryTitle ?? "",
    remoteUrl: input.remoteUrl ?? "",
    buttonEnabled: canClone && !input.navigating && !input.submitting && Boolean(input.remoteUrl),
    notice: environment !== null && !canClone ? CANNOT_CLONE : "",
  };
}

export type ClonePlan =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "clone"; readonly title: string; readonly destinationPath: string; readonly remoteUrl: string };

export function planClone(input: {
  readonly environment: AddProjectEnvironment | null;
  readonly pathText: string;
  readonly remoteUrl: string | null;
  readonly navigating: boolean;
  readonly submitting: boolean;
}): ClonePlan {
  const environment = input.environment;
  if (
    environment === null ||
    !environment.canWriteSourceControl ||
    !environment.canOperate ||
    !input.remoteUrl ||
    input.navigating ||
    input.submitting
  )
    return { kind: "ignore" };
  const resolved = resolveAddProjectPath(input.pathText, platformFromOs(environment.os));
  if (!resolved.ok) return { kind: "error", message: resolved.error };
  return {
    kind: "clone",
    title: inferProjectTitleFromPath(resolved.path),
    destinationPath: resolved.path,
    remoteUrl: input.remoteUrl,
  };
}

export interface LocalFolderModel {
  readonly empty: boolean;
  /** "This connection cannot add projects." as a banner above the field, or "". */
  readonly scopeError: string;
  readonly buttonEnabled: boolean;
}

export function presentLocalFolder(input: {
  readonly environment: AddProjectEnvironment | null;
  readonly navigating: boolean;
  readonly submitting: boolean;
}): LocalFolderModel {
  const environment = input.environment;
  const canOperate = environment?.canOperate === true;
  return {
    empty: environment === null,
    scopeError: environment !== null && !canOperate ? CANNOT_ADD : "",
    buttonEnabled: canOperate && !input.navigating && !input.submitting,
  };
}

export interface KnownProject {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archived: boolean;
}

export type LocalFolderPlan =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "alert"; readonly alert: Alert }
  | { readonly kind: "existing"; readonly project: KnownProject; readonly unarchive: boolean }
  | { readonly kind: "create"; readonly title: string; readonly workspaceRoot: string };

export function planLocalFolder(input: {
  readonly environment: AddProjectEnvironment | null;
  readonly pathText: string;
  readonly projects: readonly KnownProject[];
  readonly navigating: boolean;
  readonly submitting: boolean;
}): LocalFolderPlan {
  const environment = input.environment;
  if (environment === null || input.navigating || input.submitting) return { kind: "ignore" };
  const resolved = resolveAddProjectPath(input.pathText, platformFromOs(environment.os));
  if (!resolved.ok) return { kind: "error", message: resolved.error };
  if (!connected(environment) || !environment.canOperate)
    return {
      kind: "alert",
      alert: {
        title: "Project not added",
        message: `This connection cannot add projects right now. Any existing files remain at ${resolved.path}.`,
      },
    };
  const wanted = normalizeForComparison(resolved.path);
  const existing =
    wanted.length === 0
      ? undefined
      : input.projects.find(
          (project) =>
            project.environmentId === environment.id && normalizeForComparison(project.workspaceRoot) === wanted,
        );
  if (existing) return { kind: "existing", project: existing, unarchive: existing.archived };
  return { kind: "create", title: inferProjectTitleFromPath(resolved.path), workspaceRoot: resolved.path };
}

export function projectExistsAlert(title: string, unarchived: boolean): Alert {
  return {
    title: "Project already exists",
    message: unarchived ? title : `${title} is still archived. Try again later.`,
  };
}

export const PROJECT_ADDED_LATE: Alert = { title: "Project added", message: NOT_REACHED_YET };


export interface PublishChoice {
  readonly provider: string;
  readonly label: string;
  readonly owner: string | null;
}

export interface NewProjectModel {
  readonly environmentId: string | null;
  /** No environment can create projects: EmptyEnvironmentState. */
  readonly empty: boolean;
  /** An environment is chosen: the name field, preview, publish rows and buttons show. */
  readonly ready: boolean;
  readonly machineRows: readonly AddProjectRow[];
  readonly pathPreview: string;
  readonly publishRows: readonly AddProjectRow[];
  readonly buttonEnabled: boolean;
  /** What "Create project" publishes, when the switch is on. */
  readonly publish: PublishChoice | null;
  /** The "Add existing project" row under the button. */
  readonly existingRows: readonly AddProjectRow[];
}

function publishTargets(discovery: SourceControlDiscovery | null): PublishChoice[] {
  const readiness = readinessOf(discovery);
  return PROVIDERS.flatMap((provider) => {
    if (!readiness(provider.kind).ready) return [];
    const account = discovery?.providers.find((candidate) => candidate.kind === provider.kind)?.auth.account ?? null;
    const placement = provider.newRepositoryOwner(account);
    return placement === null ? [] : [{ provider: provider.kind, label: provider.label, owner: placement.owner }];
  });
}

/** `<owner>/<folder>` or `<folder>`, the folder being the workspace root's last segment. */
export function publishRepositoryName(owner: string | null, workspaceRoot: string): string {
  const folder = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return owner ? `${owner}/${folder}` : folder;
}

export function presentNewProject(input: {
  readonly environments: readonly AddProjectEnvironment[];
  readonly selectedId: string | null;
  readonly name: string;
  readonly discovery: SourceControlDiscovery | null;
  readonly publishes: boolean;
  readonly publishProvider: string | null;
  readonly submitting: boolean;
}): NewProjectModel {
  const options = environmentOptions(input.environments, null).filter((option) => option.newProjectsRoot !== null);
  const environment = resolveAddProjectEnvironment(options, input.selectedId);
  const targets = publishTargets(input.discovery);
  const target = targets.find((candidate) => candidate.provider === input.publishProvider) ?? targets[0] ?? null;
  const name = input.name.trim();
  const root = environment?.newProjectsRoot ?? null;
  const preview = root !== null ? joinCloneFolder(root, newProjectFolderName(name)) : null;
  const showMachines = options.length > 1 || (environment === null && options.length > 0);
  const machineRows = showMachines
    ? options.map((option) =>
        environmentRow(option, option.id === environment?.id, !input.submitting, ""),
      )
    : [];
  const pathPreview =
    preview === null || environment === null
      ? ""
      : `${name.length > 0 ? `Creates ${preview}` : `Goes in ${root}`}${showMachines ? ` on ${environment.label}` : ""}`;
  const publishRows: AddProjectRow[] = [];
  if (target !== null) {
    const provider = byKind(target.provider)!;
    publishRows.push(
      row({
        kind: "publish",
        id: target.provider,
        title: `Create private repository on ${target.label}`,
        subtitle: name.length > 0 && preview !== null ? publishRepositoryName(target.owner, preview) : (target.owner ?? ""),
        ...providerIcon(provider),
        iconSize: 18,
        selected: input.publishes,
        trailing: "switch",
      }),
    );
    if (input.publishes && targets.length > 1)
      for (const candidate of targets) {
        const selected = candidate.provider === target.provider;
        publishRows.push(
          row({
            kind: "publish-target",
            id: candidate.provider,
            title: candidate.label,
            ...providerIcon(byKind(candidate.provider)!),
            selected,
            enabled: !input.submitting,
            trailing: selected ? "check" : "none",
          }),
        );
      }
  }
  return {
    environmentId: environment?.id ?? null,
    empty: environment === null && options.length === 0,
    ready: environment !== null,
    machineRows,
    pathPreview,
    publishRows,
    buttonEnabled: !input.submitting && name.length > 0,
    publish: input.publishes ? target : null,
    existingRows: [ADD_EXISTING_ROW],
  };
}

const ADD_EXISTING_ROW: AddProjectRow = row({
  kind: "existing",
  id: "existing",
  title: "Add existing project",
  subtitle: "Open a folder or clone a repository",
  icon: "symbol:sf/folder.badge.plus",
});

export function createdWithoutCommitAlert(commitError: string): Alert {
  return { title: "Created without a first commit", message: commitError };
}

export function publishFailedAlert(label: string, error: unknown): Alert {
  return { title: `Could not create the ${label} repository`, message: errorMessage(error) };
}


export interface FolderBrowserModel {
  /** The directory to list with `filesystem.browse`, or "" for none. */
  readonly request: string;
  /** A banner when the session cannot read host folders. */
  readonly accessError: string;
  readonly browseError: string;
  /** The muted line a clone into a folder that does not exist yet shows instead of an error. */
  readonly missingNote: string;
  readonly loading: boolean;
  readonly rows: readonly AddProjectRow[];
}

function filterEntries(entries: readonly BrowseEntry[], query: string): BrowseEntry[] {
  const lower = query.toLowerCase();
  const showHidden = query.startsWith(".");
  return entries.filter(
    (entry) => entry.name.toLowerCase().startsWith(lower) && (showHidden || !entry.name.startsWith(".")),
  );
}

export function presentFolderBrowser(input: {
  readonly environment: AddProjectEnvironment;
  readonly pathText: string;
  readonly pinnedName: string;
  readonly cloning: boolean;
  readonly access: { readonly canRead: boolean; readonly pending: boolean; readonly error: string | null };
  readonly browse: { readonly pending: boolean; readonly outcome: BrowseOutcome | null };
}): FolderBrowserModel {
  const platform = platformFromOs(input.environment.os);
  const windows = isWindowsPlatform(platform);
  const browsing = isBrowseQuery(input.pathText, platform);
  const directoryPath = browsing ? browseDirectoryPath(input.pathText) : "";
  const leaf = browsing && !hasTrailingSeparator(input.pathText) ? input.pathText.slice(lastSeparatorIndex(input.pathText) + 1) : "";
  const parentPath = browsing ? browseParentPath(directoryPath) : null;
  const canBrowseUp = browsing && hasTrailingSeparator(directoryPath) && parentPath !== null;
  const pinned = input.pinnedName;
  const pinnedMatches = windows ? leaf.toLowerCase() === pinned.toLowerCase() : leaf === pinned;
  const filter = pinnedMatches ? "" : leaf;
  const outcome = input.browse.outcome;

  const tapTarget = (directory: string, name: string | null) => {
    const selectedPath = name === null ? directory : appendSegment(directory, name);
    if (pinned && name !== null) {
      const matches = windows ? name.toLowerCase() === pinned.toLowerCase() : name === pinned;
      return { path: matches ? selectedPath : joinCloneFolder(selectedPath, pinned), browsePath: selectedPath };
    }
    return { path: joinCloneFolder(selectedPath, pinned), browsePath: selectedPath };
  };

  const rows: AddProjectRow[] = [];
  if (canBrowseUp && parentPath !== null)
    rows.push(
      row({
        kind: "browse-up",
        id: "..",
        title: "..",
        icon: "symbol:sf/arrow.turn.left.up",
        iconTint: "icon-muted",
        trailing: "none",
        ...tapTarget(parentPath, null),
      }),
    );
  for (const entry of filterEntries(outcome?.ok ? outcome.entries : [], filter))
    rows.push(
      row({
        kind: "folder",
        id: entry.name,
        title: entry.name,
        icon: "symbol:sf/folder",
        iconTint: "icon-muted",
        trailing: "none",
        ...tapTarget(directoryPath, entry.name),
      }),
    );

  const failed = outcome !== null && !outcome.ok ? outcome : null;
  const missing = failed !== null && input.cloning && failed.failure === "read_directory_failed" && failed.pathMissing;
  return {
    request: input.access.canRead && directoryPath.length > 0 ? directoryPath : "",
    accessError:
      !input.access.canRead && !input.access.pending
        ? (input.access.error ?? "This connection cannot browse host folders.")
        : "",
    browseError: failed !== null && !missing ? failed.message : "",
    missingNote: missing ? "This folder does not exist yet. Cloning creates it." : "",
    loading: input.access.pending || (input.browse.pending && outcome === null),
    rows,
  };
}


const STAGE_LABELS: Record<CloneStage, string> = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

export interface CloneBannerModel {
  readonly phase: "running" | "failed" | "cancelled";
  readonly title: string;
  /** Running: the stage summary. Failed or cancelled: the error, or "". */
  readonly detail: string;
}

export interface ProjectCloneModel {
  readonly banner: CloneBannerModel | null;
  readonly blocksStart: boolean;
  readonly blockReason: string;
}

function cloneName(snapshot: CloneSnapshot): string {
  if (snapshot.repository) return snapshot.repository.nameWithOwner;
  return snapshot.destinationPath.split(/[/\\]/).filter((segment) => segment.length > 0).at(-1) ?? snapshot.destinationPath;
}

function cloneSummary(snapshot: CloneSnapshot): string {
  const parts = [STAGE_LABELS[snapshot.stage]];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  // A stall makes git's last transfer speed in `detail` a lie.
  if (snapshot.stalled) parts.push("Stalled");
  else if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}

export function presentProjectClone(input: {
  /** The environment's clone list, or null while the stream has not delivered one. */
  readonly clones: readonly CloneSnapshot[] | null;
  readonly projectId: string;
  /** The draft was opened by a clone for this project (upstream's `cloning: "1"`). */
  readonly awaitingClone: boolean;
}): ProjectCloneModel {
  const clone = input.clones?.find((snapshot) => snapshot.projectId === input.projectId) ?? null;
  const blocksStart = (input.clones === null && input.awaitingClone) || (clone !== null && clone.phase !== "done");
  const name = clone === null ? "" : cloneName(clone);
  const banner: CloneBannerModel | null =
    clone === null || clone.phase === "done"
      ? null
      : clone.phase === "running"
        ? { phase: "running", title: `Cloning ${name}`, detail: cloneSummary(clone) }
        : {
            phase: clone.phase,
            title: clone.phase === "cancelled" ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
            detail: clone.error ?? "",
          };
  return { banner, blocksStart, blockReason: blocksStart ? CLONE_BLOCK_REASON : "" };
}


export interface AppAccessCheck {
  readonly provider: string;
  readonly host: string;
  readonly repository: string;
}

const APP_NAME = "T3 Code for GitHub";
export const APP_INSTALL_URL = "https://github.com/apps/t3-code-for-github/installations/new";

function remoteRepository(value: string): { host: string; path: string } | null {
  const normalized = value.trim().replace(/\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (url.hostname && segments.length > 1) return { host: url.hostname, path: segments.join("/") };
    } catch {
      return null;
    }
  }
  const scp = /^[a-z]:/i.test(normalized)
    ? null
    : /^(?:[a-zA-Z0-9._-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  return scp?.[1] && scp[2] ? { host: scp[1], path: scp[2] } : null;
}

/** The repository to ask `sourceControl.appAccess` about, for remotes on the app sign-in's host. */
export function appAccessCheck(remoteUrl: string): AppAccessCheck | null {
  const parsed = remoteRepository(remoteUrl);
  if (parsed === null || parsed.host !== "github.com") return null;
  const asWritten = remoteUrl.trim().replace(/\.git\/?$/i, "").split(/[/:]/).slice(-2).join("/");
  return {
    provider: "github",
    host: parsed.host,
    repository: asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path,
  };
}

export function appAccessAlert(check: AppAccessCheck): Alert & { readonly cancel: string; readonly confirm: string; readonly url: string } {
  const owner = check.repository.split("/")[0] ?? check.repository;
  return {
    title: `Give ${APP_NAME} access to ${owner}`,
    message: `It isn't installed there, so GitHub requests for ${check.repository} use your own login and its lower rate limit.`,
    cancel: "Not now",
    confirm: "Install",
    url: APP_INSTALL_URL,
  };
}
