import { expect, test } from "bun:test";
import { PullPages, type PullPageRequest } from "../pull-pages";

test("pagination retains rows on failure and retries only an unconsumed cursor", async () => {
  const book = new PullPages(); const requests:PullPageRequest[]=[];
  const entry = {host:"git.test",projectId:"test",repository:"org/repo",number:4,observedAt:2,title:"Current"};
  const fetchPage = async (request:PullPageRequest) => {
    requests.push(request);
    if (requests.length === 1) return {entries:[entry],nextCursors:{repo:"c1"},truncated:true};
    if (requests.length === 2) throw Error("Try later");
    return {entries:[{...entry,observedAt:1,title:"Stale"},{...entry,number:5}],nextCursors:{}};
  };
  expect((await book.read("A",0,fetchPage)).hasMore).toBe(true);
  expect((await book.read("A",1,fetchPage)).moreError).toBe("Try later");
  const final = await book.read("A",2,fetchPage);
  expect(final.page.entries).toEqual([entry,{...entry,number:5}]); expect(final.hasMore).toBe(false);
  await book.read("A",3,fetchPage);
  expect(requests).toEqual([{limit:30},{limit:30,cursors:{repo:"c1"}},{limit:30,cursors:{repo:"c1"}}]);
});

test("legacy capped lists widen up to 500 and cursor cycles stop", async () => {
  const book=new PullPages();const limits:number[]=[];
  for (let index=0;index<20;index++) await book.read("older",index,async ({limit})=>{limits.push(limit);return {truncated:true};});
  expect(limits.slice(-2)).toEqual([480,500]); expect(limits.length).toBe(17);
  for(const [index,next] of ["one","two","one"].entries()) {
    const reply=await book.read("cursor",index,async()=>({nextCursors:{repo:next}}));expect(reply.hasMore).toBe(index!==2);
  }
});

test("a late page cannot overwrite a newly selected filter", async () => {
  const book=new PullPages();let finish!: (value:Record<string,unknown>)=>void;
  const late=book.read("old",0,()=>new Promise(resolve=>{finish=resolve;}));
  await book.read("new",0,async()=>({entries:[]}));finish({entries:[{number:4}]});
  await expect(late).rejects.toThrow("list changed");
});
