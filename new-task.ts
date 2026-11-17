import type { ModelSelection } from "./thread-settings";

export const DRAFT_KEY_PREFIX = "new-task~";
export type DraftKey = `new-task~${string}`;
export type WorkspaceMode = "local" | "worktree";

export interface WorkspacePick {
  mode: WorkspaceMode;
  branch: string | null;
  worktreePath: string | null;
  startFromOrigin: boolean | null;
  followsCurrentCheckout: boolean;
}

export interface TaskStamp {
  environmentId: string;
  projectId: string;
  createdAt: string;
  cloning: boolean;
  workspace: WorkspacePick | null;
}

export interface VcsRef {
  name: string;
  isRemote: boolean;
  remoteName: string;
  upstreamRef: string;
  current: boolean;
  isDefault: boolean;
  worktreePath: string | null;
}

export interface RefsFacts {
  loading: boolean;
  isRepo: boolean | null;
  refs: VcsRef[];
}

export interface ProjectDefaults {
  mode: WorkspaceMode;
  settled: boolean;
  startFromOrigin: boolean;
}

export interface ResolvedWorkspace {
  mode: WorkspaceMode;
  branch: string | null;
  worktreePath: string | null;
  startFromOrigin: boolean;
}

export function mintDraftKey(nowMs: number, random8: string): DraftKey {
  return `${DRAFT_KEY_PREFIX}${Math.max(0, Math.floor(nowMs)).toString(36)}-${random8}`;
}

export function isDraftKey(id: string): id is DraftKey {
  return id.startsWith(DRAFT_KEY_PREFIX) && !id.includes(":");
}

export function randomBase36(length: number, bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, length), (byte) => (byte % 36).toString(36)).join("");
}

