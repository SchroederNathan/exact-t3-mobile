import {object,string} from "./connection";

export function discussionGrants(detail: Record<string,unknown>, writable: boolean) {
  const review = object(object(detail.capabilities).review), viewer = object(detail.viewerPermissions);
  return {canReply: writable && review.reply === true && viewer.comment === true, canResolve: writable && review.resolve === true && viewer.resolve === true};
}

export function discussionPosts(value:unknown) {
  return (Array.isArray(value) ? value : []).flatMap(entry=>{
    const raw=object(entry),id=string(raw.id),author=object(raw.author);
    return id ? [{id,author:string(author.login)||string(author.name)||"Unknown author",body:string(raw.body),date:string(raw.createdAt),edited:string(raw.editedAt)}] : [];
  });
}

export function discussionSeeds(value:Record<string,unknown>) {
  return [value.reviewThreads,value.overviewThreads].flatMap(items=>Array.isArray(items)?items:[]).flatMap(entry=>{
    const raw=object(entry),id=string(raw.id),posts=discussionPosts(raw.comments);
    return id ? [{id,path:string(raw.path),line:Number.isSafeInteger(raw.line)?Number(raw.line):0,resolved:raw.isResolved===true,resolutionAllowed:raw.canResolve!==false,outdated:raw.isOutdated===true,posts,next:string(raw.nextCommentsCursor),count:Math.max(posts.length,Number.isSafeInteger(raw.commentCount)?Number(raw.commentCount):0)}] : [];
  });
}

export function discussionPage(seed:ReturnType<typeof discussionSeeds>[number],extra:ReturnType<typeof discussionPosts>) {
  const posts=new Map([...extra,...seed.posts].map(post=>[post.id,post]));
  return [...posts.values()].sort((left,right)=>left.date.localeCompare(right.date)||left.id.localeCompare(right.id));
}
