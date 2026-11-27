import {expect,test} from "bun:test";
import {decodePullPreferences,readPullPreferences,writePullPreference} from "../pull-preferences";

test("pull filters restore independent scopes and don't replace an unreadable saved file",async()=>{
  let contents:string|undefined;
  const fs = {readFile:async()=>{if(contents===undefined) throw Object.assign(new Error("missing"),{code:"ENOENT"});return new TextEncoder().encode(contents).buffer;},atomicWriteFile:async(_path:string,data:ArrayBuffer|Uint8Array)=>{contents=new TextDecoder().decode(data);}};
  expect(await readPullPreferences(fs)).toEqual([]);
  const [all,secondary] = decodePullPreferences({version:1,scopes:[{scope:"",labels:["a,b", "a,b"]},{scope:"secondary",author:"me",project:"secondary:shared",state:"unsupported",sort:"oldest"}]});
  await writePullPreference(fs,all!);await writePullPreference(fs,secondary!);await writePullPreference(fs,{...all!,sort:"created"});
  expect(await readPullPreferences(fs)).toEqual([expect.objectContaining({scope:"secondary",author:"me",project:"secondary:shared",state:"open",sort:"oldest"}),expect.objectContaining({scope:"",labels:["a,b"],sort:"created"})]);
  contents='{"version":5,"scopes":[]}';await expect(writePullPreference(fs,all!)).rejects.toThrow();expect(contents).toBe('{"version":5,"scopes":[]}');
});
