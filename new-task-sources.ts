import type { NativeModule, Result, Sources, Storage } from "./app.contract.d.ts";
import type { ComposerSettings } from "./composer-settings";
import { type DirectSession, object, scopedThreadId, string, threadIdentity } from "./connection";
import { draftClone } from "./add-project-sources";
import { saveModelDrafts } from "./model-drafts";
import {
  environmentPresentation,
  filterProjectScopes,
  homeDraftRows,
  isDraftKey,
  matchEnvironmentProject,
  middleEllipsis,
  mintDraftKey,
  presentNewTask,
  projectEmptyState,
  projectScopes,
  resolveWorkspace,
  retargetStamp,
  scopeTarget,
  type ChoiceProject,
  type RefsFacts,
  type TaskStamp,
  type VcsRef,
  type WorkspaceMode,
} from "./new-task";
import { RefPager, branchRows, checkoutNewTaskBranch, type VcsPort, type VcsRefPage } from "./new-task-git";
import { loadTaskPrefs, saveTaskPrefs, type TaskPrefs } from "./new-task-prefs";

type ThreadDraft = Parameters<Sources["presentNewTask"]>[0][1];
type Project = Parameters<Sources["presentNewTask"]>[0][2][number];
type Environment = Parameters<Sources["presentNewTask"]>[0][3][number];

export interface NewTaskBoundary {
  sessionFor(environmentId: string): DirectSession;
  sessions(): DirectSession[];
  sync(native: NativeModule): void;
  awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T>;
  composerSettings: ComposerSettings;
}

const PROJECT_SUBTITLE_WIDTH = 274;

function parseRef(value: unknown): VcsRef {
  const ref = object(value);
  return {
    name: string(ref.name),
    isRemote: ref.isRemote === true,
    remoteName: string(ref.remoteName),
    upstreamRef: string(ref.upstreamRef),
    current: ref.current === true,
    isDefault: ref.isDefault === true,
    worktreePath: string(ref.worktreePath) || null,
  };
}

function parseRefPage(value: unknown): VcsRefPage {
  const result = object(value);
  return {
    refs: (Array.isArray(result.refs) ? result.refs : []).map(parseRef),
    isRepo: result.isRepo !== false,
    isAtRepositoryRoot:
      typeof result.isAtRepositoryRoot === "boolean" ? result.isAtRepositoryRoot : undefined,
    nextCursor: typeof result.nextCursor === "number" ? result.nextCursor : null,
  };
}

export function vcsPort(session: DirectSession): VcsPort {
  return {
    listRefs: async (cwd, options) => parseRefPage(await session.listRefsAt(cwd, options)),
    switchRef: async (cwd, refName) => {
      const result = await session.switchRefAt(cwd, refName);
      return { refName: string(result.refName) || null };
    },
  };
}

function stampOf(draft: ThreadDraft): TaskStamp | null {
  const task = draft.task;
  if (!task) return null;
  return {
    ...task,
    workspace: task.workspace
      ? { ...task.workspace, mode: task.workspace.mode === "worktree" ? "worktree" : "local" }
      : null,
  };
}

function rawId(scoped: string): string {
  return threadIdentity(scoped).threadId;
}

function choiceProject(project: Project): ChoiceProject {
  return { ...project };
}

export function newTaskSources(boundary: NewTaskBoundary): Pick<
  Sources,
  | "presentNewTask"
  | "loadProjectChoices"
  | "loadEnvironmentChoices"
  | "loadBranchChoices"
  | "loadHomeDrafts"
  | "startNewTask"
  | "rememberTaskProject"
  | "startScratchTask"
  | "switchTaskEnvironment"
  | "checkoutTaskBranch"
  | "forgetTaskSettings"
