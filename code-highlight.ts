export interface CodeRun {
  id: string;
  text: string;
  kind: number;
}
export interface CodeInput {
  id: string;
  body: string;
  language: string;
  pending: boolean;
}
export interface CodeHighlight {
  blockId: string;
  body: string;
  language: string;
  runs: CodeRun[];
}
type Token = { start: number; end: number; kind: number };
const plain = (body: string): CodeRun[] => [{ id: "0", text: body, kind: -1 }];
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const splitSurrogate = (text: string, at: number) =>
  at > 0 &&
  at < text.length &&
  /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
  /[\uDC00-\uDFFF]/.test(text[at]!);

export function codeRuns(body: string, result: unknown): CodeRun[] {
  const tokens = object(result).tokens;
  if (!Array.isArray(tokens)) return plain(body);
  const runs: CodeRun[] = [];
  let offset = 0;
  const append = (text: string, kind: number) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else runs.push({ id: String(runs.length), text, kind });
  };
  for (const value of tokens) {
    const token = object(value) as Partial<Token>;
    const { start, end, kind } = token;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof kind !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      !Number.isInteger(kind) ||
      start < offset ||
      end <= start ||
      end > body.length ||
      kind < 0 ||
      kind > 13 ||
      splitSurrogate(body, start) ||
      splitSurrogate(body, end)
    )
      return plain(body);
    append(body.slice(offset, start), -1);
    append(body.slice(start, end), kind);
    offset = end;
  }
  append(body.slice(offset), -1);
  return runs.length ? runs : plain(body);
}

export class CodeHighlights {
  private settled = new Map<string, { runs: CodeRun[]; bytes: number }>();
  private bytes = 0;
  constructor(
    private maxEntries = 128,
    private maxBytes = 4 * 1024 * 1024,
  ) {}

  load(
    inputs: CodeInput[],
    request: (code: string, language: string) => Promise<unknown>,
  ): Promise<CodeHighlight[]> {
    return Promise.all(
      inputs
        .filter((input) => !input.pending)
        .map((input) => {
          const key = JSON.stringify([input.language, input.body]);
          const cached = this.settled.get(key);
          if (cached) {
            this.settled.delete(key);
            this.settled.set(key, cached);
          }
          let result = cached ? Promise.resolve(cached.runs) : undefined;
          if (!result) {
            try {
              result = request(input.body, input.language)
                .then((answer) => {
                  const runs = codeRuns(input.body, answer);
                  const bytes =
                    key.length * 2 +
                    runs.reduce((total, run) => total + run.text.length * 2 + 48, 0);
                  if (
                    !this.settled.has(key) &&
                    Array.isArray(object(answer).tokens) &&
                    bytes <= this.maxBytes
                  ) {
                    this.settled.set(key, { runs, bytes });
                    this.bytes += bytes;
                    while (this.settled.size > this.maxEntries || this.bytes > this.maxBytes) {
                      const first = this.settled.entries().next().value;
                      if (!first) break;
                      this.bytes -= first[1].bytes;
                      this.settled.delete(first[0]);
                    }
                  }
                  return runs;
                })
                .catch(() => plain(input.body));
            } catch {
              result = Promise.resolve(plain(input.body));
            }
          }
          return result.then((runs) => ({
            blockId: input.id,
            body: input.body,
            language: input.language,
            runs,
          }));
        }),
    );
  }
}
