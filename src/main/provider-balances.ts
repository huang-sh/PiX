import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { balanceQuery, type BalanceQuery, type ProviderBalance } from "../shared/provider-balances.js";

const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
type Amounts = ProviderBalance["amounts"];
type Reading = { amounts: Amounts; updatedAt: string };
type BalanceError = NonNullable<ProviderBalance["error"]>;
interface Source { url: URL; read(body: unknown): Amounts }
export interface BalanceProvider {
  provider: string;
  name: string;
  baseUrl?: string;
  query?: BalanceQuery;
  auth(signal: AbortSignal): Promise<ModelAuth | undefined>;
}

class QueryError extends Error {
  constructor(readonly code: BalanceError) { super(code); }
}

const amount = (value: unknown): number => {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "")
    throw new QueryError("invalidResponse");
  const n = Number(value);
  if (!Number.isFinite(n)) throw new QueryError("invalidResponse");
  return n;
};
function field(body: unknown, path: string): unknown {
  let value = body;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) throw new QueryError("invalidResponse");
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Select by the actual endpoint, so a renamed provider works and a relay
 * never sends its key to the original vendor's billing endpoint. */
export function balanceSource(baseUrl?: string, query?: BalanceQuery): Source | undefined {
  if (!baseUrl) return undefined;
  const base = new URL(baseUrl);
  if (query) {
    const q = balanceQuery(query), url = new URL(q.url);
    if (url.origin !== base.origin) throw new QueryError("originMismatch");
    return { url, read: body => [{ currency: q.currency, remaining: amount(amount(field(body, q.path)) * q.multiplier) }] };
  }
  if (base.protocol !== "https:") return undefined;
  const simple = (path: string, key: string, currency: string): Source => ({
    url: new URL(path, base.origin), read: body => [{ currency, remaining: amount(field(body, key)) }],
  });
  switch (base.host) {
    case "api.deepseek.com":
      return { url: new URL("/user/balance", base.origin), read: body => {
        const infos = field(body, "balance_infos");
        if (!Array.isArray(infos) || !infos.length) throw new QueryError("invalidResponse");
        return infos.map(info => {
          const currency = field(info, "currency");
          if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new QueryError("invalidResponse");
          return { currency, remaining: amount(field(info, "total_balance")) };
        }).sort((a, b) => a.currency.localeCompare(b.currency));
      } };
    case "api.moonshot.cn": return simple("/v1/users/me/balance", "data.available_balance", "CNY");
    case "api.moonshot.ai": return simple("/v1/users/me/balance", "data.available_balance", "USD");
    case "api.siliconflow.cn": return simple("/v1/user/info", "data.totalBalance", "CNY");
    case "api.siliconflow.com": return simple("/v1/user/info", "data.totalBalance", "USD");
    case "openrouter.ai":
      return { url: new URL("/api/v1/credits", base.origin), read: body => [{ currency: "USD",
        remaining: amount(amount(field(body, "data.total_credits")) - amount(field(body, "data.total_usage"))) }] };
    default: return undefined;
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new QueryError("invalidResponse");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new QueryError("invalidResponse");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new QueryError("invalidResponse");
    throw error;
  } finally { await reader.cancel(); }
}

/** Credential/configuration fingerprints isolate cached accounts. Only amounts
 * and timestamps reach disk; failures never replace a successful reading. */
export class ProviderBalanceService {
  private good = new Map<string, Reading>();
  private recent = new Map<string, { at: number; result: ProviderBalance }>();
  private pending = new Map<string, Promise<ProviderBalance>>();
  private loaded = false;
  constructor(private readonly path?: string) {}

  async read(p: BalanceProvider, force = false, signal = AbortSignal.timeout(8000)): Promise<ProviderBalance> {
    const empty = { provider: p.provider, name: p.name, amounts: [] };
    let source: Source | undefined;
    let headers: Headers;
    try {
      if (!p.query && !balanceSource(p.baseUrl)) return { ...empty, error: "unsupported" };
      const auth = await p.auth(signal);
      if (!auth) return { ...empty, error: "credentials" };
      source = balanceSource(auth.baseUrl ?? p.baseUrl, p.query);
      if (!source) return { ...empty, error: "unsupported" };
      const defaults = { Accept: "application/json", ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}) };
      headers = new Headers(providerHeadersToRecord(defaults, auth.headers));
      if (!headers.has("authorization") && !headers.has("x-api-key")) return { ...empty, error: "credentials" };
    } catch (error) {
      return { ...empty, error: error instanceof QueryError ? error.code : signal.aborted ? "timeout" : "credentials" };
    }
    const key = createHash("sha256").update(JSON.stringify([p.provider, source.url.href, p.query, [...headers].sort()])).digest("hex");
    this.load();
    const pending = this.pending.get(key);
    if (pending) return { ...await pending, name: p.name };
    const recent = this.recent.get(key);
    if (!force && recent && Date.now() - recent.at < CACHE_MS) return { ...recent.result, name: p.name };
    const request = this.fetch(p, source, headers, key, signal);
    this.pending.set(key, request);
    try { return await request; }
    finally { this.pending.delete(key); }
  }

  private async fetch(p: BalanceProvider, source: Source, headers: Headers, key: string, signal: AbortSignal): Promise<ProviderBalance> {
    let result: ProviderBalance = { provider: p.provider, name: p.name, amounts: [] };
    try {
      const response = await fetch(source.url, { headers, signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new QueryError(response.status === 401 || response.status === 403 ? "authorization"
          : response.status === 429 ? "rateLimited" : "unavailable");
      }
      const reading = { amounts: source.read(await readJson(response)), updatedAt: new Date().toISOString() };
      result = { ...result, ...reading };
      this.good.set(key, reading);
      this.save();
    } catch (error) {
      const code = error instanceof QueryError ? error.code : signal.aborted ? "timeout" : "unavailable";
      // An invalid/revoked login must not appear to have a usable balance.
      const previous = code === "authorization" ? undefined : this.good.get(key);
      if (code === "authorization") { this.good.delete(key); this.save(); }
      result = { ...result, ...previous, ...(previous ? { stale: true } : {}), error: code };
    }
    this.recent.set(key, { at: Date.now(), result });
    while (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value!);
    return result;
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path) return;
    try {
      const entries: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(entries)) return;
      for (const [key, reading] of entries.slice(-100)) {
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !reading || !Array.isArray(reading.amounts)
          || typeof reading.updatedAt !== "string" || !Number.isFinite(Date.parse(reading.updatedAt))) continue;
        if (reading.amounts.length > 0 && reading.amounts.length <= 10 && reading.amounts.every((a: { currency: unknown; remaining: unknown }) =>
          typeof a.currency === "string" && /^[A-Z]{3}$/.test(a.currency) && typeof a.remaining === "number" && Number.isFinite(a.remaining)))
          this.good.set(key, { amounts: reading.amounts.map((a: { currency: string; remaining: number }) => ({ currency: a.currency, remaining: a.remaining })), updatedAt: reading.updatedAt });
      }
    } catch { /* Missing/corrupt cache leaves live querying available. */ }
  }

  private save() {
    while (this.good.size > 100) this.good.delete(this.good.keys().next().value!);
    if (!this.path) return;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temp, JSON.stringify([...this.good]), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
    } catch { /* Cache persistence never blocks the balance query. */ }
    finally { try { unlinkSync(temp); } catch {} }
  }
}
