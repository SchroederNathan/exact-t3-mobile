// Prints DM Sans advance widths (per mille of the em) for printable ASCII, for new-task.ts.
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? new URL("../assets/fonts/DMSans_400Regular.ttf", import.meta.url).pathname;
const data = new DataView(readFileSync(path).buffer);
const tables = new Map<string, number>();
for (let index = 0; index < data.getUint16(4); index++) {
  const record = 12 + index * 16;
  const tag = String.fromCharCode(...[0, 1, 2, 3].map((i) => data.getUint8(record + i)));
  tables.set(tag, data.getUint32(record + 8));
}
const head = tables.get("head")!, hhea = tables.get("hhea")!, hmtx = tables.get("hmtx")!, cmap = tables.get("cmap")!;
const unitsPerEm = data.getUint16(head + 18);
const metrics = data.getUint16(hhea + 34);
let format4 = 0;
for (let index = 0; index < data.getUint16(cmap + 2); index++) {
  const record = cmap + 4 + index * 8;
  const offset = cmap + data.getUint32(record + 4);
  if (data.getUint16(offset) === 4) format4 = offset;
}
const segments = data.getUint16(format4 + 6) / 2;
const glyph = (code: number) => {
  for (let s = 0; s < segments; s++) {
    const end = data.getUint16(format4 + 14 + s * 2);
    if (code > end) continue;
    const startAt = format4 + 16 + segments * 2 + s * 2;
    const start = data.getUint16(startAt);
    if (code < start) return 0;
    const delta = data.getInt16(startAt + segments * 2);
    const rangeAt = startAt + segments * 4;
    const range = data.getUint16(rangeAt);
    if (range === 0) return (code + delta) & 0xffff;
    const id = data.getUint16(rangeAt + range + (code - start) * 2);
    return id === 0 ? 0 : (id + delta) & 0xffff;
  }
  return 0;
};
const advance = (id: number) => data.getUint16(hmtx + Math.min(id, metrics - 1) * 4);
const widths = [];
for (let code = 32; code < 127; code++) widths.push(Math.round((advance(glyph(code)) / unitsPerEm) * 1000));
widths.push(Math.round((advance(glyph(0x2026)) / unitsPerEm) * 1000));
console.log(JSON.stringify(widths));
