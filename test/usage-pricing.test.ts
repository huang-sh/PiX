import test from "node:test";
import assert from "node:assert/strict";
import { parsePricingTable, resolvePricing } from "../src/main/usage-pricing.js";

// A slice shaped like LiteLLM's model_prices_and_context_window.json.
const table = parsePricingTable({
  "anthropic/claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  "openai/gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
  },
  "deepseek/deepseek-chat": {
    input_cost_per_token: 2.7e-7,
    output_cost_per_token: 1.1e-6,
  },
  "sample_spec": { max_input_tokens: 4096 },
  "embedder": { input_cost_per_token: "not-a-number" },
});

test("parsing keeps entries with rates and drops metadata", () => {
  // Three usable models plus the garbage-rate embedder below; only metadata
  // entries without any cost field are dropped.
  assert.equal(table.size, 4);
  assert.ok(!table.has("sample_spec"));
  // Entries whose only rate fields are unusable still resolve, priced at zero.
  assert.deepEqual(table.get("embedder"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("model resolution walks pair, bare id, and vendor suffix", () => {
  // Exact provider pair.
  assert.deepEqual(resolvePricing(table, "deepseek/deepseek-chat")!.input, 2.7e-7);
  // Dotted pi spelling against the dashed LiteLLM key, via the bare id.
  assert.deepEqual(resolvePricing(table, "pi/claude-sonnet-4.5")!.output, 1.5e-5);
  // Routing provider fronts a table model: suffix match finds the vendor key.
  assert.deepEqual(resolvePricing(table, "github-copilot/gpt-4o")!.cacheRead, 1.25e-6);
  // Unknown models and the unattributed bucket resolve nothing.
  assert.equal(resolvePricing(table, "zai/glm-5.3"), undefined);
  assert.equal(resolvePricing(table, "Tools/summaries"), undefined);
});
