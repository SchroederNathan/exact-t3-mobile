import type { NativeModule, Result, Sources, Store } from "./app.contract.d.ts";
import {
  CANCEL_CLONE_FAILED,
  NOT_REACHED_YET,
  PROJECT_ADDED_LATE,
  REMOVE_PROJECT_FAILED,
  RETRY_CLONE_FAILED,
  appAccessAlert,
  appAccessCheck,
  cloneDestinationPath,
  createdWithoutCommitAlert,
  destinationFromRepository,
  environmentOptions,
  errorMessage,
  localFolderPath,
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
  type AddProjectEnvironment,
  type CloneDestinationRequest,
  type ConnectionPhase,
  type ProjectCloneModel,
} from "./add-project";
import { type DirectSession, scopedThreadId, threadIdentity } from "./connection";
import { environmentPresentation, mintDraftKey } from "./new-task";
import {
  browseFilesystem,
  cancelProjectClone,
  checkAppAccess,
  createNewProject,
  createProject,
  deleteProject,
  discoverSourceControl,
  lookupRepository,
  publishRepository,
  retryProjectClone,
  startProjectClone,
  unarchiveProject,
  type BrowseOutcome,
  type SourceControlDiscovery,
} from "./project-rpc";

type Environment = Parameters<Sources["presentAddProject"]>[0][3][number];
type Reply = Result<"addLocalProject">;

export interface EnvironmentScopes {
  readonly operate: boolean;
  readonly sourceControlWrite: boolean;
  readonly filesystemRead: boolean;
  readonly error: string | null;
}

export interface AddProjectBoundary {
  sessionFor(environmentId: string): DirectSession;
  sync(native: NativeModule): void;
  awaitReply<T>(operation: Promise<T>, native?: NativeModule | null): Promise<T>;
  scopes(environmentId: string, store: Store): Promise<EnvironmentScopes>;
}

const PROJECT_WAIT_MS = 15000;
const BROWSE_TTL_MS = 5000;
const ADD_ROUTES = new Set(["addProject", "addProjectNew", "addProjectLocal", "addProjectRepository", "addProjectDestination"]);

const EMPTY_DRAFT: Reply["draft"] = { id: "", text: "", revision: 0, attachments: [], pendingSend: null, task: null };

const refused = (fields: Partial<Reply>): Reply => ({
  ok: false,
  error: "",
  alertTitle: "",
  alertBody: "",
  clearName: false,
  key: "",
  draft: EMPTY_DRAFT,
  environmentId: "",
  projectId: "",
  remoteUrl: "",
  publishCwd: "",
  publishProvider: "",
  publishLabel: "",
  publishRepository: "",
  ...fields,
});

function destination(request: CloneDestinationRequest): Result<"lookupAddRepository"> {
  const { remoteUrl, repositoryTitle, repositoryName } = request;
  return { ok: true, error: "", remoteUrl, repositoryTitle, repositoryName };
}

/** A new task draft for the project, as upstream's `selectDetail` opens one. */
function opened(
  environmentId: string,
  rawProjectId: string,
  cloning: boolean,
  nowMs: number,
  fields: Partial<Reply> = {},
): Reply {
  const key = mintDraftKey(nowMs, crypto.randomUUID().replace(/-/g, "").slice(0, 8));
  const projectId = scopedThreadId(environmentId, rawProjectId);
  return refused({
    ...fields,
    ok: true,
    key,
    environmentId,
    projectId,
    draft: {
      id: key,
      text: "",
      revision: 1,
      attachments: [],
      pendingSend: null,
      task: { environmentId, projectId, createdAt: new Date(nowMs).toISOString(), cloning, workspace: null },
    },
  });
}

function phaseOf(status: string): ConnectionPhase {
  const phase = environmentPresentation(status).phase;
  return phase === "connected" || phase === "connecting" || phase === "reconnecting" || phase === "offline"
    ? phase
    : "error";
}

/** The clone banner and send block for a draft's project, from the environment's clone stream. */
export function draftClone(session: DirectSession | null, projectId: string, awaitingClone: boolean): ProjectCloneModel {
  if (!session || !projectId) return { banner: null, blocksStart: false, blockReason: "" };
  return presentProjectClone({ clones: session.projectClones(), projectId: threadIdentity(projectId).threadId, awaitingClone });
}

