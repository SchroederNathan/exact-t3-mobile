import { describe, expect, test } from "bun:test";
import {
  answersFor,
  controlAccess,
  projectControls,
  type Question,
  type QuestionDraft,
} from "../thread-controls";
import { ThreadHistory } from "../thread-history";
import { ComposerSendScope } from "../approval-send";

const question: Question = {
  id: "q",
  header: "Pick",
  text: "Which?",
  runs: [],
  multi: false,
  custom: true,
  initial: "",
  hasInitial: false,
  options: [
    { id: "0", label: "Padded", value: " value ", description: "", exact: true },
    { id: "1", label: "Other", value: "Other", description: "", exact: false },
  ],
};
const draft = (fields: Partial<QuestionDraft> = {}): QuestionDraft => ({
  key: "key",
  questionId: "q",
  selected: [],
  custom: "",
  hasCustom: false,
  revision: 1,
  ...fields,
});

describe("question answers", () => {
  test("preserves provider values, filters unknown choices, and deduplicates in selection order", () => {
    expect(answersFor([question], [draft({ selected: [" value "] })], "key")).toEqual({
      q: " value ",
    });
    expect(answersFor([question], [draft({ selected: ["value"] })], "key")).toBeNull();
    expect(answersFor([question], [draft({ selected: [" Other "] })], "key")).toEqual({
      q: "Other",
    });
    expect(
      answersFor(
        [
          {
            ...question,
            options: [
              { id: "label", label: "value", value: "value", description: "", exact: false },
              ...question.options,
            ],
          },
        ],
        [draft({ selected: [" value "] })],
        "key",
      ),
    ).toEqual({ q: " value " });
    expect(
      answersFor(
        [{ ...question, multi: true }],
        [draft({ selected: ["Other", "missing", " value ", "Other"] })],
        "key",
      ),
    ).toEqual({ q: ["Other", " value "] });
  });
  test("custom answers override choices, obey custom policy, and preserve initial-answer clearing", () => {
    expect(
      answersFor(
        [question],
        [draft({ selected: ["Other"], custom: " custom ", hasCustom: true })],
        "key",
      ),
    ).toEqual({ q: "custom" });
    expect(
      answersFor(
        [{ ...question, custom: false }],
        [draft({ selected: ["Other"], custom: "custom", hasCustom: true })],
        "key",
      ),
    ).toEqual({ q: "Other" });
    expect(answersFor([question], [draft({ custom: "  ", hasCustom: true })], "key")).toBeNull();
    expect(
      answersFor(
        [{ ...question, hasInitial: true, initial: "seed" }],
        [draft({ custom: "", hasCustom: true })],
        "key",
      ),
    ).toEqual({ q: "" });
    expect(answersFor([{ ...question, hasInitial: true, initial: " seed " }], [], "key")).toEqual({
      q: " seed ",
    });
  });
  test("treats prototype-shaped IDs as data and scopes drafts by request", () => {
    expect(
      answersFor(
        [{ ...question, id: "__proto__" }],
        [draft({ questionId: "__proto__", selected: ["Other"] })],
        "key",
      ),
    ).toEqual(JSON.parse('{"__proto__":"Other"}'));
    expect(
      answersFor([question], [draft({ key: "other", selected: ["Other"] })], "key"),
    ).toBeNull();
    const attachment = {
      id: "file",
      type: "file",
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    };
    expect(answersFor([question], [], "key", { q: [attachment] })).toEqual({ q: "" });
    expect(
      answersFor([question, { ...question, id: "other" }], [], "key", { q: [attachment] }),
    ).toBeNull();
    expect(
      answersFor(
        [{ ...question, id: "__proto__" }],
        [],
        "key",
        Object.fromEntries([["__proto__", [attachment]]]),
      ),
    ).toEqual(JSON.parse('{"__proto__":""}'));
    expect(answersFor([{ ...question, id: "__proto__" }], [], "key", {})).toBeNull();
  });
});

test("approval redirect scope rejects draft edits and leaving then returning to the same route", () => {
  const scope = new ComposerSendScope();
  scope.observe("thread", "route", 2);
  scope.prepare("command", "thread", 3);
  scope.observe("thread", "route", 3);
  const same = scope.take("command", "thread", 3);
  expect(same()).toBe(true);
  scope.observe("thread", "route", 4);
  expect(same()).toBe(false);
  const edited = scope.take("command", "thread", 4);
  expect(edited()).toBe(true);
  scope.observe("other", "route-2", 4);
  scope.observe("thread", "route", 4);
  expect(edited()).toBe(false);
  const retry = scope.take("command", "thread", 3, true);
  expect(retry()).toBe(true);
  scope.observe("thread", "route", 5);
  expect(retry()).toBe(false);
});

test("permission requires authentication and explicit permissions supersede scopes", () => {
  expect(
    controlAccess({ authenticated: true, permissions: [], scopes: ["orchestration:operate"] }),
  ).toBe(false);
  expect(controlAccess({ authenticated: false, permissions: ["orchestration:operate"] })).toBe(
    false,
  );
  expect(controlAccess({ authenticated: true, scopes: ["orchestration:operate"] })).toBe(true);
});

