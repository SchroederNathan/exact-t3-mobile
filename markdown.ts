import { decodeHTML } from "entities";
import { Lexer, type MarkedToken, type Token } from "marked";
import { markdownLinkKind } from "./markdown-links";

export interface InlineRun {
  id: string;
  text: string;
  strong: boolean;
  emphasis: boolean;
  strike: boolean;
  code: boolean;
  href: string;
  linkKind: string;
}
export interface TableCell {
  id: string;
  column: number;
  header: boolean;
  align: string;
  runs: InlineRun[];
}
export interface MarkdownBlock {
  id: string;
  kind: "paragraph" | "heading" | "list-item" | "quote" | "code" | "thematic-break" | "table" | "markdown";
  body: string;
  marker: string;
  gutter: number;
  depth: number;
  quoteDepth: number;
  language: string;
  languageLabel: string;
  headingLevel: number;
  spacingAfter: number;
  runs: InlineRun[];
  cells: TableCell[];
  columns: number;
  tableSignature: string;
  pending: boolean;
}

const languageLabels: Record<string, string> = {
  bash: "Bash", c: "C", cc: "C++", cpp: "C++", cs: "C#", csharp: "C#", css: "CSS", cxx: "C++",
  dockerfile: "Dockerfile", go: "Go", golang: "Go", graphql: "GraphQL", html: "HTML", java: "Java",
  javascript: "JavaScript", js: "JavaScript", json: "JSON", jsx: "JSX", markdown: "Markdown", md: "Markdown",
  objc: "Objective-C", objectivec: "Objective-C", php: "PHP", py: "Python", python: "Python", rb: "Ruby",
  rs: "Rust", ruby: "Ruby", rust: "Rust", scss: "SCSS", sh: "Shell", shell: "Shell", sql: "SQL", swift: "Swift",
  toml: "TOML", ts: "TypeScript", tsx: "TSX", typescript: "TypeScript", xml: "XML", yaml: "YAML", yml: "YAML", zsh: "Zsh",
};
const languageLabel = (language: string) => {
  const lower = language.toLowerCase();
  return languageLabels[lower] ?? lower.replace(/^[a-z]/, (letter) => letter.toUpperCase());
};

type InlineStyle = Omit<InlineRun, "id" | "text">;
const plain: InlineStyle = { strong: false, emphasis: false, strike: false, code: false, href: "", linkKind: "" };

function inlineRuns(tokens: Token[], id: string, preserveSoftBreaks: boolean): InlineRun[] {
  const runs: InlineRun[] = [];
  const append = (text: string, style: InlineStyle) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && previous.strong === style.strong && previous.emphasis === style.emphasis &&
      previous.strike === style.strike && previous.code === style.code && previous.href === style.href) {
      previous.text += text;
    } else runs.push({ id: `${id}:run:${runs.length}`, text, ...style });
  };
  const walk = (items: Token[], style: InlineStyle) => {
    for (const candidate of items) {
      const token = candidate as MarkedToken;
      switch (token.type) {
        case "strong": walk(token.tokens, { ...style, strong: true }); break;
        case "em": walk(token.tokens, { ...style, emphasis: true }); break;
        case "del": walk(token.tokens, { ...style, strike: true }); break;
        case "link": {
          const href = decodeHTML(token.href);
          walk(token.tokens, { ...style, href, linkKind: markdownLinkKind(href) });
          break;
        }
        case "codespan": append(token.text, { ...style, code: true }); break;
        case "br": append("\n", style); break;
        case "html": append(token.raw, style); break;
        case "image": append(decodeHTML(token.text), style); break;
        case "text":
          if (token.tokens) walk(token.tokens, style);
          else append(decodeHTML(preserveSoftBreaks ? token.text : token.text.replace(/\r?\n/g, " ")), style);
          break;
        case "escape": append(decodeHTML(token.text), style); break;
        default: append(token.raw, style);
      }
    }
  };
  walk(tokens, plain);
  return runs;
}

function openFence(raw: string): boolean {
  const lines = raw.split("\n");
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  if (!opening) return false;
  const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*\\r?$`);
  return !lines.slice(1).some((line) => closing.test(line));
}

export function markdownBlocks(markdown: string, messageId: string, preserveSoftBreaks = false, pending = false): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const walk = (tokens: Token[], depth: number, quoteDepth: number, marker = "", tight = false, gutter = 0) => {
    const emit = (kind: MarkdownBlock["kind"], body: string, tokens: Token[] = [], headingLevel = 0, language = "") => {
      const id = `${messageId}:block:${blocks.length}`;
      const block: MarkdownBlock = {
        id,
        kind: kind === "paragraph" ? (marker ? "list-item" : quoteDepth ? "quote" : kind) : kind,
        body, marker, gutter, depth, quoteDepth, language, languageLabel: languageLabel(language), headingLevel,
        spacingAfter: kind === "code" || kind === "table" ? 12 : tight && kind === "paragraph" ? 0 : 8,
        runs: inlineRuns(tokens, id, preserveSoftBreaks), cells: [], columns: 0, tableSignature: "", pending: false,
      };
      blocks.push(block);
      marker = "";
      return block;
    };
    for (const candidate of tokens) {
      const token = candidate as MarkedToken;
      switch (token.type) {
        case "space":
        case "def": break;
        case "list": {
          if (marker) emit("paragraph", "");
          for (const [index, item] of token.items.entries()) {
            const itemMarker = item.task ? item.checked ? "☑" : "☐" : token.ordered ? `${Number(token.start) + index}.` : "•";
            walk(item.tokens, depth + 1, quoteDepth, itemMarker, !token.loose, itemMarker === "•" ? 14 : 24);
          }
          const last = blocks.at(-1);
          if (last) last.spacingAfter = Math.max(last.spacingAfter, 8);
          break;
        }
        case "blockquote": {
          const before = blocks.length;
          walk(token.tokens, depth, quoteDepth + 1, marker, tight, gutter);
          if (blocks.length > before) marker = "";
          break;
        }
        case "paragraph":
        case "text": emit("paragraph", token.text, token.tokens ?? [token]); break;
        case "heading": emit("heading", token.text, token.tokens, token.depth); break;
        case "code": {
          const block = emit("code", token.text.replace(/\n+$/, ""), [], 0, token.lang?.split(/\s+/u)[0] ?? "");
          block.pending = pending && openFence(token.raw);
          break;
        }
        case "table": {
          const block = emit("table", token.raw.trimEnd());
          block.columns = token.header.length;
          block.cells = [token.header, ...token.rows].flatMap((row, index) => row.map((cell, column) => {
            const id = `${block.id}:cell:${index}:${column}`;
            return { id, column, header: index === 0, align: token.align[column] ?? "left", runs: inlineRuns(cell.tokens, id, preserveSoftBreaks) };
          }));
          block.tableSignature = JSON.stringify([block.columns, block.cells.map((cell) => [
            cell.column, cell.header, cell.runs.map((run) => [run.text, run.strong, run.emphasis, run.code]),
          ])]);
          break;
        }
        case "hr": emit("thematic-break", ""); break;
        default: emit("markdown", token.raw.trimEnd(), [{ type: "html", raw: token.raw.trimEnd(), text: token.raw.trimEnd(), block: true, pre: false }]);
      }
    }
    if (marker) emit("paragraph", "");
  };
  walk(Lexer.lex(markdown, { gfm: true }), 0, 0);
  for (const block of blocks.slice(0, -1)) block.pending = false;
  return blocks;
}
