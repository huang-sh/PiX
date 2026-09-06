import type { DesktopRoute } from "./types.js";
import { CUSTOM_MODEL_APIS } from "./types.js";
import { validatePromptImages } from "./images.js";
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object payload");
  return value as Record<string, unknown>;
};
const str = (
  value: unknown,
  name: string,
  optional = false,
): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()))
    throw new Error(`${name} must be a non-empty string`);
  return value;
};
const externalUrl = (value: unknown) => {
  const url = new URL(str(value, "url")!);
  if (!["https:", "http:", "mailto:"].includes(url.protocol))
    throw new Error(`External protocol is not allowed: ${url.protocol}`);
  return url.href;
};
const integer = (value: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value as number;
};
export function validateRouteInput(
  route: DesktopRoute,
  input: unknown,
): Record<string, unknown> {
  const v = input === undefined ? {} : obj(input);
  switch (route) {
    case "wsl.connect":
      return {
        distro: str(v.distro, "distro"),
        cwd: v.browse === true ? str(v.cwd, "cwd", true) ?? "" : str(v.cwd, "cwd"),
        ...(v.browse === true ? { browse: true } : {}),
      };
    case "ssh.connect":
      return {
        host: str(v.host, "host"),
        cwd: str(v.cwd, "cwd"),
        ...(v.browse === true ? { browse: true } : {}),
      };
    case "remote.openProject":
    case "remote.directories":
    case "workspace.directories":
    case "workspace.open":
      return { path: str(v.path, "path") };
    case "app.openExternal":
      return { url: externalUrl(v.url) };
    case "app.openProject":
      return { id: str(v.id, "id") };
    case "app.forgetProject":
      return { id: str(v.id, "id") };
    case "session.open":
      return { path: str(v.path, "path") };
    case "session.import":
      return {};
    case "session.rename":
      return { path: str(v.path, "path"), name: str(v.name, "name") };
    case "session.delete":
      return {
        path: str(v.path, "path"),
        // Set when the renderer already collected an in-app confirmation.
        ...(v.confirmed === true ? { confirmed: true } : {}),
      };
    case "workspace.read":
      return { path: str(v.path, "path") };
    case "workspace.tree":
      return { path: str(v.path, "path", true) ?? "" };
    case "workspace.write":
      return {
        path: str(v.path, "path"),
        content: str(v.content, "content", true) ?? "",
      };
    case "git.diff":
      return { path: str(v.path, "path", true), staged: v.staged === true };
    case "shell.run":
      return { command: str(v.command, "command") };
    case "shell.abort":
      return { id: str(v.id, "id") };
    case "terminal.create":
      return {
        cols: integer(v.cols, "cols", 2, 500),
        rows: integer(v.rows, "rows", 1, 200),
      };
    case "terminal.write":
      return {
        id: str(v.id, "id"),
        data: str(v.data, "data", true) ?? "",
      };
    case "terminal.resize":
      return {
        id: str(v.id, "id"),
        cols: integer(v.cols, "cols", 2, 500),
        rows: integer(v.rows, "rows", 1, 200),
      };
    case "terminal.kill":
      return { id: str(v.id, "id") };
    case "settings.update": {
      const patch = obj(v.patch);
      if (v.scope !== "project" && v.scope !== "global" && Object.hasOwn(patch, "theme") &&
          patch.theme !== "light" && patch.theme !== "dark" && patch.theme !== "system" && patch.theme !== "teal")
        throw new Error("theme must be light, dark, teal or system");
      return {
        scope:
          v.scope === "project"
            ? "project"
            : v.scope === "global"
              ? "global"
              : "app",
        patch,
        replace: v.replace === true,
      };
    }
    case "settings.reset":
      return {
        scope:
          v.scope === "project"
            ? "project"
            : v.scope === "global"
              ? "global"
              : "app",
      };
    case "layout.save":
      return { layout: obj(v.layout) };
    case "agent.control": {
      const action = str(v.action, "action")!;
      if (action === "deleteNode")
        return { action, nodeId: str(v.nodeId, "nodeId"), graphId: str(v.graphId, "graphId") };
      if (action === "promptAt") {
        const requestId = str(v.requestId, "requestId")!;
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error("Invalid request ID");
        const images = v.images === undefined ? undefined : validatePromptImages(v.images);
        return { action, requestId, nodeId: v.nodeId === null ? null : str(v.nodeId, "nodeId"),
          text: str(v.text, "text", !!images?.length) ?? "", ...(images?.length ? { images } : {}),
          provider: str(v.provider, "provider", true), modelId: str(v.modelId, "modelId", true),
          thinkingLevel: str(v.thinkingLevel, "thinkingLevel", true) };
      }
      if (action === "branchAbort") return { action, branchId: str(v.branchId, "branchId"), runId: str(v.runId, "runId") };
      if (["prompt", "steer", "followUp"].includes(action)) {
        const images = v.images === undefined ? undefined : validatePromptImages(v.images);
        return { action, text: str(v.text, "text", !!images?.length) ?? "", ...(images?.length ? { images } : {}) };
      }
      if (action === "setModel")
        return {
          action,
          provider: str(v.provider, "provider"),
          modelId: str(v.modelId, "modelId"),
          persist: v.persist === true,
        };
      if (action === "addCustomModel" || action === "updateCustomModel") {
        const provider = str(v.provider, "provider")!.trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || ["__proto__", "constructor", "prototype"].includes(provider))
          throw new Error("Invalid provider ID");
        const baseUrl = str(v.baseUrl, "baseUrl")!.trim();
        const url = new URL(baseUrl);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Model endpoint must be an HTTP(S) URL without embedded credentials");
        if (!CUSTOM_MODEL_APIS.includes(v.api as typeof CUSTOM_MODEL_APIS[number]))
          throw new Error("Unsupported model API");
        return {
          action, provider, baseUrl, api: v.api,
          modelId: str(v.modelId, "modelId")!.trim(),
          name: str(v.name, "name", true)?.trim(),
          apiKey: str(v.apiKey, "apiKey", true)?.trim(),
          contextWindow: integer(v.contextWindow, "contextWindow", 1, Number.MAX_SAFE_INTEGER),
          maxTokens: integer(v.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER),
          reasoning: v.reasoning === true,
          imageInput: v.imageInput === true,
        };
      }
      if (action === "setThinking")
        return { action, level: str(v.level, "level") };
      if (action === "setQueueMode")
        return {
          action,
          kind: v.kind === "followUp" ? "followUp" : "steering",
          mode: v.mode === "all" ? "all" : "one-at-a-time",
        };
      if (action === "compact")
        return {
          action,
          instructions: str(v.instructions, "instructions", true),
        };
      if (action === "setAutoCompaction" || action === "setAutoRetry")
        return { action, enabled: v.enabled === true };
      if (action === "bash")
        return {
          action,
          command: str(v.command, "command"),
          excludeFromContext: v.excludeFromContext === true,
        };
      if (action === "exportHtml")
        return { action, outputPath: str(v.outputPath, "outputPath", true) };
      if (action === "setName") return { action, name: str(v.name, "name") };
      if (action === "setTools")
        return {
          action,
          names: Array.isArray(v.names)
            ? v.names.filter((x) => typeof x === "string")
            : [],
        };
      if (action === "getSkills" || action === "getExtensions")
        return { action, reload: v.reload === true };
      if (action === "loginApiKey")
        return {
          action,
          provider: str(v.provider, "provider"),
          apiKey: str(v.apiKey, "apiKey"),
        };
      if (action === "loginOAuth")
        return {
          action,
          provider: str(v.provider, "provider"),
          method: v.method === "device-code" ? "device-code" : "browser",
        };
      if (action === "logout")
        return { action, provider: str(v.provider, "provider") };
      if (action === "setBrokerProviders")
        return {
          action,
          providers: Array.isArray(v.providers)
            ? v.providers.map((x) => str(x, "provider"))
            : [],
          ...(Array.isArray(v.models) ? { models: v.models.map((value) => {
            const m = obj(value);
            return {
              provider: str(m.provider, "provider"), id: str(m.id, "id"),
              name: str(m.name, "name"), api: str(m.api, "api"),
              reasoning: m.reasoning === true,
              thinkingLevelMap: m.thinkingLevelMap === undefined ? undefined : obj(m.thinkingLevelMap),
              input: Array.isArray(m.input) && m.input.includes("image") ? ["text", "image"] : ["text"],
              contextWindow: integer(m.contextWindow, "contextWindow", 1, Number.MAX_SAFE_INTEGER),
              maxTokens: integer(m.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER),
              cost: obj(m.cost),
            };
          }) } : {}),
        };
      if (action === "setLabel")
        return {
          action,
          entryId: str(v.entryId, "entryId"),
          label: str(v.label, "label", true),
        };
      if (action === "navigateTree" || action === "fork")
        return { action, entryId: str(v.entryId, "entryId") };
      return { action };
    }
    default:
      return v;
  }
}
