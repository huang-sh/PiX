import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomModelInput } from "../shared/types.js";
import { CUSTOM_MODEL_APIS } from "../shared/types.js";
import { validateRouteInput } from "../shared/contracts.js";

function readConfig(path: string) {
  let config: any = { providers: {} };
  try {
    config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Could not read models.json. Fix its JSON first; the file was not changed.");
  }
  const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(config) || !object(config.providers)) throw new Error("Invalid models.json providers; the file was not changed.");
  return config;
}

/** Only return editable fields, never provider keys, headers or other credentials. */
export function getCustomModels(path: string): CustomModelInput[] {
  const config = readConfig(path);
  return Object.entries(config.providers).flatMap(([id, value]) => {
    const provider = value as any;
    if (!Array.isArray(provider?.models)) return [];
    return provider.models.filter((m: any) => m && typeof m.id === "string" && CUSTOM_MODEL_APIS.includes(m.api ?? provider.api)).map((m: any) => ({
      provider: id, modelId: m.id, name: m.name ?? m.id,
      baseUrl: m.baseUrl ?? provider.baseUrl ?? "", api: m.api ?? provider.api,
      contextWindow: m.contextWindow ?? 128000, maxTokens: m.maxTokens ?? 16384,
      reasoning: m.reasoning === true, imageInput: m.input?.includes("image") === true,
    }));
  });
}

/** Save Pi's config without replacing existing providers or advanced options. */
export function addCustomModel(path: string, input: CustomModelInput, update = false) {
  const v = validateRouteInput("agent.control", { ...input, action: update ? "updateCustomModel" : "addCustomModel" }) as unknown as CustomModelInput;
  const config = readConfig(path);
  const provider = Object.hasOwn(config.providers, v.provider) ? config.providers[v.provider] : {};
  if (!provider || typeof provider !== "object" || Array.isArray(provider) || (provider.models !== undefined && !Array.isArray(provider.models)))
    throw new Error("Invalid provider configuration; the file was not changed.");
  const models = [...(provider.models ?? [])];
  const index = models.findIndex((model: any) => model?.id === v.modelId);
  if (!update && index !== -1)
    throw new Error("This model already exists in models.json");
  if (update && index === -1) throw new Error("Custom model no longer exists. Refresh the model list.");
  const model = {
      ...(update ? models[index] : {}),
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
