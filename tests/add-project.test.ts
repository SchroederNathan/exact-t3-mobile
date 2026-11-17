import { expect, test } from "bun:test";
import {
  ADD_EXISTING_ROW,
  NOT_REACHED_YET,
  PROJECT_ADDED_LATE,
  addProjectSource,
  appAccessAlert,
  appAccessCheck,
  cloneDestinationPath,
  connectionStatusText,
  createdWithoutCommitAlert,
  destinationFromRepository,
  environmentOptions,
  errorMessage,
  getCloneDirectoryName,
  inferProjectTitleFromPath,
  localFolderPath,
  newProjectFolderName,
  normalizePastedCloneUrl,
  pastedPathInput,
  planClone,
  planLocalFolder,
  planRepositorySubmit,
  presentCloneDestination,
  presentFolderBrowser,
  presentLocalFolder,
  presentNewProject,
  presentProjectClone,
  presentRepositoryInput,
  presentSourceChooser,
  projectExistsAlert,
  publishFailedAlert,
  publishRepositoryName,
  resolveAddProjectEnvironment,
  resolveAddProjectPath,
  type AddProjectEnvironment,
} from "../add-project";
import type { CloneSnapshot, SourceControlDiscovery, SourceControlProvider } from "../project-rpc";

const mac = (patch: Partial<AddProjectEnvironment> = {}): AddProjectEnvironment => ({
  id: "mac",
  label: "Mac mini",
  machineSymbol: "macmini",
  os: "darwin",
  baseDirectory: "",
  newProjectsRoot: "/Users/me/projects",
  ghqCloneLayout: false,
  phase: "connected",
  error: null,
  canOperate: true,
  canWriteSourceControl: true,
  ...patch,
});

const provider = (kind: string, label: string, patch: Partial<SourceControlProvider> = {}): SourceControlProvider => ({
  kind,
  label,
  available: false,
  installHint: `Install ${label}`,
  auth: { status: "unknown", account: null, host: null, detail: null },
  appSignIn: false,
  ...patch,
});

const discovery: SourceControlDiscovery = {
  providers: [
    provider("github", "GitHub", {
      available: true,
      auth: { status: "authenticated", account: "octocat", host: "github.com", detail: null },
    }),
    provider("gitlab", "GitLab"),
    provider("bitbucket", "Bitbucket", {
      available: true,
      auth: { status: "unauthenticated", account: null, host: null, detail: null },
    }),
    provider("forgejo", "Forgejo", {
      available: true,
      auth: { status: "unauthenticated", account: null, host: null, detail: "Run fj auth login" },
    }),
  ],
};

test("source chooser lists new, local, Git URL, then ready providers before the rest by label", () => {
  const model = presentSourceChooser({ environments: [mac()], selectedId: null, discovery, discoveryPending: false });
  expect(model.environmentId).toBe("mac");
  expect(model.environmentRows).toEqual([]);
  expect(model.sourceRows.map((row) => [row.title, row.subtitle, row.enabled, row.trailing])).toEqual([
    ["New project", "Start a new Git repository from a name", true, "chevron"],
    ["Local folder", "Browse a folder on disk", true, "chevron"],
    ["Git URL", "Clone from a remote URL", true, "chevron"],
    ["GitHub repository", "Clone GitHub owner/repo", true, "chevron"],
    ["Azure DevOps repository", "Provider status unavailable. Open Source Control settings and rescan.", false, "none"],
    ["Bitbucket repository", "Bitbucket is not authenticated. Open Source Control settings for setup guidance.", false, "none"],
    ["Cursor Origin repository", "Provider status unavailable. Open Source Control settings and rescan.", false, "none"],
    ["Forgejo / Gitea repository", "Run fj auth login", false, "none"],
    ["GitCafe repository", "Provider status unavailable. Open Source Control settings and rescan.", false, "none"],
    ["GitLab repository", "Install GitLab", false, "none"],
  ]);
  expect(model.sourceRows.map((row) => row.icon)).toEqual([
    "symbol:sf/plus",
    "symbol:sf/folder.badge.plus",
    "symbol:sf/link",
    "assets/source-control-github.svg",
    "assets/source-control-azure-devops.svg",
    "assets/source-control-bitbucket.svg",
    "assets/source-control-cursor-origin.svg",
    "assets/source-control-forgejo.svg",
    "assets/source-control-gitcafe.svg",
    "assets/source-control-gitlab.svg",
  ]);
  expect(model.sourceRows[3]).toMatchObject({ id: "github", iconSize: 18, iconTint: "icon" });
  expect(model.sourceRows[9]).toMatchObject({ iconSize: 18, iconTint: "" });
});

