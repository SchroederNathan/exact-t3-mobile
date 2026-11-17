export interface RpcSession {
  query(tag: string, payload: unknown): Promise<unknown>;
}

export type SourceControlAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface SourceControlProvider {
  readonly kind: string;
  readonly label: string;
  readonly available: boolean;
  readonly installHint: string;
  readonly auth: {
    readonly status: SourceControlAuthStatus;
    readonly account: string | null;
    readonly host: string | null;
    readonly detail: string | null;
  };
  readonly appSignIn: boolean;
}

export interface SourceControlDiscovery {
  readonly providers: readonly SourceControlProvider[];
}

export interface RepositoryInfo {
  readonly provider: string;
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface BrowseEntry {
  readonly name: string;
  readonly fullPath: string;
}

export type BrowseFailure = "windows_path_unsupported" | "current_project_required" | "read_directory_failed";

export type BrowseOutcome =
  | { readonly ok: true; readonly parentPath: string; readonly entries: readonly BrowseEntry[] }
  | {
      readonly ok: false;
      readonly failure: BrowseFailure | null;
      readonly pathMissing: boolean;
      readonly message: string;
    };

export interface ProjectRecord {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archived: boolean;
}

export interface NewProject {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly commitError: string | null;
}

export interface PublishedRepository {
  readonly repository: RepositoryInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly status: "pushed" | "remote_added";
}

export type AppAccess = "covered" | "not-covered" | "signed-out";

export interface CloneStarted {
  readonly projectId: string;
  readonly cwd: string;
  readonly remoteUrl: string;
  readonly repository: RepositoryInfo | null;
}

export type ClonePhase = "running" | "done" | "failed" | "cancelled";
export type CloneStage = "connecting" | "counting" | "receiving" | "resolving" | "checkout";

export interface CloneSnapshot {
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly repository: RepositoryInfo | null;
  readonly phase: ClonePhase;
  readonly stage: CloneStage;
  readonly percent: number | null;
  readonly detail: string | null;
  readonly stalled: boolean;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sequence: number;
}

export const PROJECT_CLONES_SUBSCRIPTION = { tag: "subscribeProjectClones", payload: {} } as const;

type Fields = Record<string, unknown>;

class MalformedReply extends Error {
  constructor(tag: string, field: string) {
    super(`The server sent an unexpected ${tag} reply (${field}).`);
  }
}

function record(value: unknown, tag: string, field: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MalformedReply(tag, field);
  return value as Fields;
}

function text(fields: Fields, key: string, tag: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new MalformedReply(tag, key);
  return value;
}

function nullableText(fields: Fields, key: string, tag: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MalformedReply(tag, key);
  return value;
}

function oneOf<T extends string>(fields: Fields, key: string, allowed: readonly T[], tag: string): T {
  const value = fields[key];
  if (!allowed.includes(value as T)) throw new MalformedReply(tag, key);
  return value as T;
}

// Effect encodes `Schema.Option` as `{ _tag: "Some", value }` or `{ _tag: "None" }`.
function optionText(fields: Fields, key: string, tag: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const option = record(value, tag, key);
  if (option._tag === "None") return null;
  if (option._tag === "Some" && typeof option.value === "string") return option.value;
  throw new MalformedReply(tag, key);
}

function list(value: unknown, tag: string, field: string): unknown[] {
  if (!Array.isArray(value)) throw new MalformedReply(tag, field);
  return value;
}

function repositoryInfo(value: unknown, tag: string): RepositoryInfo {
  const fields = record(value, tag, "repository");
  return {
    provider: text(fields, "provider", tag),
    nameWithOwner: text(fields, "nameWithOwner", tag),
    url: text(fields, "url", tag),
    sshUrl: text(fields, "sshUrl", tag),
  };
}

function nullableRepository(fields: Fields, tag: string): RepositoryInfo | null {
  return fields.repository === null || fields.repository === undefined
    ? null
    : repositoryInfo(fields.repository, tag);
}

function projectRecord(value: unknown, tag: string): ProjectRecord {
  const fields = record(value, tag, "project");
  return {
    id: text(fields, "id", tag),
    title: text(fields, "title", tag),
    workspaceRoot: text(fields, "workspaceRoot", tag),
    archived: typeof fields.archivedAt === "string",
  };
}

export async function discoverSourceControl(session: RpcSession): Promise<SourceControlDiscovery> {
  const tag = "server.discoverSourceControl";
  const fields = record(await session.query(tag, {}), tag, "reply");
  return {
    providers: list(fields.sourceControlProviders, tag, "sourceControlProviders").map((item) => {
      const provider = record(item, tag, "sourceControlProviders");
      const auth = record(provider.auth, tag, "auth");
      return {
        kind: text(provider, "kind", tag),
        label: text(provider, "label", tag),
        available: oneOf(provider, "status", ["available", "missing"], tag) === "available",
        installHint: text(provider, "installHint", tag),
        auth: {
          status: oneOf(auth, "status", ["authenticated", "unauthenticated", "unknown"], tag),
          account: optionText(auth, "account", tag),
          host: optionText(auth, "host", tag),
          detail: optionText(auth, "detail", tag),
        },
        appSignIn: provider.appSignIn === true,
      };
    }),
  };
}

const BROWSE_FAILURES: readonly BrowseFailure[] = [
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
];

/**
 * A browse refusal is data the folder browser shows. The rejection carries the server's
 * `FilesystemBrowseError` fields when the session keeps them (on `detail`, else on itself).
 */
export async function browseFilesystem(session: RpcSession, partialPath: string): Promise<BrowseOutcome> {
  const tag = "filesystem.browse";
  let reply: unknown;
  try {
    reply = await session.query(tag, { partialPath });
  } catch (error) {
    const raw = typeof error === "object" && error !== null ? (error as Fields) : {};
    const detail =
      typeof raw.detail === "object" && raw.detail !== null ? (raw.detail as Fields) : raw;
    const message =
      typeof detail.message === "string"
        ? detail.message
        : error instanceof Error
          ? error.message
          : "An error occurred.";
    return {
      ok: false,
      failure: BROWSE_FAILURES.includes(detail.failure as BrowseFailure)
        ? (detail.failure as BrowseFailure)
        : null,
      pathMissing: detail.pathMissing === true,
      message,
    };
  }
  const fields = record(reply, tag, "reply");
  return {
    ok: true,
    parentPath: text(fields, "parentPath", tag),
    entries: list(fields.entries, tag, "entries").map((item) => {
      const entry = record(item, tag, "entries");
      return { name: text(entry, "name", tag), fullPath: text(entry, "fullPath", tag) };
    }),
  };
}

export async function lookupRepository(
  session: RpcSession,
  input: { readonly provider: string; readonly repository: string },
): Promise<RepositoryInfo> {
  const tag = "sourceControl.lookupRepository";
  return repositoryInfo(
    await session.query(tag, { provider: input.provider, repository: input.repository }),
    tag,
  );
}

export async function createProject(
  session: RpcSession,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
  },
): Promise<ProjectRecord> {
  const tag = "projects.mutate";
  return projectRecord(
    await session.query(tag, {
      type: "project.create",
      commandId: input.commandId,
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
    }),
    tag,
  );
}

