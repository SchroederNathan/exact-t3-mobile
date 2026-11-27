const choices = {
  draft: { all: "All drafts", only: "Drafts only", hide: "Hide drafts" },
  review: { all: "All reviews", approved: "Approved", "changes-requested": "Changes requested", "review-required": "Review required", none: "No reviews" },
  checks: { all: "All checks", passing: "Passing", failing: "Failing" },
  sort: { updated: "Recently updated", created: "Newest created", oldest: "Oldest updated" },
};

interface MenuProject { id:string; environmentId:string; title:string; workspaceRoot:string; repositoryKey:string; isScratch:boolean }

export function pullProjectOptions(projects: MenuProject[], environments: {id:string; label:string}[], scope: string, selected: string) {
  const unique = new Map<string,MenuProject>();
  for (const project of projects) {
    if (project.isScratch || (scope && project.environmentId !== scope)) continue;
    const key = JSON.stringify([project.environmentId, project.repositoryKey ? ["repo",project.repositoryKey.toLowerCase()] : ["id",project.id]]);
    if (!unique.has(key) || project.id === selected) unique.set(key,project);
  }
  const rows = [...unique.values()].map(project => ({...project}));
  for (const suffix of [(row:MenuProject)=>environments.find(env=>env.id===row.environmentId)?.label || row.environmentId,(row:MenuProject)=>row.workspaceRoot,(row:MenuProject)=>row.environmentId,(row:MenuProject)=>row.id]) {
    const counts = new Map<string,number>();
    for (const row of rows) counts.set(row.title,(counts.get(row.title) ?? 0)+1);
    for (const row of rows) if (counts.get(row.title)! > 1 && suffix(row)) row.title += ` · ${suffix(row)}`;
  }
  return rows.sort((left,right)=>left.title.localeCompare(right.title)).map(row=>({id:`project:${row.id}`,title:row.title,selected:row.id===selected}));
}

export function pullControlMenu(state: string, involvement: string, draft: string, review: string, checks: string, sort: string, projects: MenuProject[] = [], environments: {id:string; label:string}[] = [], scope = "", project = "", facetCount = 0) {
  const selected = {draft, review, checks, sort};
  const projectOptions = pullProjectOptions(projects,environments,scope,project);
  const chosenProject = projectOptions.find(option=>option.selected);
  const count = facetCount + [state !== "open", involvement !== "all", draft !== "all", review !== "all", checks !== "all", chosenProject].filter(Boolean).length;
  const groups: {id:string;title:string;options:{id:string; title:string; selected:boolean}[]}[] = (Object.keys(choices) as (keyof typeof choices)[]).map(field => {
    const options = Object.entries(choices[field]).map(([value,title]) => ({id:`${field}:${value}`,title,selected:selected[field] === value}));
    const chosen = options.find(option => option.selected)?.title ?? "";
    const title = field === "sort" ? chosen : selected[field] !== "all" ? (field === "checks" ? `${chosen} checks` : chosen) : {draft:"Drafts",review:"Reviews",checks:"Checks"}[field];
    return {id:field,title,options};
  });
  groups.splice(3,0,{id:"project",title:chosenProject?.title ?? "Project",options:[{id:"project:",title:"All projects",selected:!chosenProject},...projectOptions]});
  const reset = count > 0 || sort !== "updated";
  return {count,reset,groups,menu:JSON.stringify({groups,reset})};
}

export function orderPulls<T extends {updatedAt:string; createdAt:string}>(items: T[], sort: string) {
  if (sort === "updated") return items;
  return [...items].sort((left,right) => sort === "created" ? (right.createdAt || right.updatedAt).localeCompare(left.createdAt || left.updatedAt) : left.updatedAt.localeCompare(right.updatedAt));
}

export function pullFacets(items: {author:string;row:{allLabels:{name:string;color:string}[]}}[], labels:string[], author:string) {
  const build = (field:string, selected:string[], suggestions:{title:string;color:string}[]) => {
    const colors = new Map(suggestions.filter(entry=>entry.color).map(entry=>[entry.title.toLowerCase(),entry.color]));
    const values = new Map<string,string>();
    for (const name of [...selected,...suggestions.map(entry=>entry.title).sort((left,right)=>left.localeCompare(right))]) {
      if (name && !values.has(name.toLowerCase()) && values.size < 60) values.set(name.toLowerCase(),name);
    }
    const options = [{id:"",title:`All ${field}`,color:"",selected:!selected.length},...Array.from(values,([key,value])=>({id:value,title:field==="authors" && key==="me" ? "Me" : value,color:colors.get(key) ?? "",selected:selected.some(name=>name.toLowerCase()===key)}))];
    if (field==="authors") {
      const me = options.findIndex(option=>option.id.toLowerCase()==="me");
      options.splice(1,0,me < 0 ? {id:"me",title:"Me",color:"",selected:false} : options.splice(me,1)[0]!);
    }
    return {options,menu:JSON.stringify(options)};
  };
  return {labels:build("labels",labels,items.flatMap(item=>item.row.allLabels.map(label=>({title:label.name,color:label.color})))),authors:build("authors",author?[author]:[],items.map(item=>({title:item.author,color:""})))};
}