test("source chooser without scopes explains what the connection cannot do", () => {
  const model = presentSourceChooser({
    environments: [mac({ newProjectsRoot: null, canOperate: false })],
    selectedId: "mac",
    discovery,
    discoveryPending: true,
  });
  expect(model.loading).toBe(true);
  expect(model.sourceRows[0]).toMatchObject({
    title: "Local folder",
    subtitle: "This connection cannot add projects.",
    enabled: false,
  });
  expect(model.sourceRows.slice(1).every((row) => row.subtitle === "This connection cannot clone projects." && !row.enabled)).toBe(true);
});

test("source chooser shows environments when several exist and marks the chosen one", () => {
  const environments = [mac(), mac({ id: "box", label: "Build box", machineSymbol: "server.rack" })];
  const model = presentSourceChooser({ environments, selectedId: "box", discovery: null, discoveryPending: false });
  expect(model.environmentRows.map((row) => [row.title, row.selected, row.trailing, row.icon])).toEqual([
    ["Build box", true, "check", "symbol:sf/server.rack"],
    ["Mac mini", false, "none", "symbol:sf/macmini"],
  ]);
  const offline = presentSourceChooser({
    environments: [mac({ phase: "reconnecting", error: "timeout" })],
    selectedId: "mac",
    discovery: null,
    discoveryPending: false,
  });
  expect(offline.environmentRows[0]).toMatchObject({
    subtitle: "Failed to connect. Reconnecting... Reason: timeout",
    enabled: false,
    selected: true,
  });
  expect(offline.sourceRows[0]).toMatchObject({ title: "New project", enabled: false });
  expect(presentSourceChooser({ environments: [], selectedId: null, discovery: null, discoveryPending: false }).empty).toBe(true);
});

test("environment preselection follows upstream", () => {
  const offline = mac({ id: "off", label: "Alpha", phase: "offline" });
  const box = mac({ id: "box", label: "Build box" });
  expect(environmentOptions([mac(), offline, box], null).map((environment) => environment.id)).toEqual(["box", "mac"]);
  expect(environmentOptions([mac(), offline, box], "off").map((environment) => environment.id)).toEqual(["off", "box", "mac"]);
  expect(resolveAddProjectEnvironment([offline, box], "off")).toBeNull();
  expect(resolveAddProjectEnvironment([offline, box], null)?.id).toBe("box");
  expect(connectionStatusText("error", null)).toBe("Connection failed");
  expect(connectionStatusText("connecting", null)).toBe("Connecting...");
});

