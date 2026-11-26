const minute = 60_000;
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const defaults = [60, 180].map(minutes => ({ kind: "after", minutes }) as Record<string, unknown>).concat([
  { kind: "at", day: "today", time: "18:00" }, { kind: "at", day: "tomorrow", time: "09:00" }, { kind: "at", day: "monday", time: "09:00" },
]);

export interface SnoozeChoice { id: string; label: string; detail: string; wake: number; minutes: number }

export function snoozeChoices(settings: unknown, now: number): SnoozeChoice[] {
  const start = new Date(now), results = new Map<number, SnoozeChoice>();
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  for (const setting of Array.isArray(settings) ? settings.slice(0, 8) : defaults) {
    if (!setting || typeof setting !== "object") continue;
    let id: string, label: string, minutes = 0, namesDay = false;
    const date = new Date(now);
    if (setting.kind === "after") {
      minutes = setting.minutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) continue;
      date.setTime(now + minutes * minute);
      const divisor = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
      const count = minutes / divisor;
      label = `In ${count} ${divisor === 1440 ? "day" : divisor === 60 ? "hour" : "minute"}${count === 1 ? "" : "s"}`;
      id = `after:${minutes}`;
    } else if (setting.kind === "at" && typeof setting.time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(setting.time)) {
      const day = setting.day, index = weekdays.indexOf(day);
      if (index < 0 && day !== "today" && day !== "tomorrow") continue;
      const days = day === "today" ? 0 : day === "tomorrow" ? 1 : (index - start.getDay() + 7) % 7 || 7;
      const hour = Number(setting.time.slice(0, 2));
      date.setDate(date.getDate() + days);
      date.setHours(hour, Number(setting.time.slice(3)), 0, 0);
      if (date.getTime() <= now) continue;
      label = days === 0 ? (hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening") : days === 1 ? "Tomorrow" : day === "monday" ? "Next week" : `${days === 7 ? "Next " : ""}${day[0].toUpperCase()}${day.slice(1)}`;
      namesDay = label !== "Next week";
      id = `at:${day}:${setting.time}`;
    } else continue;
    const bucket = Math.floor(date.getTime() / minute);
    if (!results.has(bucket)) results.set(bucket, { id, label, detail: (namesDay || date.toDateString() === start.toDateString() ? "" : `${weekday.format(date)} `) + clock.format(date), wake: date.getTime(), minutes });
  }
  return [...results.values()].sort((left, right) => left.wake - right.wake);
}

export function snoozeDeadline(choice: SnoozeChoice | undefined, now: number): number {
  if (!choice) return 0;
  const wake = choice.minutes ? now + choice.minutes * minute : choice.wake;
  return wake > now ? wake : 0;
}

export function canDeferThread(row: Record<string, unknown>, now: number): boolean {
  const request = row.pendingRuntimeRequest as {kind?: string} | null;
  if ((request && request.kind !== "user_input") || row.pendingSubagentRequest != null || Number(row.pendingGuestMessageCount) > 0 || ["queued", "preparing", "starting"].includes(String(row.status))) return false;
  const sent = Date.parse(String(row.latestUserMessageAt));
  if (!Number.isFinite(sent) || Math.abs(now - sent) > 2 * minute || row.status === "failed") return true;
  return [row.latestRunRequestedAt, row.latestRunStartedAt, row.latestRunCompletedAt].some(value => Date.parse(String(value)) >= sent);
}
