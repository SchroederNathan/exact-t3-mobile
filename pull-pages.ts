type RecordValue = Record<string, unknown>;
export type PullPageRequest = {limit: number; cursors?: Record<string,string>};
const pageSize = 30;

function entries(page: RecordValue): RecordValue[] {
  return Array.isArray(page.entries) ? page.entries.filter(entry => entry && typeof entry === "object") : [];
}

function nextRequest(page: RecordValue, previous: PullPageRequest): PullPageRequest | null {
  const raw = page.nextCursors;
  const cursors = Object.fromEntries(Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}).filter((pair): pair is [string,string] => pair[0].trim() !== "" && typeof pair[1] === "string" && pair[1].trim() !== "" && pair[1].length <= 4096));
  if (Object.keys(cursors).length) {
    if (previous.cursors && Object.keys(cursors).length === Object.keys(previous.cursors).length && Object.entries(cursors).every(([key,value]) => previous.cursors?.[key] === value)) return null;
    return {limit:pageSize, cursors};
  }
  return page.truncated === true && previous.limit < 500 ? {limit:Math.min(500, previous.limit + pageSize)} : null;
}

function mergePage(previous: RecordValue, page: RecordValue): RecordValue {
  const byKey = new Map<string,RecordValue>();
  for (const entry of [...entries(previous),...entries(page)]) {
    const key = JSON.stringify([entry.host, entry.projectId, entry.repository, entry.number]);
    const held = byKey.get(key);
    if (!held || (Number(entry.observedAt ?? Date.parse(String(entry.updatedAt))) || 0) >= (Number(held.observedAt ?? Date.parse(String(held.updatedAt))) || 0)) byKey.set(key,entry);
  }
  return {...previous,...page,entries:[...byKey.values()], viewers:{...(previous.viewers as object),...(page.viewers as object)}, providers:page.providers ?? previous.providers};
}

export class PullPages {
  private active?: {key:string; index:number; page:RecordValue; next:PullPageRequest|null; consumed:Set<string>};

  async read(key:string, index:number, fetchPage:(request:PullPageRequest)=>Promise<RecordValue>) {
    let chain = this.active;
    if (index === 0 || !chain || chain.key !== key) {
      chain = {key,index,page:{},next:{limit:pageSize},consumed:new Set()};
      this.active = chain;
    } else if (chain.index === index || !chain.next) {
      return {page:chain.page, hasMore:chain.next !== null, moreError:""};
    }
    const request = chain.next!;
    chain.index = index;
    try {
      const result = await fetchPage(request);
      if (this.active !== chain || chain.index !== index) throw new Error("The pull request list changed.");
      chain.page = mergePage(chain.page,result);
      const signature = (input:PullPageRequest) => JSON.stringify([input.limit,Object.entries(input.cursors ?? {}).sort(([left],[right])=>left.localeCompare(right))]);
      chain.consumed.add(signature(request));
      chain.next = nextRequest(result,request);
      if (chain.next && chain.consumed.has(signature(chain.next))) chain.next = null;
      return {page:chain.page, hasMore:Boolean(chain.next), moreError:""};
    } catch (error) {
      if (this.active !== chain || chain.index !== index || !Object.keys(chain.page).length) throw error;
      return {page:chain.page, hasMore:true, moreError:error instanceof Error ? error.message : "More pull requests could not be loaded."};
    }
  }
}
