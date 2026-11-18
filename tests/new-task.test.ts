import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DRAFT_KEY_PREFIX,
  branchBadge,
  defaultModelSelection,
  deriveThreadTitleFromPrompt,
  deriveThreadTitleSeed,
  draftRowTitle,
  environmentPresentation,
  filterProjectScopes,
  homeDraftRows,
  isDraftKey,
  launchWorkspaceStrategy,
  matchEnvironmentProject,
  mintDraftKey,
  planLaunch,
  presentNewTask,
  projectEmptyState,
  projectScopes,
  resolveWorkspace,
  retargetStamp,
  type ChoiceProject,
  type NewTaskFacts,
  type VcsRef,
} from "../new-task";

const ref = (name: string, extra: Partial<VcsRef> = {}): VcsRef => ({
  name,
  isRemote: false,
  remoteName: "",
  upstreamRef: "",
  current: false,
  isDefault: false,
  worktreePath: null,
  ...extra,
});
const refs = [ref("main", { current: true, isDefault: true }), ref("feature/login"), ref("fix/typo")];

const facts = (overrides: Partial<NewTaskFacts> = {}): NewTaskFacts => ({
  key: "new-task~abc-12345678",
  ready: true,
  stamp: {
    environmentId: "env",
    projectId: "env:acme",
    createdAt: "2026-11-17T00:00:00.000Z",
    cloning: false,
    workspace: null,
  },
  text: "",
  attachments: 0,
  submitting: false,
  project: { title: "acme-web", label: "acme-web", workspaceRoot: "/repos/acme-web", isScratch: false },
  defaults: { mode: "local", settled: true, startFromOrigin: true },
  environment: { id: "env", label: "Nate's Mac Mini", machineSymbol: "macmini", status: "Connected" },
  refs: { loading: false, isRepo: true, refs },
  modelResolved: true,
  viewportShort: false,
  canReadFiles: true,
  cloneBlocked: false,
  ...overrides,
});

test("draft keys never collide with scoped thread ids and the contract copy matches", () => {
  const key = mintDraftKey(1_700_000_000_000, "abcdefgh");
  expect(key).toBe(`new-task~${(1_700_000_000_000).toString(36)}-abcdefgh`);
  expect(isDraftKey(key)).toBe(true);
  expect(isDraftKey("env:thread")).toBe(false);
  expect(isDraftKey("new-task~x:y")).toBe(false);
  const contract = readFileSync(new URL("../new-task.contract", import.meta.url), "utf8");
  expect(contract).toContain(`id.startsWith("${DRAFT_KEY_PREFIX}")`);
});

test("a fresh draft shows the project hero, the current checkout and its branch", () => {
  const view = presentNewTask(facts());
  expect(view.phase).toBe("ready");
  expect(view.question).toBe("What should we build");
  expect(view.projectLabel).toBe("acme-web");
  expect(view.environmentA11y).toBe("Choose environment, Nate's Mac Mini, Connected");
  expect(view.workspaceLabel).toBe("Current checkout");
  expect(view.workspaceIcon).toBe("folder");
  expect(view.workspaceHint).toBe("Switches to a new worktree");
  expect(view.branchLabel).toBe("main");
  expect(view.branchA11y).toBe("Branch: main");
  expect(view.branchPickerTitle).toBe("Branch");
  expect(view.sendBlockedReason).toBe("");
  expect(view.placeholder).toBe("Ask anything");
  expect(view.cwd).toBe("/repos/acme-web");
});

test("worktree mode starts from the default branch, from the remote by default", () => {
  const view = presentNewTask(
    facts({
      stamp: {
        ...facts().stamp!,
        workspace: { mode: "worktree", branch: null, worktreePath: null, startFromOrigin: null, followsCurrentCheckout: false },
      },
    }),
  );
  expect(view.workspaceLabel).toBe("New worktree");
  expect(view.workspaceIcon).toBe("folder-branch");
  expect(view.branchLabel).toBe("From main (remote)");
  expect(view.branchA11y).toBe("Base branch: From main (remote)");
  expect(view.branchPickerTitle).toBe("Base branch");
  const local = presentNewTask(
    facts({
      stamp: {
        ...facts().stamp!,
        workspace: { mode: "worktree", branch: "feature/login", worktreePath: null, startFromOrigin: false, followsCurrentCheckout: false },
      },
    }),
  );
  expect(local.branchLabel).toBe("From feature/login");
});

