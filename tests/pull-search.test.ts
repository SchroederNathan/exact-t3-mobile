import {expect, test} from "bun:test";
import {pullSearch, pullListPredicate} from "../pull-search";
import {orderPulls, pullControlMenu, pullProjectOptions, pullFacets} from "../pull-controls";

test("advanced menu counts filters but not sort; typed qualifiers override selected filters", () => {
  const menu = pullControlMenu("open","all","only","approved","all","oldest");
  expect(menu.count).toBe(2);
  expect(menu.groups.map(group=>group.title)).toEqual(["Drafts only","Approved","Checks","Project","Oldest updated"]);
  expect(menu.groups.every(group=>group.options.filter(option=>option.selected).length === 1)).toBe(true);
  expect(pullControlMenu("open","all","all","all","all","created")).toMatchObject({count:0, reset:true});
  expect(pullSearch("draft:true review:approved draft:false").filters).toEqual({draft:"hide", review:"approved"});
});

test("project choices keep selected repo aliases, exclude scratch, and distinguish identical projects across servers", () => {
  const base = {title:"Client",repositoryKey:"Repo",workspaceRoot:"/client",isScratch:false};
  const projects = [{...base,id:"a:1",environmentId:"a"},{...base,id:"a:2",environmentId:"a",repositoryKey:"repo"},{...base,id:"b:1",environmentId:"b"},{...base,id:"c:1",environmentId:"c",isScratch:true}];
  const environments = [{id:"a",label:"Home"},{id:"b",label:"Work"}];
  expect(pullProjectOptions(projects,environments,"","a:2")).toEqual([{id:"project:a:2",title:"Client · Home",selected:true},{id:"project:b:1",title:"Client · Work",selected:false}]);
  expect(pullProjectOptions(projects,environments,"a","")).toEqual([{id:"project:a:1",title:"Client",selected:false}]);
});

test("sorts the loaded rows without mutating their default order", () => {
  const rows = [{updatedAt:"2026-05-04",createdAt:"2026-01-01"},{updatedAt:"2026-03-01",createdAt:"2026-02-10"}];
  expect(orderPulls(rows,"updated")).toBe(rows);
  expect(orderPulls(rows,"created")).toEqual([rows[1],rows[0]]);
  expect(orderPulls(rows,"oldest")).toEqual([rows[1],rows[0]]);
});

test("facet selections preserve literal punctuation and survive an empty filtered list", () => {
  const label = 'voice, "keyboard": UI';
  const rows = [{author:"juno",row:{allLabels:[{name:label,color:"#abcdef"},{name:"Docs",color:""}]}}];
  const facets = pullFacets(rows,[label],"me");
  expect(facets.labels.options[1]).toEqual({id:label,title:label,color:"#abcdef",selected:true});
  expect(facets.authors.options.map(option=>option.title)).toEqual(["All authors","Me","juno"]);
  expect(pullFacets([],[label],"juno").authors.options.at(-1)?.selected).toBe(true);
  expect(pullSearch("",[label,"Docs"],"me")).toEqual({filters:{labels:[[label],["Docs"]],author:"me"}});
  expect(pullSearch("label:other author:you",[label],"me")).toEqual({filters:{labels:[["other"]],author:"you"}});
  expect(pullControlMenu("open","all","all","all","all","updated",[],[],"","",3)).toMatchObject({count:3,reset:true});
});

test("PR search separates qualifiers from provider text without splitting quoted labels", () => {
  expect(pullSearch('keyboard label:"Reader, voice",UI -label:later kind:bug,task author:@me -draft:false checks:failure review:required')).toEqual({query:"keyboard",filters:{labels:[["Reader, voice","UI"],["kind:bug","kind:task"]],excludedLabels:["later"],author:"@me",draft:"only",checks:"failing",review:"review-required"}});
  expect(pullSearch('author:One author:two repo:ignored https://example.test/x draft:maybe')).toEqual({query:"https://example.test/x draft:maybe"});
  expect(pullSearch('"kind:term" '+ 'z'.repeat(220)).query?.length).toBe(200);
  expect(pullSearch(Array.from({length:12},(_,i)=>`label:${i}`).join(' ')).filters?.labels?.length).toBe(10);
});

test("local-only providers match every search word; host search can match unlisted body text", () => {
  const page = {providers:[{host:"local",searchesOnHost:false},{host:"remote",searchesOnHost:true}], viewers:{local:"Juno",remote:"Other"}};
  const row = {host:"local",number:42,state:"open",title:"Keyboard focus", author:{login:"juno"},labels:[{name:"UI"}],headBranch:"design"};
  const matches = (input: string, entry = row) => pullListPredicate(page,"open","all",input)(entry);
  expect(matches("#42 design label:ui author:@me")).toBe(true);
  expect(matches("bodyword")).toBe(false);
  expect(matches("bodyword",{...row,host:"remote"})).toBe(true);
  expect(matches("author:@me",{...row,host:"remote"})).toBe(false);
  expect(matches("-label:ui")).toBe(false);
  expect(matches("draft:true")).toBe(false);
  expect(matches("checks:passing")).toBe(true);
});
