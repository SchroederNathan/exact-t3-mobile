import { expect, test } from "bun:test";
import { decodePullRoute, providerLink, pullRouteKey } from "../pull-route";

test("provider actions preserve an explicit web URL and never share embedded credentials or invent an address",()=>{
  for (const url of ["https://code.example.invalid/Org/My%20Project/pull/9?view=files#L4","http://git.internal:8080/org/review/9"]) expect(providerLink(url)).toBe(url);
  for (const url of ["","/pull/9","//git.invalid/pull/9","javascript:alert(1)","https://token@git.invalid/pr/9","https://u:p@git.invalid","https://git.invalid/\npath","https://git.invalid\\other.invalid"]) expect(providerLink(url)).toBe("");
});

test("canonical PR routes round trip without normalizing host, repository, or Unicode", () => {
  const key = pullRouteKey("laptop:一", "project/one", "host.internal:443", "Org/repo%2F");
  expect(decodePullRoute(key, "29")).toEqual({environmentId:"laptop:一",projectId:"project/one",host:"host.internal:443",repository:"Org/repo%2F",routeKey:key,number:29});
  for (const number of ["0","-1","1e3","01","9007199254740992"]) expect(decodePullRoute(key,number)).toBeUndefined();
});

test("ambiguous, malformed, empty and overlong PR route identities do not resolve directly", () => {
  for (const key of ["project", "pr-z1", "pr-fff", "pr-ff", pullRouteKey("e","p","","r"),pullRouteKey("e","p","h","\n"),pullRouteKey("e","p","h","a".repeat(5000))]) expect(decodePullRoute(key,"9")).toBeUndefined();
});
