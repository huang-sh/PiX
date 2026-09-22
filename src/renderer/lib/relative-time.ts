// One escalation ladder shared by every relative-time surface, so no badge
// gets stuck on a single unit (e.g. "47h"). Months count 30 days and years
// 365 — badge-level approximations, not calendar arithmetic.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export type RelativeTimeUnit = "now" | "minutes" | "hours" | "days" | "months" | "years";

export function relativeTimeUnit(elapsedMs: number): { unit: RelativeTimeUnit; n: number } {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < MINUTE) return { unit: "now", n: 0 };
  if (elapsed < HOUR) return { unit: "minutes", n: Math.floor(elapsed / MINUTE) };
  if (elapsed < DAY) return { unit: "hours", n: Math.floor(elapsed / HOUR) };
  if (elapsed < MONTH) return { unit: "days", n: Math.floor(elapsed / DAY) };
  if (elapsed < YEAR) return { unit: "months", n: Math.floor(elapsed / MONTH) };
  return { unit: "years", n: Math.floor(elapsed / YEAR) };
}
