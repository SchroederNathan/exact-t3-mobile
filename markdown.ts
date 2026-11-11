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
  parts: TableCellPart[];
}
export interface TableCellPart {
  id: string;
  runs: InlineRun[];
  imageSource: string;
  imageAlt: string;
  inlineImage: boolean;
}
export interface MarkdownBlock {
  id: string;
  kind:
    | "paragraph"
    | "heading"
    | "list-item"
    | "quote"
    | "code"
    | "image"
    | "thematic-break"
    | "table"
    | "markdown";
  body: string;
  imageSource: string;
  imageAlt: string;
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
  bash: "Bash",
  c: "C",
  cc: "C++",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  cxx: "C++",
  dockerfile: "Dockerfile",
  go: "Go",
  golang: "Go",
  graphql: "GraphQL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  objc: "Objective-C",
  objectivec: "Objective-C",
  php: "PHP",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
};
const languageLabel = (language: string) => {
  const lower = language.toLowerCase();
  return languageLabels[lower] ?? lower.replace(/^[a-z]/, (letter) => letter.toUpperCase());
};

type InlineStyle = Omit<InlineRun, "id" | "text">;
const plain: InlineStyle = {
  strong: false,
  emphasis: false,
  strike: false,
  code: false,
  href: "",
  linkKind: "",
};

const inlineFilePath =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

function htmlImage(tag: string) {
  if (!/^<img\b/i.test(tag)) return;
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name))
      attributes.set(name, decodeHTML(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  const source = attributes.get("src") ?? "";
  return {
    source: source
      .replace(/</g, "%3C")
      .replace(/>/g, "%3E")
      .replace(/\|/g, "%7C")
      .replace(/\n/g, ""),
    alt: attributes.get("alt") ?? "",
  };
}

function htmlImagesMarkdown(content: string): string {
  if (!/<img\b/i.test(content)) return content;
  const tags = [...content.matchAll(/<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex++;
    return !tags[tagIndex] || delimiter.index < tags[tagIndex]!.index;
  });
  const codeRanges: { start: number; end: number }[] = [];
  for (let index = 0; index < delimiters.length; index++) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate++) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(
          content.slice(
            closing.index + closing[0].length,
            nextLine < 0 ? content.length : nextLine,
          ),
        )
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex < 0) {
      if (!fenced) continue;
      codeRanges.push({ start: opening.index, end: content.length });
      break;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  const pieces: string[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const tag of tags) {
    while (codeRanges[rangeIndex] && codeRanges[rangeIndex]!.end <= tag.index) rangeIndex++;
    const range = codeRanges[rangeIndex];
    if (range && tag.index >= range.start) continue;
    pieces.push(content.slice(offset, tag.index));
    const image = htmlImage(tag[0]);
    if (image?.source) {
      const alt = image.alt.replace(/[\\[\]]/g, "\\$&").replace(/&/g, "&amp;");
      const source = image.source.replace(/\\/g, "\\\\").replace(/&/g, "&amp;");
      pieces.push(`![${alt}](<${source}>)`);
    } else if (/^<summary\b/i.test(tag[0])) pieces.push("\n\n**");
    else if (/^<\/summary\s*>/i.test(tag[0])) pieces.push("**\n\n");
    else if (/^<\/?(?:p|div|details)\b/i.test(tag[0])) pieces.push("\n\n");
    else if (/^<br\b/i.test(tag[0])) pieces.push("  \n");
    offset = tag.index + tag[0].length;
  }
  pieces.push(content.slice(offset));
  return pieces.join("");
}