test("repository input copy and submit plans", () => {
  expect(presentRepositoryInput({ source: "url", text: "", submitting: false })).toEqual({
    title: "Git URL",
    placeholder: "https://github.com/org/repo.git",
    buttonLabel: "Continue",
    buttonEnabled: false,
  });
  expect(presentRepositoryInput({ source: "gitlab", text: "g/p", submitting: false })).toEqual({
    title: "GitLab",
    placeholder: "group/project",
    buttonLabel: "Lookup repository",
    buttonEnabled: true,
  });
  expect(addProjectSource("nope")).toBe("url");
  expect(addProjectSource("forgejo")).toBe("forgejo");
  expect(planRepositorySubmit("github", "octocat/")).toEqual({
    kind: "error",
    message: "Enter the full owner/repository name.",
  });
  expect(planRepositorySubmit("github", " octocat/Hello-World ")).toEqual({
    kind: "lookup",
    provider: "github",
    repository: "octocat/Hello-World",
  });
  expect(planRepositorySubmit("url", "octocat/Hello-World")).toEqual({
    kind: "destination",
    destination: {
      source: "url",
      remoteUrl: "https://github.com/octocat/Hello-World.git",
      repositoryTitle: "https://github.com/octocat/Hello-World.git",
      repositoryName: "Hello-World",
    },
  });
  expect(planRepositorySubmit("url", "  ")).toEqual({ kind: "ignore" });
  expect(
    destinationFromRepository("gitlab", {
      provider: "gitlab",
      nameWithOwner: "group/project",
      url: "https://gitlab.com/group/project.git",
      sshUrl: "git@gitlab.com:group/project.git",
    }),
  ).toEqual({
    source: "gitlab",
    remoteUrl: "git@gitlab.com:group/project.git",
    repositoryTitle: "group/project",
    repositoryName: "project",
  });
  expect(errorMessage(new Error(" "))).toBe("An error occurred.");
});

test("pasted clone URLs normalize as upstream does", () => {
  expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe("https://github.com/pingdotgg/t3code.git");
  for (const kept of [
    "https://gitlab.com/group/project.git",
    "git@github.com:owner/repo.git",
    "group/subgroup/project",
    "/srv/git/repo.git",
    "https://gitlab.com/acme/tools/src/branch/worker.git",
    "https://scm.example.test/acme/tools/src/branch/worker.git",
    "https://scm.example.test/acme/tools/src/branch/worker",
    "https://scm.example.test/team/repo/src/branch/main/-/README.md",
    "https://forgejo.example.test/a/b/src/branch/mount/team/repo.git",
  ])
    expect(normalizePastedCloneUrl(kept)).toBe(kept);
  for (const [page, repository] of [
    ["https://github.com/pingdotgg/t3code/tree/main", "t3code"],
    ["https://gitlab.com/gitlab-org/gitlab-runner/-/tree/main", "gitlab-runner"],
    ["https://git.cafe/pingdotgg/t3code/tree/main", "t3code"],
    ["https://gitlab.example.test/g/p/-/blob/main/src/branch/x", "p"],
    ["https://code.company.test/g/p/-/tree/main", "p"],
    ["https://github.com/pingdotgg/t3code/tree/release.git", "t3code"],
  ] as const)
    expect(getCloneDirectoryName(normalizePastedCloneUrl(page))).toBe(repository);
  expect(normalizePastedCloneUrl("https://alice:example@bitbucket.org/workspace/repo/src/master/")).toBe(
    "https://alice:example@bitbucket.org/workspace/repo",
  );
});

test("clone folder names come from any clone URL", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git",
    "https://dev.azure.com/org/project/_git/repo",
    "https://github.com/owner/repo.git?ref=main#readme",
    "/srv/git/repo.git",
    "C:\\src\\repo.git",
    "git@github.com:repo.git",
  ])
    expect(getCloneDirectoryName(url)).toBe("repo");
  expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
  expect(getCloneDirectoryName("https://host:8080")).toBe("");
});

