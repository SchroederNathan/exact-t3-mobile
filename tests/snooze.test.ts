import { expect, test } from "bun:test";
import { canDeferThread, customSnoozeDeadline, localSnoozeField, snoozeChoices, snoozeDeadline } from "../snooze";

test("a custom snooze accepts only real future local minutes or a positive elapsed duration", () => {
  const now = new Date(2027, 2, 13, 12).getTime();
  expect(localSnoozeField(now)).toBe("2027-03-13T12:00");
  expect(customSnoozeDeadline("date", "2027-03-14T12:00", "", "", now)).toBe(new Date(2027, 2, 14, 12).getTime());
  for (const field of ["2027-03-13T12:00", "2027-04-31T12:00", "2027-03-14T24:00", ""]) expect(customSnoozeDeadline("date", field, "", "", now)).toBe(0);
  if (new Date(2027, 2, 14, 2, 30).getHours() !== 2) expect(customSnoozeDeadline("date", "2027-03-14T02:30", "", "", now)).toBe(0);
  expect(customSnoozeDeadline("duration", "", "1.5", "hours", now)).toBe(now + 90 * 60_000);
  expect(customSnoozeDeadline("duration", "", "1", "days", now)).toBe(now + 86_400_000);
  for (const invalid of ["", "0", "-1", "1e300", "abc"]) expect(customSnoozeDeadline("duration", "", invalid, "hours", now)).toBe(0);
});

test("calendar choices are sorted and minute collisions retain configuration order", () => {
  const sunday = new Date(2026, 10, 29, 17, 0, 35).getTime();
  const rows = snoozeChoices(undefined, sunday);
  expect(rows.map(row => row.label)).toEqual(["In 1 hour", "In 3 hours", "Tomorrow"]);
  const morning = rows[2]!;
  expect(snoozeDeadline(morning, new Date(2026, 10, 30, 1).getTime())).toBe(new Date(2026, 10, 30, 9).getTime());
  expect(snoozeDeadline(morning, morning.wake)).toBe(0);
  expect(snoozeDeadline(rows[0], sunday + 15_000)).toBe(sunday + 3_615_000);
  expect(snoozeChoices([], sunday)).toEqual([]);
});

test("a weekday means next occurrence, while elapsed days remain exactly 24 hours across DST", () => {
  const friday = new Date(2027, 2, 12, 12);
  const rows = snoozeChoices([{kind:"at", day:"friday", time:"15:00"},{kind:"after", minutes:2880},{kind:"at", day:"today", time:"11:00"}], friday.getTime());
  expect(rows.map(row => row.label)).toEqual(["In 2 days", "Next Friday"]);
  expect(rows[0]!.wake - friday.getTime()).toBe(48 * 3600_000);
  expect(rows[1]!.wake).toBe(new Date(2027,2,19,15).getTime());
});

test("only a user question can be deferred; recent unadopted messages get two minutes", () => {
  const now = Date.UTC(2026, 2, 1), message = new Date(now).toISOString();
  expect(canDeferThread({pendingRuntimeRequest:{kind:"user_input"}}, now)).toBe(true);
  for (const row of [{pendingRuntimeRequest:{kind:"approval"}}, {pendingGuestMessageCount:1}, {pendingSubagentRequest:"question"}, {status:"queued"}, {latestUserMessageAt:message}]) expect(canDeferThread(row, now)).toBe(false);
  expect(canDeferThread({latestUserMessageAt:message}, now + 120001)).toBe(true);
  expect(canDeferThread({latestUserMessageAt:message, latestRunStartedAt:message}, now)).toBe(true);
});
