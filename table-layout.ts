import type { MarkdownBlock } from "./markdown";

export interface TableLayout { blockId: string; signature: string; widths: number[] }
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export class TableLayouts {
  private settled = new Map<string, { widths: number[]; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries = 64, private maxBytes = 1024 * 1024) {}

  load(inputs: MarkdownBlock[], request: (block: MarkdownBlock) => Promise<unknown>): Promise<TableLayout[]> {
    const work = inputs.map((block) => {
      const key = block.tableSignature;
      const cached = this.settled.get(key);
      if (cached) {
        this.settled.delete(key);
        this.settled.set(key, cached);
        return Promise.resolve([{ blockId: block.id, signature: key, widths: cached.widths }]);
      }
      try {
        return request(block).then((answer): TableLayout[] => {
          const result = object(answer);
          const widths = result.widths;
          if (!Array.isArray(widths) || widths.length !== block.columns ||
            !widths.every((width): width is number => typeof width === "number" && Number.isFinite(width) && width >= 60 && width <= 320)) return [];
          const bytes = key.length * 2 + widths.length * 8;
          if (!this.settled.has(key) && bytes <= this.maxBytes) {
            this.settled.set(key, { widths, bytes });
            this.bytes += bytes;
            while (this.settled.size > this.maxEntries || this.bytes > this.maxBytes) {
              const first = this.settled.entries().next().value;
              if (!first) break;
              this.bytes -= first[1].bytes;
              this.settled.delete(first[0]);
            }
          }
          return [{ blockId: block.id, signature: key, widths }];
        }).catch(() => []);
      } catch { return Promise.resolve([]); }
    });
    return Promise.all(work).then((layouts) => layouts.flat());
  }
}
