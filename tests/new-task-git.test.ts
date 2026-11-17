import { expect, test } from "bun:test";
import { RefPager, branchRows, checkoutNewTaskBranch, type ListRefsOptions, type VcsRefPage } from "../new-task-git";
import type { VcsRef } from "../new-task";

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

function port(pages: VcsRefPage[]) {
  const calls: Array<{ op: string; cwd: string; options?: ListRefsOptions; refName?: string }> = [];
  return {
    calls,
    async listRefs(cwd: string, options: ListRefsOptions) {
      calls.push({ op: "listRefs", cwd, options });
      const index = options.cursor ?? 0;
      return pages[index] ?? { refs: [], isRepo: true, isAtRepositoryRoot: true, nextCursor: null };
    },
    async switchRef(cwd: string, refName: string) {
      calls.push({ op: "switchRef", cwd, refName });
      return { refName };
    },
  };
}

test("worktree mode and the current branch never touch git", async () => {
  const vcs = port([]);
  expect(await checkoutNewTaskBranch(vcs, { cwd: "/r", mode: "worktree", ref: ref("feature") })).toEqual({
    ok: true,
    branch: "feature",
    worktreePath: null,
  });
  expect(await checkoutNewTaskBranch(vcs, { cwd: "/r", mode: "local", ref: ref("main", { current: true }) })).toEqual({
    ok: true,
    branch: "main",
    worktreePath: null,
  });
  expect(vcs.calls).toEqual([]);
});

test("local mode reads the exact local branch, then switches to it", async () => {
  const vcs = port([{ refs: [ref("feature/login")], isRepo: true, isAtRepositoryRoot: true, nextCursor: null }]);
  expect(await checkoutNewTaskBranch(vcs, { cwd: "/r", mode: "local", ref: ref("feature/login") })).toEqual({
    ok: true,
    branch: "feature/login",
    worktreePath: null,
  });
  expect(vcs.calls).toEqual([
    { op: "listRefs", cwd: "/r", options: { query: "feature/login", refKind: "local", refresh: true } },
    { op: "switchRef", cwd: "/r", refName: "feature/login" },
  ]);
});

test("a branch checked out in another worktree is reused only at the repository root", async () => {
  const elsewhere = ref("fix", { worktreePath: "/wt/fix" });
  expect(
    await checkoutNewTaskBranch(port([{ refs: [elsewhere], isRepo: true, isAtRepositoryRoot: true, nextCursor: null }]), {
      cwd: "/r",
      mode: "local",
      ref: ref("fix"),
    }),
  ).toEqual({ ok: true, branch: "fix", worktreePath: "/wt/fix" });
  expect(
    await checkoutNewTaskBranch(port([{ refs: [elsewhere], isRepo: true, isAtRepositoryRoot: false, nextCursor: null }]), {
      cwd: "/r",
      mode: "local",
      ref: ref("fix"),
    }),
  ).toEqual({
    ok: false,
    error:
      "This project is a repository subdirectory. Choose another branch or add the repository root as a project to reuse this worktree.",
  });
  expect(
    await checkoutNewTaskBranch(port([{ refs: [elsewhere], isRepo: true, isAtRepositoryRoot: undefined, nextCursor: null }]), {
      cwd: "/r",
      mode: "local",
      ref: ref("fix"),
    }),
  ).toMatchObject({ ok: false });
  expect(await checkoutNewTaskBranch(port([]), { cwd: null, mode: "local", ref: ref("fix") })).toEqual({
    ok: false,
    error: "The selected project is unavailable. Reconnect and try again.",
  });
});

test("a remote ref checks out its local name through every page", async () => {
  const vcs = port([
    { refs: [ref("other")], isRepo: true, isAtRepositoryRoot: true, nextCursor: 1 },
    { refs: [], isRepo: true, isAtRepositoryRoot: true, nextCursor: null },
  ]);
  await checkoutNewTaskBranch(vcs, {
    cwd: "/r",
    mode: "local",
    ref: ref("origin/feature", { isRemote: true, remoteName: "origin" }),
  });
  expect(vcs.calls.map((call) => call.options?.query ?? call.refName)).toEqual(["feature", "feature", "origin/feature"]);
  expect(vcs.calls[1]!.options).toEqual({ query: "feature", refKind: "local", cursor: 1 });
});

test("branch rows select the pick, else the current branch, with badges", () => {
  const refs = [ref("main", { current: true, isDefault: true }), ref("feature/login"), ref("origin/x", { isRemote: true, remoteName: "origin" })];
  expect(branchRows(refs, "/r", "").map((row) => [row.name, row.badge, row.selected])).toEqual([
    ["main", "CURRENT", true],
    ["feature/login", "", false],
    ["origin/x", "REMOTE", false],
  ]);
  expect(branchRows(refs, "/r", "feature/login").find((row) => row.selected)?.name).toBe("feature/login");
});

test("the pager asks for each page once and follows the cursor", async () => {
  const vcs = port([
    { refs: [ref("a")], isRepo: true, isAtRepositoryRoot: true, nextCursor: 1 },
    { refs: [ref("b")], isRepo: true, isAtRepositoryRoot: true, nextCursor: null },
  ]);
  const pager = new RefPager();
  expect((await pager.load(vcs, "env", "/r", "", 1)).hasMore).toBe(true);
  const both = await pager.load(vcs, "env", "/r", "", 2);
  expect(both.refs.map((entry) => entry.name)).toEqual(["a", "b"]);
  expect(both.hasMore).toBe(false);
  expect(vcs.calls.length).toBe(2);
  expect(vcs.calls[0]!.options).toEqual({ limit: 100 });
  expect(vcs.calls[1]!.options).toEqual({ cursor: 1, limit: 100 });
  await pager.load(vcs, "env", "/r", "fix typo", 1);
  expect(vcs.calls[2]!.options).toEqual({ query: "fix-typo", limit: 100 });
  pager.invalidate("env", "/r");
  await pager.load(vcs, "env", "/r", "", 1);
  expect(vcs.calls.length).toBe(4);
});
