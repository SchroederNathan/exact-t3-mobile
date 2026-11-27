import {expect, test} from "bun:test";
import {pullSearch, pullListPredicate} from "../pull-search";

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