test("send is blocked while starting, for a clone, or without a base branch", () => {
  expect(presentNewTask(facts({ submitting: true })).sendBlockedReason).toBe("Starting the thread…");
  expect(presentNewTask(facts({ cloneBlocked: true })).sendBlockedReason).toBe(
    "Wait for the project clone to finish.",
  );
  expect(
    presentNewTask(
      facts({
        refs: { loading: false, isRepo: true, refs: [] },
        stamp: {
          ...facts().stamp!,
          workspace: { mode: "worktree", branch: null, worktreePath: null, startFromOrigin: null, followsCurrentCheckout: false },
        },
      }),
    ).sendBlockedReason,
  ).toBe("Choose a base branch before creating a worktree.");
});

test("scratch drafts ask what to work on and hide the workspace controls", () => {
  const view = presentNewTask(
    facts({ project: { title: "scratch", label: "scratch", workspaceRoot: "/scratch", isScratch: true } }),
  );
  expect(view.question).toBe("What should we work on?");
  expect(view.projectLabel).toBe("No project");
  expect(view.workspaceVisible).toBe(false);
  expect(view.branchVisible).toBe(false);
});

test("phases: no project, a missing project, no model, loading branches", () => {
  expect(presentNewTask(facts({ stamp: { ...facts().stamp!, projectId: "" } })).phase).toBe("needsProject");
  expect(presentNewTask(facts({ project: null })).phase).toBe("missing");
  expect(presentNewTask(facts({ modelResolved: false })).phase).toBe("noModel");
  expect(presentNewTask(facts({ refs: { loading: true, isRepo: null, refs: [] } })).branchLabel).toBe(
    "Loading branches…",
  );
  expect(presentNewTask(facts({ environment: null })).environmentLabel).toBe("Environment");
});

test("a folder that is not a repository forces the current checkout", () => {
  const resolved = resolveWorkspace({
    pick: { mode: "worktree", branch: "main", worktreePath: null, startFromOrigin: true, followsCurrentCheckout: false },
    canChoose: true,
    defaults: { mode: "worktree", settled: true, startFromOrigin: true },
    refs: { loading: false, isRepo: false, refs: [] },
    rootCwd: "/r",
  });
  expect(resolved).toEqual({ mode: "local", branch: null, worktreePath: null, startFromOrigin: false });
});

test("a local pick made before refs loaded follows the current checkout", () => {
  const resolved = resolveWorkspace({
    pick: { mode: "local", branch: null, worktreePath: null, startFromOrigin: null, followsCurrentCheckout: true },
    canChoose: true,
    defaults: { mode: "local", settled: true, startFromOrigin: true },
    refs: { loading: false, isRepo: true, refs: [ref("dev", { current: true, worktreePath: "/wt/dev" })] },
    rootCwd: "/r",
  });
  expect(resolved.branch).toBe("dev");
  expect(resolved.worktreePath).toBe("/wt/dev");
  expect(presentNewTask(facts({ stamp: { ...facts().stamp!, workspace: { mode: "local", branch: "dev", worktreePath: "/wt/dev", startFromOrigin: null, followsCurrentCheckout: false } } })).workspaceLabel).toBe("Current worktree");
});

test("retargeting keeps the creation time and drops the workspace for another project", () => {
  const stamp = {
    ...facts().stamp!,
    workspace: { mode: "worktree" as const, branch: "main", worktreePath: null, startFromOrigin: null, followsCurrentCheckout: false },
  };
  expect(retargetStamp(stamp, "env", "env:billing", "later")).toEqual({
    environmentId: "env",
    projectId: "env:billing",
    createdAt: stamp.createdAt,
    cloning: false,
    workspace: null,
  });
  expect(retargetStamp(null, "env", "env:billing", "now").createdAt).toBe("now");
});