test("default clone path seeds from the base directory and ghq layout", () => {
  const url = "https://github.com/octocat/Hello-World.git";
  expect(cloneDestinationPath(mac(), url, "Hello-World")).toEqual({ pinnedName: "Hello-World", seed: "~/Hello-World" });
  expect(cloneDestinationPath(mac({ baseDirectory: "/base" }), url, "Hello-World").seed).toBe("/base/Hello-World");
  expect(cloneDestinationPath(mac({ baseDirectory: "/base", ghqCloneLayout: true }), url, "Hello-World")).toEqual({
    pinnedName: "Hello-World",
    seed: "/base/github.com/octocat/Hello-World",
  });
  expect(cloneDestinationPath(mac({ ghqCloneLayout: true }), "ssh://git@gitlab.com:2222/group/sub/repo.git", "repo").seed).toBe(
    "~/gitlab.com/group/sub/repo",
  );
  expect(cloneDestinationPath(mac({ ghqCloneLayout: true }), "https://github.com/owner/../../repo", "repo").seed).toBe("~/repo");
  expect(
    cloneDestinationPath(mac({ os: "windows", baseDirectory: "C:\\Users\\me\\ghq", ghqCloneLayout: true }), "git@github.com:owner/repo.git", "repo")
      .seed,
  ).toBe("C:\\Users\\me\\ghq\\github.com\\owner\\repo");
  expect(localFolderPath(mac()).seed).toBe("~/");
  expect(localFolderPath(mac({ baseDirectory: " /base " })).seed).toBe("/base/");
});

test("path validation errors read exactly as upstream", () => {
  expect(resolveAddProjectPath("  ", "MacIntel")).toEqual({ ok: false, error: "Enter a project path." });
  expect(resolveAddProjectPath("C:\\code", "MacIntel")).toEqual({
    ok: false,
    error: "Windows-style paths are only supported on Windows environments.",
  });
  expect(resolveAddProjectPath("./app", "MacIntel")).toEqual({
    ok: false,
    error: "Relative paths require an active project in this environment.",
  });
  expect(resolveAddProjectPath("~/code/app/", "MacIntel")).toEqual({ ok: true, path: "~/code/app" });
  expect(resolveAddProjectPath("C:\\code\\", "Win32")).toEqual({ ok: true, path: "C:\\code" });
  expect(inferProjectTitleFromPath("/Users/me/app/")).toBe("app");
  expect(inferProjectTitleFromPath("~/code/app")).toBe("app");
  expect(inferProjectTitleFromPath("C:\\code\\app")).toBe("app");
});

test("new project folder names follow the slug rules", () => {
  expect(newProjectFolderName("My Cool App")).toBe("my-cool-app");
  expect(newProjectFolderName("  Café déjà vu!! ")).toBe("cafe-deja-vu");
  expect(newProjectFolderName("---")).toBe("project");
  expect(newProjectFolderName("CON")).toBe("con-project");
  expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
});

test("pasted paths replace the field and lose shell quoting", () => {
  expect(pastedPathInput("~/", "~/a")).toBe("~/a");
  expect(pastedPathInput("~/", "~//Users/me/My Repo")).toBe("/Users/me/My Repo");
  expect(pastedPathInput("~/", "~/'/Users/me/a b'")).toBe("/Users/me/a b");
  expect(pastedPathInput("", "/Users/me/a\\ b")).toBe("/Users/me/a b");
});

test("clone destination screen and submit", () => {
  expect(
    presentCloneDestination({
      environment: mac({ canWriteSourceControl: false }),
      remoteUrl: "u",
      repositoryTitle: "octocat/Hello-World",
      navigating: false,
      submitting: false,
    }),
  ).toEqual({
    empty: false,
    repositoryTitle: "octocat/Hello-World",
    remoteUrl: "u",
    buttonEnabled: false,
    notice: "This connection cannot clone projects.",
  });
  const base = { environment: mac(), remoteUrl: "https://github.com/o/r.git", navigating: false, submitting: false };
  expect(planClone({ ...base, pathText: "~/code/r/" })).toEqual({
    kind: "clone",
    title: "r",
    destinationPath: "~/code/r",
    remoteUrl: "https://github.com/o/r.git",
  });
  expect(planClone({ ...base, pathText: "" })).toEqual({ kind: "error", message: "Enter a project path." });
  expect(planClone({ ...base, navigating: true, pathText: "~/r" })).toEqual({ kind: "ignore" });
});

