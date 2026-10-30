/** An optional balance query for an OpenAI-compatible provider. Credentials
 * come from the provider's existing login, never from these settings. */
export interface BalanceQuery {
  url: string;
  /** Dot-separated JSON fields, including numeric array indexes. */
  path: string;
  currency: string;
  multiplier: number;
}

export interface ProviderBalance {
  provider: string;
  name: string;
  amounts: Array<{ currency: string; remaining: number }>;
  updatedAt?: string;
  stale?: boolean;
  error?: "unsupported" | "credentials" | "authorization" | "rateLimited" | "unavailable" | "invalidResponse" | "timeout" | "originMismatch";
}

/** Validate saved settings and form input without executing expressions. */
export function balanceQuery(value: unknown): BalanceQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid balance query");
  const v = value as Record<string, unknown>;
  if (typeof v.url !== "string" || v.url.length > 2048) throw new Error("Invalid balance URL");
  const url = new URL(v.url.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Balance URL must be HTTP(S) without embedded credentials or a fragment");
  if (typeof v.path !== "string" || v.path.length > 200 || !/^[\w-]+(?:\.[\w-]+)*$/.test(v.path)
    || v.path.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part)))
    throw new Error("Invalid balance field path");
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) throw new Error("Invalid balance currency");
  const multiplier = v.multiplier ?? 1;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0)
    throw new Error("Invalid balance multiplier");
  return { url: url.href, path: v.path, currency: v.currency, multiplier };
}
