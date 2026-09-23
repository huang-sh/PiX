/**
 * Usage accounting for the settings page's usage panel, in the same terms the
 * pi SDK reports: token counts per reply plus the cost the provider returned.
 * The main process extracts one UsageRecord per billed event from session
 * files; everything here is pure aggregation on top of those records.
 */
export type UsageRange = "today" | "7d" | "30d" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["today", "7d", "30d", "all"];

export interface UsageAmount {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Where a record's cost came from: the provider's own number, a price-table
 * estimate (the provider reports none), a subscription plan the user marked
 * as not billed per token, or nothing (no price data either). */
export type CostSource = "actual" | "estimated" | "unbilled" | "none";

/** Per-token rates for the estimated source. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One billed event: an assistant reply, auxiliary usage entry, or summary generation. */
export interface UsageRecord {
  timestamp: string;
  /** "provider/modelId" attribution; summary/tool usage shares the SDK's "Tools/summaries" bucket. */
  model: string;
  usage: UsageAmount;
  /** Set by estimateUsageCosts; absent while records are still raw. */
  source?: CostSource;
}

/** A session file reduced to identity plus its billed events. */
export interface UsageSessionInput {
  id: string;
  path: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  records: UsageRecord[];
}

export interface UsageSessionRow {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  usage: UsageAmount;
  /** Portion of usage.cost estimated from price tables. */
  estimatedCost: number;
}

export interface UsageModelRow {
  model: string;
  usage: UsageAmount;
  estimatedCost: number;
}

export interface UsageDayRow {
  /** Local calendar day, "yyyy-mm-dd". */
  day: string;
  cost: number;
  /** Portion of cost estimated from price tables. */
  estimatedCost: number;
  tokens: number;
}

export interface UsageOverview {
  generatedAt: string;
  range: UsageRange;
  totals: UsageAmount;
  /** Portion of totals.cost estimated from price tables. */
  estimatedCost: number;
  today: UsageAmount;
  sessionCount: number;
  days: UsageDayRow[];
  models: UsageModelRow[];
  sessions: UsageSessionRow[];
}

/** Day buckets never grow beyond this even for "all", so the chart stays readable. */
const MAX_DAY_BUCKETS = 90;
/** Sessions beyond the newest of these would only pad the table. */
const MAX_SESSION_ROWS = 200;

const emptyAmount = (): UsageAmount => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

const numberOrZero = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const usageAmount = (usage: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | number;
}): UsageAmount => ({
  input: numberOrZero(usage.input),
  output: numberOrZero(usage.output),
  cacheRead: numberOrZero(usage.cacheRead),
  cacheWrite: numberOrZero(usage.cacheWrite),
  cost: numberOrZero(
    typeof usage.cost === "number" ? usage.cost : usage.cost?.total,
  ),
});

export const usageTokens = (amount: UsageAmount) =>
  amount.input + amount.output + amount.cacheRead + amount.cacheWrite;

/**
 * Fills in each record's cost source: subscription-billed providers (coding
 * plans) cost nothing by user marking; provider-reported costs stay as-is
 * (actual); where the provider reports none, the record's cost becomes a
 * price-table estimate; with no pricing match either, it stays zero (none).
 */
export function estimateUsageCosts(
  sessions: UsageSessionInput[],
  resolve: (model: string) => ModelPricing | undefined,
  unbilled: ReadonlySet<string> = new Set(),
): void {
  const unbilledProviders = new Set([...unbilled].map(provider => provider.toLowerCase()));
  for (const session of sessions)
    for (const record of session.records) {
      const provider = record.model.slice(0, record.model.indexOf("/"));
      if (provider && unbilledProviders.has(provider.toLowerCase())) {
        record.usage = { ...record.usage, cost: 0 };
        record.source = "unbilled";
        continue;
      }
      if (record.usage.cost > 0) {
        record.source = "actual";
        continue;
      }
      const pricing = resolve(record.model);
      if (!pricing) {
        record.source = "none";
        continue;
      }
      const estimate =
        record.usage.input * pricing.input +
        record.usage.output * pricing.output +
        record.usage.cacheRead * pricing.cacheRead +
        record.usage.cacheWrite * pricing.cacheWrite;
      record.usage.cost = estimate;
      record.source = estimate > 0 ? "estimated" : "none";
    }
}

