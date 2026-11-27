import { expect, test } from "bun:test";
import { decodePullRoute, pullRouteKey } from "../pull-route";

test("canonical PR routes round trip without normalizing host, repository, or Unicode", () => {
  const key = pullRouteKey("laptop:一", "project/one", "host.internal:443", "Org/repo%2F");
  expect(decodePullRoute(key, "29")).toEqual({environmentId:"laptop:一",projectId:"project/one",host:"host.internal:443",repository:"Org/repo%2F",routeKey:key,number:29});
  for (const number of ["0","-1","1e3","01","9007199254740992"]) expect(decodePullRoute(key,number)).toBeUndefined();
});

test("ambiguous, malformed, empty and overlong PR route identities do not resolve directly", () => {
  for (const key of ["project", "pr-z1", "pr-fff", "pr-ff", pullRouteKey("e","p","","r"),pullRouteKey("e","p","h","\n"),pullRouteKey("e","p","h","a".repeat(5000))]) expect(decodePullRoute(key,"9")).toBeUndefined();
});
