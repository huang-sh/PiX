import { describe, expect, it } from "vitest";
import { relativeTimeUnit } from "../../src/renderer/lib/relative-time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe("relativeTimeUnit", () => {
  it("escalates through every unit instead of getting stuck on hours or days", () => {
    expect(relativeTimeUnit(30_000)).toEqual({ unit: "now", n: 0 });
    expect(relativeTimeUnit(5 * MINUTE)).toEqual({ unit: "minutes", n: 5 });
    expect(relativeTimeUnit(3 * HOUR)).toEqual({ unit: "hours", n: 3 });
    expect(relativeTimeUnit(2 * DAY)).toEqual({ unit: "days", n: 2 });
    expect(relativeTimeUnit(6 * MONTH)).toEqual({ unit: "months", n: 6 });
    expect(relativeTimeUnit(3 * YEAR)).toEqual({ unit: "years", n: 3 });
  });

  it("picks the next unit at each boundary", () => {
    expect(relativeTimeUnit(HOUR)).toEqual({ unit: "hours", n: 1 });
    expect(relativeTimeUnit(DAY)).toEqual({ unit: "days", n: 1 });
    expect(relativeTimeUnit(MONTH)).toEqual({ unit: "months", n: 1 });
    expect(relativeTimeUnit(YEAR)).toEqual({ unit: "years", n: 1 });
  });

  it("clamps negative elapsed time (clock skew) to now", () => {
    expect(relativeTimeUnit(-MINUTE)).toEqual({ unit: "now", n: 0 });
  });
});