const addAmount = (sum: UsageAmount, record: UsageRecord) => {
  sum.input += record.usage.input;
  sum.output += record.usage.output;
  sum.cacheRead += record.usage.cacheRead;
  sum.cacheWrite += record.usage.cacheWrite;
  sum.cost += record.usage.cost;
};

const estimatedCostOf = (record: UsageRecord) =>
  record.source === "estimated" ? record.usage.cost : 0;

/** Group-by accumulator: an amount plus the estimated portion inside it. */
interface UsageBucket {
  amount: UsageAmount;
  estimated: number;
}
const bucketFor = (map: Map<string, UsageBucket>, key: string) => {
  let bucket = map.get(key);
  if (!bucket) map.set(key, (bucket = { amount: emptyAmount(), estimated: 0 }));
  return bucket;
};
const addRecord = (bucket: UsageBucket, record: UsageRecord) => {
  addAmount(bucket.amount, record);
  bucket.estimated += estimatedCostOf(record);
};

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

const midnight = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Inclusive start of a range as a local-time epoch; null means unbounded. */
export function usageStart(range: UsageRange, now = new Date()): number | null {
  if (range === "all") return null;
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return midnight(start);
}

export function aggregateUsage(
  sessions: UsageSessionInput[],
  range: UsageRange,
  now = new Date(),
): UsageOverview {
  const startMs = usageStart(range, now);
  const todayKey = localDay(now);
  const totals = { amount: emptyAmount(), estimated: 0 };
  const today = emptyAmount();
  const byModel = new Map<string, UsageBucket>();
  const byDay = new Map<string, UsageBucket>();
  const rows: UsageSessionRow[] = [];

  for (const session of sessions) {
    const inRange = { amount: emptyAmount(), estimated: 0 };
    for (const record of session.records) {
      const time = Date.parse(record.timestamp);
      if (!Number.isFinite(time)) continue;
      if (startMs !== null && time < startMs) continue;
      const dayKey = localDay(new Date(time));
      addRecord(inRange, record);
      addRecord(totals, record);
      if (dayKey === todayKey) addAmount(today, record);
      addRecord(bucketFor(byModel, record.model), record);
      addRecord(bucketFor(byDay, dayKey), record);
    }
    if (usageTokens(inRange.amount) === 0 && inRange.amount.cost === 0) continue;
    rows.push({
      id: session.id,
      path: session.path,
      ...(session.name ? { name: session.name } : {}),
      firstMessage: session.firstMessage,
      modified: session.modified,
      messageCount: session.messageCount,
      usage: inRange.amount,
      estimatedCost: inRange.estimated,
    });
  }

  // One bucket per local day from the range start to today, so gaps between
  // activity still show as empty columns instead of collapsing the timeline.
  // "all" clamps its start forward so the most recent days are the ones kept
  // under the cap, and days advance through calendar arithmetic to stay on
  // local midnight across DST transitions.
  const earliest =
    byDay.size ? midnight(new Date([...byDay.keys()].sort()[0]!)) : midnight(now);
  const firstBucket =
    startMs !== null
      ? startMs
      : Math.max(
          earliest,
          midnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (MAX_DAY_BUCKETS - 1))),
        );
  const days: UsageDayRow[] = [];
  const cursor = new Date(firstBucket);
  while (midnight(cursor) <= midnight(now) && days.length < MAX_DAY_BUCKETS) {
    const key = localDay(cursor);
    const bucket = byDay.get(key);
    days.push({
      day: key,
      cost: bucket?.amount.cost ?? 0,
      estimatedCost: bucket?.estimated ?? 0,
      tokens: bucket ? usageTokens(bucket.amount) : 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    generatedAt: now.toISOString(),
    range,
    totals: totals.amount,
    estimatedCost: totals.estimated,
    today,
    sessionCount: rows.length,
    days,
    models: [...byModel]
      .map(([model, bucket]) => ({
        model,
        usage: bucket.amount,
        estimatedCost: bucket.estimated,
      }))
      .filter((row) => usageTokens(row.usage) > 0 || row.usage.cost > 0)
      .sort(
        (a, b) =>
          b.usage.cost - a.usage.cost ||
          usageTokens(b.usage) - usageTokens(a.usage),
      ),
    sessions: rows
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, MAX_SESSION_ROWS),
  };
}