test("local folder screen plans create, reuse and refusal", () => {
  expect(presentLocalFolder({ environment: mac({ canOperate: false }), navigating: false, submitting: false })).toEqual({
    empty: false,
    scopeError: "This connection cannot add projects.",
    buttonEnabled: false,
  });
  const projects = [
    { environmentId: "mac", id: "p1", title: "app", workspaceRoot: "/Users/me/app", archived: true },
    { environmentId: "box", id: "p2", title: "web", workspaceRoot: "/Users/me/web", archived: false },
  ];
  const base = { environment: mac(), projects, navigating: false, submitting: false };
  expect(planLocalFolder({ ...base, pathText: "/Users/me/app/" })).toEqual({
    kind: "existing",
    project: projects[0]!,
    unarchive: true,
  });
  expect(planLocalFolder({ ...base, pathText: "/Users/me/web" })).toEqual({
    kind: "create",
    title: "web",
    workspaceRoot: "/Users/me/web",
  });
  expect(planLocalFolder({ ...base, environment: mac({ phase: "offline" }), pathText: "/Users/me/x" })).toEqual({
    kind: "alert",
    alert: {
      title: "Project not added",
      message: "This connection cannot add projects right now. Any existing files remain at /Users/me/x.",
    },
  });
  expect(projectExistsAlert("app", true)).toEqual({ title: "Project already exists", message: "app" });
  expect(projectExistsAlert("app", false).message).toBe("app is still archived. Try again later.");
  expect(PROJECT_ADDED_LATE).toEqual({ title: "Project added", message: NOT_REACHED_YET });
  expect(NOT_REACHED_YET).toBe(
    "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
  );
});

test("new project preview, machines and publish targets", () => {
  const input = {
    environments: [mac()],
    selectedId: null,
    name: "",
    discovery,
    publishes: false,
    publishProvider: null,
    submitting: false,
  };
  const empty = presentNewProject(input);
  expect(empty.pathPreview).toBe("Goes in /Users/me/projects");
  expect(empty.machineRows).toEqual([]);
  expect(empty.buttonEnabled).toBe(false);
  expect(empty.publishRows.map((row) => [row.title, row.subtitle, row.trailing, row.selected])).toEqual([
    ["Create private repository on GitHub", "octocat", "switch", false],
  ]);
  const named = presentNewProject({ ...input, name: " My App ", publishes: true });
  expect(named.pathPreview).toBe("Creates /Users/me/projects/my-app");
  expect(named.publishRows[0]!.subtitle).toBe("octocat/my-app");
  expect(named.publish).toEqual({ provider: "github", label: "GitHub", owner: "octocat" });
  expect(named.buttonEnabled).toBe(true);
  const two = presentNewProject({
    ...input,
    environments: [mac(), mac({ id: "box", label: "Build box" })],
    selectedId: "mac",
    name: "x",
  });
  expect(two.pathPreview).toBe("Creates /Users/me/projects/x on Mac mini");
  expect(two.machineRows.map((row) => [row.title, row.trailing])).toEqual([
    ["Build box", "none"],
    ["Mac mini", "check"],
  ]);
  const gitcafe: SourceControlDiscovery = {
    providers: [
      ...discovery.providers,
      provider("gitcafe", "GitCafe", {
        available: true,
        auth: { status: "authenticated", account: "cafe", host: null, detail: null },
      }),
    ],
  };
  const several = presentNewProject({ ...input, discovery: gitcafe, publishes: true, publishProvider: "gitcafe" });
  expect(several.publishRows.map((row) => [row.kind, row.title, row.trailing])).toEqual([
    ["publish", "Create private repository on GitCafe", "switch"],
    ["publish-target", "GitHub", "none"],
    ["publish-target", "GitCafe", "check"],
  ]);
  expect(presentNewProject({ ...input, environments: [mac({ newProjectsRoot: null })] }).empty).toBe(true);
  expect(publishRepositoryName("octocat", "/Users/me/projects/my-app")).toBe("octocat/my-app");
  expect(publishRepositoryName(null, "/Users/me/projects/my-app")).toBe("my-app");
  expect(ADD_EXISTING_ROW).toMatchObject({
    title: "Add existing project",
    subtitle: "Open a folder or clone a repository",
    icon: "symbol:sf/folder.badge.plus",
  });
  expect(createdWithoutCommitAlert("no email")).toEqual({ title: "Created without a first commit", message: "no email" });
  expect(publishFailedAlert("GitHub", new Error("exists"))).toEqual({
    title: "Could not create the GitHub repository",
    message: "exists",
  });
});

