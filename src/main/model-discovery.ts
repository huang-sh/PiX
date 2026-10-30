import type { CustomProviderInput, DiscoveredModel } from "../shared/types.js";
import { customProviderInput } from "../shared/contracts.js";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function readCatalog(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Model endpoint returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) throw new Error("Model list response exceeds 8 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!body) throw new Error("Model endpoint returned an invalid model list");
  return body;
}

/** Discovery is read-only; credentials stay in the main process and never enter results. */
export async function discoverModels(
  input: CustomProviderInput, auth: ModelAuth = {}, signal = AbortSignal.timeout(15000),
): Promise<DiscoveredModel[]> {
  const v = customProviderInput({ ...input, baseUrl: auth.baseUrl ?? input.baseUrl });
  const anthropic = v.api === "anthropic-messages";
  const google = v.api === "google-generative-ai";
  const url = new URL(v.baseUrl);
  url.hash = "";
  // Anthropic's conversation SDK appends /v1 to the supplied base URL.
  url.pathname = url.pathname.replace(/\/+$/, "") + (anthropic ? "/v1/models" : "/models");
  const defaults: Record<string, string> = { Accept: "application/json" };
  const key = v.apiKey || auth.apiKey;
  const bearer = !google && (!anthropic || v.provider === "github-copilot" || key?.includes("sk-ant-oat") === true);
  const keyHeader = bearer ? "Authorization" : google ? "x-goog-api-key" : "x-api-key";
  if (key) defaults[keyHeader] = bearer ? `Bearer ${key}` : key;
  if (anthropic) defaults["anthropic-version"] = "2023-06-01";
  const headers = new Headers(providerHeadersToRecord(defaults, auth.headers));
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      const response = await fetch(url, { headers, signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Could not fetch models (HTTP ${response.status}). Check the base URL, API key and model-list support.`);
      }
      const body = await readCatalog(response);
      const entries = google ? body.models : body.data;
      if (!Array.isArray(entries)) throw new Error("Model endpoint returned an invalid model list");
      for (const entry of entries) {
        const m = record(entry);
        if (!m) throw new Error("Model endpoint returned an invalid model entry");
        const id = google ? m.name : m.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("Model endpoint returned an invalid model ID");
        // Gemini also lists embedding models, which cannot serve a conversation.
        if (google && Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes("generateContent")) continue;
        const modelId = google ? id.replace(/^models\//, "") : id.trim();
        if (!modelId) throw new Error("Model endpoint returned an invalid model ID");
        const name = m.display_name ?? m.displayName ?? m.name;
        models.set(modelId, { id: modelId, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) });
        if (models.size > 10000) throw new Error("Model list exceeds 10000 models");
      }
      const cursor = google ? body.nextPageToken : body.has_more === true ? body.last_id ?? record(entries.at(-1))?.id : undefined;
      if (cursor === undefined || cursor === "" || cursor === null) {
        if (!google && body.has_more === true) throw new Error("Model endpoint returned an invalid pagination cursor");
        return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
      }
      if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Model endpoint returned an invalid pagination cursor");
      cursors.add(cursor);
      url.searchParams.set(google ? "pageToken" : "after_id", cursor);
    }
    throw new Error("Model list exceeds 100 pages");
  } catch (error) {
    if (signal.aborted) throw new Error("Fetching models timed out. Please try again.");
    if (error instanceof SyntaxError) throw new Error("Model endpoint did not return JSON. Check the API base URL.");
    throw error;
  }
}
