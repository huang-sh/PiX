import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { runCommandKey } from "../../src/renderer/features/commands/runCommand";
import { i18n } from "../../src/renderer/i18n";
import { filterSlashCommands, matchSlashTrigger } from "../../src/renderer/lib/slash";
import { useSessionStore } from "../../src/renderer/stores/session";
import type { RuntimeCommand } from "../../src/shared/types";

function mountComposer(run?: (name: string) => Promise<void>) {
  return mount(PromptComposer, {
    attachTo: document.body,
    props: {
      runnable: true,
      model: null,
      thinkingLevel: "off",
      models: [],
      onModel: vi.fn(),
      onThinking: vi.fn(),
      onSubmit: vi.fn(async () => true),
    },
    global: {
      plugins: [i18n],
      provide: run ? { [runCommandKey as symbol]: run } : {},
    },
  });
}

async function type(wrapper: ReturnType<typeof mountComposer>, text: string) {
  await wrapper.find("textarea").setValue(text);
  await nextTick();
}

function menu() {
  return document.querySelector(".slash-menu");
}

function menuItems() {
  return [...document.querySelectorAll<HTMLButtonElement>(".slash-item")];
}

describe("matchSlashTrigger", () => {
  it("opens for a bare slash and pending query", () => {
    expect(matchSlashTrigger("/")).toBe("");
    expect(matchSlashTrigger("/rev")).toBe("rev");
  });

  it("closes for whitespace, mid-text slashes, and plain drafts", () => {
    expect(matchSlashTrigger("/review file")).toBeNull();
    expect(matchSlashTrigger("/multi\nline")).toBeNull();
    expect(matchSlashTrigger("see /etc/hosts")).toBeNull();
    expect(matchSlashTrigger("describe the next step")).toBeNull();
    expect(matchSlashTrigger("")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns every command for an empty query so all sources remain scrollable", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `cmd${i}`, source: "builtin" as const }));
    expect(filterSlashCommands(many, "")).toEqual(many);
  });

  it("fuzzy-matches names and descriptions", () => {
    const commands: RuntimeCommand[] = [
      { name: "model", description: "Select model", source: "builtin" },
      { name: "compact", description: "Compact context", source: "builtin" },
    ];
    expect(filterSlashCommands(commands, "mod").map((c) => c.name)).toContain("model");
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });
});

describe("PromptComposer slash menu", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("opens above the textarea when the draft is a pending command", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/mod");
    expect(menu()).not.toBeNull();
    const names = menuItems().map((item) => item.textContent ?? "");
    expect(names.join("\n")).toContain("/model");
    expect(names.join("\n")).not.toContain("/compact");
    wrapper.unmount();
  });

  it("a bare slash keeps builtins first even with more than twelve extension commands", async () => {
    useSessionStore().commands = Array.from({ length: 20 }, (_, i) => ({ name: `ext${i}`, source: "extension" }));
    const wrapper = mountComposer(vi.fn().mockResolvedValue(undefined));
    await type(wrapper, "/");
    const names = [...document.querySelectorAll(".slash-name")].map(item => item.textContent);
    expect(names.slice(0, 3)).toEqual(["/settings", "/model", "/tree"]);
    expect(names).toContain("/compact");
    expect(names).toContain("/session");
    expect(names).toContain("/ext19");
    wrapper.unmount();
  });

  it("ArrowDown then Enter executes the highlighted builtin and clears the draft", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/");
    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "ArrowDown" });
    await textarea.trigger("keydown", { key: "Enter" });
    expect(run).toHaveBeenCalledWith("model");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");
    expect(menu()).toBeNull();
    wrapper.unmount();
  });

  it("Ctrl+n moves the highlight like ArrowDown", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/");
    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "n", ctrlKey: true });
    await textarea.trigger("keydown", { key: "Enter" });
    expect(run).toHaveBeenCalledWith("model");
    wrapper.unmount();
  });

  it("selecting an agent command inserts the token for arguments", async () => {
    useSessionStore().commands = [
      { name: "review", description: "Review code", source: "prompt", argumentHint: "<file>" },
    ];
    const wrapper = mountComposer();
    await type(wrapper, "/review");
    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "Enter" });
    const element = textarea.element as HTMLTextAreaElement;
    expect(element.value).toBe("/review ");
    expect(element.selectionStart).toBe("/review ".length);
    expect(menu()).toBeNull();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.props("onSubmit")).toHaveBeenCalledWith("/review");
    wrapper.unmount();
  });

  it("sending an exact builtin uses the same dispatcher after the menu closes", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/session ");
    await wrapper.find(".composer-submit").trigger("click");
    expect(run).toHaveBeenCalledWith("session");
    expect(wrapper.props("onSubmit")).not.toHaveBeenCalled();
    expect(wrapper.find("textarea").element.value).toBe("");
    wrapper.unmount();
  });

  it("Enter with no matches submits the literal text", async () => {
    const onSubmit = vi.fn(async () => true);
    const wrapper = mount(PromptComposer, {
      attachTo: document.body,
      props: {
        runnable: true,
        model: null,
        thinkingLevel: "off",
        models: [],
        onModel: vi.fn(),
        onThinking: vi.fn(),
        onSubmit,
      },
      global: { plugins: [i18n], provide: { [runCommandKey as symbol]: vi.fn().mockResolvedValue(undefined) } },
    });
    await type(wrapper, "/zzz");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/zzz");
    wrapper.unmount();
  });

  it("Escape and outside pointer presses close the menu", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/");
    await wrapper.find("textarea").trigger("keydown", { key: "Escape" });
    expect(menu()).toBeNull();

    await type(wrapper, "/m");
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(menu()).toBeNull();
    wrapper.unmount();
  });

  it("typing a space or newline closes the menu", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/mo");
    expect(menu()).not.toBeNull();
    await type(wrapper, "/mo d");
    expect(menu()).toBeNull();
    wrapper.unmount();
  });

  it("IME composition Enter neither selects nor submits", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountComposer(run);
    await type(wrapper, "/");
    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();

    // Safari fires the closing Enter right after compositionend; the short
    // settle window must swallow it too.
    await textarea.trigger("compositionend");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    wrapper.unmount();
  });

  it("hides builtin commands when no dispatcher is provided", async () => {
    useSessionStore().commands = [];
    const wrapper = mountComposer();
    await type(wrapper, "/");
    expect(menuItems()).toHaveLength(0);
    expect(menu()?.textContent).toContain(i18n.global.t("draft.slashEmpty") as string);
    wrapper.unmount();
  });
});
