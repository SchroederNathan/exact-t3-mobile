import {expect,test} from "bun:test";
import {changedFiles} from "../pull-files";
import {pullDiffRows} from "../pull-diff-view";

test("diff rows preserve line numbers, page-local IDs and whitespace across file folds",()=>{
  const files = ["folder/a","folder/b"].flatMap(path=>changedFiles({patch:`diff --git a/${path} b/${path}\n@@ -5 +8 @@\n-  before\n+  after`,truncated:false,nextCursor:null}).files);
  const rows = pullDiffRows(files,["folder/b"]);
  expect(rows.filter(row=>row.kind==="file").map(row=>[row.key,row.expanded])).toEqual([["file:folder/a",true],["file:folder/b",false]]);
  expect(rows.find(row=>row.kind==="addition")).toMatchObject({oldLine:"",newLine:"8",text:"  after",prefix:"+"});
  expect(rows.find(row=>row.kind==="deletion")).toMatchObject({oldLine:"5",newLine:"",text:"  before",prefix:"−"});
  const open = pullDiffRows(files,[]);expect(new Set(open.map(row=>row.key)).size).toBe(open.length);
});
