import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./debug-log.js";
import { pixHome } from "./paths.js";
import type { ModelPricing } from "../shared/usage.js";

/**
 * Per-token prices for estimating what providers refuse to report: LiteLLM's
 * canonical public model-price table (the same source pi-cost uses), cached on
 * disk so the usage panel works offline and does not refetch on every open.
 */
const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_CACHE_PATH = join(pixHome(), ".pix", "usage-pricing.json");
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8000;

/** model key (lowercased LiteLLM key) → per-token rates. */
export type PricingTable = Map<string, ModelPricing>;

const finiteRate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Keeps only entries that carry at least one per-token rate. */
export function parsePricingTable(json: unknown): PricingTable {
  const table: PricingTable = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) return table;
  for (const [key, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const pricing: ModelPricing = {
      input: finiteRate(record.input_cost_per_token) ?? 0,
      output: finiteRate(record.output_cost_per_token) ?? 0,
      cacheRead: finiteRate(record.cache_read_input_token_cost) ?? 0,
      cacheWrite: finiteRate(record.cache_creation_input_token_cost) ?? 0,
    };
    if (
      record.input_cost_per_token === undefined &&
      record.output_cost_per_token === undefined &&
      record.cache_read_input_token_cost === undefined &&
      record.cache_creation_input_token_cost === undefined
    )
      continue;
    table.set(key.toLowerCase(), pricing);
  }
  return table;
}

/**
 * Matches a usage record's "provider/modelId" against the table. Pi spells
 * versions with dots where LiteLLM uses dashes, and routing providers
 * (copilot, custom endpoints) front models the table knows under their real
 * vendor, so matching walks exact pair → bare id → shortest key ending in the
 * bare id.
 */
export function resolvePricing(
  table: PricingTable,
  model: string,
): ModelPricing | undefined {
  const slash = model.indexOf("/");
  const provider = slash >= 0 ? model.slice(0, slash) : "";
  const modelId = slash >= 0 ? model.slice(slash + 1) : model;
  const candidates = [modelId.toLowerCase(), modelId.toLowerCase().replaceAll(".", "-")];
  for (const candidate of candidates) {
    const pair = table.get(`${provider}/${candidate}`);
    if (pair) return pair;
  }
  for (const candidate of candidates) {
    const bare = table.get(candidate);
    if (bare) return bare;
  }
  for (const candidate of candidates) {
    const suffix = `/${candidate}`;
    let best: string | undefined;
    for (const key of table.keys()) {
      if (key.endsWith(suffix) && (best === undefined || key.length < best.length))
        best = key;
    }
    if (best !== undefined) return table.get(best);
  }
  return undefined;
}

/**
 * Memoized per-model resolver: the suffix match walks the whole table, and
 * every record of one model resolves the same way, so cost estimation pays
 * one lookup per distinct model instead of one per record.
 */
export function pricingResolver(table: PricingTable) {
  const memo = new Map<string, ModelPricing | undefined>();
  return (model: string): ModelPricing | undefined => {
    if (!memo.has(model)) memo.set(model, resolvePricing(table, model));
    return memo.get(model);
  };
}

interface PricingCache {
  fetchedAt: number;
  models: unknown;
}

let tableCache: { table: PricingTable; at: number } | undefined;
let loading: Promise<PricingTable> | undefined;

const readCache = (path: string): PricingCache | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && typeof (value as PricingCache).fetchedAt === "number"
      ? (value as PricingCache)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Fresh table from the in-memory cache, then the disk cache, refetching only
 * when both are stale. Any failure keeps the panel working: a stale cache is
 * better than none, and none at all just leaves unreported costs at zero
 * instead of blocking the route.
 */
export async function loadPricingTable(): Promise<PricingTable> {
  if (tableCache && Date.now() - tableCache.at < PRICING_TTL_MS) return tableCache.table;
  loading ??= (async () => {
    const stale = readCache(PRICING_CACHE_PATH);
    if (stale && Date.now() - stale.fetchedAt < PRICING_TTL_MS) {
      const table = parsePricingTable(stale.models);
      if (table.size) {
        tableCache = { table, at: stale.fetchedAt };
        return table;
      }
    }
    let table: PricingTable | undefined;
    try {
      const response = await fetch(PRICING_URL, {
        signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`pricing table fetch: HTTP ${response.status}`);
      const models = await response.json();
      table = parsePricingTable(models);
      try {
        mkdirSync(dirname(PRICING_CACHE_PATH), { recursive: true });
        const tmp = `${PRICING_CACHE_PATH}.tmp`;
        writeFileSync(
          tmp,
          JSON.stringify({ fetchedAt: Date.now(), models } satisfies PricingCache),
        );
        renameSync(tmp, PRICING_CACHE_PATH);
      } catch (e) { debugLog("usage pricing: cache write", e); }
    } catch (e) {
      debugLog("usage pricing: fetch", e);
    }
    if (table === undefined || table.size === 0) {
      table = stale ? parsePricingTable(stale.models) : new Map();
    }
    tableCache = { table, at: stale && table.size === 0 ? stale.fetchedAt : Date.now() };
    return table;
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}
