export type ComposerTriggerKind = "path" | "slash-command" | "skill";

export type ComposerCommandItem =
  | {
      id: string;
      type: "slash-command";
      command: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ComposerSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "path";
      path: string;
      kind: "file" | "directory";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      model: ComposerModel;
      label: string;
      description: string;
    };

export interface ComposerSlashCommand {
  name: string;
  description?: string;
}

export interface ComposerSkill {
  name: string;
  path: string;
  scope?: string;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  enabled: boolean;
  userInvocable?: boolean;
  userInvocationOnly?: boolean;
}

export function composerSkillIcon(skill: ComposerSkill): string {
  const path = skill.path.replaceAll("\\", "/");
  if (/\/(?:\.codex|\.agents)\/plugins\//u.test(path)) return "symbol:sf/square.grid.2x2";
  const scope = skill.scope?.trim().toLowerCase() ?? "";
  if (["repo", "repository", "project", "workspace", "local"].includes(scope)) return "symbol:sf/folder";
  if (["user", "personal"].includes(scope)) return "symbol:sf/person.crop.circle";
  return scope === "system" ? "symbol:sf/gearshape" : "symbol:sf/cube";
}

export interface ComposerModel {
  instanceId: string;
  slug: string;
  name: string;
  shortName?: string;
  provider: string;
  available?: boolean;
  legacy?: boolean;
  hidden?: boolean;
}

function includesQuery(value: string, query: string): boolean {
  return query === "" || value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function modelSearchText(model: ComposerModel): string {
  return [model.name, model.shortName, model.slug, model.provider, model.instanceId]
    .filter(Boolean)
    .join(" ");
}

function modelScore(model: ComposerModel, query: string): number {
  if (!query) return 0;
  const needle = query.toLocaleLowerCase();
  const values = [model.name, model.shortName ?? "", model.slug, model.provider, model.instanceId]
    .map((value) => value.toLocaleLowerCase());
  const exact = values.findIndex((value) => value === needle);
  if (exact >= 0) return exact;
  const prefix = values.findIndex((value) => value.startsWith(needle));
  if (prefix >= 0) return 10 + prefix;
  const found = values.findIndex((value) => value.includes(needle));
  return found >= 0 ? 20 + found : 1000;
}

export function buildComposerModelItems(
  models: ReadonlyArray<ComposerModel>,
  query: string,
  limit = 8,
): ComposerCommandItem[] {
  return models
    .filter(
      (model) =>
        model.available !== false &&
        model.legacy !== true &&
        model.hidden !== true &&
        includesQuery(modelSearchText(model), query),
    )
    .toSorted(
      (left, right) =>
        modelScore(left, query) - modelScore(right, query) ||
        modelSearchText(left).localeCompare(modelSearchText(right)),
    )
    .slice(0, limit)
    .map((model) => ({
      id: `model:${model.instanceId}:${model.slug}`,
      type: "model" as const,
      model,
      label: model.shortName || model.name || model.slug,
      description: model.provider || model.instanceId,
    }));
}

export function buildComposerSlashCommandItems(input: {
  query: string;
  /** Provider commands are only valid at the beginning of a prompt. */
  atMessageStart: boolean;
  hasThread?: boolean;
  hasCompactableConversation?: boolean;
  providerDriver?: string;
  providerCommands?: ReadonlyArray<ComposerSlashCommand>;
  skills?: ReadonlyArray<ComposerSkill>;
  offersFreshSession?: boolean;
}): ComposerCommandItem[] {
  const query = input.query.toLocaleLowerCase();
  const result: ComposerCommandItem[] = [];
  if (includesQuery("model", query))
    result.push({
      id: "cmd:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch model",
    });
  if (input.atMessageStart) {
    if (input.offersFreshSession && includesQuery("clear", query))
      result.push({
        id: "cmd:clear",
        type: "slash-command",
        command: "clear",
        label: "/clear",
        description: "Start a fresh session",
      });
    const visibleSkillNames = new Set(
      (input.skills ?? [])
        .filter((skill) => skill.enabled && skill.userInvocable !== false)
        .map((skill) => skill.name.trim().toLocaleLowerCase()),
    );
    for (const command of input.providerCommands ?? []) {
      const name = command.name.trim();
      if (!name || !includesQuery(name, query)) continue;
      if (name === "clear" && input.offersFreshSession) continue;
      if (name === "compact" && input.hasCompactableConversation === false) continue;
      if (name === "feedback" && !input.hasThread && input.providerDriver === "codex") continue;
      if (visibleSkillNames.has(name.toLocaleLowerCase())) continue;
      result.push({
        id: `pcmd:${name}`,
        type: "provider-slash-command",
        command: { name, description: command.description },
        label: `/${name}`,
        description: command.description ?? "",
      });
    }
    const seenSkills = new Set<string>();
    for (const skill of input.skills ?? []) {
      if (!skill.enabled || skill.userInvocable === false) continue;
      const normalizedName = skill.name.trim().toLocaleLowerCase();
      if (!normalizedName || seenSkills.has(normalizedName)) continue;
      seenSkills.add(normalizedName);
      const label = skill.displayName || skill.name;
      if (!includesQuery(skill.name, query) && !includesQuery(label, query)) continue;
      result.push({
        id: `skill:${skill.name}`,
        type: "skill",
        skill,
        label: `skill:${skill.name}`,
        description: skill.shortDescription || skill.description || "",
      });
    }
  }
  return result;
}

export function buildComposerSkillItems(
  skills: ReadonlyArray<ComposerSkill>,
  query: string,
  limit = 20,
): ComposerCommandItem[] {
  return skills
    .filter((skill) => skill.enabled && skill.userInvocable !== false)
    .filter((skill) => includesQuery(skill.name, query) || includesQuery(skill.displayName || "", query))
    .slice(0, limit)
    .map((skill) => ({
      id: `skill:${skill.name}`,
      type: "skill" as const,
      skill,
      label: skill.displayName || skill.name,
      description: skill.shortDescription || skill.description || "",
    }));
}

export function composerFileLink(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const label = (separator >= 0 ? path.slice(separator + 1) : path)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  const destination = encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
  return `[${label}](${destination})`;
}

export function buildComposerPathItems(
  entries: ReadonlyArray<{ path: string; kind?: string }>,
  query: string,
  limit = 20,
): ComposerCommandItem[] {
  return entries
    .filter((entry) => entry.path && includesQuery(entry.path, query))
    .slice(0, limit)
    .map((entry) => {
      const parts = entry.path.split(/[\\/]/u);
      return {
        id: `path:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        kind: entry.kind === "directory" ? ("directory" as const) : ("file" as const),
        label: parts.at(-1) || entry.path,
        description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
      };
    });
}

export function composerCommandInsertion(item: ComposerCommandItem): string {
  switch (item.type) {
    case "path":
      return `${composerFileLink(item.path)} `;
    case "skill":
      return `$${item.skill.name} `;
    case "slash-command":
      return `/${item.command} `;
    case "provider-slash-command":
      return `/${item.command.name} `;
    case "model":
      return `model:${item.model.instanceId}/${item.model.slug} `;
  }
}
