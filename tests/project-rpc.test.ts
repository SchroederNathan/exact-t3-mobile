import { expect, test } from "bun:test";
import {
  PROJECT_CLONES_SUBSCRIPTION,
  browseFilesystem,
  cancelProjectClone,
  checkAppAccess,
  createNewProject,
  createProject,
  deleteProject,
  discoverSourceControl,
  ensureScratchProject,
  lookupRepository,
  parseProjectClones,
  publishRepository,
  retryProjectClone,
  startProjectClone,
  unarchiveProject,
  type RpcSession,
} from "../project-rpc";

function session(reply: unknown | ((tag: string) => unknown)) {
  const sent: { tag: string; payload: unknown }[] = [];
  const rpc: RpcSession = {
    async query(tag, payload) {
      sent.push({ tag, payload });
      const value = typeof reply === "function" ? (reply as (tag: string) => unknown)(tag) : reply;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { rpc, sent };
}

const repository = {
  provider: "github",
  nameWithOwner: "octocat/Hello-World",
  url: "https://github.com/octocat/Hello-World.git",
  sshUrl: "git@github.com:octocat/Hello-World.git",
};

const projectReply = {
  id: "p1",
  title: "app",
  workspaceRoot: "/Users/me/app",
  defaultModelSelection: null,
  scripts: [],
  archivedAt: null,
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  deletedAt: null,
};

test("discovery sends an empty payload and unwraps Option fields", async () => {
  const { rpc, sent } = session({
    versionControlSystems: [],
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        status: "available",
        version: { _tag: "Some", value: "2.60.0" },
        installHint: "Install gh",
        detail: { _tag: "None" },
        auth: {
          status: "authenticated",
          account: { _tag: "Some", value: "octocat" },
          host: { _tag: "Some", value: "github.com" },
          detail: { _tag: "None" },
        },
        appSignIn: true,
      },
      {
        kind: "gitlab",
        label: "GitLab",
        status: "missing",
        version: { _tag: "None" },
        installHint: "Install glab",
        detail: { _tag: "None" },
        auth: { status: "unknown", account: { _tag: "None" }, host: { _tag: "None" }, detail: { _tag: "None" } },
      },
    ],
  });
  expect(await discoverSourceControl(rpc)).toEqual({
    providers: [
      {
        kind: "github",
        label: "GitHub",
        available: true,
        installHint: "Install gh",
        auth: { status: "authenticated", account: "octocat", host: "github.com", detail: null },
        appSignIn: true,
      },
      {
        kind: "gitlab",
        label: "GitLab",
        available: false,
        installHint: "Install glab",
        auth: { status: "unknown", account: null, host: null, detail: null },
        appSignIn: false,
      },
    ],
  });
  expect(sent).toEqual([{ tag: "server.discoverSourceControl", payload: {} }]);
});

test("discovery refuses a reply without providers", async () => {
  const { rpc } = session({ versionControlSystems: [] });
  await expect(discoverSourceControl(rpc)).rejects.toThrow("server.discoverSourceControl");
});

test("browse sends the partial path and parses entries", async () => {
  const { rpc, sent } = session({
    parentPath: "/Users/me",
    entries: [{ name: "Desktop", fullPath: "/Users/me/Desktop" }],
  });
  expect(await browseFilesystem(rpc, "~/")).toEqual({
    ok: true,
    parentPath: "/Users/me",
    entries: [{ name: "Desktop", fullPath: "/Users/me/Desktop" }],
  });
  expect(sent).toEqual([{ tag: "filesystem.browse", payload: { partialPath: "~/" } }]);
});

test("a browse refusal keeps the missing-path flag when the session carries it", async () => {
  const refusal = Object.assign(new Error("Failed to browse filesystem path '~/new/'."), {
    detail: {
      _tag: "FilesystemBrowseError",
      failure: "read_directory_failed",
      pathMissing: true,
      message: "Failed to browse filesystem path '~/new/'.",
    },
  });
  const { rpc } = session(refusal);
  expect(await browseFilesystem(rpc, "~/new/")).toEqual({
    ok: false,
    failure: "read_directory_failed",
    pathMissing: true,
    message: "Failed to browse filesystem path '~/new/'.",
  });
  const plain = session(new Error("Permission denied"));
  expect(await browseFilesystem(plain.rpc, "/root/")).toEqual({
    ok: false,
    failure: null,
    pathMissing: false,
    message: "Permission denied",
  });
});

test("repository lookup sends provider and repository", async () => {
  const { rpc, sent } = session(repository);
  expect(await lookupRepository(rpc, { provider: "github", repository: "octocat/Hello-World" })).toEqual(
    repository,
  );
  expect(sent).toEqual([
    {
      tag: "sourceControl.lookupRepository",
      payload: { provider: "github", repository: "octocat/Hello-World" },
    },
  ]);
});

