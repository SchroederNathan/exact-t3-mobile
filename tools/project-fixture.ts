type RecordValue = Record<string, unknown>;
type Socket = { send(data: string): unknown; data?: { shellRequest?: string } };

const timestamp = "2026-11-10T12:00:00Z";
const home = "/Users/fixture";
const folders: Record<string, string[]> = {
  "~/": ["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Projects", "Public", ".config"],
  "~/Projects/": ["t3code", "website"],
  "/": ["Users", "tmp"],
  "/Users/": ["fixture"],
};
const providers = [
  ["github", "GitHub", "https"],
  ["cursor-origin", "Cursor Origin", "https"],
  ["gitlab", "GitLab", "ssh"],
  ["gitcafe", "GitCafe", "ssh"],
  ["forgejo", "Forgejo", "https"],
  ["bitbucket", "Bitbucket", "ssh"],
  ["azure-devops", "Azure DevOps", "ssh"],
] as const;
const hosts: Record<string, string> = {
  github: "github.com",
  "cursor-origin": "origin.cursor.com",
  gitlab: "gitlab.com",
  gitcafe: "git.cafe",
  forgejo: "codeberg.org",
  bitbucket: "bitbucket.org",
  "azure-devops": "dev.azure.com",
};
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });
const object = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Answers the Add Project RPCs for one fixture environment and records what it was sent. */
export class ProjectFixture {
  readonly calls: { tag: string; payload: RecordValue }[] = [];
  readonly projects = new Map<string, RecordValue>();
  private clones = new Map<string, RecordValue>();
  private cloneSubscribers = new Map<Socket, Set<string>>();
  private sequence = 0;
  private created = 0;

  constructor(readonly environmentId: string) {}

  receive(socket: Socket, input: unknown): boolean {
    const frame = object(input);
    if (frame._tag === "Interrupt") {
      return this.cloneSubscribers.get(socket)?.delete(text(frame.requestId)) ?? false;
    }
    if (frame._tag !== "Request") return false;
    const tag = text(frame.tag);
    const requestId = text(frame.id);
    const payload = object(frame.payload);
    const handler = this.handlers[tag];
    if (!handler) return false;
    this.calls.push({ tag, payload });
    try {
      const value = handler(payload, socket, requestId);
      if (value !== undefined) this.exit(socket, requestId, { _tag: "Success", value });
    } catch (error) {
      const detail = error instanceof FixtureFailure ? error.detail : { message: String(error) };
      this.exit(socket, requestId, { _tag: "Failure", cause: [{ _tag: "Fail", error: detail }] });
    }
    return true;
  }

