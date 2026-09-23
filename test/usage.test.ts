import test from "node:test";
import assert from "node:assert/strict";
import { validateRouteInput } from "../src/shared/contracts.js";
import {
  aggregateUsage,
  estimateUsageCosts,
  usageAmount,
  usageStart,
  type UsageRecord,
  type UsageSessionInput,
} from "../src/shared/usage.js";

const record = (
  timestamp: string,
  model: string,
  usage: Partial<UsageRecord["usage"]> = {},
): UsageRecord => ({
  timestamp,
  model,
  usage: usageAmount({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: { total: usage.cost ?? 0 },
  }),
});

const session = (
  id: string,
  records: UsageRecord[],
  modified: string,
): UsageSessionInput => ({
  id,
  path: `D:\\p\\${id}.jsonl`,
  created: records[0]?.timestamp ?? modified,
  modified,
  messageCount: records.length * 2,
  firstMessage: `prompt ${id}`,
  records,
});

// 2026-09-23 local, so day arithmetic in the tests is deterministic.
const now = new Date(2026, 8, 23, 15, 30);
const day = (offset: number, hour = 10) =>
  new Date(2026, 8, 23 + offset, hour).toISOString();
const localDay = (offset: number) => {
  const d = new Date(2026, 8, 23 + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Cost sums are float accumulations.
const near = (actual: number, expected: number) =>
  Math.abs(actual - expected) < 1e-9;

test("usage amount reads the provider-reported cost total and tolerates gaps", () => {
  assert.deepEqual(usageAmount({ input: 5, cost: { total: 0.25 } }), {
    input: 5,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.25,
  });
  assert.equal(usageAmount({ input: "x", cost: { total: Number.NaN } }).input, 0);
  assert.equal(usageAmount({}).cost, 0);
});

test("range starts are local midnights", () => {
  assert.equal(usageStart("today", now), new Date(2026, 8, 23).getTime());
  assert.equal(usageStart("7d", now), new Date(2026, 8, 17).getTime());
  assert.equal(usageStart("30d", now), new Date(2026, 7, 25).getTime());
  assert.equal(usageStart("all", now), null);
});

test("aggregation totals, buckets, and rows follow the range", () => {
  const sessions = [
    session("a", [
      record(day(0), "zai/glm-5.3", { input: 100, output: 10, cost: 0.1 }),
      record(day(0, 11), "Tools/summaries", { input: 50, cost: 0.05 }),
    ], day(0, 11)),
    session("b", [
      record(day(-1), "zai/glm-5.3", { input: 200, output: 20, cacheRead: 5, cost: 0.2 }),
    ], day(-1)),
    session("old", [
      record(day(-40), "openai/gpt-x", { input: 999, cost: 9 }),
    ], day(-40)),
    session("empty", [], day(0)),
  ];

  const week = aggregateUsage(sessions, "7d", now);
  assert.ok(near(week.totals.cost, 0.35));
  assert.equal(week.totals.input, 350);
  assert.equal(week.totals.cacheRead, 5);
  // Today keeps its own card even inside a wider range.
  assert.ok(near(week.today.cost, 0.15));
  assert.equal(week.today.input, 150);
  // One bucket per local day across the range, gaps included.
  assert.equal(week.days.length, 7);
  assert.deepEqual(
    week.days.map((d) => d.day),
    [...Array(7)].map((_, i) => localDay(i - 6)),
  );
  assert.ok(near(week.days.at(-1)!.cost, 0.15));
  assert.ok(near(week.days.at(-2)!.cost, 0.2));
  assert.equal(week.days.at(-3)!.cost, 0);
  // Models sort by cost; sessions without in-range usage drop out.
  assert.deepEqual(
    week.models.map((m) => m.model),
    ["zai/glm-5.3", "Tools/summaries"],
  );
  assert.equal(week.sessionCount, 2);
  assert.deepEqual(
    week.sessions.map((s) => s.id),
    ["a", "b"],
  );

  const all = aggregateUsage(sessions, "all", now);
  assert.ok(near(all.totals.cost, 9.35));
  assert.equal(all.sessionCount, 3);
  assert.ok(all.models.some((m) => m.model === "openai/gpt-x"));
  // "all" clamps its chart to the most recent days under the cap.
  assert.ok(all.days.length <= 90);

  const today = aggregateUsage(sessions, "today", now);
  assert.ok(near(today.totals.cost, 0.15));
  assert.ok(today.days.length === 1 && near(today.days[0]!.cost, 0.15));
});

test("estimateUsageCosts keeps actual costs and fills estimates by source", () => {
  const reported = record(day(0), "zai/glm-5.3", { input: 10, cost: 0.1 });
  const unreported = record(day(0), "github-copilot/claude-sonnet-4.5", {
    input: 1000,
    output: 200,
    cacheRead: 5000,
  });
  const unknown = record(day(0), "ds0model/mystery", { input: 50 });
  const sessions = [session("mix", [reported, unreported, unknown], day(0))];
  const rates = { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 0 };
  estimateUsageCosts(
    sessions,
    (model) => (model === "github-copilot/claude-sonnet-4.5" ? rates : undefined),
  );
  assert.equal(reported.source, "actual");
  assert.ok(near(reported.usage.cost, 0.1));
  assert.equal(unreported.source, "estimated");
  assert.ok(near(unreported.usage.cost, 1000e-6 + 200 * 5e-6 + 5000e-7));
  assert.equal(unknown.source, "none");
  assert.equal(unknown.usage.cost, 0);

  const overview = aggregateUsage(sessions, "today", now);
  assert.ok(
    near(overview.totals.cost, reported.usage.cost + unreported.usage.cost),
  );
  assert.ok(near(overview.estimatedCost, unreported.usage.cost));
  const modelRow = overview.models.find((m) => m.model === unreported.model)!;
  assert.ok(near(modelRow.estimatedCost, unreported.usage.cost));
  const sessionRow = overview.sessions[0]!;
  assert.ok(near(sessionRow.estimatedCost, unreported.usage.cost));
  assert.ok(near(overview.days[0]!.estimatedCost, unreported.usage.cost));
});

test("subscription-marked providers cost nothing, even when reported", () => {
  const planReply = record(day(0), "zai/glm-5.3", { input: 100, cost: 0.5 });
  const planUnknown = record(day(0), "zai/some-model", { input: 70 });
  const paid = record(day(0), "openai/gpt-x", { input: 10, cost: 0.2 });
  const sessions = [session("plan", [planReply, planUnknown, paid], day(0))];
  estimateUsageCosts(
    sessions,
    (model) => (model === "zai/some-model" ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } : undefined),
    new Set(["ZAI"]),
  );
  // Reported and estimable alike: a subscription plan is not billed per token.
  assert.equal(planReply.source, "unbilled");
  assert.equal(planReply.usage.cost, 0);
  assert.equal(planUnknown.source, "unbilled");
  assert.equal(planUnknown.usage.cost, 0);
  assert.equal(paid.source, "actual");

  const overview = aggregateUsage(sessions, "today", now);
  assert.ok(near(overview.totals.cost, 0.2));
  assert.equal(overview.estimatedCost, 0);
  // Tokens still count for the subscription models.
  assert.equal(overview.totals.input, 180);
});

test("usage.overview validates its range and defaults", () => {
  assert.deepEqual(validateRouteInput("usage.overview", {}), { range: "30d" });
  assert.deepEqual(validateRouteInput("usage.overview", { range: "all" }), { range: "all" });
  assert.deepEqual(validateRouteInput("usage.overview", { range: "bogus" }), { range: "30d" });
});
