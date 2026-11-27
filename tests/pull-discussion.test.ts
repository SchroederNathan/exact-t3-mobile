import {expect,test} from "bun:test";
import {discussionGrants,discussionPage,discussionPosts,discussionSeeds} from "../pull-discussion";

test("discussion writes require the connection, host and viewer to permit that exact action",()=>{
  const detail = {capabilities:{review:{reply:true,resolve:true}},viewerPermissions:{comment:true,resolve:false}};
  expect(discussionGrants(detail,true)).toEqual({canReply:true,canResolve:false});
  expect(discussionGrants(detail,false)).toEqual({canReply:false,canResolve:false});
  expect(discussionGrants({...detail,capabilities:{review:{reply:"true"}},viewerPermissions:{comment:true,resolve:true}},true)).toEqual({canReply:false,canResolve:false});
  expect(discussionGrants({},true)).toEqual({canReply:false,canResolve:false});
  expect(discussionSeeds({reviewThreads:[{id:"restricted",canResolve:false}]})[0]?.resolutionAllowed).toBe(false);
});

test("discussion pages preserve fresh seed edits, order and distinct conversation IDs",()=>{
  const seeds=discussionSeeds({reviewThreads:[{id:"file",path:"a",line:4,commentCount:3,comments:[{id:"current",body:"edit",createdAt:"2026-01-02"}]}],overviewThreads:[{id:"general",path:null,comments:[]}]});
  expect(seeds.map(seed=>[seed.id,seed.path,seed.count])).toEqual([["file","a",3],["general","",0]]);
  const extra=discussionPosts([{id:"current",body:"old"},{id:"earlier",body:"start",createdAt:"2026-01-01"},{body:"no identity"}]);
  expect(discussionPage(seeds[0]!,extra).map(post=>[post.id,post.body])).toEqual([["earlier","start"],["current","edit"]]);
});