test("launch plans: root, existing worktree and a t3 worktree branch", () => {
  const base = {
    text: "Reply with ok",
    attachments: [],
    mode: "local" as const,
    branch: null,
    worktreePath: null,
    startFromOrigin: true,
    currentCheckoutBranch: "main",
    projectId: "env:acme",
    projectTitle: "acme-web",
    runtimeMode: "full-access",
  };
  const ids = { threadId: "env:t1", branchHex8: "0a1b2c3d" };
  const root = planLaunch(base, ids);
  expect(root.ok && root.plan.strategy).toBe("root");
  expect(root.ok && launchWorkspaceStrategy(root.plan)).toEqual({ type: "root", branch: "main" });
  const existing = planLaunch({ ...base, branch: "dev", worktreePath: "/wt/dev" }, ids);
  expect(existing.ok && launchWorkspaceStrategy(existing.plan)).toEqual({
    type: "existing_worktree",
    worktreePath: "/wt/dev",
    branch: "dev",
  });
  const worktree = planLaunch({ ...base, mode: "worktree", branch: "main" }, ids);
  expect(worktree.ok && launchWorkspaceStrategy(worktree.plan)).toEqual({
    type: "worktree",
    baseRef: "main",
    branch: "t3/0a1b2c3d",
    startFromOrigin: true,
  });
  const fromLocal = planLaunch({ ...base, mode: "worktree", branch: "main", startFromOrigin: false }, ids);
  expect(fromLocal.ok && launchWorkspaceStrategy(fromLocal.plan)).toEqual({
    type: "worktree",
    baseRef: "main",
    branch: "t3/0a1b2c3d",
  });
  expect(planLaunch({ ...base, mode: "worktree" }, ids)).toEqual({
    ok: false,
    error: "Choose a base branch before creating a worktree.",
  });
  expect(root.ok && root.plan.title).toBe("Reply with ok");
});

test("titles follow the Expo client's seed and row rules", () => {
  expect(deriveThreadTitleSeed("  a  b ", [])).toBe("a b");
  expect(deriveThreadTitleSeed("x".repeat(60), [])).toBe(`${"x".repeat(50)}...`);
  expect(deriveThreadTitleSeed("", [{ type: "image", name: "a.png" }])).toBe("Attached image");
  expect(deriveThreadTitleSeed("", [{ type: "file", name: "report.pdf" }])).toBe("File: report.pdf");
  expect(deriveThreadTitleFromPrompt("y".repeat(80))).toBe(`${"y".repeat(69)}...`);
  expect(draftRowTitle("", 1)).toBe("1 attachment");
  expect(draftRowTitle("", 3)).toBe("3 attachments");
  expect(draftRowTitle("", 0)).toBe("0 attachments");
});

test("branch badges and environment status words", () => {
  expect(branchBadge(ref("main", { current: true }), "/r")).toBe("CURRENT");
  expect(branchBadge(ref("x", { worktreePath: "/wt" }), "/r")).toBe("WORKTREE");
  expect(branchBadge(ref("x", { worktreePath: "/r" }), "/r")).toBe("");
  expect(branchBadge(ref("origin/x", { isRemote: true }), "/r")).toBe("REMOTE");
  expect(branchBadge(ref("x", { isDefault: true }), "/r")).toBe("DEFAULT");
  expect(environmentPresentation("Connected")).toEqual({ phase: "connected", statusText: "Connected" });
  expect(environmentPresentation("Connecting").statusText).toBe("Connecting...");
  expect(environmentPresentation("Reconnecting").statusText).toBe("Reconnecting...");
  expect(environmentPresentation("Off").statusText).toBe("Offline");
  expect(environmentPresentation("socket closed").statusText).toBe("Connection failed");
});

const project = (id: string, extra: Partial<ChoiceProject> = {}): ChoiceProject => ({
  id,
  environmentId: "env",
  title: id,
  workspaceRoot: `/repos/${id}`,
  isScratch: false,
  pinned: false,
  updatedAt: 0,
  repositoryKey: "",
  faviconUrl: "",
  monogram: "",
  monogramColor: "",
  ...extra,
});

test("project scopes sort by thread activity, then update time, and drop scratch", () => {
  const scopes = projectScopes(
    [
      project("acme-web", { updatedAt: 1 }),
      project("billing-api", { updatedAt: 2 }),
      project("scratch", { isScratch: true, updatedAt: 3 }),
    ],
    new Map(),
  );
  expect(scopes.map((scope) => scope.title)).toEqual(["billing-api", "acme-web"]);
  const active = projectScopes(
    [project("acme-web", { updatedAt: 1 }), project("billing-api", { updatedAt: 2 })],
    new Map([["acme-web", 5]]),
  );
  expect(active.map((scope) => scope.title)).toEqual(["acme-web", "billing-api"]);
  expect(filterProjectScopes(scopes, "BILL").map((scope) => scope.title)).toEqual(["billing-api"]);
  expect(filterProjectScopes(scopes, "repos/acme").map((scope) => scope.title)).toEqual(["acme-web"]);
});

