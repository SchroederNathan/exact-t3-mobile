import type { MarkdownBlock } from "./markdown";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ImageFrame extends Rect {
  cell: number;
  part: number;
}
interface Measurement {
  widths: number[];
  height: number;
  cells: Rect[];
  images: ImageFrame[];
}
export interface TableImageLayout extends Rect {
  blockId: string;
  alt: string;
  inlineImage: boolean;
}
export interface TableLayout {
  blockId: string;
  signature: string;
  widths: number[];
  height: number;
  payload: string;
  images: TableImageLayout[];
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const rect = (value: unknown, width: number, height: number): value is Rect => {
  const source = object(value);
  return (
    [source.x, source.y, source.width, source.height].every(finite) &&
    Number(source.x) >= 0 &&
    Number(source.y) >= 0 &&
    Number(source.width) > 0 &&
    Number(source.height) > 0 &&
    Number(source.x) + Number(source.width) <= width + 0.01 &&
    Number(source.y) + Number(source.height) <= height + 0.01
  );
};

function measurement(answer: unknown, block: MarkdownBlock): Measurement | null {
  const result = object(answer);
  const widths = result.widths;
  if (
    !Array.isArray(widths) ||
    widths.length !== block.columns ||
    !widths.every((width): width is number => finite(width) && width >= 60 && width <= 320)
  )
    return null;
  const imageCount = block.cells.reduce(
    (total, cell) => total + cell.parts.filter((part) => part.imageSource !== "").length,
    0,
  );
  if (imageCount === 0) return { widths, height: 0, cells: [], images: [] };
  const { height, cells, images } = result;
  const width = widths.reduce((sum, column) => sum + column, 0);
  if (
    !finite(height) ||
    height <= 0 ||
    !Array.isArray(cells) ||
    cells.length !== block.cells.length ||
    !cells.every((cell): cell is Rect => rect(cell, width, height)) ||
    !Array.isArray(images) ||
    images.length !== imageCount
  )
    return null;
  const unique = new Set<string>();
  const validImages = images.every((image): image is ImageFrame => {
    const source = object(image);
    if (
      !rect(source, width, height) ||
      !Number.isInteger(source.cell) ||
      !Number.isInteger(source.part)
    )
      return false;
    const cell = block.cells[Number(source.cell)];
    const part = cell?.parts[Number(source.part)];
    const key = `${source.cell}:${source.part}`;
    if (
      !part?.imageSource ||
      unique.has(key) ||
      source.height !== (part.inlineImage ? 20 : 200) ||
      source.width !== (part.inlineImage ? 20 : widths[cell!.column]! - 20)
    )
      return false;
    unique.add(key);
    return true;
  });
  return validImages ? { widths, height, cells, images } : null;
}

function bind(block: MarkdownBlock, measured: Measurement): TableLayout {
  return {
    blockId: block.id,
    signature: block.tableSignature,
    widths: measured.widths,
    height: measured.height,
    images: measured.images.map((image) => {
      const part = block.cells[image.cell]!.parts[image.part]!;
      return {
        blockId: part.id,
        alt: part.imageAlt,
        inlineImage: part.inlineImage,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      };
    }),
    payload:
      measured.images.length === 0
        ? ""
        : JSON.stringify({
            columns: block.columns,
            labels: block.cells.map((cell) =>
              cell.parts
                .map((part) =>
                  part.imageSource ? part.imageAlt : part.runs.map((run) => run.text).join(""),
                )
                .join(""),
            ),
            cells: block.cells.map((cell) => ({
              column: cell.column,
              header: cell.header,
              align: cell.align,
              parts: cell.parts.map((part) => ({
                image: part.imageSource !== "",
                inlineImage: part.inlineImage,
                runs: part.runs.map(({ text, strong, emphasis, strike, code, href, linkKind }) => ({
                  text,
                  strong,
                  emphasis,
                  strike,
                  code,
                  href,
                  linkKind,
                })),
              })),
            })),
            frames: measured.cells,
            images: measured.images,
          }),
  };
}

export class TableLayouts {
  private settled = new Map<string, { measured: Measurement; bytes: number }>();
  private bytes = 0;
  constructor(
    private maxEntries = 64,
    private maxBytes = 1024 * 1024,
  ) {}

  load(
    inputs: MarkdownBlock[],
    request: (block: MarkdownBlock) => Promise<unknown>,
  ): Promise<TableLayout[]> {
    const work = inputs.map((block) => {
      const key = block.tableSignature;
      const cached = this.settled.get(key);
      if (cached) {
        this.settled.delete(key);
        this.settled.set(key, cached);
        return Promise.resolve([bind(block, cached.measured)]);
      }
      try {
        return request(block)
          .then((answer): TableLayout[] => {
            const measured = measurement(answer, block);
            if (!measured) return [];
            const bytes =
              key.length * 2 +
              measured.widths.length * 8 +
              measured.cells.length * 32 +
              measured.images.length * 48;
            if (!this.settled.has(key) && bytes <= this.maxBytes) {
              this.settled.set(key, { measured, bytes });
              this.bytes += bytes;
              while (this.settled.size > this.maxEntries || this.bytes > this.maxBytes) {
                const first = this.settled.entries().next().value;
                if (!first) break;
                this.bytes -= first[1].bytes;
                this.settled.delete(first[0]);
              }
            }
            return [bind(block, measured)];
          })
          .catch(() => []);
      } catch {
        return Promise.resolve([]);
      }
    });
    return Promise.all(work).then((layouts) => layouts.flat());
  }
}