> & {
  draftHost(id: string, environmentId: string, projectId: string): ReturnType<DirectSession["draftSettings"]>;
  rememberStickyModel(storage: Storage, id: string): Promise<void>;
  refreshAfterCheckout(environmentId: string, cwd: string): void;
} {
  const pager = new RefPager();
  const projectFiles = new Map<string, { settled: boolean; value: Record<string, unknown> | null }>();
  const branchRetries = new Map<string, number>();
  let prefs: TaskPrefs = { lastProject: null, stickyModel: null };
  let prefsLoad: Promise<TaskPrefs> | undefined;
  const loadPrefs = async (storage: Storage) => {
    prefsLoad ??= loadTaskPrefs(storage).then((value) => (prefs = value));
    return prefsLoad;
  };
  const writePrefs = async (storage: Storage, next: TaskPrefs) => {
    await loadPrefs(storage);
    prefs = next;
    await saveTaskPrefs(storage, next);
  };
  const session = (environmentId: string): DirectSession | null => {
    try {
      return boundary.sessionFor(environmentId);
    } catch {
      return null;
    }
  };
  const watch = (native?: NativeModule | null) => {
    native?.watch("connections");
    if (native?.available) boundary.sync(native);
  };
  const connected = (environments: ReadonlyArray<Environment>, id: string) =>
    environments.some((environment) => environment.id === id && environment.status === "Connected");

  async function refsFor(
    environmentId: string,
    cwd: string,
    online: boolean,
    native?: NativeModule | null,
  ): Promise<RefsFacts> {
    const target = session(environmentId);
    if (!target || !cwd || !online) {
      const cached = pager.cached(environmentId, cwd);
      return cached
        ? { loading: false, isRepo: cached.isRepo, refs: cached.refs }
        : { loading: online, isRepo: null, refs: [] };
    }
    const result = await boundary.awaitReply(pager.load(vcsPort(target), environmentId, cwd, "", 1), native);
    return result.error
      ? { loading: false, isRepo: null, refs: [] }
      : { loading: false, isRepo: result.isRepo, refs: result.refs };
  }

  async function projectFile(environmentId: string, cwd: string, online: boolean, native?: NativeModule | null) {
    const key = JSON.stringify([environmentId, cwd]);
    const cached = projectFiles.get(key);
    if (cached?.settled) return cached;
    const target = session(environmentId);
    if (!target || !online || !cwd) return { settled: false, value: null };
    const entry = { settled: true, value: null as Record<string, unknown> | null };
    try {
      entry.value = await boundary.awaitReply(target.readProjectFile(cwd, "t3.json"), native);
    } catch {}
    projectFiles.set(key, entry);
    return entry;
  }

  function draftHost(id: string, environmentId: string, projectId: string) {
    const target = boundary.sessionFor(environmentId);
    return target.draftSettings(projectId ? rawId(projectId) : "", prefs.stickyModel);
  }

  return {
    draftHost,
    refreshAfterCheckout: (environmentId, cwd) => pager.invalidate(environmentId, cwd),
    async rememberStickyModel(storage, id) {
      const pick = boundary.composerSettings.selection(id)?.modelSelection;
      if (!pick) return;
      await loadPrefs(storage);
      await writePrefs(storage, { ...prefs, stickyModel: pick });
    },

    presentNewTask: async (
      [key, draft, projects, environments, _revision, viewportShort, submitting],
      _store,
      storage,
      native,
    ) => {
      watch(native);
      await loadPrefs(storage);
      const stamp = key ? stampOf(draft) : null;
      const base = {
        key,
        ready: draft.id === key,
        stamp,
        text: draft.text,
        attachments: draft.attachments.length,
        submitting,
        project: null,
        defaults: { mode: "local" as WorkspaceMode, settled: false, startFromOrigin: true },
        environment: null,
        refs: { loading: false, isRepo: null, refs: [] },
        modelResolved: true,
        viewportShort,
        canReadFiles: true,
        cloneBlocked: false,
      };
      if (!key || !stamp?.projectId) return presentNewTask(base);
      const environment = environments.find((entry) => entry.id === stamp.environmentId) ?? null;
      const online = connected(environments, stamp.environmentId);
      const target = session(stamp.environmentId);
      const project = projects.find((entry) => entry.id === stamp.projectId) ?? null;
      if (!project && !(target?.shellReady() ?? false)) return presentNewTask({ ...base, ready: false });
      if (!project) return presentNewTask({ ...base, environment });
      const [refs, file] = await Promise.all([
        refsFor(stamp.environmentId, project.workspaceRoot, online, native),
        projectFile(stamp.environmentId, project.workspaceRoot, online, native),
      ]);
      const defaults = target?.taskDefaults(rawId(project.id), file.value) ?? { mode: "local" as const, startFromOrigin: true };
      const clone = draftClone(online ? target : null, stamp.projectId, stamp.cloning && stamp.projectId === project.id);
      let modelResolved = true;
      try {
        modelResolved = !target?.configLoaded() || draftHost(key, stamp.environmentId, stamp.projectId).resolved;
      } catch {}
      return presentNewTask({
        ...base,
        project: {
          title: project.title,
          label: project.title,
          workspaceRoot: project.workspaceRoot,
          isScratch: project.isScratch,
        },
        defaults: { ...defaults, settled: file.settled },
        environment,
        refs,
        modelResolved,
        cloneBlocked: clone.blocksStart,
        cloneBanner: clone.banner,
      });
    },

    loadProjectChoices: async ([key, draft, projects, environments, environmentsLoaded, query], _store, _storage, native) => {
      watch(native);
      const empty = {
        key,
        hasReadyEnvironment: false,
        scratchVisible: false,
        scratchEnabled: false,
        scratchEnvironmentId: "",
        emptyTitle: "",
        emptyDetail: "",
        emptySpinner: false,
        emptyAction: "",
        noMatch: false,
        items: [],
      };
      if (!key) return empty;
      const stamp = stampOf(draft);
      const preferred = stamp?.environmentId ?? "";
      const online = new Set(environments.filter((entry) => entry.status === "Connected").map((entry) => entry.id));
      const activity = new Map<string, number>();
      for (const live of boundary.sessions())
        for (const [id, at] of live.activityByProject()) activity.set(id, at);
      const scopes = projectScopes(projects.map(choiceProject), activity);
      const shown = filterProjectScopes(scopes, query);
      const offering = environments
        .filter((entry) => session(entry.id)?.scratchReady() === true)
        .sort(
          (left, right) =>
            Number(online.has(right.id)) - Number(online.has(left.id)) ||
            Number(right.id === preferred) - Number(left.id === preferred),
        );
      const scratch = offering[0];
      const shellReady = boundary.sessions().some((entry) => entry.shellReady());
      const emptyState =
        scopes.length === 0
          ? projectEmptyState({ environmentsLoaded, environments, shellReady })
          : { title: "", detail: "", spinner: false, action: "" as const };
      return {
        ...empty,
        hasReadyEnvironment: online.size > 0,
        scratchVisible: scratch !== undefined,
        scratchEnabled: scratch !== undefined && online.has(scratch.id),
        scratchEnvironmentId: scratch?.id ?? "",
        emptyTitle: emptyState.title,
        emptyDetail: emptyState.detail,
        emptySpinner: emptyState.spinner,
        emptyAction: emptyState.action,
        noMatch: scopes.length > 0 && shown.length === 0,
        items: shown.map((scope) => {
          const target = scopeTarget(scope, preferred, online);
          return {
            key: scope.key,
            environmentId: target.environmentId,
            projectId: target.id,
            title: scope.title,
            subtitle:
              scope.projects.length > 1
                ? `${scope.projects.length} workspaces`
                : middleEllipsis(target.workspaceRoot, PROJECT_SUBTITLE_WIDTH),
            faviconUrl: target.faviconUrl,
            monogram: target.monogram,
            monogramColor: target.monogramColor,
          };
        }),
      };
    },

    loadEnvironmentChoices: ([key, draft, projects, environments], _store, _storage, native) => {
      watch(native);
      const stamp = key ? stampOf(draft) : null;
      if (!stamp) return [];
      const current = projects.find((entry) => entry.id === stamp.projectId) ?? null;
      const eligible = environments.filter((environment) => {
        if (environment.id === stamp.environmentId) return true;
        if (!environment.enabled) return false;
        if (current?.isScratch)
          return environment.status === "Connected" && session(environment.id)?.scratchReady() === true;
        const candidates = projects.filter((entry) => entry.environmentId === environment.id && !entry.isScratch);
        return current !== null && candidates.length > 0 && matchEnvironmentProject(current, candidates) !== null &&
          candidates.some(
            (entry) =>
              (current.repositoryKey && entry.repositoryKey === current.repositoryKey) ||
              entry.workspaceRoot.split("/").at(-1) === current.workspaceRoot.split("/").at(-1) ||
              entry.title.toLowerCase() === current.title.toLowerCase(),
          );
      });
      return eligible.map((environment) => {
        const presentation = environmentPresentation(environment.status);
        return {
          id: environment.id,
          label: environment.label,
          machineSymbol: environment.machineSymbol || "server.rack",
          phase: presentation.phase,
          statusText: presentation.statusText,
          selected: environment.id === stamp.environmentId,
        };
      });
    },

    loadBranchChoices: async ([key, environmentId, cwd, selected, query, pages, retry], _store, _storage, native) => {
      watch(native);
      const empty = { key, rows: [], hasMore: false, error: "", message: "" };
      if (!key || !cwd) return empty;
      const target = session(environmentId);
      if (!target) return { ...empty, error: "This environment is disconnected." };
      const retryKey = JSON.stringify([environmentId, cwd]);
      if ((branchRetries.get(retryKey) ?? retry) !== retry) pager.invalidate(environmentId, cwd);
      branchRetries.set(retryKey, retry);
      const result = await boundary.awaitReply(
        pager.load(vcsPort(target), environmentId, cwd, query, pages),
        native,
      );
      const rows = branchRows(result.refs, cwd, selected);
      return {
        key,
        rows,
        hasMore: result.hasMore,
        error: result.error,
        message: rows.length ? "" : query.trim() ? "No matching branches" : "No branches available",
      };
    },

    loadHomeDrafts: async ([drafts, projects, environments], _store, _storage, native) => {
      watch(native);
      const inputs = drafts.map((draft) => {
        const launch = draft.pendingSend?.launch ?? null;
        return {
          id: draft.id,
          text: draft.text,
          attachments: draft.attachments.length,
          stamp: stampOf(draft),
          launchState: launch ? draft.pendingSend!.state : "",
          launchThreadId: launch?.threadId ?? "",
          launchBranch: launch?.branch ?? "",
        };
      });
      const branches = new Map<string, string>();
      for (const input of inputs) {
        const stamp = input.stamp;
        if (!stamp?.projectId || input.launchState === "unknown") continue;
        const project = projects.find((entry) => entry.id === stamp.projectId);
        if (!project) continue;
        const online = connected(environments, stamp.environmentId);
        const refs = await refsFor(stamp.environmentId, project.workspaceRoot, online, native).catch(
          (): RefsFacts => ({ loading: false, isRepo: null, refs: [] }),
        );
        const file = projectFiles.get(JSON.stringify([stamp.environmentId, project.workspaceRoot]));
        const defaults = session(stamp.environmentId)?.taskDefaults(rawId(project.id), file?.value ?? null) ?? {
          mode: "local" as const,
          startFromOrigin: true,
        };
        const resolved = resolveWorkspace({
          pick: stamp.workspace,
          canChoose: !project.isScratch,
          defaults: { ...defaults, settled: file?.settled ?? false },
          refs,
          rootCwd: project.workspaceRoot,
        });
        branches.set(
          input.id,
          resolved.branch ?? (resolved.mode === "local" ? (refs.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? "") : ""),
        );
      }
      return homeDraftRows(inputs, (input) => branches.get(input.id) ?? "").map((row) => {
        const project = projects.find((entry) => entry.id === row.projectId);
        const environment = environments.find((entry) => entry.id === row.environmentId);
        return {
          key: row.key,
          kind: row.kind,
          title: row.title,
          threadId: row.threadId,
          branch: row.branch,
          environmentLabel: environment?.label ?? "",
          machineSymbol: environment?.machineSymbol || "server.rack",
          faviconUrl: project?.faviconUrl ?? "",
          monogram: project?.monogram ?? "",
          monogramColor: project?.monogramColor ?? "",
        };
      });
    },

    startNewTask: async ([currentId, nowMs], _store, storage) => {
      await loadPrefs(storage);
      let projectId = "";
      let environmentId = "";
      if (currentId && !isDraftKey(currentId)) {
        try {
          const identity = threadIdentity(currentId);
          const raw = boundary.sessionFor(identity.environmentId).threadProjectId(identity.threadId);
          if (raw && boundary.sessionFor(identity.environmentId).task(raw)) {
            projectId = scopedThreadId(identity.environmentId, raw);
            environmentId = identity.environmentId;
          }
        } catch {}
      }
      if (!projectId && prefs.lastProject) {
        const { environmentId: lastEnvironment, projectId: lastProject } = prefs.lastProject;
        const raw = lastProject ? rawId(lastProject) : "";
        if (raw && session(lastEnvironment)?.task(raw)) {
          projectId = lastProject;
          environmentId = lastEnvironment;
        }
      }
      const random = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const key = mintDraftKey(nowMs, random);
      return {
        ok: true,
        error: "",
        key,
        draft: {
          id: key,
          text: "",
          revision: 1,
          attachments: [],
          pendingSend: null,
          task: {
            environmentId,
            projectId,
            createdAt: new Date(nowMs).toISOString(),
            cloning: false,
            workspace: null,
          },
        },
      };
    },

    rememberTaskProject: async ([environmentId, projectId], _store, storage) => {
      try {
        const project = projectId ? session(environmentId)?.task(rawId(projectId)) : null;
        if (!project || project.isScratch) return { ok: true, error: "" };
        await writePrefs(storage, { ...prefs, lastProject: { environmentId, projectId } });
        return { ok: true, error: "" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "The project could not be remembered." };
      }
    },

    startScratchTask: async ([draft, environmentId], _store, _storage, native) => {
      try {
        const target = boundary.sessionFor(environmentId);
        const raw = await boundary.awaitReply(target.ensureScratch(), native);
        await boundary.awaitReply(target.waitForProject(raw, 10000), native);
        return {
          ok: true,
          error: "",
          alertTitle: "",
          draft: {
            ...draft,
            revision: draft.revision + 1,
            task: retargetStamp(stampOf(draft), environmentId, scopedThreadId(environmentId, raw), draft.task?.createdAt ?? ""),
          },
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : "The folder for threads without a project could not be created.",
          alertTitle: "Could not start without a project",
          draft,
        };
      }
    },

    switchTaskEnvironment: async ([draft, environmentId], _store, _storage, native) => {
      const stamp = stampOf(draft);
      try {
        const target = boundary.sessionFor(environmentId);
        const source = stamp?.projectId ? session(stamp.environmentId)?.task(rawId(stamp.projectId)) : null;
        let projectId: string;
        if (source?.isScratch) {
          const raw = await boundary.awaitReply(target.ensureScratch(), native);
          await boundary.awaitReply(target.waitForProject(raw, 10000), native);
          projectId = scopedThreadId(environmentId, raw);
        } else {
          const candidates = target
            .projectList()
            .filter((entry) => !entry.isScratch)
            .map((entry) => ({ ...entry }));
          const match = matchEnvironmentProject(
            source ? { title: source.title, workspaceRoot: source.workspaceRoot, repositoryKey: source.repositoryKey } : null,
            candidates,
          );
          if (!match) throw new Error("This environment has no matching project.");
          projectId = match.id;
        }
        return {
          ok: true,
          error: "",
          alertTitle: "",
          draft: { ...draft, revision: draft.revision + 1, task: retargetStamp(stamp, environmentId, projectId, stamp?.createdAt ?? "") },
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : "The folder for threads without a project could not be created.",
          alertTitle: "Could not switch machine",
          draft,
        };
      }
    },

    checkoutTaskBranch: async ([key, environmentId, cwd, name, isRemote], _store, _storage, native) => {
      try {
        const target = boundary.sessionFor(environmentId);
        const ref: VcsRef = {
          name,
          isRemote,
          remoteName: isRemote ? (name.split("/")[0] ?? "") : "",
          upstreamRef: "",
          current: false,
          isDefault: false,
          worktreePath: null,
        };
        const result = await boundary.awaitReply(
          checkoutNewTaskBranch(vcsPort(target), { cwd, mode: "local", ref }),
          native,
        );
        pager.invalidate(environmentId, cwd);
        return result.ok
          ? { ok: true, error: "", key, branch: result.branch, worktreePath: result.worktreePath ?? "" }
          : { ok: false, error: result.error, key, branch: "", worktreePath: "" };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "The branch could not be checked out.",
          key,
          branch: "",
          worktreePath: "",
        };
      }
    },

    forgetTaskSettings: async ([key], _store, storage) => {
      boundary.composerSettings.forget(key);
      try {
        await saveModelDrafts(storage, boundary.composerSettings.snapshot());
        return { ok: true, error: "" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Model settings could not be saved." };
      }
    },
  };
}

export type ComposedReply = Result<"startNewTask">;