export async function unarchiveProject(
  session: RpcSession,
  input: { readonly commandId: string; readonly projectId: string },
): Promise<ProjectRecord> {
  const tag = "projects.mutate";
  return projectRecord(
    await session.query(tag, {
      type: "project.update",
      commandId: input.commandId,
      projectId: input.projectId,
      archived: false,
    }),
    tag,
  );
}

export async function deleteProject(
  session: RpcSession,
  input: { readonly commandId: string; readonly projectId: string },
): Promise<void> {
  await session.query("projects.mutate", {
    type: "project.delete",
    commandId: input.commandId,
    projectId: input.projectId,
  });
}

export async function createNewProject(session: RpcSession, name: string): Promise<NewProject> {
  const tag = "projects.createNew";
  const fields = record(await session.query(tag, { name }), tag, "reply");
  return {
    projectId: text(fields, "projectId", tag),
    workspaceRoot: text(fields, "workspaceRoot", tag),
    commitError: nullableText(fields, "commitError", tag),
  };
}

export async function publishRepository(
  session: RpcSession,
  input: { readonly cwd: string; readonly provider: string; readonly repository: string },
): Promise<PublishedRepository> {
  const tag = "sourceControl.publishRepository";
  const fields = record(
    await session.query(tag, {
      cwd: input.cwd,
      provider: input.provider,
      repository: input.repository,
      visibility: "private",
    }),
    tag,
    "reply",
  );
  return {
    repository: repositoryInfo(fields.repository, tag),
    remoteName: text(fields, "remoteName", tag),
    remoteUrl: text(fields, "remoteUrl", tag),
    branch: text(fields, "branch", tag),
    status: oneOf(fields, "status", ["pushed", "remote_added"], tag),
  };
}