function inlineRuns(
  tokens: Token[],
  id: string,
  preserveSoftBreaks: boolean,
  inTableCell = false,
  onImage?: (source: string, alt: string, precedingRuns: InlineRun[]) => void,
): InlineRun[] {
  let runs: InlineRun[] = [];
  const append = (text: string, style: InlineStyle) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (
      previous &&
      previous.strong === style.strong &&
      previous.emphasis === style.emphasis &&
      previous.strike === style.strike &&
      previous.code === style.code &&
      previous.href === style.href
    ) {
      previous.text += text;
    } else runs.push({ id: `${id}:run:${runs.length}`, text, ...style });
  };
  const walk = (items: Token[], style: InlineStyle, inLink = false) => {
    for (const candidate of items) {
      const token = candidate as MarkedToken;
      switch (token.type) {
        case "strong":
          walk(token.tokens, { ...style, strong: true }, inLink);
          break;
        case "em":
          walk(token.tokens, { ...style, emphasis: true }, inLink);
          break;
        case "del":
          walk(token.tokens, { ...style, strike: true }, inLink);
          break;
        case "link": {
          const href = decodeHTML(token.href);
          walk(token.tokens, { ...style, href, linkKind: markdownLinkKind(href) }, true);
          break;
        }
        case "codespan":
          append(
            token.text,
            !inLink && inlineFilePath.test(token.text) && !/[<>]/.test(token.text)
              ? { ...style, href: token.text, linkKind: "file", code: false }
              : { ...style, code: true },
          );
          break;
        case "br":
          append("\n", style);
          break;
        case "html": {
          const image = htmlImage(token.raw);
          if (image?.source && onImage) {
            onImage(image.source, image.alt, runs);
            runs = [];
          } else if (!image) {
            append(inTableCell && /^<br\b/i.test(token.raw) ? "\n" : token.raw, style);
          }
          break;
        }
        case "image": {
          const source = decodeHTML(token.href);
          const alt = token.tokens
            ? inlineRuns(token.tokens, id, preserveSoftBreaks)
                .map((run) => run.text)
                .join("")
            : decodeHTML(token.text);
          if (onImage) {
            onImage(source, alt, runs);
            runs = [];
          } else {
            append(
              alt || source,
              inLink ? style : { ...style, href: source, linkKind: markdownLinkKind(source) },
            );
          }
          break;
        }
        case "text":
          if (token.tokens) walk(token.tokens, style, inLink);
          else
            append(
              decodeHTML(preserveSoftBreaks ? token.text : token.text.replace(/\r?\n/g, " ")),
              style,
            );
          break;
        case "escape":
          append(decodeHTML(token.text), style);
          break;
        default:
          append(token.raw, style);
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

export function markdownBlocks(
  markdown: string,
  messageId: string,
  preserveSoftBreaks = false,
  pending = false,
): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const walk = (
    tokens: Token[],
    depth: number,
    quoteDepth: number,
    marker = "",
    tight = false,
    gutter = 0,
  ) => {
    const emit = (
      kind: MarkdownBlock["kind"],
      body: string,
      tokens: Token[] = [],
      headingLevel = 0,
      language = "",
    ) => {
      const id = `${messageId}:block:${blocks.length}`;
      const block: MarkdownBlock = {
        id,
        kind: kind === "paragraph" ? (marker ? "list-item" : quoteDepth ? "quote" : kind) : kind,
        body,
        imageSource: "",
        imageAlt: "",
        marker,
        gutter,
        depth,
        quoteDepth,
        language,
        languageLabel: languageLabel(language),
        headingLevel,
        spacingAfter:
          kind === "code" || kind === "table" ? 12 : tight && kind === "paragraph" ? 0 : 8,
        runs: inlineRuns(tokens, id, preserveSoftBreaks),
        cells: [],
        columns: 0,
        tableSignature: "",
        pending: false,
      };
      blocks.push(block);
      marker = "";
      return block;
    };
    const emitInline = (
      kind: "paragraph" | "heading",
      body: string,
      tokens: Token[],
      headingLevel = 0,
    ) => {
      let hasImages = false;
      const emitRuns = (runs: InlineRun[]) => {
        if (hasImages && !runs.some((run) => run.text.trim())) return;
        const block = emit(kind, body, [], headingLevel);
        block.runs = hasImages
          ? runs.map((run, index) => ({ ...run, id: `${block.id}:run:${index}` }))
          : runs;
        if (hasImages) block.body = runs.map((run) => run.text).join("");
      };
      const remainingRuns = inlineRuns(
        tokens,
        `${messageId}:block:${blocks.length}`,
        preserveSoftBreaks,
        false,
        (source, alt, precedingRuns) => {
          hasImages = true;
          emitRuns(precedingRuns);
          const block = emit("image", alt);
          block.imageSource = source;
          block.imageAlt = alt;
        },
      );
      emitRuns(remainingRuns);
    };
    for (const candidate of tokens) {
      const token = candidate as MarkedToken;
      switch (token.type) {
        case "space":
        case "def":
          break;
        case "list": {
          if (marker) emit("paragraph", "");
          for (const [index, item] of token.items.entries()) {
            const itemMarker = item.task
              ? item.checked
                ? "☑"
                : "☐"
              : token.ordered
                ? `${Number(token.start) + index}.`
                : "•";
            walk(
              item.tokens,
              depth + 1,
              quoteDepth,
              itemMarker,
              !token.loose,
              itemMarker === "•" ? 14 : 24,
            );
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
        case "text":
          emitInline("paragraph", token.text, token.tokens ?? [token]);
          break;
        case "heading":
          emitInline("heading", token.text, token.tokens, token.depth);
          break;
        case "code": {
          const block = emit(
            "code",
            token.text.replace(/\n+$/, ""),
            [],
            0,
            token.lang?.split(/\s+/u)[0] ?? "",
          );
          block.pending = pending && openFence(token.raw);
          break;
        }
        case "table": {
          const block = emit("table", token.raw.trimEnd());
          block.columns = token.header.length;
          block.cells = [token.header, ...token.rows].flatMap((row, index) =>
            row.map((cell, column) => {
              const id = `${block.id}:cell:${index}:${column}`;
              const parts: TableCellPart[] = [];
              let inlineImage = false;
              const appendRuns = (runs: InlineRun[]) => {
                if (!runs.length) return;
                const partId = `${id}:text:${parts.length}`;
                parts.push({
                  id: partId,
                  runs: runs.map((run, index) => ({ ...run, id: `${partId}:run:${index}` })),
                  imageSource: "",
                  imageAlt: "",
                  inlineImage: false,
                });
                inlineImage = !runs.at(-1)!.text.endsWith("\n");
              };
              appendRuns(
                inlineRuns(cell.tokens, id, preserveSoftBreaks, true, (source, alt, runs) => {
                  appendRuns(runs);
                  parts.push({
                    id: `${id}:image:${parts.length}`,
                    runs: [],
                    imageSource: source,
                    imageAlt: alt,
                    inlineImage,
                  });
                  inlineImage = true;
                }),
              );
              return {
                id,
                column,
                header: index === 0,
                align: token.align[column] ?? "left",
                runs: parts.flatMap((part) => part.runs),
                parts,
              };
            }),
          );
          block.tableSignature = JSON.stringify([
            block.columns,
            block.cells.map((cell) => [
              cell.column,
              cell.header,
              cell.align,
              cell.runs.map((run) => [run.text, run.strong, run.emphasis, run.code]),
              cell.parts.map((part) => [
                Boolean(part.imageSource),
                part.inlineImage,
                part.runs.length,
              ]),
            ]),
          ]);
          break;
        }
        case "html": {
          const normalized = htmlImagesMarkdown(token.raw);
          if (normalized !== token.raw) {
            const before = blocks.length;
            walk(Lexer.lex(normalized, { gfm: true }), depth, quoteDepth, marker, tight, gutter);
            if (blocks.length > before) marker = "";
            break;
          }
          emit("markdown", token.raw.trimEnd(), [token]);
          break;
        }
        case "hr":
          emit("thematic-break", "");
          break;
        default:
          emit("markdown", token.raw.trimEnd(), [
            {
              type: "html",
              raw: token.raw.trimEnd(),
              text: token.raw.trimEnd(),
              block: true,
              pre: false,
            },
          ]);
      }
    }
    if (marker) emit("paragraph", "");
  };
  walk(Lexer.lex(markdown, { gfm: true }), 0, 0);
  for (const block of blocks.slice(0, -1)) block.pending = false;
  return blocks;
}
