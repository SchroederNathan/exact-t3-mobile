import type { Storage } from "./app.contract.d.ts";

const path = "app:/data/pull-list-controls-v1.json";
const choices = {state:["open","closed","merged","all"],involvement:["all","reviewing","authored"],draft:["all","only","hide"],review:["all","approved","changes-requested","review-required","none"],checks:["all","passing","failing"],sort:["updated","created","oldest"]};
const plain = (value:unknown):value is Record<string,unknown>=>typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value:unknown, limit:number)=>typeof value==="string" && value.length <= limit ? value : "";

export function decodePullPreferences(value:unknown) {
  if (!plain(value) || value.version!==1 || !Array.isArray(value.scopes)) throw new Error("Saved pull request filters could not be read.");
  return value.scopes.flatMap(entry=>{
    if (!plain(entry) || typeof entry.scope!=="string" || entry.scope.length>1024) return [];
    const option = (field:keyof typeof choices)=>typeof entry[field]==="string" && choices[field].includes(entry[field]) ? entry[field] : choices[field][0]!;
    const labels = Array.isArray(entry.labels) ? [...new Set(entry.labels.map(label=>text(label,200)).filter(Boolean))].slice(0,10) : [];
    return [{scope:entry.scope,state:option("state"),involvement:option("involvement"),draft:option("draft"),review:option("review"),checks:option("checks"),sort:option("sort"),labels,author:text(entry.author,200),project:text(entry.project,2048)}];
  });
}

export async function readPullPreferences(fs: Pick<Storage["fs"],"readFile">) {
  let bytes;
  try { bytes=await fs.readFile(path); }
  catch (error) { if (plain(error) && error.code === "ENOENT") return []; throw error; }
  return decodePullPreferences(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function writePullPreference(fs: Pick<Storage["fs"],"readFile"|"atomicWriteFile">, entry:ReturnType<typeof decodePullPreferences>[number]) {
  const saved = await readPullPreferences(fs);
  await fs.atomicWriteFile(path,new TextEncoder().encode(JSON.stringify({version:1,scopes:[...saved.filter(row=>row.scope!==entry.scope),entry]})));
}
