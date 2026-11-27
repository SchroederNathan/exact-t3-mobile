type FacetChoice = {id:string;title:string;color:string;selected:boolean};

export function hostFacetChoices(kind:string, value:Record<string,unknown>): FacetChoice[] {
  const entries = kind === "labels" ? value.labels : value.authors;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry=>{
    if (!entry || typeof entry !== "object") return [];
    const name = kind === "labels" ? entry.name : entry.login;
    if (typeof name !== "string" || !name.trim() || name.length>200) return [];
    const color = typeof entry.color === "string" ? entry.color.replace(/^#/,"") : "";
    return [{id:name,title:name,color:kind === "labels" && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "",selected:false}];
  });
}

export function facetSearchRows(selected:string[], suggestions:FacetChoice[], hosted:FacetChoice[], query:string) {
  const lower = (value:string)=>value.toLowerCase();
  const selection = new Set(selected.map(lower));
  const colors = new Map([...hosted,...suggestions].filter(item=>item.color).map(item=>[lower(item.id),item.color]));
  const loaded = suggestions.filter(item=>item.id && lower(item.id).includes(lower(query.trim())));
  const rows = new Map<string,FacetChoice>();
  for (const item of [...selected.map(id=>({id,title:id,color:"",selected:true})),...loaded.slice(0,50),...hosted,...loaded.slice(50)]) {
    const key = lower(item.id);
    if (key && !rows.has(key)) rows.set(key,{...item,color:colors.get(key) ?? "",selected:selection.has(key)});
    if (rows.size === 100) break;
  }
  return [...rows.values()];
}
