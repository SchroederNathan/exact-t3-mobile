import type { Args } from "./app.contract.d.ts";

export function pullDiffRows(files:Args<"pullDiffRows">[0], collapsed:readonly string[]) {
  const closed = new Set(collapsed);
  return files.flatMap(file=>{
    const head = {key:`file:${file.path}`,path:file.path,kind:"file",text:file.path,oldLine:"",newLine:"",prefix:"",expanded:!closed.has(file.path),added:file.additions,deleted:file.deletions};
    if (closed.has(file.path)) return [head];
    if (file.omitted) return [head,{...head,key:`omit:${file.path}`,kind:"meta",text:"Patch omitted"}];
    return [head,...file.rows.map(line=>({...head,key:`line:${line.id}:${file.path}`,kind:line.kind,text:line.text,oldLine:line.oldLine,newLine:line.newLine,prefix:line.kind==="addition"?"+":line.kind==="deletion"?"−":""}))];
  });
}
