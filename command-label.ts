const shells = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const setup = new Set(["cd", "export", "set", "unset", "source", "."]);
const control = new Set([
  "if",
  "then",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "case",
  "function",
  "return",
  "exit",
]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;
const optionsWithValue: Record<string, Set<string>> = {
  env: new Set(["-C", "--chdir", "-u", "--unset"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-u", "--user"]),
};

function shellCommands(command: string, single = false): string[][] | null {
  if (command.length > 16_384) return null;
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let started = false;
  let quote = "";
  let escaped = false;
  const finishToken = () => {
    if (started) tokens.push(token);
    token = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) {
      if (char !== "\n") token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"' && !'$`"\\\n'.includes(command[i + 1] ?? "")) {
      token += char;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      i--;
    } else if (";\n|&".includes(char)) {
      if (single) return null;
      finishToken();
      if (tokens.length) commands.push(tokens);
      tokens = [];
      if (commands.length >= 64) return null;
    } else if (/\s/u.test(char)) {
      finishToken();
    } else {
      token += char;
      started = true;
    }
  }
  if (quote || escaped) return null;
  finishToken();
  if (tokens.length) commands.push(tokens);
  return commands;
}

function shellScriptIndex(tokens: readonly string[], start: number): number | null {
  for (let index = start; index < tokens.length; index++) {
    const option = tokens[index]!;
    if (option === "--" || !option.startsWith("-")) return null;
    if (["-o", "-O", "--rcfile", "--init-file"].includes(option)) index++;
    else if (option === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(option)) return index + 1;
  }
  return null;
}

export function commandDisplayText(command: string): string {
  let display = command.trim();
  const tokens = shellCommands(display, true)?.[0];
  const program = tokens?.[0]
    ?.split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.exe$/iu, "");
  if (tokens && program && shells.has(program)) {
    const index = shellScriptIndex(tokens, 1);
    if (index !== null && index === tokens.length - 1) display = tokens[index]?.trim() || display;
  }
  return display.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (character) =>
    character === "\u007f" ? "␡" : String.fromCharCode(0x2400 + character.charCodeAt(0)),
  );
}

// Exact bundles app-local modules only; keep this POSIX subset aligned with client-runtime's commandLabel.
export function commandProgramName(command: string, depth = 0): string | null {
  if (depth >= 8) return null;
  const commands = shellCommands(command);
  if (!commands) return null;
  for (const tokens of commands) {
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (assignment.test(token)) {
        index++;
        continue;
      }
      const program = token.split(/[\\/]/u).at(-1)!;
      if (program === "env" || program === "sudo") {
        index++;
        while (index < tokens.length) {
          const option = tokens[index]!;
          if (option === "--") {
            index++;
            break;
          }
          if (program === "env" && (option === "-S" || option === "--split-string"))
            return commandProgramName(tokens[index + 1] ?? "", depth + 1);
          if (optionsWithValue[program]!.has(option)) index += 2;
          else if (option.startsWith("-")) index++;
          else break;
        }
        continue;
      }
      if (["command", "builtin", "exec", "time", "noglob", "nocorrect"].includes(program)) {
        index++;
        while (tokens[index]?.startsWith("-")) index++;
        continue;
      }
      if (shells.has(program)) {
        const scriptIndex = shellScriptIndex(tokens, index + 1);
        if (scriptIndex !== null) return commandProgramName(tokens[scriptIndex] ?? "", depth + 1);
      }
      if (setup.has(program)) break;
      if (control.has(program) || !/^[A-Za-z0-9_.+-]+$/u.test(program)) return null;
      return program;
    }
  }
  return null;
}