test("project picker empty states name the next step", () => {
  expect(projectEmptyState({ environmentsLoaded: false, environments: [], shellReady: false }).title).toBe(
    "Loading environments",
  );
  expect(projectEmptyState({ environmentsLoaded: true, environments: [], shellReady: false })).toEqual({
    title: "No environments connected",
    detail: "Add an environment before creating a task.",
    spinner: false,
    action: "add-environment",
  });
  expect(
    projectEmptyState({ environmentsLoaded: true, environments: [{ status: "Connecting", enabled: true }], shellReady: false }).title,
  ).toBe("Connecting to environment");
  expect(
    projectEmptyState({ environmentsLoaded: true, environments: [{ status: "Off", enabled: true }], shellReady: false }).detail,
  ).toBe("The saved environment is offline. Check the URL or start the environment, then retry.");
  expect(
    projectEmptyState({ environmentsLoaded: true, environments: [{ status: "Connected", enabled: true }], shellReady: true }).title,
  ).toBe("No projects found");
});

test("the same project on another machine matches by repository, folder, then title", () => {
  const source = project("acme", { repositoryKey: "github.com/a/acme", workspaceRoot: "/a/acme" });
  expect(matchEnvironmentProject(source, [project("x"), project("y", { repositoryKey: "github.com/a/acme" })])?.id).toBe("y");
  expect(matchEnvironmentProject(source, [project("x"), project("z", { workspaceRoot: "/b/acme" })])?.id).toBe("z");
  expect(matchEnvironmentProject(source, [project("q"), project("w")])?.id).toBe("q");
});

test("the default model prefers the project, then the sticky pick, then the default", () => {
  const config = {
    settings: {},
    providers: [
      {
        instanceId: "codex",
        enabled: true,
        installed: true,
        models: [{ slug: "a" }, { slug: "b", isDefault: true }],
      },
    ],
  };
  expect(defaultModelSelection(config, { instanceId: "codex", model: "a" }, null)).toEqual({ instanceId: "codex", model: "a" });
  expect(defaultModelSelection(config, null, { instanceId: "codex", model: "a" })).toEqual({ instanceId: "codex", model: "a" });
  expect(defaultModelSelection(config, null, null)).toEqual({ instanceId: "codex", model: "b" });
  expect(defaultModelSelection({ providers: [] }, null, null)).toBeNull();
});

test("Home lists drafts with content before launches waiting to send", () => {
  const stamp = facts().stamp!;
  const rows = homeDraftRows(
    [
      { id: "new-task~a", text: "", attachments: 0, stamp, launchState: "", launchThreadId: "", launchBranch: "" },
      { id: "new-task~b", text: "Fix the login", attachments: 0, stamp: { ...stamp, createdAt: "2026-11-18" }, launchState: "", launchThreadId: "", launchBranch: "" },
      { id: "new-task~c", text: "Queued", attachments: 0, stamp: { ...stamp, createdAt: "2026-11-19" }, launchState: "unknown", launchThreadId: "env:t", launchBranch: "main" },
      { id: "new-task~d", text: "Sending", attachments: 0, stamp, launchState: "prepared", launchThreadId: "env:u", launchBranch: "" },
      { id: "env:thread", text: "Thread draft", attachments: 0, stamp: null, launchState: "", launchThreadId: "", launchBranch: "" },
    ],
    () => "main",
  );
  expect(rows.map((row) => [row.key, row.kind, row.title, row.branch])).toEqual([
    ["new-task~b", "draft", "Fix the login", "main"],
    ["new-task~c", "unsent", "Queued", "main"],
  ]);
});

test("workspace paths truncate in the middle as the Expo client's subtitle does", () => {
  const { middleEllipsis } = require("../new-task");
  const root = "/private/tmp/claude-501/-Volumes-ExternalSSD-T3Worktrees-exact-t3-mobile-ddbeb2b3-b2f48508ad8110c7/79f5b8a9-2103-4dbf-865e-a2783202e40e/scratchpad/repos";
  expect(middleEllipsis(`${root}/billing-api`, 274)).toBe("/private/tmp/claude-…hpad/repos/billing-api");
  expect(middleEllipsis(`${root}/acme-web`, 274)).toBe("/private/tmp/claude-…pad/repos/acme-web");
  expect(middleEllipsis("/short/path", 274)).toBe("/short/path");
});
