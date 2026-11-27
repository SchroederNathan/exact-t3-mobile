import {expect,test} from "bun:test";
import {discussionPage,discussionPosts,discussionSeeds} from "../pull-discussion";

test("discussion pages preserve fresh seed edits, order and distinct conversation IDs",()=>{
  const seeds=discussionSeeds({reviewThreads:[{id:"file",path:"a",line:4,commentCount:3,comments:[{id:"current",body:"edit",createdAt:"2026-01-02"}]}],overviewThreads:[{id:"general",path:null,comments:[]}]});
  expect(seeds.map(seed=>[seed.id,seed.path,seed.count])).toEqual([["file","a",3],["general","",0]]);
  const extra=discussionPosts([{id:"current",body:"old"},{id:"earlier",body:"start",createdAt:"2026-01-01"},{body:"no identity"}]);
  expect(discussionPage(seeds[0]!,extra).map(post=>[post.id,post.body])).toEqual([["earlier","start"],["current","edit"]]);
});
