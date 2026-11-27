import { expect, test } from "bun:test";
import { pullRow } from "../pull-row";

test("PR rows expose all labels and status to assistive tech while only two chips take space", () => {
  const row = pullRow({state:"open", provider:"gitlab", title:"Keyboard", number:3, author:{login:"Élodie"}, mergeability:"conflicting", baseBranch:"main", labels:[{name:"UI",color:"#aBc123"},{name:"Docs",color:"url(bad)"},{name:"More"}], stack:{position:2,size:3}, checksState:"pending", viewerReviewRequested:true, reviewDecision:"approved", additions:1240, deletions:0});
  expect(row.labels).toEqual([{name:"UI",color:"#aBc123"},{name:"Docs",color:""}]);
  expect(row.extraLabels).toBe(1);
  expect(row.accessible).toBe("Merge request 3, Keyboard, Open, conflicts with main, by Élodie, Reviews approved, checks pending, stack 2 of 3, UI, Docs, More, 1240 additions, 0 deletions");
  expect(row.initial).toBe("É");
  expect(row.addedText).toBe(`+${(1240).toLocaleString()}`);
  expect(row.deletedText).toBe("");
});

test("PR rows suppress inapplicable state rather than inventing badges", () => {
  for (const [state,status] of [["merged","Merged"],["closed","Closed"],["open","Draft"]]) {
    const row = pullRow({state, isDraft:true, mergeability:"conflicting", stack:{position:2,size:1}, labels:[{},null],updatedAt:"bad"});
    expect([row.status,row.conflict,row.stackText,row.initial,row.updatedMs,row.labels]).toEqual([status,false,"","?",0,[]]);
  }
});
