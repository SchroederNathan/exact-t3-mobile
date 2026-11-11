export interface ReviewRow {
  id: string;
  kind: "file" | "hunk" | "addition" | "deletion" | "context" | "meta";
  text: string;
  oldLine: string;
  newLine: string;
}

const pathEscapes: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};
const pathEncoder = new TextEncoder();
const pathDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function unquoteGitPatchPath(token: string) {
  const body = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
  if (!body.includes("\\")) return body;
  const bytes: number[] = [];
  for (const match of body.matchAll(/\\([0-7]{3}|.)|[^\\]+|\\/gsu)) {
    const escaped = match[1];
    if (escaped && /^[0-7]{3}$/.test(escaped)) bytes.push(Number.parseInt(escaped, 8));
    else bytes.push(...pathEncoder.encode(escaped ? (pathEscapes[escaped] ?? escaped) : match[0]));
  }
  return pathDecoder.decode(new Uint8Array(bytes));
}

function patchPath(value: string) {
  return unquoteGitPatchPath(value.split("\t", 1)[0] ?? "").replace(/^[ab]\//, "");
}

export function projectTurnDiff(diff: string): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let file: ReviewRow | undefined;
  let oldPath = "";
  let hasFileMarkers = false;
  let binary = false;
  let hunk: { old: number; new: number; oldRemaining: number; newRemaining: number } | undefined;
  const lines = diff.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const append = (kind: ReviewRow["kind"], text = line, oldLine = "", newLine = "") => {
      const row = { id: String(index), kind, text, oldLine, newLine };
      rows.push(row);
      return row;
    };
    const fileHeader = /^diff --(?:git|cc|combined) (.*)$/.exec(line);
    if (fileHeader) {
      const paths = /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/.exec(
        line,
      );
      file = append("file", paths ? patchPath(paths[2]!) : unquoteGitPatchPath(fileHeader[1]!));
      oldPath = "";
      hasFileMarkers = false;
      binary = false;
      hunk = undefined;
      continue;
    }
    if (binary) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      hunk = {
        old: Number(header[1]),
        new: Number(header[3]),
        oldRemaining: Number(header[2] ?? 1),
        newRemaining: Number(header[4] ?? 1),
      };
      append("hunk");
      continue;
    }
    if (hunk) {
      if (line.startsWith(" ") && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
        append("context", line.slice(1), String(hunk.old++), String(hunk.new++));
        hunk.oldRemaining--;
        hunk.newRemaining--;
        continue;
      }
      if (line.startsWith("-") && hunk.oldRemaining > 0) {
        append("deletion", line.slice(1), String(hunk.old++));
        hunk.oldRemaining--;
        continue;
      }
      if (line.startsWith("+") && hunk.newRemaining > 0) {
        append("addition", line.slice(1), "", String(hunk.new++));
        hunk.newRemaining--;
        continue;
      }
      if (line.startsWith("\\")) {
        append("meta");
        continue;
      }
      hunk = undefined;
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      oldPath = patchPath(line.slice(4));
      if (!file || hasFileMarkers) file = append("file", oldPath);
      hasFileMarkers = true;
      continue;
    }
    if (line.startsWith("+++ ") && file && hasFileMarkers) {
      const newPath = patchPath(line.slice(4));
      file.text =
        newPath === "/dev/null"
          ? oldPath
          : oldPath !== "/dev/null" && oldPath !== newPath
            ? `${oldPath} → ${newPath}`
            : newPath;
      continue;
    }
    const rename = /^(rename|copy) (from|to) (.*)$/.exec(line);
    if (rename) {
      const path = unquoteGitPatchPath(rename[3]!);
      if (file && rename[2] === "to") file.text = path;
      append("meta", `${rename[1]} ${rename[2]} ${path}`);
      continue;
    }
    if (line === "GIT binary patch") {
      binary = true;
      append("meta", "Binary file changed");
      continue;
    }
    if (line !== "") append("meta");
  }
  return rows;
}