export function randomHex8(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function truncate(text: string, maxLength = 50): string {
  const characters = Array.from(text.trim());
  return characters.length <= maxLength
    ? text.trim()
    : `${characters.slice(0, maxLength).join("")}...`;
}

export function deriveThreadTitleSeed(
  text: string,
  attachments: ReadonlyArray<{ type: string; name: string }>,
): string {
  const prose = normalizeTitle(text);
  if (prose) return truncate(prose);
  const images = attachments.filter((item) => item.type === "image");
  if (images.length) return images.length === 1 ? "Attached image" : "Attached images";
  const name = normalizeTitle(attachments[0]?.name ?? "");
  return name ? truncate(`File: ${name}`) : "New thread";
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = normalizeTitle(value) || "New thread";
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}

export function draftRowTitle(text: string, attachmentCount: number): string {
  if (text.trim()) return deriveThreadTitleFromPrompt(text);
  return attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`;
}

function currentLocalRef(refs: ReadonlyArray<VcsRef>): VcsRef | undefined {
  return refs.find((ref) => !ref.isRemote && ref.current);
}

export function branchWorktreePath(
  mode: WorkspaceMode,
  rootCwd: string,
  path: string | null | undefined,
): string | null {
  return mode === "worktree" || !path || path === rootCwd ? null : path;
}

/**
 * What the draft starts in: its own pick, else the project's default mode, with the branch
 * derived from refs rather than written back, so a late ref list or t3.json default still wins.
 */
export function resolveWorkspace(input: {
  pick: WorkspacePick | null;
  canChoose: boolean;
  defaults: ProjectDefaults;
  refs: RefsFacts;
  rootCwd: string;
}): ResolvedWorkspace {
  const pick = input.canChoose ? input.pick : null;
  const isRepo = input.refs.isRepo ?? true;
  const startFromOrigin = isRepo && (pick?.startFromOrigin ?? input.defaults.startFromOrigin);
  if (!isRepo) return { mode: "local", branch: null, worktreePath: null, startFromOrigin: false };
  const mode = pick?.mode ?? input.defaults.mode;
  const resolved = {
    mode,
    branch: pick?.branch ?? null,
    worktreePath: pick?.worktreePath ?? null,
    startFromOrigin,
  };
  if (resolved.branch !== null) return resolved;
  if (mode === "worktree") {
    const base =
      input.refs.refs.find((ref) => ref.isDefault) ?? currentLocalRef(input.refs.refs) ?? null;
    return (pick !== null || input.defaults.settled) && base
      ? { ...resolved, branch: base.name, worktreePath: null }
      : resolved;
  }
  if (!pick?.followsCurrentCheckout) return resolved;
  const current = currentLocalRef(input.refs.refs);
  return current
    ? {
        ...resolved,
        branch: current.name,
        worktreePath: branchWorktreePath("local", input.rootCwd, current.worktreePath),
      }
    : resolved;
}

export function workspaceLabel(
  mode: WorkspaceMode,
  worktreePath: string | null,
): "Current checkout" | "Current worktree" | "New worktree" {
  if (mode === "worktree") return "New worktree";
  return worktreePath ? "Current worktree" : "Current checkout";
}

export function branchLabel(input: {
  branch: string | null;
  startFromOrigin: boolean;
  mode: WorkspaceMode;
}): string {
  if (!input.branch) return "Choose branch";
  if (input.mode === "local") return input.branch;
  return input.startFromOrigin ? `From ${input.branch} (remote)` : `From ${input.branch}`;
}

export function branchBadge(ref: VcsRef, rootCwd: string): "CURRENT" | "WORKTREE" | "REMOTE" | "DEFAULT" | "" {
  if (ref.current) return "CURRENT";
  if (ref.worktreePath && ref.worktreePath !== rootCwd) return "WORKTREE";
  if (ref.isRemote) return "REMOTE";
  if (ref.isDefault) return "DEFAULT";
  return "";
}

export function shouldCheckout(mode: WorkspaceMode, ref: Pick<VcsRef, "current" | "worktreePath">) {
  return mode === "local" && !ref.current && !ref.worktreePath;
}

export function sanitizeRefQuery(raw: string): string {
  return raw.trim().replace(/[ \t\n\r\f\v]+/g, "-");
}

export type EnvironmentPhase =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "error"
  | "unsupported"
  | "available";

export function environmentPresentation(status: string): {
  phase: EnvironmentPhase;
  statusText: string;
} {
  switch (status) {
    case "Connected":
      return { phase: "connected", statusText: "Connected" };
    case "Connecting":
      return { phase: "connecting", statusText: "Connecting..." };
    case "Reconnecting":
      return { phase: "reconnecting", statusText: "Reconnecting..." };
    case "Disconnected":
    case "Off":
    case "Pairing required":
      return { phase: "offline", statusText: "Offline" };
    default:
      return { phase: "error", statusText: "Connection failed" };
  }
}

export interface NewTaskFacts {
  key: string;
  ready: boolean;
  stamp: TaskStamp | null;
  text: string;
  attachments: number;
  submitting: boolean;
  project: {
    title: string;
    label: string;
    workspaceRoot: string;
    isScratch: boolean;
  } | null;
  defaults: ProjectDefaults;
  environment: { id: string; label: string; machineSymbol: string; status: string } | null;
  refs: RefsFacts;
  modelResolved: boolean;
  viewportShort: boolean;
  canReadFiles: boolean;
  cloneBlocked: boolean;
}

export type NewTaskPhase = "loading" | "missing" | "needsProject" | "noModel" | "ready";

export interface NewTaskView {
  key: string;
  phase: NewTaskPhase;
  environmentId: string;
  projectId: string;
  rootCwd: string;
  cwd: string;
  isScratch: boolean;
  heroKind: "project" | "scratch" | "hidden";
  question: string;
  projectLabel: string;
  environmentLabel: string;
  environmentSymbol: string;
  environmentOnline: boolean;
  environmentA11y: string;
  contextVisible: boolean;
  workspaceVisible: boolean;
  workspaceLabel: string;
  workspaceIcon: "folder" | "folder-branch";
  workspaceDisabled: boolean;
  workspaceHint: string;
  workspaceNext: WorkspaceMode;
  branchVisible: boolean;
  branchLabel: string;
  branchA11y: string;
  branchDisabled: boolean;
  branchPickerTitle: "Branch" | "Base branch";
  sendBlockedReason: string;
  placeholder: string;
  canReadFiles: boolean;
  mode: WorkspaceMode;
  branch: string;
  worktreePath: string;
  startFromOrigin: boolean;
  currentBranch: string;
  isRepo: boolean;
}

const emptyView = (key: string, phase: NewTaskPhase): NewTaskView => ({
  key,
  phase,
  environmentId: "",
  projectId: "",
  rootCwd: "",
  cwd: "",
  isScratch: false,
  heroKind: "hidden",
  question: "",
  projectLabel: "",
  environmentLabel: "",
  environmentSymbol: "",
  environmentOnline: false,
  environmentA11y: "",
  contextVisible: false,
  workspaceVisible: false,
  workspaceLabel: "",
  workspaceIcon: "folder",
  workspaceDisabled: true,
  workspaceHint: "",
  workspaceNext: "local",
  branchVisible: false,
  branchLabel: "",
  branchA11y: "",
  branchDisabled: true,
  branchPickerTitle: "Branch",
  sendBlockedReason: "",
  placeholder: "Ask anything",
  canReadFiles: false,
  mode: "local",
  branch: "",
  worktreePath: "",
  startFromOrigin: false,
  currentBranch: "",
  isRepo: false,
});

export function presentNewTask(facts: NewTaskFacts): NewTaskView {
  if (!facts.key) return emptyView("", "loading");
  if (!facts.ready) return emptyView(facts.key, "loading");
  const stamp = facts.stamp;
  if (!stamp || !stamp.projectId) return emptyView(facts.key, "needsProject");
  if (!facts.project) return emptyView(facts.key, "missing");
  const project = facts.project;
  const environment = facts.environment;
  const online = environment?.status === "Connected";
  const environmentLabel = environment?.label || "Environment";
  const base = {
    ...emptyView(facts.key, facts.modelResolved ? "ready" : "noModel"),
    environmentId: stamp.environmentId,
    projectId: stamp.projectId,
    rootCwd: project.workspaceRoot,
    isScratch: project.isScratch,
    projectLabel: project.isScratch ? "No project" : project.label || project.title,
    environmentLabel,
    environmentSymbol: environment?.machineSymbol || "server.rack",
    environmentOnline: online,
    environmentA11y: `Choose environment, ${environmentLabel}, ${online ? "Connected" : "Offline"}`,
    canReadFiles: facts.canReadFiles,
  };
  const resolved = resolveWorkspace({
    pick: stamp.workspace,
    canChoose: !project.isScratch,
    defaults: facts.defaults,
    refs: facts.refs,
    rootCwd: project.workspaceRoot,
  });
  const isRepoKnown = facts.refs.isRepo !== null;
  const isRepo = facts.refs.isRepo ?? true;
  const current = currentLocalRef(facts.refs.refs);
  const shownBranch =
    resolved.branch ??
    (resolved.mode === "worktree"
      ? (current?.name ??
        facts.refs.refs.find((ref) => ref.isDefault)?.name ??
        null)
      : (current?.name ?? null));
  const locked = facts.submitting;
  const label = workspaceLabel(resolved.mode, resolved.worktreePath);
  const loadingBranches = online && facts.refs.loading && facts.refs.refs.length === 0;
  const branchText = loadingBranches
    ? "Loading branches…"
    : branchLabel({
        branch: shownBranch,
        startFromOrigin: resolved.startFromOrigin,
        mode: resolved.mode,
      });
  const sendBlockedReason = facts.cloneBlocked
    ? "Wait for the project clone to finish."
    : facts.submitting
      ? "Starting the thread…"
      : resolved.mode === "worktree" && (!resolved.branch || !isRepoKnown)
        ? "Choose a base branch before creating a worktree."
        : "";
  return {
    ...base,
    cwd:
      resolved.mode === "worktree"
        ? project.workspaceRoot
        : (resolved.worktreePath ?? project.workspaceRoot),
    heroKind: facts.viewportShort ? "hidden" : project.isScratch ? "scratch" : "project",
    question: project.isScratch ? "What should we work on?" : "What should we build",
    contextVisible: facts.viewportShort,
    workspaceVisible: !project.isScratch,
    workspaceLabel: label,
    workspaceIcon: label === "Current checkout" ? "folder" : "folder-branch",
    workspaceDisabled: locked || (isRepoKnown && !isRepo),
    workspaceHint:
      resolved.mode === "worktree" ? "Switches to the current checkout" : "Switches to a new worktree",
    workspaceNext: resolved.mode === "worktree" ? "local" : "worktree",
    branchVisible: !project.isScratch,
    branchLabel: branchText,
    branchA11y: `${resolved.mode === "worktree" ? "Base branch" : "Branch"}: ${branchText}`,
    branchDisabled: locked || (isRepoKnown && !isRepo),
    branchPickerTitle: resolved.mode === "worktree" ? "Base branch" : "Branch",
    sendBlockedReason,
    mode: resolved.mode,
    branch: resolved.branch ?? "",
    worktreePath: resolved.worktreePath ?? "",
    startFromOrigin: resolved.startFromOrigin,
    currentBranch: current?.name ?? "",
    isRepo,
  };
}

/** Keeps text, attachments, model and runtime; a new project drops the workspace pick. */
export function retargetStamp(
  stamp: TaskStamp | null,
  environmentId: string,
  projectId: string,
  nowIso: string,
): TaskStamp {
  return {
    environmentId,
    projectId,
    createdAt: stamp?.createdAt || nowIso,
    cloning: false,
    workspace: stamp && stamp.projectId === projectId ? stamp.workspace : null,
  };
}

export interface LaunchPlan {
  threadId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  runtimeMode: string;
  interactionMode: string;
  strategy: "root" | "existing_worktree" | "worktree";
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  startFromOrigin: boolean;
}

export function planLaunch(
  input: {
    text: string;
    attachments: ReadonlyArray<{ type: string; name: string }>;
    mode: WorkspaceMode;
    branch: string | null;
    worktreePath: string | null;
    startFromOrigin: boolean;
    currentCheckoutBranch: string | null;
    projectId: string;
    projectTitle: string;
    runtimeMode: string;
  },
  ids: { threadId: string; branchHex8: string },
): { ok: true; plan: LaunchPlan } | { ok: false; error: string } {
  const title = deriveThreadTitleSeed(input.text, input.attachments);
  const common = {
    threadId: ids.threadId,
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    title,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
  };
  if (input.mode === "worktree") {
    if (!input.branch)
      return { ok: false, error: "Choose a base branch before creating a worktree." };
    return {
      ok: true,
      plan: {
        ...common,
        strategy: "worktree",
        branch: `t3/${ids.branchHex8}`,
        baseRef: input.branch,
        worktreePath: null,
        startFromOrigin: input.startFromOrigin,
      },
    };
  }
  const branch = input.branch ?? input.currentCheckoutBranch;
  if (input.worktreePath)
    return {
      ok: true,
      plan: {
        ...common,
        strategy: "existing_worktree",
        branch,
        baseRef: null,
        worktreePath: input.worktreePath,
        startFromOrigin: false,
      },
    };
  return {
    ok: true,
    plan: {
      ...common,
      strategy: "root",
      branch,
      baseRef: null,
      worktreePath: null,
      startFromOrigin: false,
    },
  };
}

export function launchWorkspaceStrategy(plan: LaunchPlan): Record<string, unknown> {
  if (plan.strategy === "worktree")
    return {
      type: "worktree",
      baseRef: plan.baseRef,
      branch: plan.branch,
      ...(plan.startFromOrigin ? { startFromOrigin: true } : {}),
    };
  if (plan.strategy === "existing_worktree")
    return {
      type: "existing_worktree",
      worktreePath: plan.worktreePath,
      ...(plan.branch ? { branch: plan.branch } : {}),
    };
  return { type: "root", ...(plan.branch ? { branch: plan.branch } : {}) };
}

export interface ChoiceProject {
  id: string;
  environmentId: string;
  title: string;
  workspaceRoot: string;
  isScratch: boolean;
  pinned: boolean;
  updatedAt: number;
  repositoryKey: string;
  faviconUrl: string;
  monogram: string;
  monogramColor: string;
}

export interface ProjectScope {
  key: string;
  title: string;
  projects: ChoiceProject[];
  pinned: boolean;
}

export function projectScopes(
  projects: ReadonlyArray<ChoiceProject>,
  activityByProject: ReadonlyMap<string, number>,
): ProjectScope[] {
  const scopes = new Map<string, ProjectScope>();
  for (const project of projects) {
    const key = project.repositoryKey ? `repo:${project.repositoryKey}` : `project:${project.id}`;
    const scope = scopes.get(key);
    if (scope) {
      scope.projects.push(project);
      scope.pinned ||= project.pinned;
    } else scopes.set(key, { key, title: project.title, projects: [project], pinned: project.pinned });
  }
  const activity = (scope: ProjectScope) => {
    const threads = scope.projects
      .map((project) => activityByProject.get(project.id))
      .filter((value): value is number => value !== undefined);
    return threads.length ? Math.max(...threads) : Math.max(...scope.projects.map((p) => p.updatedAt));
  };
  return [...scopes.values()]
    .filter((scope) => scope.projects.some((project) => !project.isScratch))
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        activity(right) - activity(left) ||
        left.title.localeCompare(right.title) ||
        left.key.localeCompare(right.key),
    );
}

export function filterProjectScopes(scopes: ProjectScope[], searchText: string): ProjectScope[] {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

export function scopeTarget(
  scope: ProjectScope,
  preferredEnvironmentId: string,
  connected: ReadonlySet<string>,
): ChoiceProject {
  const rank = (project: ChoiceProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.projects[0] ? 1 : 2;
  const ordered = [...scope.projects].sort((left, right) => rank(left) - rank(right));
  return ordered.find((project) => connected.has(project.environmentId)) ?? ordered[0]!;
}

export function projectEmptyState(input: {
  environmentsLoaded: boolean;
  environments: ReadonlyArray<{ status: string; enabled: boolean }>;
  shellReady: boolean;
}): { title: string; detail: string; spinner: boolean; action: "" | "add-environment" | "add-project" } {
  if (!input.environmentsLoaded)
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      spinner: true,
      action: "",
    };
  const enabled = input.environments.filter((environment) => environment.enabled);
  if (enabled.length === 0)
    return {
      title: "No environments connected",
      detail: "Add an environment before creating a task.",
      spinner: false,
      action: "add-environment",
    };
  if (!input.shellReady) {
    const phases = enabled.map((environment) => environmentPresentation(environment.status).phase);
    if (phases.some((phase) => phase === "connecting" || phase === "reconnecting" || phase === "connected"))
      return {
        title: "Connecting to environment",
        detail: "Loading projects from the saved environment.",
        spinner: true,
        action: "",
      };
    return {
      title: "Environment unavailable",
      detail: "The saved environment is offline. Check the URL or start the environment, then retry.",
      spinner: false,
      action: "",
    };
  }
  return {
    title: "No projects found",
    detail: "The connected environment did not report any projects.",
    spinner: false,
    action: "add-project",
  };
}

/** The best copy of a project on another machine: repository, then folder name, then title. */
type ProjectKey = { title: string; workspaceRoot: string; repositoryKey: string };

export function matchEnvironmentProject<T extends ProjectKey>(
  source: ProjectKey | null,
  candidates: ReadonlyArray<T>,
): T | null {
  if (!candidates.length) return null;
  if (!source) return candidates[0]!;
  const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  return (
    (source.repositoryKey && candidates.find((item) => item.repositoryKey === source.repositoryKey)) ||
    candidates.find((item) => basename(item.workspaceRoot) === basename(source.workspaceRoot)) ||
    candidates.find((item) => item.title.toLowerCase() === source.title.toLowerCase()) ||
    candidates[0]!
  );
}

/** Draft pick, then project default, then the last model chosen anywhere, then the default model. */
export function defaultModelSelection(
  config: Record<string, unknown>,
  projectDefault: unknown,
  sticky: ModelSelection | null,
): ModelSelection | null {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const providers = (Array.isArray(config.providers) ? config.providers : [])
    .map(record)
    .filter(
      (provider) =>
        provider.enabled !== false &&
        provider.installed !== false &&
        record(provider.auth).status !== "unauthenticated" &&
        provider.availability !== "unavailable",
    );
  const available = (selection: unknown): ModelSelection | null => {
    const value = record(selection);
    if (typeof value.instanceId !== "string" || typeof value.model !== "string") return null;
    return providers.some(
      (provider) =>
        provider.instanceId === value.instanceId &&
        (Array.isArray(provider.models) ? provider.models : [])
          .map(record)
          .some((model) => model.slug === value.model && model.isLegacy !== true),
    )
      ? (value as unknown as ModelSelection)
      : null;
  };
  const settings = record(config.settings);
  const preferred =
    available(projectDefault) ?? available(sticky) ?? available(settings.defaultModelSelection);
  if (preferred) return preferred;
  const models = providers.flatMap((provider) =>
    (Array.isArray(provider.models) ? provider.models : [])
      .map(record)
      .filter((model) => model.isLegacy !== true)
      .map((model) => ({
        instanceId: String(provider.instanceId),
        model: String(model.slug),
        isDefault: model.isDefault === true,
      })),
  );
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model } : null;
}

export interface HomeDraftInput {
  id: string;
  text: string;
  attachments: number;
  stamp: TaskStamp | null;
  launchState: string;
  launchThreadId: string;
  launchBranch: string;
}

export interface HomeDraftRow {
  key: string;
  kind: "draft" | "unsent";
  title: string;
  threadId: string;
  environmentId: string;
  projectId: string;
  branch: string;
  createdAt: string;
}

export function homeDraftRows(
  drafts: ReadonlyArray<HomeDraftInput>,
  branchFor: (draft: HomeDraftInput) => string,
): HomeDraftRow[] {
  const rows: HomeDraftRow[] = [];
  for (const draft of drafts) {
    if (!isDraftKey(draft.id) || !draft.stamp?.projectId) continue;
    if (draft.launchState === "unknown") {
      rows.push({
        key: draft.id,
        kind: "unsent",
        title: deriveThreadTitleFromPrompt(draft.text),
        threadId: draft.launchThreadId,
        environmentId: draft.stamp.environmentId,
        projectId: draft.stamp.projectId,
        branch: draft.launchBranch,
        createdAt: draft.stamp.createdAt,
      });
    } else if (
      (draft.launchState === "" || draft.launchState === "rejected") &&
      (draft.text.trim() || draft.attachments > 0)
    ) {
      rows.push({
        key: draft.id,
        kind: "draft",
        title: draftRowTitle(draft.text, draft.attachments),
        threadId: "",
        environmentId: draft.stamp.environmentId,
        projectId: draft.stamp.projectId,
        branch: branchFor(draft),
        createdAt: draft.stamp.createdAt,
      });
    }
  }
  return rows.sort(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === "draft" ? -1 : 1) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.key.localeCompare(right.key),
  );
}

// DM Sans advance widths per mille of the em for " " through "~", then "…" (tools/font-widths.ts).
const DM_SANS_WIDTHS = [
  266, 250, 291, 804, 580, 786, 734, 159, 373, 373, 480, 550, 182, 541, 198, 392, 684, 312, 576, 591,
  607, 610, 628, 534, 608, 628, 202, 227, 550, 550, 550, 524, 1005, 664, 603, 717, 688, 565, 535, 758,
  681, 234, 501, 584, 527, 841, 691, 774, 580, 774, 594, 580, 561, 655, 669, 968, 603, 580, 541, 314,
  392, 314, 622, 660, 213, 544, 626, 572, 627, 568, 340, 558, 575, 240, 243, 504, 223, 891, 574, 593,
  626, 627, 370, 502, 392, 573, 527, 763, 496, 556, 458, 427, 234, 427, 550, 566,
];

function textWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    total += character === "…" ? DM_SANS_WIDTHS[95]! : (DM_SANS_WIDTHS[code - 32] ?? 600);
  }
  return (total * fontSize) / 1000;
}

/** UIKit's middle truncation, which Exact's text lacks: equal widths kept on both sides. */
export function middleEllipsis(text: string, budget: number, fontSize = 13): string {
  if (textWidth(text, fontSize) <= budget) return text;
  const characters = Array.from(text);
  const target = budget - textWidth("…", fontSize);
  let head = 0;
  let headWidth = 0;
  while (head < characters.length) {
    const next = textWidth(characters[head]!, fontSize);
    if (headWidth + next > target / 2) break;
    headWidth += next;
    head++;
  }
  let tail = 0;
  let tailWidth = 0;
  while (tail < characters.length - head) {
    const next = textWidth(characters[characters.length - 1 - tail]!, fontSize);
    if (tailWidth + next > target - headWidth) break;
    tailWidth += next;
    tail++;
  }
  return `${characters.slice(0, head).join("")}…${characters.slice(characters.length - tail).join("")}`;
}