/** The view shapes take mutable row lists. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer Item)[] ? Item[] : T[K] };
function copyRows<T extends object>(model: T): Mutable<T> {
  return Object.fromEntries(
    Object.entries(model).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as Mutable<T>;
}

export function addProjectSources(boundary: AddProjectBoundary): Pick<
  Sources,
  | "loadAddProjectFacts"
  | "presentAddProject"
  | "lookupAddRepository"
  | "openAddFolder"
  | "addLocalProject"
  | "createAddProject"
  | "cloneAddProject"
  | "publishAddRepository"
  | "checkAddAppAccess"
  | "runProjectCloneAction"
> {
  // Scopes and discovery hold for one visit to Add project (`epoch`); a listing for 5 s after its last use.
  const scopes = new Map<string, EnvironmentScopes>();
  const discoveries = new Map<string, SourceControlDiscovery | null>();
  const browses = new Map<string, { value: BrowseOutcome; expiry: ReturnType<typeof setTimeout> }>();
  let epoch = -1;
  let revision = 0;

  const session = (environmentId: string): DirectSession | null => {
    try {
      return boundary.sessionFor(environmentId);
    } catch {
      return null;
    }
  };
  const browseKey = (environmentId: string, directory: string) => JSON.stringify([environmentId, directory]);
  const keepBrowse = (key: string, value: BrowseOutcome) => {
    clearTimeout(browses.get(key)?.expiry);
    browses.set(key, { value, expiry: setTimeout(() => browses.delete(key), BROWSE_TTL_MS) });
  };
  const cachedBrowse = (environmentId: string, directory: string): BrowseOutcome | null => {
    const key = browseKey(environmentId, directory);
    const entry = browses.get(key);
    if (!entry) return null;
    keepBrowse(key, entry.value);
    return entry.value;
  };

  function environmentsOf(environments: readonly Environment[]): AddProjectEnvironment[] {
    return environments.map((environment) => {
      const live = environment.status === "Connected" ? session(environment.id) : null;
      const facts = live?.configLoaded() ? live.addProjectFacts() : null;
      const granted = scopes.get(environment.id);
      return {
        id: environment.id,
        label: environment.label,
        machineSymbol: environment.machineSymbol || "server.rack",
        os: facts?.os ?? "",
        baseDirectory: facts?.baseDirectory ?? "",
        newProjectsRoot: facts?.newProjectsRoot ?? null,
        ghqCloneLayout: facts?.ghqCloneLayout ?? false,
        phase: phaseOf(environment.status),
        error: null,
        // Until the session's scopes arrive, the server is the one to refuse.
        canOperate: granted?.operate ?? true,
        canWriteSourceControl: granted?.sourceControlWrite ?? true,
      };
    });
  }

  async function loadScopes(environmentId: string, store: Store) {
    if (scopes.has(environmentId)) return;
    let value: EnvironmentScopes;
    try {
      value = await boundary.scopes(environmentId, store);
    } catch (error) {
      value = { operate: false, sourceControlWrite: false, filesystemRead: false, error: errorMessage(error) };
    }
    scopes.set(environmentId, value);
    revision++;
  }

  async function loadDiscovery(environmentId: string, native?: NativeModule | null) {
    if (discoveries.has(environmentId)) return;
    const target = session(environmentId);
    if (!target) return;
    let value: SourceControlDiscovery | null = null;
    try {
      value = await boundary.awaitReply(discoverSourceControl(target.rpc), native);
    } catch {}
    discoveries.set(environmentId, value);
    revision++;
  }

  async function loadBrowse(environmentId: string, directory: string, native?: NativeModule | null) {
    if (!directory || cachedBrowse(environmentId, directory)) return;
    const target = session(environmentId);
    if (!target) return;
    keepBrowse(browseKey(environmentId, directory), await boundary.awaitReply(browseFilesystem(target.rpc, directory), native));
    revision++;
  }

  /** The environment a screen works in: the chooser's pick, else the one the chooser passed on. */
  function screenEnvironment(route: string, chooserId: string, targetId: string, all: AddProjectEnvironment[]) {
    if (route === "addProject") {
      const id = presentSourceChooser({ environments: all, selectedId: chooserId || null, discovery: null, discoveryPending: false }).environmentId;
      return all.find((environment) => environment.id === id) ?? null;
    }
    const options = environmentOptions(all, null);
    if (route === "addProjectNew")
      return resolveAddProjectEnvironment(options.filter((option) => option.newProjectsRoot !== null), targetId || null);
    return resolveAddProjectEnvironment(options, targetId || null);
  }

  function browseRequest(environment: AddProjectEnvironment, pathText: string) {
    return presentFolderBrowser({
      environment,
      pathText,
      pinnedName: "",
      cloning: false,
      access: { canRead: true, pending: false, error: null },
      browse: { pending: false, outcome: null },
    }).request;
  }

  function fileAccess(environmentId: string) {
    const granted = scopes.get(environmentId);
    return { canRead: granted?.filesystemRead ?? false, pending: granted === undefined, error: granted?.error ?? null };
  }

  return {
    loadAddProjectFacts: async ([route, visit, chooserId, targetId, pathText, environments], store, _storage, native) => {
      if (!ADD_ROUTES.has(route)) return { stamp: "" };
      if (visit !== epoch) {
        epoch = visit;
        scopes.clear();
        discoveries.clear();
      }
      native?.watch("connections");
      if (native?.available) boundary.sync(native);
      await Promise.all(
        environments.filter((environment) => environment.status === "Connected").map((environment) => loadScopes(environment.id, store)),
      );
      const environment = screenEnvironment(route, chooserId, targetId, environmentsOf(environments));
      if (environment) {
        const work: Promise<unknown>[] = [];
        if (route === "addProject" || route === "addProjectNew" || route === "addProjectDestination")
          work.push(loadDiscovery(environment.id, native));
        if (pathText && fileAccess(environment.id).canRead)
          work.push(loadBrowse(environment.id, browseRequest(environment, pathText), native));
        await Promise.all(work);
      }
      return { stamp: String(revision) };
    },

    presentAddProject: ([route, source, flow, environments, _stamp, factsPending, navigating, submitting]) => {
      const all = environmentsOf(environments);
      const environment = ADD_ROUTES.has(route) ? screenEnvironment(route, flow.environmentId, flow.targetId, all) : null;
      const discovery = environment ? (discoveries.get(environment.id) ?? null) : null;
      const discoveryPending = environment !== null && !discoveries.has(environment.id);
      const field =
        route === "addProjectDestination"
          ? cloneDestinationPath(environment, flow.remoteUrl || null, flow.repositoryName || null)
          : localFolderPath(environment);
      const browsing = environment !== null && (route === "addProjectLocal" || route === "addProjectDestination");
      const request = browsing ? browseRequest(environment, flow.path) : "";
      const browser = browsing
        ? presentFolderBrowser({
            environment,
            pathText: flow.path,
            pinnedName: field.pinnedName,
            cloning: route === "addProjectDestination",
            access: fileAccess(environment.id),
            browse: { pending: factsPending, outcome: request ? cachedBrowse(environment.id, request) : null },
          })
        : { request: "", accessError: "", browseError: "", missingNote: "", loading: false, rows: [] };
      return {
        environmentId: environment?.id ?? "",
        source: copyRows(
          presentSourceChooser({
            environments: all,
            selectedId: flow.environmentId || null,
            discovery,
            discoveryPending: route === "addProject" && discoveryPending,
          }),
        ),
        repository: presentRepositoryInput({ source, text: flow.repositoryText, submitting }),
        destination: presentCloneDestination({
          environment,
          remoteUrl: flow.remoteUrl || null,
          repositoryTitle: flow.repositoryTitle || null,
          navigating,
          submitting,
        }),
        local: presentLocalFolder({ environment, navigating, submitting }),
        newProject: copyRows(
          presentNewProject({
            environments: all,
            selectedId: flow.targetId || null,
            name: flow.name,
            discovery,
            publishes: flow.publish,
            publishProvider: flow.publishProvider || null,
            submitting,
          }),
        ),
        browser: copyRows(browser),
        pathSeed: browsing ? field.seed : "",
        pathRaw: flow.path,
        pathText: flow.pathEdited ? pastedPathInput(flow.previousPath, flow.path) : flow.path,
      };
    },

    lookupAddRepository: async ([environmentId, source, text], _store, _storage, native) => {
      const none = { ok: false, error: "", remoteUrl: "", repositoryTitle: "", repositoryName: "" };
      const plan = planRepositorySubmit(source, text);
      if (plan.kind === "ignore") return none;
      if (plan.kind === "error") return { ...none, error: plan.message };
      if (plan.kind === "destination") return destination(plan.destination);
      try {
        const target = boundary.sessionFor(environmentId);
        const repository = await boundary.awaitReply(
          lookupRepository(target.rpc, { provider: plan.provider, repository: plan.repository }),
          native,
        );
        return destination(destinationFromRepository(source, repository));
      } catch (error) {
        return { ...none, error: errorMessage(error) };
      }
    },

    openAddFolder: async ([environmentId, browsePath, path], _store, _storage, native) => {
      try {
        await loadBrowse(environmentId, browsePath, native);
      } catch {}
      return { path };
    },

    addLocalProject: async ([environmentId, pathText, nowMs], _store, _storage, native) => {
      const target = session(environmentId);
      const environment = environmentsOf(target ? [target.environment] : []).at(0) ?? null;
      const projects = (target?.projectRecords() ?? []).map((project) => ({ ...project, environmentId }));
      const plan = planLocalFolder({ environment, pathText, projects, navigating: false, submitting: false });
      if (plan.kind === "ignore") return refused({});
      if (plan.kind === "error") return refused({ error: plan.message });
      if (plan.kind === "alert") return refused({ alertTitle: plan.alert.title, alertBody: plan.alert.message });
      try {
        const live = boundary.sessionFor(environmentId);
        if (plan.kind === "existing") {
          let unarchived = true;
          if (plan.unarchive)
            try {
              await boundary.awaitReply(
                unarchiveProject(live.rpc, { commandId: crypto.randomUUID(), projectId: plan.project.id }),
                native,
              );
            } catch {
              unarchived = false;
            }
          const alert = projectExistsAlert(plan.project.title, unarchived);
          return opened(environmentId, plan.project.id, false, nowMs, { alertTitle: alert.title, alertBody: alert.message });
        }
        const projectId = crypto.randomUUID();
        await boundary.awaitReply(
          createProject(live.rpc, {
            commandId: crypto.randomUUID(),
            projectId,
            title: plan.title,
            workspaceRoot: plan.workspaceRoot,
          }),
          native,
        );
        if (!(await boundary.awaitReply(live.waitForProject(projectId, PROJECT_WAIT_MS), native)))
          return refused({ alertTitle: PROJECT_ADDED_LATE.title, alertBody: PROJECT_ADDED_LATE.message });
        return opened(environmentId, projectId, false, nowMs);
      } catch (error) {
        return refused({ error: errorMessage(error) });
      }
    },

    createAddProject: async ([environmentId, name, publishProvider, nowMs], _store, _storage, native) => {
      const trimmed = name.trim();
      if (!trimmed) return refused({});
      try {
        const live = boundary.sessionFor(environmentId);
        const created = await boundary.awaitReply(createNewProject(live.rpc, trimmed), native);
        const alert = created.commitError ? createdWithoutCommitAlert(created.commitError) : null;
        const choice = publishProvider
          ? presentNewProject({
              environments: environmentsOf([live.environment]),
              selectedId: environmentId,
              name: trimmed,
              discovery: discoveries.get(environmentId) ?? null,
              publishes: true,
              publishProvider,
              submitting: false,
            }).publish
          : null;
        const publish = choice
          ? {
              publishCwd: created.workspaceRoot,
              publishProvider: choice.provider,
              publishLabel: choice.label,
              publishRepository: publishRepositoryName(choice.owner, created.workspaceRoot),
            }
          : {};
        const notice = { alertTitle: alert?.title ?? "", alertBody: alert?.message ?? "", environmentId, ...publish };
        if (!(await boundary.awaitReply(live.waitForProject(created.projectId, PROJECT_WAIT_MS), native)))
          return refused({ ...notice, error: NOT_REACHED_YET, clearName: true });
        return opened(environmentId, created.projectId, false, nowMs, notice);
      } catch (error) {
        return refused({ error: errorMessage(error) });
      }
    },

    cloneAddProject: async ([environmentId, pathText, remoteUrl, nowMs], _store, _storage, native) => {
      const target = session(environmentId);
      const environment = environmentsOf(target ? [target.environment] : []).at(0) ?? null;
      const plan = planClone({ environment, pathText, remoteUrl: remoteUrl || null, navigating: false, submitting: false });
      if (plan.kind === "ignore") return refused({});
      if (plan.kind === "error") return refused({ error: plan.message });
      try {
        const live = boundary.sessionFor(environmentId);
        const started = await boundary.awaitReply(
          startProjectClone(live.rpc, {
            projectId: crypto.randomUUID(),
            title: plan.title,
            createdAt: new Date(nowMs).toISOString(),
            remoteUrl: plan.remoteUrl,
            destinationPath: plan.destinationPath,
          }),
          native,
        );
        const notice = { environmentId, remoteUrl: started.remoteUrl || plan.remoteUrl };
        if (!(await boundary.awaitReply(live.waitForProject(started.projectId, PROJECT_WAIT_MS), native)))
          return refused({ ...notice, error: NOT_REACHED_YET });
        return opened(environmentId, started.projectId, true, nowMs, notice);
      } catch (error) {
        return refused({ error: errorMessage(error) });
      }
    },

    publishAddRepository: async ([environmentId, cwd, provider, repository, label], _store, _storage, native) => {
      try {
        const live = boundary.sessionFor(environmentId);
        const published = await boundary.awaitReply(publishRepository(live.rpc, { cwd, provider, repository }), native);
        return await appAccess(environmentId, published.remoteUrl, native);
      } catch (error) {
        const alert = publishFailedAlert(label, error);
        return { show: true, title: alert.title, body: alert.message, url: "" };
      }
    },

    checkAddAppAccess: ([environmentId, remoteUrl], _store, _storage, native) => appAccess(environmentId, remoteUrl, native),

    runProjectCloneAction: async ([kind, environmentId, projectId], _store, _storage, native) => {
      const raw = threadIdentity(projectId).threadId;
      const title = kind === "cancel" ? CANCEL_CLONE_FAILED : kind === "retry" ? RETRY_CLONE_FAILED : REMOVE_PROJECT_FAILED;
      try {
        const live = boundary.sessionFor(environmentId);
        const rpc = live.rpc;
        const work: Promise<unknown> =
          kind === "cancel"
            ? cancelProjectClone(rpc, raw)
            : kind === "retry"
              ? retryProjectClone(rpc, raw)
              : deleteProject(rpc, { commandId: crypto.randomUUID(), projectId: raw });
        await boundary.awaitReply(work, native);
        return { ok: true, error: "", alertTitle: "", removed: kind === "remove", projectId };
      } catch (error) {
        return { ok: false, error: errorMessage(error), alertTitle: title, removed: false, projectId };
      }
    },
  };

  /** Upstream's `suggestAppAccess`: only for a host whose provider signs in with the app. */
  async function appAccess(environmentId: string, remoteUrl: string, native?: NativeModule | null) {
    const quiet = { show: false, title: "", body: "", url: "" };
    const check = appAccessCheck(remoteUrl);
    const provider = discoveries.get(environmentId)?.providers.find((entry) => entry.kind === check?.provider);
    if (!check || !provider?.appSignIn) return quiet;
    try {
      const live = boundary.sessionFor(environmentId);
      const status = await boundary.awaitReply(checkAppAccess(live.rpc, check), native);
      if (status !== "not-covered") return quiet;
      const alert = appAccessAlert(check);
      return { show: true, title: alert.title, body: alert.message, url: alert.url };
    } catch {
      return quiet;
    }
  }
}