test("pending controls use runtime request ownership and preserve supplied empty options", () => {
  const controls = projectControls(
    "env",
    "thread",
    [
      {
        id: "runtime",
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", supportsFeedback: true },
      },
      {
        id: "ignored",
        kind: "auth_refresh",
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    [{ id: "item", requestId: "runtime", type: "approval_request", options: [] }],
    [],
  );
  expect(controls.requests.map(({ id, options, key }) => ({ id, options, key }))).toEqual([
    { id: "runtime", options: [], key: '["env","thread","runtime"]' },
  ]);
  expect(controls.requests[0]?.supportsFeedback).toBe(true);
  expect(
    projectControls(
      "env",
      "thread",
      [
        {
          id: "stale",
          kind: "command",
          status: "pending",
          responseCapability: { type: "not_resumable", supportsFeedback: true },
        },
      ],
      [],
      [],
    ).requests[0]?.supportsFeedback,
  ).toBe(false);
});

test.each(["preparing", "starting", "running", "waiting"])(
  "Stop targets the newest interruptible run while it is %s",
  (status) => {
    const runs = [
      { id: "older", ordinal: 1, status: "running" },
      { id: "completed", ordinal: 4, status: "completed" },
      { id: "current", ordinal: 3, status },
      { id: "queued", ordinal: 5, status: "queued" },
    ];
    const interrupt = { id: "interrupt", type: "run_interrupt_request", runId: "current" };
    expect(projectControls("env", "thread", [], [], runs).stop).toEqual({
      runId: "current",
      state: "available",
      error: "",
    });
    expect(projectControls("env", "thread", [], [interrupt], runs).stop.state).toBe("stopping");
    expect(
      projectControls(
        "env",
        "thread",
        [],
        [{ ...interrupt, unresponsiveAt: "2026-11-11T09:00:00Z" }],
        runs,
      ).stop.state,
    ).toBe("unresponsive");
    expect(
      projectControls(
        "env",
        "thread",
        [],
        [interrupt, { id: "result", type: "run_interrupt_result", runId: "current" }],
        runs,
      ).stop.state,
    ).toBe("available");
  },
);

test("history retains controls outside the visible window and ignores stale resolution", () => {
  const history = new ThreadHistory("thread");
  history.install({
    snapshotSequence: 10,
    hasMoreHistory: true,
    historyCursor: "older",
    latestLocalTurnOrdinal: 50,
    projection: {
      visibleTurnItems: [],
      turnItems: [],
      runs: [],
      runtimeRequests: [
        {
          id: "request",
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
        },
      ],
    },
  });
  history.apply({
    kind: "event",
    sequence: 11,
    event: {
      threadId: "thread",
      type: "turn-item.updated",
      payload: {
        id: "item",
        threadId: "thread",
        type: "user_input_request",
        requestId: "request",
        ordinal: 1,
        questions: [{ id: "q", header: "Question", question: "Continue?", options: [] }],
      },
    },
  });
  expect(
    history.controls("env").requests.map(({ id, dismissible }) => ({ id, dismissible })),
  ).toEqual([{ id: "request", dismissible: true }]);
  expect(history.controls("env").pendingKeys).toEqual(['["env","thread","request"]']);
  expect(history.visibleRows()).toEqual([]);
  history.apply({
    kind: "event",
    sequence: 10,
    event: {
      threadId: "thread",
      type: "runtime-request.updated",
      payload: { id: "request", status: "resolved" },
    },
  });
  expect(history.controls("env").requests.length).toBe(1);
  history.apply({
    kind: "event",
    sequence: 12,
    event: {
      threadId: "thread",
      type: "runtime-request.updated",
      payload: { id: "request", status: "resolved" },
    },
  });
  expect(history.controls("env").resolvedKeys).toEqual(['["env","thread","request"]']);
  expect(history.controls("env").requests).toEqual([]);
  history.disconnect();
  expect(history.controls("env").ready).toBe(false);
  history.install({
    projection: {
      runtimeRequests: [
        {
          id: "missing-detail",
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
        },
      ],
    },
  });
  expect(history.controls("env").pendingKeys).toEqual(['["env","thread","missing-detail"]']);
  expect(history.controls("env").requests).toEqual([]);
  history.install({ projection: { runtimeRequests: [] } });
  expect(history.controls("env").pendingKeys).toEqual([]);
  expect(history.controls("env").keyPrefix).toBe('["env","thread",');
});

test("inherited request items cannot answer local requests and provider delivery errors render", () => {
  const history = new ThreadHistory("thread");
  history.install({
    projection: {
      runtimeRequests: [
        {
          id: "request",
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live" },
        },
      ],
      visibleTurnItems: [
        {
          visibility: "inherited",
          sourceThreadId: "parent",
          sourceItemId: "item",
          item: {
            id: "item",
            threadId: "parent",
            type: "user_input_request",
            requestId: "request",
            questions: [],
          },
        },
      ],
    },
  });
  expect(history.controls("env").requests).toEqual([]);
  history.apply({
    kind: "event",
    sequence: 1,
    event: {
      threadId: "thread",
      type: "turn-item.updated",
      payload: {
        id: "failure",
        type: "error",
        title: "Answer delivery not confirmed",
        failure: { message: "Stop and retry." },
      },
    },
  });
  expect(history.feed().flatMap((row) => (row.message ? [row.message.body] : []))).toEqual([
    "Answer delivery not confirmed\n\nStop and retry.",
  ]);
});
