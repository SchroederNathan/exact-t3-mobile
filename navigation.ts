import type { Args, Result } from "./app.contract.d.ts";

type Router = Args<"regroupNavigation">[0];

const pairs = [
  ["threads", "threadDetail"],
  ["settings", "settingsDetail"],
] as const;

export function regroupNavigation(before: Router, split: boolean): Result<"regroupNavigation"> {
  validateNavigation(before);
  let after = { ...before, tabs: before.tabs.map((tab) => ({ ...tab, stack: [...tab.stack] })) };
  for (const [primary, detail] of pairs) {
    const sourceName = split ? primary : detail;
    const targetName = split ? detail : primary;
    const source = after.tabs.find(({ name }) => name === sourceName);
    const target = after.tabs.find(({ name }) => name === targetName);
    if (!source || !target) throw new Error("The workspace navigation groups are incomplete.");
    const selected = after.tab === sourceName;
    if (source.stack.length === 1 && !selected) continue;
    const sourceTail = source.stack.slice(1);
    const targetTail = target.stack.slice(1);
    const useSource =
      selected ||
      (after.tab !== targetName && (sourceTail.at(-1)?.id ?? -1) > (targetTail.at(-1)?.id ?? -1));
    const retained = (useSource ? sourceTail : targetTail).map((entry) => ({
      ...entry,
      tab: targetName,
    }));
    Object.assign(after, {
      tab: selected ? targetName : after.tab,
      tabs: after.tabs.map((tab) =>
        tab.name === sourceName
          ? { ...tab, stack: tab.stack.slice(0, 1) }
          : tab.name === targetName
            ? { ...tab, stack: [tab.stack[0]!, ...retained] }
            : tab,
      ),
    });
  }
  return { before, after, split };
}

function validateNavigation(router: Router): void {
  const tabs = new Set<string>();
  const visits = new Set<number>();
  if (!Number.isSafeInteger(router.next) || router.next < 0)
    throw new Error("The navigation visit counter is invalid.");
  for (const tab of router.tabs) {
    if (tabs.has(tab.name) || tab.stack[0]?.name !== tab.name)
      throw new Error("Each navigation tab requires its own root.");
    tabs.add(tab.name);
    for (const entry of tab.stack) {
      if (
        entry.tab !== tab.name ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 0 ||
        entry.id >= router.next ||
        visits.has(entry.id)
      )
        throw new Error("Each navigation visit requires a unique identity in its owning tab.");
      visits.add(entry.id);
    }
  }
  if (!tabs.has(router.tab)) throw new Error("The selected navigation tab is unavailable.");
}
