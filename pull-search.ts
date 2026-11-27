type PullSearchFilters = { labels?: string[][]; excludedLabels?: string[]; author?: string; draft?: string; review?: string; checks?: string };

function splitOutsideQuotes(input: string, delimiter: (character: string) => boolean): string[] {
  const parts: string[] = [];
  let quoted = false;
  let part = "";
  for (const character of input) {
    if (character === '"') quoted = !quoted;
    if (!quoted && delimiter(character)) {
      if (part) parts.push(part);
      part = "";
    } else part += character;
  }
  if (part) parts.push(part);
  return parts;
}

const reviewNames: Record<string, string> = { approved: "approved", changes_requested: "changes-requested", "changes-requested": "changes-requested", required: "review-required", "review-required": "review-required", none: "none" };
const checkNames: Record<string, string> = { passing: "passing", success: "passing", failing: "failing", failure: "failing" };

export function pullSearch(input: string, selectedLabels: string[] = [], selectedAuthor = "") {
  const text: string[] = [];
  const filters: PullSearchFilters = {};
  const authors = new Map<string, string>();
  for (const token of splitOutsideQuotes(input, character => /\s/.test(character))) {
    const qualifier = /^(-?)([a-z][\w-]*):(.+)$/i.exec(token);
    if (!qualifier) { text.push(token); continue; }
    const [, minus, key, argument] = qualifier;
    const field = key!.toLowerCase();
    const names = splitOutsideQuotes(argument!, character => character === ",").map(part => part.replace(/^"(.*)"$/, "$1").trim().slice(0, 200)).filter(Boolean).slice(0, 10);
    const name = names[0] ?? "";
    const normalized = name.toLowerCase();
    if (!name || argument!.startsWith("/")) text.push(token);
    else if (field === "draft" && ["true", "false"].includes(normalized)) filters.draft = (normalized === "true") !== Boolean(minus) ? "only" : "hide";
    else if (field === "author" && !minus) authors.set(normalized.replace(/^@/, ""), name);
    else if (field === "review" && !minus && Object.hasOwn(reviewNames, normalized)) filters.review = reviewNames[normalized];
    else if (["checks", "status"].includes(field) && !minus && Object.hasOwn(checkNames, normalized)) filters.checks = checkNames[normalized];
    else if (["draft", "author", "review", "status", "checks"].includes(field)) text.push(token);
    else if (!["is", "archived", "state", "repo", "org", "user", "sort"].includes(field)) {
      const values = names.map(value => field === "label" || value.includes(":") ? value : `${key}:${value}`.slice(0, 200));
      if (minus) filters.excludedLabels = [...(filters.excludedLabels ?? []), ...values].slice(0, 10);
      else if ((filters.labels?.length ?? 0) < 10) (filters.labels ??= []).push(values);
    }
  }
  if (authors.size === 1) filters.author = [...authors.values()][0];
  const query = text.join(" ").slice(0, 200).trim();
  const selections = {...(selectedLabels.length ? {labels:selectedLabels.slice(0,10).map(label=>[label])} : {}), ...(selectedAuthor ? {author:selectedAuthor} : {}), ...filters};
  return { ...(query ? {query} : {}), ...(Object.keys(selections).length ? {filters:selections} : {}) };
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";

export function pullListPredicate(page: Record<string, unknown>, state: string, involvement: string, search: string, labels: string[] = [], author = "") {
  const {query, filters = {}} = pullSearch(search,labels,author);
  const local = new Set((Array.isArray(page.providers) ? page.providers : []).filter(provider => record(provider).searchesOnHost === false).map(provider => record(provider).host));
  const viewers = record(page.viewers);
  const words = lower(query).split(/\s+/).filter(Boolean);
  return (entry: Record<string, unknown>) => {
    if (state !== "all" && (entry.state || "open") !== state) return false;
    if (involvement === "reviewing" && entry.viewerReviewRequested !== true) return false;
    const viewer = lower(viewers[String(entry.host)]);
    const actor = lower(record(entry.author).login || entry.author);
    if (involvement === "authored" && (!viewer || actor !== viewer)) return false;
    if (filters.author) {
      const requested = lower(filters.author).replace(/^@/, "");
      if (!actor || actor !== (requested === "me" ? viewer : requested)) return false;
    }
    if ((filters.draft === "only" && !entry.isDraft) || (filters.draft === "hide" && entry.isDraft)) return false;
    if (filters.review && entry.reviewDecision && entry.reviewDecision !== filters.review) return false;
    if (filters.checks && entry.checksState && entry.checksState !== filters.checks) return false;
    const labels = (Array.isArray(entry.labels) ? entry.labels : []).map(label => lower(record(label).name));
    if (filters.labels?.some(group => !group.some(name => labels.includes(lower(name)))) || filters.excludedLabels?.some(name => labels.includes(lower(name)))) return false;
    if (!local.has(entry.host) || !words.length) return true;
    const haystack = [entry.repository, `#${entry.number}`, entry.title, actor, entry.headBranch, entry.baseBranch, ...labels].map(lower).join(" ");
    return words.every(word => haystack.includes(word));
  };
}
