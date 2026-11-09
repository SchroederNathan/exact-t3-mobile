import { Lexer, type MarkedToken, type Token } from "marked";

export interface MarkdownBlock {
  id: string;
  kind: "paragraph" | "heading" | "list-item" | "quote" | "code" | "thematic-break" | "markdown";
  body: string;
  marker: string;
  depth: number;
  quoteDepth: number;
  language: string;
  headingLevel: number;
  spacingAfter: number;
}

export function markdownBlocks(markdown: string, messageId: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const walk = (tokens: Token[], depth: number, quoteDepth: number, marker = "", tight = false) => {
    const emit = (kind: MarkdownBlock["kind"], body: string, headingLevel = 0, language = "") => {
      blocks.push({
        id: `${messageId}:block:${blocks.length}`,
        kind: kind === "paragraph" ? (marker ? "list-item" : quoteDepth ? "quote" : kind) : kind,
        body,
        marker,
        depth,
        quoteDepth,
        language,
        headingLevel,
        spacingAfter: kind === "code" ? 12 : tight && kind === "paragraph" ? 0 : 8,
      });
      marker = "";
    };
    for (const candidate of tokens) {
      // The lexer has no extensions, so every token is a built-in Marked token.
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
            walk(item.tokens, depth + 1, quoteDepth, itemMarker, !token.loose);
          }
          const last = blocks.at(-1);
          if (last) last.spacingAfter = Math.max(last.spacingAfter, 8);
          break;
        }
        case "blockquote": {
          const before = blocks.length;
          walk(token.tokens, depth, quoteDepth + 1, marker, tight);
          if (blocks.length > before) marker = "";
          break;
        }
        case "paragraph":
        case "text":
          emit("paragraph", token.text);
          break;
        case "heading":
          emit("heading", token.text, token.depth);
          break;
        case "code":
          emit("code", token.text, 0, token.lang?.split(/\s+/u)[0] ?? "");
          break;
        case "hr":
          emit("thematic-break", "");
          break;
        default:
          emit("markdown", token.raw.trimEnd());
      }
    }
    if (marker) emit("paragraph", "");
  };
  walk(Lexer.lex(markdown, { gfm: true }), 0, 0);
  return blocks;
}