test("project create, unarchive and delete send projects.mutate commands", async () => {
  const { rpc, sent } = session(projectReply);
  expect(
    await createProject(rpc, { commandId: "c1", projectId: "p1", title: "app", workspaceRoot: "/Users/me/app" }),
  ).toEqual({ id: "p1", title: "app", workspaceRoot: "/Users/me/app", archived: false });
  expect(await unarchiveProject(rpc, { commandId: "c2", projectId: "p1" })).toEqual({
    id: "p1",
    title: "app",
    workspaceRoot: "/Users/me/app",
    archived: false,
  });
  await deleteProject(rpc, { commandId: "c3", projectId: "p1" });
  expect(sent).toEqual([
    {
      tag: "projects.mutate",
      payload: {
        type: "project.create",
        commandId: "c1",
        projectId: "p1",
        title: "app",
        workspaceRoot: "/Users/me/app",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    },
    { tag: "projects.mutate", payload: { type: "project.update", commandId: "c2", projectId: "p1", archived: false } },
    { tag: "projects.mutate", payload: { type: "project.delete", commandId: "c3", projectId: "p1" } },
  ]);
});

test("an archived project reply reads as archived", async () => {
  const { rpc } = session({ ...projectReply, archivedAt: "2026-11-16T00:00:00.000Z" });
  expect((await unarchiveProject(rpc, { commandId: "c", projectId: "p1" })).archived).toBe(true);
});

test("createNew sends the name and keeps a commit error", async () => {
  const { rpc, sent } = session({ projectId: "p2", workspaceRoot: "/Users/me/projects/my-app", commitError: "no user.email" });
  expect(await createNewProject(rpc, "My App")).toEqual({
    projectId: "p2",
    workspaceRoot: "/Users/me/projects/my-app",
    commitError: "no user.email",
  });
  expect(sent).toEqual([{ tag: "projects.createNew", payload: { name: "My App" } }]);
  const clean = session({ projectId: "p2", workspaceRoot: "/w" });
  expect((await createNewProject(clean.rpc, "x")).commitError).toBeNull();
});

test("publish sends a private repository request", async () => {
  const { rpc, sent } = session({
    repository,
    remoteName: "origin",
    remoteUrl: "https://github.com/octocat/my-app.git",
    branch: "main",
    status: "pushed",
  });
  const published = await publishRepository(rpc, {
    cwd: "/Users/me/projects/my-app",
    provider: "github",
    repository: "octocat/my-app",
  });
  expect(published.remoteUrl).toBe("https://github.com/octocat/my-app.git");
  expect(published.status).toBe("pushed");
  expect(sent).toEqual([
    {
      tag: "sourceControl.publishRepository",
      payload: { cwd: "/Users/me/projects/my-app", provider: "github", repository: "octocat/my-app", visibility: "private" },
    },
  ]);
});

test("app access sends provider, host and repository", async () => {
  const { rpc, sent } = session({ status: "not-covered" });
  expect(await checkAppAccess(rpc, { provider: "github", host: "github.com", repository: "octocat/app" })).toBe(
    "not-covered",
  );
  expect(sent).toEqual([
    { tag: "sourceControl.appAccess", payload: { provider: "github", host: "github.com", repository: "octocat/app" } },
  ]);
  await expect(checkAppAccess(session({ status: "maybe" }).rpc, { provider: "github", host: "h", repository: "r" })).rejects.toThrow();
});

test("clone start sends only the fields upstream sends", async () => {
  const { rpc, sent } = session({
    projectId: "p3",
    cwd: "/Users/me/Hello-World",
    remoteUrl: repository.url,
    repository,
  });
  expect(
    await startProjectClone(rpc, {
      projectId: "p3",
      title: "Hello-World",
      createdAt: "2026-11-17T00:00:00.000Z",
      remoteUrl: repository.url,
      destinationPath: "~/Hello-World",
    }),
  ).toEqual({ projectId: "p3", cwd: "/Users/me/Hello-World", remoteUrl: repository.url, repository });
  expect(sent).toEqual([
    {
      tag: "projectClone.start",
      payload: {
        projectId: "p3",
        title: "Hello-World",
        createdAt: "2026-11-17T00:00:00.000Z",
        remoteUrl: repository.url,
        destinationPath: "~/Hello-World",
      },
    },
  ]);
});

test("clone cancel and retry send the project id", async () => {
  const { rpc, sent } = session({ applied: true });
  expect(await cancelProjectClone(rpc, "p3")).toBe(true);
  expect(await retryProjectClone(rpc, "p3")).toBe(true);
  expect(sent).toEqual([
    { tag: "projectClone.cancel", payload: { projectId: "p3" } },
    { tag: "projectClone.retry", payload: { projectId: "p3" } },
  ]);
});

test("ensureScratch sends an empty payload", async () => {
  const { rpc, sent } = session({ projectId: "scratch" });
  expect(await ensureScratchProject(rpc)).toBe("scratch");
  expect(sent).toEqual([{ tag: "projects.ensureScratch", payload: {} }]);
});

test("a clone list event parses each snapshot", () => {
  expect(PROJECT_CLONES_SUBSCRIPTION).toEqual({ tag: "subscribeProjectClones", payload: {} });
  const snapshot = {
    projectId: "p3",
    remoteUrl: repository.url,
    destinationPath: "/Users/me/Hello-World",
    repository: null,
    phase: "running",
    stage: "receiving",
    percent: 42,
    detail: "1.2 MiB/s",
    error: null,
    startedAt: "2026-11-17T00:00:00.000Z",
    endedAt: null,
    sequence: 3,
  };
  expect(parseProjectClones([snapshot])).toEqual([{ ...snapshot, stalled: false }]);
  expect(parseProjectClones([{ ...snapshot, stalled: true, repository }])[0]).toMatchObject({
    stalled: true,
    repository,
  });
  expect(() => parseProjectClones([{ ...snapshot, stage: "unpacking" }])).toThrow();
  expect(() => parseProjectClones({})).toThrow();
});
