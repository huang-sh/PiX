import type { BuildSystemPromptOptions, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { PROMPT_OVERRIDE_CUSTOM_TYPE, type PromptCustomization, type PromptOverrideRecord, type RawSessionEntry, type SystemPromptPreview } from "../../shared/types.js";

/** Resolve the same nearest valid ancestor for previews and live runs. */
export function latestPromptOverride(branch: RawSessionEntry[]): PromptOverrideRecord | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "custom" || entry.customType !== PROMPT_OVERRIDE_CUSTOM_TYPE) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (data?.off === true) return { mode: "append", off: true };
    if ((data?.mode === "append" || data?.mode === "replace" || data?.mode === "strict")
      && typeof data.name === "string" && typeof data.text === "string" && data.text.trim())
      return { mode: data.mode, name: data.name, text: data.text };
  }
  return null;
}

// Pi does not re-export its section builder. Keep the version-specific import
// in this runtime adapter, alongside the extension that uses it.
let builder: Promise<{ buildSystemPromptSections(options: BuildSystemPromptOptions): Record<string, string> }> | undefined;

/** Compose structured sections once, then render the same result for the model
 * and settings. User text is opaque, including any XML-like examples. */
export async function composeSystemPrompt(
  options: BuildSystemPromptOptions,
  customization: PromptCustomization | undefined,
  run: PromptOverrideRecord | null,
): Promise<SystemPromptPreview> {
  const persona = run && !run.off ? run.text?.trim() : "";
  if (persona && run?.mode === "strict") {
    const text = `${persona}\n\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
    return { text, preamble: text, sections: [] };
  }
  const sdk = await (builder ??= import(new URL("core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href));
  const sections: Record<string, string> = options.forceSystemPrompt !== undefined
    ? { preamble: options.forceSystemPrompt }
    : sdk.buildSystemPromptSections(options);
  if (customization?.preamble?.trim()) sections.preamble = customization.preamble.trim();
  for (const name of ["rules", "docs"] as const)
    if (customization?.[name]?.trim()) sections[name] = `<${name}>\n${customization[name]!.trim()}\n</${name}>`;
  if (persona) sections.preamble = run?.mode === "replace" ? persona : `${persona}\n\n${sections.preamble ?? ""}`;
  return {
    text: getSystemMessageText({ role: "system", content: "", sections, timestamp: 0 }),
    preamble: sections.preamble ?? "",
    sections: Object.entries(sections).filter(([name]) => name !== "preamble").map(([name, text]) => ({
      name, content: text.slice(`<${name}>\n`.length, -`\n</${name}>`.length),
    })),
  };
}

export function pixPromptOverrideExtension(getCustomization: () => PromptCustomization | undefined): InlineExtension {
  return {
    name: "prompt-override",
    factory: pi => {
      pi.on("before_agent_start", async (event, ctx) => {
        const customization = getCustomization();
        const run = latestPromptOverride(ctx.sessionManager.getBranch() as RawSessionEntry[]);
        if (!customization?.preamble?.trim() && !customization?.rules?.trim() && !customization?.docs?.trim()
          && (!run || run.off)) return;
        const result = await composeSystemPrompt(event.systemPromptOptions, customization, run);
        return { systemPrompt: result.text };
      });
    },
  };
}