const entries = ["Applications", "Desktop", ".config", "Documents", "Hello-World"].map((name) => ({
  name,
  fullPath: `/Users/me/${name}`,
}));
const readable = { canRead: true, pending: false, error: null };

test("folder browser filters by the leaf and builds tap targets", () => {
  const model = presentFolderBrowser({
    environment: mac(),
    pathText: "~/D",
    pinnedName: "",
    cloning: false,
    access: readable,
    browse: { pending: false, outcome: { ok: true, parentPath: "/Users/me", entries } },
  });
  expect(model.request).toBe("~/");
  expect(model.rows.map((row) => [row.title, row.path, row.browsePath, row.icon])).toEqual([
    ["Desktop", "~/Desktop/", "~/Desktop/", "symbol:sf/folder"],
    ["Documents", "~/Documents/", "~/Documents/", "symbol:sf/folder"],
  ]);
  const hidden = presentFolderBrowser({
    environment: mac(),
    pathText: "/Users/me/.",
    pinnedName: "",
    cloning: false,
    access: readable,
    browse: { pending: false, outcome: { ok: true, parentPath: "/Users", entries } },
  });
  expect(hidden.rows.map((row) => row.title)).toEqual(["..", ".config"]);
  expect(hidden.rows[0]).toMatchObject({ path: "/Users/", icon: "symbol:sf/arrow.turn.left.up", trailing: "none" });
  const nested = presentFolderBrowser({
    environment: mac(),
    pathText: "/Users/me/Hello-World",
    pinnedName: "Hello-World",
    cloning: true,
    access: readable,
    browse: { pending: false, outcome: { ok: true, parentPath: "/Users", entries: [] } },
  });
  expect(nested.rows.map((row) => [row.title, row.path, row.browsePath])).toEqual([
    ["..", "/Users/Hello-World", "/Users/"],
  ]);
});

test("clone destination browsing keeps the clone folder at the end", () => {
  const model = presentFolderBrowser({
    environment: mac(),
    pathText: "~/Hello-World",
    pinnedName: "Hello-World",
    cloning: true,
    access: readable,
    browse: { pending: false, outcome: { ok: true, parentPath: "/Users/me", entries } },
  });
  expect(model.rows.map((row) => [row.title, row.path])).toEqual([
    ["Applications", "~/Applications/Hello-World"],
    ["Desktop", "~/Desktop/Hello-World"],
    ["Documents", "~/Documents/Hello-World"],
    ["Hello-World", "~/Hello-World/"],
  ]);
});

test("folder browser access, loading and missing folders", () => {
  const base = { environment: mac(), pathText: "~/new/Hello-World", pinnedName: "Hello-World" };
  const missing = { ok: false as const, failure: "read_directory_failed" as const, pathMissing: true, message: "Failed to browse." };
  expect(
    presentFolderBrowser({ ...base, cloning: true, access: readable, browse: { pending: false, outcome: missing } }),
  ).toMatchObject({ missingNote: "This folder does not exist yet. Cloning creates it.", browseError: "" });
  expect(
    presentFolderBrowser({ ...base, cloning: false, access: readable, browse: { pending: false, outcome: missing } }),
  ).toMatchObject({ missingNote: "", browseError: "Failed to browse." });
  expect(
    presentFolderBrowser({
      ...base,
      cloning: false,
      access: { canRead: false, pending: false, error: null },
      browse: { pending: false, outcome: null },
    }),
  ).toMatchObject({ accessError: "This connection cannot browse host folders.", request: "" });
  expect(
    presentFolderBrowser({ ...base, cloning: false, access: readable, browse: { pending: true, outcome: null } }).loading,
  ).toBe(true);
  expect(
    presentFolderBrowser({ ...base, pathText: "projects", cloning: false, access: readable, browse: { pending: false, outcome: null } })
      .request,
  ).toBe("");
});

