import { expect, test } from "bun:test";
import { changedFiles, ChangedFilePages, filePickerRows } from "../pull-files";

const sample = (name: string, nextCursor: string | null = null) => ({patch:`diff --git a/${name} b/${name}\n@@ -1 +1 @@\n-old\n+new`, truncated:false, nextCursor});

test("file picker sorts directories and paths independently without mutating diff order", () => {
  const files = ["src/z.ts","root","a/first","src/a.ts"].flatMap(path=>changedFiles(sample(path)).files);
  expect(filePickerRows(files,["a"]).map(row=>row.key)).toEqual(["dir:","file:root","dir:a","dir:src","file:src/a.ts","file:src/z.ts"]);
  expect(filePickerRows(files,[""])[0]?.label).toBe("Repository root");
  expect(files[0]?.path).toBe("src/z.ts");
});

test("renames separate the actual target from display text, including literal arrows and backslashes", () => {
  const patch = 'diff --git a/old.ts "b/src/new → literal\\\\name.ts"\nrename from old.ts\nrename to "src/new → literal\\\\name.ts"\n--- a/old.ts\n+++ "b/src/new → literal\\\\name.ts"\n@@ -1 +1 @@\n-a\n+b';
  const path = 'src/new → literal\\name.ts';
  const result = changedFiles({patch,truncated:false,nextCursor:null,omittedFileStats:[{path,additions:0,deletions:0}]});
  expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({path,directory:"src",name:'new → literal\\name.ts',previousPath:"old.ts",copied:false,additions:1,deletions:1});
  const copy = changedFiles({patch:"diff --git a/old b/new\ncopy from old\ncopy to new",truncated:false,nextCursor:null});
  expect(copy.files[0]).toMatchObject({path:"new",previousPath:"old",copied:true});
});

test("review filtering keeps production and generated paths, including similarly named files", () => {
  const paths = ["tests/a.swift", "pkg/FooTest.java", "src/Latest.java", "src/foo.spec.ts", "pkg/__snapshots__/x.snap", "tests/generated/model.ts", "src/latest.ts"];
  const stats = changedFiles({...sample("src/a.ts"), omittedFileStats:paths.map(path=>({path,additions:1,deletions:0}))}).files;
  expect(stats.filter(file=>file.testFile).map(file=>file.path)).toEqual([paths[0],paths[1],paths[3],paths[4]]);
  expect(stats[0]).toMatchObject({name:"a.ts",directory:"src",testFile:false});
});

test("file stats distinguish omitted patches from zero-line changes", () => {
  const parsed = changedFiles({...sample("first"), omittedFileStats:[{path:"missing",additions:3,deletions:0} ]});
  expect(parsed.files.map(({path, additions, deletions, omitted}) => [path, additions, deletions, omitted])).toEqual([["first",1,1,false],["missing",3,0,true]]);
  expect(() => changedFiles({})).toThrow("invalid diff");
});

test("a failed page retries its opaque cursor without dropping earlier files; cycles stop", async () => {
  const pages = new ChangedFilePages();
  const failure = async () => { throw new Error("offline"); };
  await expect(pages.read("a",0,failure)).rejects.toThrow("offline");
  expect((await pages.read("a",1,async cursor => {expect(cursor).toBe(""); return sample("one","next / 1");})).files).toHaveLength(1);
  expect((await pages.read("a",2,failure)).error).toBe("offline");
  const result = await pages.read("a",3,async cursor => {expect(cursor).toBe("next / 1"); return sample("two","next / 1");});
  expect(result.files.map(file => file.path)).toEqual(["one","two"]);
  expect(result.nextCursor).toBe("");
  expect(result.truncated).toBe(true);
});

test("late replies from another source-control host cannot overwrite the active diff", async () => {
  const pages = new ChangedFilePages();
  const pending = Promise.withResolvers<ReturnType<typeof sample>>();
  const first = pages.read("host-A",0,() => pending.promise);
  await pages.read("host-B",0,async () => sample("current"));
  pending.resolve(sample("stale"));
  await expect(first).rejects.toThrow("selected diff changed");
  expect((await pages.read("host-B",1,async () => {throw Error("unexpected");})).files[0]?.path).toBe("current");
});