export async function checkAppAccess(
  session: RpcSession,
  input: { readonly provider: string; readonly host: string; readonly repository: string },
): Promise<AppAccess> {
  const tag = "sourceControl.appAccess";
  const fields = record(
    await session.query(tag, {
      provider: input.provider,
      host: input.host,
      repository: input.repository,
    }),
    tag,
    "reply",
  );
  return oneOf<AppAccess>(fields, "status", ["covered", "not-covered", "signed-out"], tag);
}

export async function startProjectClone(
  session: RpcSession,
  input: {
    readonly projectId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly remoteUrl: string;
    readonly destinationPath: string;
  },
): Promise<CloneStarted> {
  const tag = "projectClone.start";
  const fields = record(
    await session.query(tag, {
      projectId: input.projectId,
      title: input.title,
      createdAt: input.createdAt,
      remoteUrl: input.remoteUrl,
      destinationPath: input.destinationPath,
    }),
    tag,
    "reply",
  );
  return {
    projectId: text(fields, "projectId", tag),
    cwd: text(fields, "cwd", tag),
    remoteUrl: text(fields, "remoteUrl", tag),
    repository: nullableRepository(fields, tag),
  };
}

async function cloneAction(session: RpcSession, tag: string, projectId: string): Promise<boolean> {
  const fields = record(await session.query(tag, { projectId }), tag, "reply");
  if (typeof fields.applied !== "boolean") throw new MalformedReply(tag, "applied");
  return fields.applied;
}

export function cancelProjectClone(session: RpcSession, projectId: string): Promise<boolean> {
  return cloneAction(session, "projectClone.cancel", projectId);
}

export function retryProjectClone(session: RpcSession, projectId: string): Promise<boolean> {
  return cloneAction(session, "projectClone.retry", projectId);
}

export async function ensureScratchProject(session: RpcSession): Promise<string> {
  const tag = "projects.ensureScratch";
  return text(record(await session.query(tag, {}), tag, "reply"), "projectId", tag);
}

/** One `subscribeProjectClones` chunk value: every clone the server tracks. */
export function parseProjectClones(value: unknown): CloneSnapshot[] {
  const tag = PROJECT_CLONES_SUBSCRIPTION.tag;
  return list(value, tag, "event").map((item) => {
    const fields = record(item, tag, "snapshot");
    const percent = fields.percent;
    if (percent !== null && (typeof percent !== "number" || !Number.isInteger(percent)))
      throw new MalformedReply(tag, "percent");
    if (typeof fields.sequence !== "number") throw new MalformedReply(tag, "sequence");
    return {
      projectId: text(fields, "projectId", tag),
      remoteUrl: text(fields, "remoteUrl", tag),
      destinationPath: text(fields, "destinationPath", tag),
      repository: nullableRepository(fields, tag),
      phase: oneOf(fields, "phase", ["running", "done", "failed", "cancelled"], tag),
      stage: oneOf(fields, "stage", ["connecting", "counting", "receiving", "resolving", "checkout"], tag),
      percent: percent as number | null,
      detail: nullableText(fields, "detail", tag),
      stalled: fields.stalled === true,
      error: nullableText(fields, "error", tag),
      startedAt: text(fields, "startedAt", tag),
      endedAt: nullableText(fields, "endedAt", tag),
      sequence: fields.sequence,
    };
  });
}
