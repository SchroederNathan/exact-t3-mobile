import { describe, expect, test } from "bun:test";
import {
  gitQuickAction,
  normalizeGitStatus,
  pullRequestSummary,
  reduceGitOperation,
} from "../connection";

describe("thread Git domain state", () => {
  test("normalizes a repository status without losing server fields", () => {
    const status = normalizeGitStatus({
      isRepo: true,
      refName: "feature/mobile",
      isDefaultRef: false,
      hasWorkingTreeChanges: true,
      hasUpstream: false,
      hasPrimaryRemote: true,
      aheadCount: 2,
      behindCount: 0,
      branchChanges: { baseRef: "main", insertions: 4, deletions: 1 },
      workingTree: {
        files: [{ path: "app.ts", insertions: 4, deletions: 1 }],
      },
      pr: { number: 17, title: "Mobile parity", url: "https://example.test/pr/17", state: "open" },
    });

    expect(status).toMatchObject({
      isRepo: true,
      refName: "feature/mobile",
      hasWorkingTreeChanges: true,
      hasUpstream: false,
      hasPrimaryRemote: true,
      aheadCount: 2,
      behindCount: 0,
    });
    expect(status.branchChanges).toEqual({ baseRef: "main", insertions: 4, deletions: 1 });
    expect(status.pullRequest).toMatchObject({ number: 17, state: "open" });
  });

  test("normalizes a non-repository response to safe empty status", () => {
    const status = normalizeGitStatus({ isRepo: false });
    expect(status).toMatchObject({
      isRepo: false,
      refName: null,
      hasWorkingTreeChanges: false,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(status.branchChanges).toBeNull();
  });

  test("chooses context-sensitive quick actions and honors disabled states", () => {
    const base = normalizeGitStatus({
      isRepo: true,
      refName: "feature/mobile",
      isDefaultRef: false,
      hasWorkingTreeChanges: true,
      hasUpstream: true,
      hasPrimaryRemote: true,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(gitQuickAction(base, false, true)).toMatchObject({
      kind: "run_action",
      action: "commit_push_pr",
      disabled: false,
    });
    expect(gitQuickAction(base, true, true)).toMatchObject({
      kind: "show_hint",
      disabled: true,
    });
    expect(gitQuickAction(base, false, false)).toMatchObject({
      kind: "show_hint",
      disabled: true,
      hint: expect.stringContaining("cannot change source control"),
    });

    const behind = normalizeGitStatus({
      ...base,
      hasWorkingTreeChanges: false,
      behindCount: 2,
    });
    expect(gitQuickAction(behind, false, true)).toMatchObject({
      kind: "run_pull",
      disabled: false,
    });

    expect(
      gitQuickAction(normalizeGitStatus({ ...base, behindCount: 2 }), false, true),
    ).toMatchObject({ kind: "run_action", action: "commit" });
    expect(
      gitQuickAction(normalizeGitStatus({ ...base, isDefaultRef: true }), false, true),
    ).toMatchObject({ kind: "run_action", action: "commit_push" });
    expect(
      gitQuickAction(
        normalizeGitStatus({
          ...base,
          hasWorkingTreeChanges: false,
          aheadCount: 0,
          pullRequest: {
            number: 17,
            title: "Mobile parity",
            url: "https://example.test/pr/17",
            state: "open",
          },
        }),
        false,
        false,
      ),
    ).toMatchObject({ kind: "open_pr", url: "https://example.test/pr/17" });

    const missingRepo = normalizeGitStatus({ isRepo: false });
    expect(gitQuickAction(missingRepo, false, true)).toMatchObject({
      kind: "show_hint",
      disabled: true,
      hint: expect.stringContaining("not a git repository"),
    });
  });

  test("reduces streamed operation progress to deterministic final state", () => {
    let state = reduceGitOperation(undefined, {
      type: "start",
      operation: "commit_push_pr",
      label: "Running source control action",
    });
    expect(state).toMatchObject({ status: "running", operation: "commit_push_pr" });

    state = reduceGitOperation(state, { type: "progress", label: "Pushing changes" });
    expect(state).toMatchObject({ status: "running", label: "Pushing changes" });

    state = reduceGitOperation(state, {
      type: "success",
      result: { branch: { status: "created", name: "feature/mobile" } },
    });
    expect(state).toMatchObject({
      status: "succeeded",
      operation: "commit_push_pr",
      error: null,
      result: { branch: { status: "created", name: "feature/mobile" } },
    });

    const failed = reduceGitOperation(state, { type: "error", error: "Push was rejected." });
    expect(failed).toMatchObject({ status: "failed", error: "Push was rejected." });
  });

  test("projects pull request list entries into stable mobile summaries", () => {
    expect(
      pullRequestSummary({
        number: 17,
        id: "github:acme/mobile:17",
        repository: "acme/mobile",
        title: "Mobile parity",
        url: "https://github.com/acme/mobile/pull/17",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/mobile",
        isDraft: false,
        updatedAt: "2026-11-11T12:00:00Z",
      }),
    ).toMatchObject({
      id: "github:acme/mobile:17",
      number: 17,
      title: "Mobile parity",
      url: "https://github.com/acme/mobile/pull/17",
      state: "open",
      baseBranch: "main",
      branch: "feature/mobile",
      repository: "acme/mobile",
      updatedAt: "2026-11-11T12:00:00Z",
    });
  });
});
