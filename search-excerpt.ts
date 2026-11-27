export type ExcerptRun = { start: number; text: string; highlighted: boolean };

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’‘]/g, "'");

export function excerptRuns(snippet: string, query: string): ExcerptRun[] {
  let normalized = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const char of snippet) {
    const folded = fold(char);
    for (let index = 0; index < folded.length; index++) offsets.push(offset);
    normalized += folded;
    offset += char.length;
  }
  offsets.push(snippet.length);
  const highlighted = new Set<number>();
  const terms = fold(query).replace(/^["'`“”]+|["'`“”]+$/g, "").split(/\s+/).filter(Boolean);
  for (const term of new Set(terms)) {
    let cursor = 0;
    while (cursor < normalized.length) {
      const start = normalized.indexOf(term, cursor);
      if (start < 0) break;
      const end = start + term.length;
      for (let index = offsets[start]!; index < offsets[end]!; index++) highlighted.add(index);
      cursor = end;
    }
  }
  const runs: ExcerptRun[] = [];
  for (let index = 0; index < snippet.length;) {
    const start = index, selected = highlighted.has(index++);
    while (index < snippet.length && highlighted.has(index) === selected) index++;
    runs.push({ start, text: snippet.slice(start, index), highlighted: selected });
  }
  return runs;
}