const snapshot = (patch: Partial<CloneSnapshot>): CloneSnapshot => ({
  projectId: "p",
  remoteUrl: "https://github.com/octocat/Hello-World.git",
  destinationPath: "/Users/me/Hello-World",
  repository: null,
  phase: "running",
  stage: "receiving",
  percent: 42,
  detail: "1.2 MiB/s",
  stalled: false,
  error: null,
  startedAt: "2026-11-17T00:00:00.000Z",
  endedAt: null,
  sequence: 1,
  ...patch,
});

test("clone banner titles, stage summaries and the send block", () => {
  expect(presentProjectClone({ clones: [snapshot({})], projectId: "p", awaitingClone: false })).toEqual({
    banner: { phase: "running", title: "Cloning Hello-World", detail: "Receiving objects · 42% · 1.2 MiB/s" },
    blocksStart: true,
    blockReason: "Wait for the project clone to finish.",
  });
  const stages = [
    ["connecting", "Connecting"],
    ["counting", "Counting objects"],
    ["resolving", "Resolving deltas"],
    ["checkout", "Checking out files"],
  ] as const;
  for (const [stage, label] of stages)
    expect(
      presentProjectClone({ clones: [snapshot({ stage, percent: null, detail: null })], projectId: "p", awaitingClone: false })
        .banner?.detail,
    ).toBe(label);
  expect(
    presentProjectClone({ clones: [snapshot({ stalled: true })], projectId: "p", awaitingClone: false }).banner?.detail,
  ).toBe("Receiving objects · 42% · Stalled");
  const repository = { provider: "github", nameWithOwner: "octocat/Hello-World", url: "u", sshUrl: "s" };
  expect(
    presentProjectClone({ clones: [snapshot({ phase: "failed", error: "auth", repository })], projectId: "p", awaitingClone: false })
      .banner,
  ).toEqual({ phase: "failed", title: "Failed to clone octocat/Hello-World", detail: "auth" });
  expect(
    presentProjectClone({ clones: [snapshot({ phase: "cancelled" })], projectId: "p", awaitingClone: false }).banner,
  ).toEqual({ phase: "cancelled", title: "Cancelled cloning Hello-World", detail: "" });
  expect(presentProjectClone({ clones: [snapshot({ phase: "done" })], projectId: "p", awaitingClone: true })).toEqual({
    banner: null,
    blocksStart: false,
    blockReason: "",
  });
  expect(presentProjectClone({ clones: null, projectId: "p", awaitingClone: true }).blocksStart).toBe(true);
  expect(presentProjectClone({ clones: null, projectId: "p", awaitingClone: false }).blocksStart).toBe(false);
});

test("app access applies to GitHub remotes and keeps the remote's casing", () => {
  expect(appAccessCheck("https://github.com/OctoCat/Hello-World.git")).toEqual({
    provider: "github",
    host: "github.com",
    repository: "OctoCat/Hello-World",
  });
  expect(appAccessCheck("git@github.com:octocat/app.git")?.repository).toBe("octocat/app");
  expect(appAccessCheck("https://gitlab.com/group/project.git")).toBeNull();
  expect(appAccessAlert({ provider: "github", host: "github.com", repository: "octocat/app" })).toEqual({
    title: "Give T3 Code for GitHub access to octocat",
    message: "It isn't installed there, so GitHub requests for octocat/app use your own login and its lower rate limit.",
    cancel: "Not now",
    confirm: "Install",
    url: "https://github.com/apps/t3-code-for-github/installations/new",
  });
});
