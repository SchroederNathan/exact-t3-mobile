import {object,string} from "./connection";

const records = (value:unknown) => Array.isArray(value) ? value.map(object) : [];
const actor = (value:unknown) => string(object(value).login) || string(object(value).name) || string(value) || "Unknown author";

function event(kind:string,id:string,author:unknown,body:unknown,date:unknown) {
  return {kind,id,key:`${kind}:${id}`,author:actor(author),body:string(body),date:string(date),path:"",line:0,summary:"",bot:object(author).isBot === true,resolved:false,outdated:false,replyCount:0};
}

export function activityEvents(value: Record<string,unknown>) {
  const nested = new Set<string>();
  const events: ReturnType<typeof event>[] = [];
  for (const thread of [...records(value.reviewThreads),...records(value.overviewThreads)]) {
    const id = string(thread.id);
    if (!id) continue;
    const comments = records(thread.comments);
    for (const comment of comments) nested.add(string(comment.id));
    const first = comments[0];
    const replyCount = Math.max(comments.length, Number.isSafeInteger(thread.commentCount) ? Number(thread.commentCount) : 0);
    events.push({...event("discussion",id,first?.author,first?.body,first?.createdAt),path:string(thread.path),line:Number.isSafeInteger(thread.line) ? Number(thread.line) : 0,replyCount,summary:"started a discussion",resolved:thread.isResolved === true,outdated:thread.isOutdated === true,bot:comments.length === replyCount && !thread.nextCommentsCursor && comments.every(comment=>object(comment.author).isBot === true)});
  }
  for (const comment of records(value.comments)) {
    const id = string(comment.id);
    if (!id || nested.has(id)) continue;
    const state = string(comment.reviewState).trim().toUpperCase().replaceAll("-","_");
    const row = event("comment",id,comment.author,comment.body,comment.createdAt);
    const verdict = state === "APPROVED" || state === "CHANGES_REQUESTED";
    events.push({...row,path:string(comment.path),summary:state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "requested changes" : "commented",bot:row.bot && !verdict,resolved:state === "DISMISSED"});
  }
  for (const commit of records(value.commits)) {
    const id = string(commit.oid) || string(commit.id);
    if (id) events.push({...event("commit",id,records(commit.authors)[0],commit.messageHeadline ?? commit.subject ?? commit.message,commit.committedDate ?? commit.createdAt),summary:"committed",bot:false});
  }
  return events.sort((left,right)=>left.date.localeCompare(right.date));
}

export function activityTimeline(events:readonly ReturnType<typeof event>[],kind:string,bots:boolean,resolved:boolean,newest:boolean) {
  const rows = events.filter(row => (kind === "All activity" || (kind === "Commits" ? row.kind === "commit" : row.kind !== "commit")) && (bots || !row.bot) && (resolved || !row.resolved));
  return {rows:newest ? rows.reverse() : rows,hidden:events.length-rows.length};
}