  private handlers: Record<string, (payload: RecordValue, socket: Socket, requestId: string) => unknown> = {
    "server.discoverSourceControl": () => ({
      versionControlSystems: [],
      sourceControlProviders: providers.map(([kind, label]) => ({
        kind,
        label,
        status: kind === "github" ? "available" : "missing",
        version: kind === "github" ? some("2.60.0") : none,
        installHint: `Install the ${label} command-line tool.`,
        detail: none,
        auth:
          kind === "github"
            ? { status: "authenticated", account: some("fixture-user"), host: some("github.com"), detail: none }
            : { status: "unknown", account: none, host: none, detail: none },
      })),
    }),
    "filesystem.browse": (payload) => {
      const partialPath = text(payload.partialPath);
      const names = folders[partialPath];
      if (!names)
        throw new FixtureFailure({
          _tag: "FilesystemBrowseError",
          partialPath,
          failure: "read_directory_failed",
          pathMissing: true,
          message: `Failed to browse filesystem path '${partialPath}'.`,
        });
      const parentPath = partialPath.startsWith("~/") ? `${home}/${partialPath.slice(2)}` : partialPath;
      return { parentPath, entries: names.map((name) => ({ name, fullPath: `${parentPath}${name}` })) };
    },
    "sourceControl.lookupRepository": (payload) => {
      const provider = text(payload.provider);
      const repository = text(payload.repository);
      if (!repository.includes("/") || !hosts[provider])
        throw new FixtureFailure({ _tag: "SourceControlRepositoryError", message: `Repository ${repository} was not found.` });
      return this.repository(provider, repository);
    },
    "projects.mutate": (payload, socket) => {
      const projectId = text(payload.projectId);
      if (payload.type === "project.create") {
        return this.addProject(socket, projectId, text(payload.title), text(payload.workspaceRoot));
      }
      const project = this.projects.get(projectId);
      if (!project) throw new FixtureFailure({ _tag: "ProjectMutationError", message: "Project not found." });
      if (payload.type === "project.update") {
        const updated = { ...project, archivedAt: payload.archived === false ? null : project.archivedAt, updatedAt: timestamp };
        this.projects.set(projectId, updated);
        this.shell(socket, { kind: "project.updated", project: updated });
        return updated;
      }
      this.projects.delete(projectId);
      this.clones.delete(projectId);
      this.shell(socket, { kind: "project.removed", projectId });
      this.publishClones();
      return project;
    },
    "projects.createNew": (payload, socket) => {
      const name = text(payload.name);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
      const projectId = `new-${++this.created}`;
      const workspaceRoot = `${home}/projects/${slug}`;
      this.addProject(socket, projectId, name, workspaceRoot);
      return { projectId, workspaceRoot };
    },
    "sourceControl.publishRepository": (payload) => {
      const provider = text(payload.provider);
      const repository = text(payload.repository);
      const info = this.repository(provider, repository);
      return { repository: info, remoteName: "origin", remoteUrl: info.url, branch: "main", status: "pushed" };
    },
    "sourceControl.appAccess": () => ({ status: "covered" }),
    "projectClone.start": (payload, socket) => {
      const projectId = text(payload.projectId);
      const remoteUrl = text(payload.remoteUrl);
      const destinationPath = text(payload.destinationPath);
      this.addProject(socket, projectId, text(payload.title), destinationPath);
      this.clones.set(projectId, {
        projectId,
        remoteUrl,
        destinationPath,
        repository: null,
        phase: "running",
        stage: "receiving",
        percent: 42,
        detail: "1.2 MiB/s",
        error: null,
        startedAt: timestamp,
        endedAt: null,
        sequence: ++this.sequence,
      });
      this.publishClones();
      return { projectId, cwd: destinationPath, remoteUrl, repository: null };
    },
    "projectClone.cancel": (payload) => this.cloneAction(text(payload.projectId), { phase: "cancelled", endedAt: timestamp }),
    "projectClone.retry": (payload) =>
      this.cloneAction(text(payload.projectId), { phase: "running", stage: "connecting", percent: null, detail: null, error: null, endedAt: null }),
    subscribeProjectClones: (_payload, socket, requestId) => {
      const subscriptions = this.cloneSubscribers.get(socket) ?? new Set<string>();
      subscriptions.add(requestId);
      this.cloneSubscribers.set(socket, subscriptions);
      this.chunk(socket, requestId, [...this.clones.values()]);
      return undefined;
    },
    "projects.ensureScratch": (_payload, socket) => {
      if (!this.projects.has("scratch")) this.addProject(socket, "scratch", "Scratch", `${home}/.t3/scratch`);
      return { projectId: "scratch" };
    },
  };

  /** Ends a running clone with `phase`, as the server would when git finishes or fails. */
  finishClone(projectId: string, phase: "done" | "failed", error: string | null = null): void {
    this.cloneAction(projectId, { phase, error, endedAt: timestamp, percent: phase === "done" ? 100 : null });
  }

  private repository(provider: string, repository: string) {
    const host = hosts[provider] ?? "github.com";
    return { provider, nameWithOwner: repository, url: `https://${host}/${repository}.git`, sshUrl: `git@${host}:${repository}.git` };
  }

  private addProject(socket: Socket, id: string, title: string, workspaceRoot: string): RecordValue {
    const project = {
      id,
      title,
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    this.projects.set(id, project);
    this.shell(socket, { kind: "project.updated", project });
    return project;
  }

  private cloneAction(projectId: string, patch: RecordValue) {
    const clone = this.clones.get(projectId);
    if (!clone) return { applied: false };
    this.clones.set(projectId, { ...clone, ...patch, sequence: ++this.sequence });
    this.publishClones();
    return { applied: true };
  }

  private publishClones() {
    const clones = [...this.clones.values()];
    for (const [socket, requests] of this.cloneSubscribers)
      for (const requestId of requests) this.chunk(socket, requestId, clones);
  }

  private shell(socket: Socket, event: RecordValue) {
    const requestId = socket.data?.shellRequest;
    if (requestId) this.chunk(socket, requestId, { ...event, sequence: ++this.sequence });
  }

  private chunk(socket: Socket, requestId: string, value: unknown) {
    socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
  }

  private exit(socket: Socket, requestId: string, exit: RecordValue) {
    socket.send(JSON.stringify({ _tag: "Exit", requestId, exit }));
  }
}

class FixtureFailure extends Error {
  constructor(readonly detail: RecordValue) {
    super(text(detail.message));
  }
}

const fixtures = new Map<string, ProjectFixture>();

export function projectFixture(environmentId: string): ProjectFixture {
  let fixture = fixtures.get(environmentId);
  if (!fixture) fixtures.set(environmentId, (fixture = new ProjectFixture(environmentId)));
  return fixture;
}
