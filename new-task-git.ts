import { branchBadge, sanitizeRefQuery, type VcsRef, type WorkspaceMode } from "./new-task";

export interface VcsRefPage {
  refs: VcsRef[];
  isRepo: boolean;
  isAtRepositoryRoot: boolean | undefined;
  nextCursor: number | null;
}

export interface ListRefsOptions {
  query?: string;
  cursor?: number;
  refKind?: "all" | "local" | "remote";
  refresh?: boolean;
  limit?: number;
}

export interface VcsPort {
  listRefs(cwd: string, options: ListRefsOptions): Promise<VcsRefPage>;
  switchRef(cwd: string, refName: string): Promise<{ refName: string | null }>;
}

const QUERY_MAX_LENGTH = 256;

function localBranchName(ref: VcsRef): string {
  if (!ref.isRemote) return ref.name;
  const prefix = ref.remoteName ? `${ref.remoteName}/` : null;
  if (prefix && ref.name.startsWith(prefix)) return ref.name.slice(prefix.length);
  const separator = ref.name.indexOf("/");
  return separator <= 0 || separator === ref.name.length - 1 ? ref.name : ref.name.slice(separator + 1);
}

/** A local-mode pick checks the branch out first; worktree mode only records the base. */
export async function checkoutNewTaskBranch(
  port: VcsPort,
  request: { cwd: string | null; mode: WorkspaceMode; ref: VcsRef },
): Promise<{ ok: true; branch: string; worktreePath: string | null } | { ok: false; error: string }> {
  const { cwd, ref } = request;
  if (!cwd) return { ok: false, error: "The selected project is unavailable. Reconnect and try again." };
  if (request.mode === "worktree" || ref.current)
    return { ok: true, branch: ref.name, worktreePath: ref.current ? null : ref.worktreePath };
  const localName = localBranchName(ref);
  let cursor: number | undefined;
  for (;;) {
    const page = await port.listRefs(cwd, {
      query: localName.slice(0, QUERY_MAX_LENGTH),
      refKind: "local",
      ...(cursor === undefined ? { refresh: true } : { cursor }),
    });
    const local = page.refs.find((entry) => entry.name === localName);
    if (
      local &&
      (!ref.isRemote || local.upstreamRef === `refs/remotes/${ref.name}`) &&
      (local.current || local.worktreePath)
    ) {
      if (local.current) return { ok: true, branch: local.name, worktreePath: null };
      if (page.isAtRepositoryRoot === undefined)
        return {
          ok: false,
          error:
            "The server did not report whether this project is at the repository root, so this worktree cannot be reused safely. Update the server or choose another branch.",
        };
      if (!page.isAtRepositoryRoot)
        return {
          ok: false,
          error:
            "This project is a repository subdirectory. Choose another branch or add the repository root as a project to reuse this worktree.",
        };
      return { ok: true, branch: local.name, worktreePath: local.worktreePath };
    }
    if (local || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const result = await port.switchRef(cwd, ref.name);
  return { ok: true, branch: result.refName ?? ref.name, worktreePath: null };
}

export interface BranchRow {
  key: string;
  name: string;
  badge: string;
  selected: boolean;
  isRemote: boolean;
  current: boolean;
  worktreePath: string;
}

export function branchRows(refs: ReadonlyArray<VcsRef>, rootCwd: string, selectedName: string): BranchRow[] {
  const selected =
    selectedName ||
    refs.find((ref) => ref.current)?.name ||
    refs.find((ref) => ref.isDefault)?.name ||
    "";
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const key = `${ref.remoteName || "local"}:${ref.name}:${ref.worktreePath ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        name: ref.name,
        badge: branchBadge(ref, rootCwd),
        selected: ref.name === selected,
        isRemote: ref.isRemote,
        current: ref.current,
        worktreePath: ref.worktreePath ?? "",
      },
    ];
  });
}

interface PagerEntry {
  pages: Promise<VcsRefPage>[];
  settled: VcsRefPage[];
  error: string;
}

export class RefPager {
  private entries = new Map<string, PagerEntry>();
  private revisions = new Map<string, number>();

  private key(environmentId: string, cwd: string, query: string, revision: number) {
    return JSON.stringify([environmentId, cwd, sanitizeRefQuery(query), revision]);
  }

  invalidate(environmentId: string, cwd: string) {
    const id = JSON.stringify([environmentId, cwd]);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  cached(environmentId: string, cwd: string, query = ""): VcsRefPage | null {
    const revision = this.revisions.get(JSON.stringify([environmentId, cwd])) ?? 0;
    return this.entries.get(this.key(environmentId, cwd, query, revision))?.settled[0] ?? null;
  }

  async load(
    port: Pick<VcsPort, "listRefs">,
    environmentId: string,
    cwd: string,
    query: string,
    pages: number,
    limit = 100,
  ): Promise<{ refs: VcsRef[]; isRepo: boolean; hasMore: boolean; error: string }> {
    const revision = this.revisions.get(JSON.stringify([environmentId, cwd])) ?? 0;
    const key = this.key(environmentId, cwd, query, revision);
    let entry = this.entries.get(key);
    if (!entry || entry.error) {
      entry = { pages: [], settled: [], error: "" };
      this.entries.set(key, entry);
    }
    const sanitized = sanitizeRefQuery(query);
    try {
      while (entry.pages.length < Math.max(1, pages)) {
        const index = entry.pages.length;
        const previous = index === 0 ? null : await entry.pages[index - 1]!;
        if (previous && previous.nextCursor === null) break;
        const page = port.listRefs(cwd, {
          ...(sanitized ? { query: sanitized } : {}),
          ...(previous ? { cursor: previous.nextCursor! } : {}),
          limit,
        });
        entry.pages.push(page);
        page.then((value) => (entry!.settled[index] = value)).catch(() => {});
      }
      const loaded = await Promise.all(entry.pages);
      const last = loaded.at(-1)!;
      return {
        refs: loaded.flatMap((page) => page.refs),
        isRepo: loaded[0]?.isRepo ?? true,
        hasMore: last.nextCursor !== null,
        error: "",
      };
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "Branches could not be loaded.";
      return { refs: [], isRepo: true, hasMore: false, error: entry.error };
    }
  }
}
