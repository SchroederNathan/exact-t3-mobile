import { expect, test } from "bun:test";
import type { Args } from "./app.contract.d.ts";
import { regroupNavigation } from "./navigation";

type Router = Args<"regroupNavigation">[0];
type Entry = Router["tabs"][number]["stack"][number];

function navigation(tab = "threads"): Router {
  return {
    tab,
    next: 6,
    tabs: [
      ["threads", "/"], ["threadDetail", "/detail"], ["pullRequests", "/pulls"],
      ["usage", "/usage"], ["settings", "/settings"], ["settingsDetail", "/settings/detail"],
    ].map(([name, url], id) => ({
      name: name!, stack: [{ id, name: name!, url: url!, tab: name!, params: { id: "", kind: "" }, fragment: "" }],
    })),
  };
}

function visit(router: Router, tab: string, name: string, url: string, params = { id: "", kind: "" }, fragment = ""): Entry {
  const entry = { id: router.next++, tab, name, url, params, fragment };
  router.tabs.find((entry) => entry.name === tab)!.stack.push(entry);
  return entry;
}

function stack(router: Router, name: string): Entry[] {
  return router.tabs.find((tab) => tab.name === name)!.stack;
}

test("folding transfers thread inspectors and inactive environment edits without losing visits", () => {
  const before = navigation("threadDetail");
  const thread = visit(before, "threadDetail", "thread", "/threads/a%3At?view=all", { id: "a:t", kind: "" }, "message-1");
  const inspector = visit(before, "threadDetail", "inspector", "/threads/a%3At/inspect/files", { id: "a:t", kind: "files" });
  const environments = visit(before, "settingsDetail", "environments", "/environments");
  const environment = visit(before, "settingsDetail", "environmentDetail", "/environments/a", { id: "a", kind: "" });
  const snapshot = structuredClone(before);
  const folded = regroupNavigation(before, false);
  expect(before).toEqual(snapshot);
  expect(folded.before).toEqual(snapshot);
  expect(folded.after.tab).toBe("threads");
  expect(stack(folded.after, "threads").slice(1)).toEqual([
    { ...thread, tab: "threads" }, { ...inspector, tab: "threads" },
  ]);
  expect(stack(folded.after, "settings").slice(1)).toEqual([
    { ...environments, tab: "settings" }, { ...environment, tab: "settings" },
  ]);
  expect(stack(folded.after, "threadDetail").map(({ name }) => name)).toEqual(["threadDetail"]);
  expect(stack(folded.after, "settingsDetail").map(({ name }) => name)).toEqual(["settingsDetail"]);
  expect(folded.after.next).toBe(10);
  expect(regroupNavigation(folded.after, true).after).toEqual(snapshot);
  expect(regroupNavigation(folded.after, false).after).toEqual(folded.after);
});

test("regrouping every inactive group keeps the selected independent tab and form routes", () => {
  const before = navigation("usage");
  const composing = visit(before, "threads", "newThread", "/threads/new");
  const pairing = visit(before, "settings", "addEnvironment", "/environments/new");
  const after = regroupNavigation(before, true).after;
  expect(after.tab).toBe("usage");
  expect(stack(after, "threadDetail").slice(1)).toEqual([{ ...composing, tab: "threadDetail" }]);
  expect(stack(after, "settingsDetail").slice(1)).toEqual([{ ...pairing, tab: "settingsDetail" }]);
  expect(stack(after, "usage")).toEqual(stack(before, "usage"));
  expect(stack(after, "pullRequests")).toEqual(stack(before, "pullRequests"));
  expect(regroupNavigation(after, false).after).toEqual(before);
});

test("normalizing cold-start declared detail routes gives compact tabs their complete parent chain", () => {
  const before = navigation("settingsDetail");
  visit(before, "settingsDetail", "environments", "/environments");
  visit(before, "settingsDetail", "environmentDetail", "/environments/server", { id: "server", kind: "" });
  const after = regroupNavigation(before, false).after;
  expect(after.tab).toBe("settings");
  expect(stack(after, "settings").map(({ id, name, url }) => ({ id, name, url }))).toEqual([
    { id: 4, name: "settings", url: "/settings" },
    { id: 6, name: "environments", url: "/environments" },
    { id: 7, name: "environmentDetail", url: "/environments/server" },
  ]);
});

test("normalizing previously split history retains the selected stack without stale Back history", () => {
  for (const selected of ["threads", "threadDetail"]) {
    const before = navigation(selected);
    visit(before, "threads", "thread", "/threads/a", { id: "a", kind: "" });
    visit(before, "threadDetail", "thread", "/threads/b", { id: "b", kind: "" });
    const after = regroupNavigation(before, true).after;
    expect(after.tab).toBe("threadDetail");
    expect(stack(after, "threadDetail").slice(1).map(({ id, url }) => ({ id, url }))).toEqual(selected === "threads"
      ? [{ id: 6, url: "/threads/a" }]
      : [{ id: 7, url: "/threads/b" }]);
    expect(stack(after, "threads").map(({ name }) => name)).toEqual(["threads"]);
    expect(regroupNavigation(after, true).after).toEqual(after);
  }
});

test("an inactive group keeps its newest final visit and clears the obsolete alternate stack", () => {
  for (const newest of ["threads", "threadDetail"]) {
    const before = navigation("usage");
    visit(before, newest === "threads" ? "threadDetail" : "threads", "thread", "/threads/old", { id: "old", kind: "" });
    visit(before, newest, "thread", "/threads/new", { id: "new", kind: "" });
    const after = regroupNavigation(before, true).after;
    expect(after.tab).toBe("usage");
    expect(stack(after, "threadDetail").slice(1).map(({ id, url }) => ({ id, url }))).toEqual([{ id: 7, url: "/threads/new" }]);
    expect(stack(after, "threads").length).toBe(1);
    expect(regroupNavigation(after, true).after).toEqual(after);
  }
});

test("malformed navigation cannot introduce duplicate visits or change an entry's owning tab", () => {
  const duplicate = navigation();
  stack(duplicate, "threads").push({ ...stack(duplicate, "threads")[0]! });
  expect(() => regroupNavigation(duplicate, true)).toThrow("unique identity");
  const misplaced = navigation();
  stack(misplaced, "threads")[0]!.tab = "threadDetail";
  expect(() => regroupNavigation(misplaced, true)).toThrow("owning tab");
  const rootless = navigation();
  stack(rootless, "settings").splice(0);
  expect(() => regroupNavigation(rootless, false)).toThrow("own root");
});
