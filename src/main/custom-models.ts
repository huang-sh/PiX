import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomModelInput } from "../shared/types.js";
import { CUSTOM_MODEL_APIS } from "../shared/types.js";
import { customModelInput } from "../shared/contracts.js";

/** models.json is Pi's own config; unknown fields must survive round-trips. */
interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  [key: string]: unknown;
}
interface ProviderConfig {
  models?: unknown[];
  api?: string;
  baseUrl?: string;
  [key: string]: unknown;
}
interface ProviderModel {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  [key: string]: unknown;
}
/** models.json is user-editable, so every array entry needs a runtime check. */
const isProviderModel = (value: unknown): value is ProviderModel =>
  !!value && typeof value === "object" && typeof (value as ProviderModel).id === "string";

function readConfig(path: string): ModelsConfig {
  let config: unknown = { providers: {} };
  try {
    config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Could not read models.json. Fix its JSON first; the file was not changed.");
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(config) || !object(config.providers)) throw new Error("Invalid models.json providers; the file was not changed.");
  return config as ModelsConfig;
}

/** Only return editable fields, never provider keys, headers or other credentials. */
export function getCustomModels(path: string): CustomModelInput[] {
  const config = readConfig(path);
  return Object.entries(config.providers).flatMap(([id, provider]) => {
    if (!Array.isArray(provider?.models)) return [];
    return provider.models
      .filter(isProviderModel)
      .flatMap((m) => {
        const api = CUSTOM_MODEL_APIS.find((candidate) => candidate === (m.api ?? provider.api));
        if (!api) return [];
        return [{
          provider: id, modelId: m.id, name: m.name ?? m.id,
          baseUrl: m.baseUrl ?? provider.baseUrl ?? "", api,
          contextWindow: m.contextWindow ?? 128000, maxTokens: m.maxTokens ?? 16384,
          reasoning: m.reasoning === true, imageInput: m.input?.includes("image") === true,
        }];
      });
  });
}

/** Save Pi's config without replacing existing providers or advanced options. */
export function addCustomModel(path: string, input: CustomModelInput, update = false) {
  const v = customModelInput(input);
  const config = readConfig(path);
  const provider = Object.hasOwn(config.providers, v.provider) ? config.providers[v.provider] : {};
  if (!provider || typeof provider !== "object" || Array.isArray(provider) || (provider.models !== undefined && !Array.isArray(provider.models)))
    throw new Error("Invalid provider configuration; the file was not changed.");
  const models = [...(provider.models ?? [])];
  const index = models.findIndex((model) => isProviderModel(model) && model.id === v.modelId);
  if (!update && index !== -1)
    throw new Error("This model already exists in models.json");
  if (update && index === -1) throw new Error("Custom model no longer exists. Refresh the model list.");
  const model = {
      ...(update ? models[index] as object : {}),
      id: v.modelId, name: v.name || v.modelId, api: v.api, baseUrl: v.baseUrl,
      contextWindow: v.contextWindow, maxTokens: v.maxTokens,
      reasoning: v.reasoning, input: v.imageInput ? ["text", "image"] : ["text"],
  };
  if (update) models[index] = model;
  else models.push(model);
  config.providers[v.provider] = {
    ...provider, models,
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
