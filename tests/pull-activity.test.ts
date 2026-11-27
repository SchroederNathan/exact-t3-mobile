import {expect,test} from "bun:test";
import {activityEvents,activityTimeline} from "../pull-activity";

test("activity filters keep bot verdicts and incomplete threads, never duplicate nested comments",()=>{
  const bot={login:"machine",isBot:true};
  const events=activityEvents({comments:[{id:"nested"},{id:"noise",author:bot},{id:"vote",author:bot,reviewState:"changes-requested",createdAt:"2026-01-05"},{id:"dismissed",reviewState:"DISMISSED"}],reviewThreads:[{id:"discussion",commentCount:2,comments:[{id:"nested",author:bot,createdAt:"2026-01-03"}]}],overviewThreads:[{id:"closed",isResolved:true,comments:[{id:"human",author:{login:"human"}}]}],commits:[{oid:"abc",messageHeadline:"Update",committedDate:"2026-01-04"}]});
  const latest=activityTimeline(events,"All activity",false,false,true);
  expect(latest.rows.map(row=>row.id)).toEqual(["vote","abc","discussion"]);
  expect(latest.hidden).toBe(3);
  expect(activityTimeline(events,"Comments",true,true,false).rows.map(row=>row.id)).not.toContain("nested");
  expect(activityTimeline(events,"Commits",true,true,false).rows.map(row=>row.id)).toEqual(["abc"]);
  expect(activityTimeline(events,"Comments",false,true,false).rows.some(row=>row.id==="closed")).toBe(true);
});
