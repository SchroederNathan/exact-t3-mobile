type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
const entries = (value: unknown) => Array.isArray(value) ? value.map(fields) : [];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const date = (value: unknown) => Date.parse(text(value)) || 0;
const labels = new Map(Object.entries({ codex: "Codex", claudeAgent: "Claude Code", cursor: "Cursor", grok: "Grok Build", antigravity: "Antigravity", opencode: "OpenCode", pi: "Pi", muse: "Muse Code" }));
const labelFor = (driver: string) => labels.get(driver) ?? driver;

function windowsOf(limits: Fields) {
  return entries(limits.windows).flatMap(window => {
    const used = window.usedPercent, id = text(window.id), label = text(window.label);
    if (!id || !label || typeof used !== "number" || !Number.isFinite(used)) return [];
    const kind = ["session", "weekly", "monthly"].includes(text(window.kind)) ? text(window.kind) : "other";
    return [{ id, label, kind, used: Math.max(0, Math.min(100, used)), resets: date(window.resetsAt), duration: Number(window.windowDurationMins) || 0 }];
  });
}

export function limitReports(environmentId: string, environment: string, providers: unknown, sources: unknown) {
  function report(id: string, driver: string, name: string, auth: Fields, limits: Fields, readable: boolean, origin: string, color: unknown) {
    const email = text(auth.email).toLowerCase(), fingerprint = text(limits.credentialFingerprint);
    const identity = email ? JSON.stringify([driver, "email", email]) : fingerprint ? JSON.stringify([driver, "credential", fingerprint]) : "";
    const windows = readable ? windowsOf(limits) : [], unavailable = fields(limits.unavailable);
    const notice = !readable ? "" : unavailable.reason === "unsupported" ? text(unavailable.message) || "This account has no subscription limits."
      : unavailable.reason === "probeFailed" ? text(unavailable.message) || "Could not read limits." : windows.length ? "" : "No limits reported.";
    const initials = email.split("@").map(part => [...part][0] ?? "").join("").toUpperCase();
    return { id, driver, identity, workspace: text(auth.workspaceId), name: name || initials || labelFor(driver), origin, checked: date(limits.checkedAt), color: /^#[\da-f]{6}$/i.test(text(color)) ? text(color) : "", notice, windows: notice ? [] : windows };
  }
  const reports = entries(providers).flatMap(provider => {
    const driver = text(provider.driver), instance = text(provider.instanceId);
    if (!driver || !instance || provider.enabled !== true) return [];
    const readable = provider.installed === true && provider.availability !== "unavailable" && Array.isArray(fields(provider.usageLimits).windows);
    return [report(JSON.stringify([environmentId, instance]), driver, text(provider.displayName), fields(provider.auth), fields(provider.usageLimits), readable, environment, provider.accentColor)];
  });
  for (const source of entries(sources)) for (const account of entries(source.accounts)) {
    const id = text(account.id), driver = text(account.driver), sourceId = text(source.id);
    if (id && sourceId && driver) reports.push(report(JSON.stringify(["source", sourceId, id, text(account.workspaceId)]), driver, text(account.email) ? "" : id.replace(/\.json$/i, ""), account, fields(account.usageLimits), Array.isArray(fields(account.usageLimits).windows), [environment, text(source.label)].filter(Boolean).join(" · "), undefined));
  }
  return reports;
}

type Report = ReturnType<typeof limitReports>[number];

export function poolLimitReports(reports: Report[], now: number) {
  const workspaces = new Map<string, Set<string>>();
  for (const { identity, workspace } of reports) if (identity && workspace) {
    const known = workspaces.get(identity) ?? new Set();
    known.add(workspace); workspaces.set(identity, known);
  }
  const accounts = new Map<string, Report>();
  for (const report of reports) {
    if (!report.windows.length) continue;
    const known = workspaces.get(report.identity);
    const workspace = report.workspace || (known?.size === 1 ? [...known][0] : "");
    const key = report.identity && (workspace || !known?.size) ? JSON.stringify([report.identity, workspace]) : report.id;
    const previous = accounts.get(key);
    if (!previous || previous.checked < report.checked) accounts.set(key, report);
  }
  const byDriver = new Map<string, Report[]>();
  for (const account of accounts.values()) {
    const members = byDriver.get(account.driver) ?? []; members.push(account); byDriver.set(account.driver, members);
  }
  const rank = (kind: string) => ["session", "weekly", "monthly", "other"].indexOf(kind);
  const pools = [...byDriver].map(([driver, members]) => {
    const keyOf = (window: Report["windows"][number]) => driver === "codex" ? window.kind : JSON.stringify([window.kind, window.id]);
    const order = members.flatMap(member => member.windows).sort((left, right) => rank(left.kind) - rank(right.kind))[0]!;
    const firstReset = (member: Report) => member.windows.find(window => keyOf(window) === keyOf(order))?.resets || Infinity;
    members.sort((left, right) => firstReset(left) - firstReset(right) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const groups = new Map<string, Map<Report, Report["windows"][number]>>();
    for (const member of members) for (const reported of member.windows) {
      const blocked = reported.kind === "session" && member.windows.some(item => item.used >= 100 && (driver === "codex" && item.kind === "weekly" || driver === "claudeAgent" && item.id === "seven_day"));
      const window = blocked ? { ...reported, used: 100, duration: 0 } : reported;
      let key = keyOf(window);
      if (groups.get(key)?.has(member)) key = JSON.stringify([window.kind, window.id]);
      const group = groups.get(key) ?? new Map(); group.set(member, window); groups.set(key, group);
    }
    let windows = [...groups].map(([key, group]) => {
      const present = [...group.values()], first = present[0]!;
      const remaining = Math.round(100 - present.reduce((sum, window) => sum + window.used, 0) / present.length);
      const columns = members.map((member, index) => {
        const window = group.get(member), pace = window && window.resets && window.duration > 0 ? Math.round(100 * Math.max(0, Math.min(1, (window.resets - now) / (window.duration * 60000)))) : -1;
        return { id: `${driver}-${index + 1}`, number: index + 1, name: member.name, origin: member.origin, color: member.color, reported: !!window, remaining: window ? Math.round(100 - window.used) : 0, pace };
      });
      return { id: key, rawId: first.id, kind: first.kind, label: first.label, remaining, columns };
    }).sort((left, right) => rank(left.kind) - rank(right.kind));
    if (driver === "cursor" && ["autoPercentUsed", "apiPercentUsed"].every(id => windows.some(item => item.rawId === id))) windows = windows.filter(item => item.rawId !== "totalPercentUsed");
    return { id: driver, provider: labelFor(driver), environment: "", notice: "", windows: windows.map(({ id, label, remaining, columns }) => ({ id, label, remaining, columns })) };
  });
  return pools.concat(reports.filter(report => report.notice).map(report => ({ id: report.id, provider: report.name, environment: report.origin, notice: report.notice, windows: [] })));
}
