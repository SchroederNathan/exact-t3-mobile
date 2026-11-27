const choices = {
  draft: { all: "All drafts", only: "Drafts only", hide: "Hide drafts" },
  review: { all: "All reviews", approved: "Approved", "changes-requested": "Changes requested", "review-required": "Review required", none: "No reviews" },
  checks: { all: "All checks", passing: "Passing", failing: "Failing" },
  sort: { updated: "Recently updated", created: "Newest created", oldest: "Oldest updated" },
};

export function pullControlMenu(state: string, involvement: string, draft: string, review: string, checks: string, sort: string) {
  const selected = {draft, review, checks, sort};
  const count = [state !== "open", involvement !== "all", draft !== "all", review !== "all", checks !== "all"].filter(Boolean).length;
  const groups = (Object.keys(choices) as (keyof typeof choices)[]).map(field => {
    const options = Object.entries(choices[field]).map(([value,title]) => ({id:`${field}:${value}`,title,selected:selected[field] === value}));
    const chosen = options.find(option => option.selected)?.title ?? "";
    const title = field === "sort" ? chosen : selected[field] !== "all" ? (field === "checks" ? `${chosen} checks` : chosen) : {draft:"Drafts",review:"Reviews",checks:"Checks"}[field];
    return {id:field,title,options};
  });
  const reset = count > 0 || sort !== "updated";
  return {count,reset,groups,menu:JSON.stringify({groups,reset})};
}

export function orderPulls<T extends {updatedAt:string; createdAt:string}>(items: T[], sort: string) {
  if (sort === "updated") return items;
  return [...items].sort((left,right) => sort === "created" ? (right.createdAt || right.updatedAt).localeCompare(left.createdAt || left.updatedAt) : left.updatedAt.localeCompare(right.updatedAt));
}
