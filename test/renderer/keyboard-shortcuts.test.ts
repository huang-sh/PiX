import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureShortcut, shortcutForEvent } from "../../src/renderer/keyboard-shortcuts";
import { formatShortcut, shortcutBindings, shortcutConflict, validateShortcutOverrides, type ShortcutOverrides } from "../../src/shared/shortcuts";
import type { SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";

const key = (value: string, modifiers: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ctrlKey: true, ...modifiers });

describe("shortcut matching", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("uses exact modifiers, handles alternate layouts and preserves disabled bindings", () => {
    expect(shortcutForEvent(key("b"), {}, false)).toBe("navigator");
    expect(shortcutForEvent(key("b", { altKey: true }), {}, false)).toBe("tools");
    expect(shortcutForEvent(key("b", { shiftKey: true }), {}, false)).toBeUndefined();
    expect(shortcutForEvent(key("b", { metaKey: true }), {}, false)).toBeUndefined();
    expect(shortcutForEvent(key("b"), { navigator: [] }, false)).toBeUndefined();
    expect(shortcutForEvent(key("b", { ctrlKey: false, metaKey: true }), {}, true)).toBe("navigator");
    expect(shortcutForEvent(key("b"), {}, true)).toBeUndefined();
    expect(captureShortcut(key("m", { code: "Semicolon" }), false)).toBe("Mod+m");
    expect(captureShortcut(key("ж", { code: "Semicolon" }), false)).toBe("Mod+ж");
    expect(captureShortcut(key("+", { shiftKey: true }), false)).toBe("Mod+Shift+Plus");
    expect(formatShortcut("Mod+Shift+Plus", true)).toBe("Cmd+Shift++");
    for (const event of [key("c"), key("Backspace"), key("F4", { ctrlKey: false, altKey: true }), key("Enter"), key("m", { ctrlKey: false }), key("m", { isComposing: true }), key("m", { repeat: true })])
      expect(captureShortcut(event, false)).toBeUndefined();
  });

  it("lets inputs use app shortcuts but leaves terminal, webview and dialogs alone", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const event = key("b");
    input.dispatchEvent(event);
    expect(shortcutForEvent(event, {}, false)).toBe("navigator");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    terminal.append(input);
    document.body.append(terminal);
    expect(shortcutForEvent(event, {}, false)).toBeUndefined();
    terminal.remove();
    const webview = document.createElement("webview");
    document.body.append(webview);
    const webEvent = key("b");
    webview.dispatchEvent(webEvent);
    expect(shortcutForEvent(webEvent, {}, false)).toBeUndefined();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);
    expect(shortcutForEvent(key("b"), {}, false)).toBeUndefined();
    dialog.remove();
    const consumed = key("b");
    consumed.preventDefault();
    expect(shortcutForEvent(consumed, {}, false)).toBeUndefined();
  });

  it("validates overrides and detects conflicts with defaults and duplicate aliases", () => {
    expect(shortcutBindings("commands")).toHaveLength(2);
    expect(shortcutConflict({ commands: ["Mod+b"] })).toMatchObject({ first: "commands", second: "navigator" });
    expect(shortcutConflict({ commands: ["Mod+m", "Mod+m"] })).toBeDefined();
    expect(shortcutConflict({ commands: ["Mod+b"], navigator: [] })).toBeUndefined();
    for (const invalid of [null, [], { unknown: [] }, { commands: ["Mod+c"] }, { commands: ["Shift+Mod+m"] }, { commands: ["Mod+b"] }])
      expect(() => validateShortcutOverrides(invalid)).toThrow();
    expect(() => validateShortcutOverrides({ commands: [], navigator: ["Mod+Shift+m"] })).not.toThrow();
  });
});

describe("keyboard shortcuts settings", () => {
  let persisted: SettingsBundle;
  let wrapper: ReturnType<typeof mount>;
  const dom = (selector: string) => new DOMWrapper(document.querySelector(selector)!);

  function open(overrides: ShortcutOverrides = {}) {
    persisted.app.keyboardShortcuts = overrides;
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(structuredClone(persisted));
    layout.screen = "settings";
    layout.settingsCategory = "shortcuts";
    wrapper = mount(SettingsPage, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    return layout;
  }

  beforeEach(() => {
    i18n.global.locale.value = "en";
    persisted = {
      app: { language: "en", theme: "dark", density: "comfortable", confirmDestructiveActions: true, browserHome: "https://pi.dev", openLastSessionOnStartup: false, enterToSend: true, openLinksInApp: true, closeToTray: true, canvasDotGrid: true, canvasDotGridSpacing: 24, canvasDotGridDotSize: 2 },
      piGlobal: {}, piProject: {}, effective: {}, paths: { app: "", global: "", project: null },
    };
    vi.mocked(desktop.invoke).mockReset();
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route === "settings.update") {
        const { patch } = structuredClone(payload) as { patch: SettingsBundle["app"] };
        Object.assign(persisted.app, patch);
      }
      return structuredClone(persisted);
    });
  });
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ""; });

  it("searches and records aliases without activating a live shortcut", async () => {
    const layout = open();
    await wrapper.get('[data-keyboard-shortcuts] input').setValue("Ctrl+Shift+P");
    expect(wrapper.findAll("[data-shortcut]")).toHaveLength(1);
    await wrapper.get('[data-keyboard-shortcuts] input').setValue("");
    await wrapper.get('[data-shortcut="commands"] [data-shortcut-edit]').trigger("click");
    await flushPromises();
    await dom(".shortcut-recorder").trigger("keydown", { key: "b", ctrlKey: true });
    expect(dom("[data-shortcut-confirm]").attributes("disabled")).toBeDefined();
    expect(dom("[data-shortcut-recording]").text()).toContain("Toggle navigator");
    const event = key("m", { shiftKey: true });
    document.querySelector(".shortcut-recorder")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(shortcutForEvent(key("b"), {}, false)).toBeUndefined();
    await flushPromises();
    await dom("[data-shortcut-confirm]").trigger("click");
    expect(wrapper.get('[data-shortcut="commands"]').text()).toContain("Ctrl+Shift+M");
    expect(shortcutBindings("commands", layout.settings?.app.keyboardShortcuts)[0]).toBe("Mod+k");
    await wrapper.get("[data-shortcut-save]").trigger("click");
    await flushPromises();
    expect(layout.settings?.app.keyboardShortcuts?.commands).toEqual(["Mod+Shift+m", "Mod+Shift+p"]);
    expect(vi.mocked(desktop.invoke).mock.calls.find(([route]) => route === "settings.update")?.[1]).toEqual({ scope: "app", patch: { keyboardShortcuts: { commands: ["Mod+Shift+m", "Mod+Shift+p"] } } });
    expect(persisted.app.theme).toBe("dark");
  });

  it("persists disabling and restores defaults without reviving removed overrides", async () => {
    const layout = open({ commands: ["Mod+Shift+m", "Mod+Shift+p"] });
    await wrapper.get('[data-shortcut="navigator"] [data-shortcut-remove]').trigger("click");
    await wrapper.get("[data-shortcut-save]").trigger("click");
    await flushPromises();
    expect(persisted.app.keyboardShortcuts?.navigator).toEqual([]);
    expect(persisted.app.keyboardShortcuts?.commands).toEqual(["Mod+Shift+m", "Mod+Shift+p"]);
    wrapper.unmount();
    open(persisted.app.keyboardShortcuts);
    expect(wrapper.get('[data-shortcut="navigator"]').text()).toContain("No shortcut assigned");
    await wrapper.get("[data-shortcut-reset-all]").trigger("click");
    await wrapper.get("[data-shortcut-save]").trigger("click");
    await flushPromises();
    expect(persisted.app.keyboardShortcuts).toEqual({});
    expect(layout.settings?.app.keyboardShortcuts?.navigator).toEqual([]);
  });

  it("blocks a single reset that would collide with a reassigned default", async () => {
    open({ commands: ["Mod+b"], navigator: [] });
    await wrapper.get('[data-shortcut="navigator"] [data-shortcut-reset]').trigger("click");
    expect(wrapper.get('[data-keyboard-shortcuts] [role="alert"]').text()).toContain("Ctrl+B");
    expect(wrapper.get('[data-shortcut="navigator"]').text()).toContain("No shortcut assigned");
    await wrapper.get("[data-shortcut-reset-all]").trigger("click");
    expect(wrapper.find('[data-keyboard-shortcuts] [role="alert"]').exists()).toBe(false);
  });

  it("retains drafts across categories and keeps bindings unchanged when saving fails", async () => {
    const layout = open();
    await wrapper.get('[data-shortcut="navigator"] [data-shortcut-remove]').trigger("click");
    await wrapper.get('[data-settings-category="general"]').trigger("click");
    await wrapper.get('[data-settings-category="shortcuts"]').trigger("click");
    expect(wrapper.get('[data-shortcut="navigator"]').text()).toContain("No shortcut assigned");
    vi.mocked(desktop.invoke).mockRejectedValue(new Error("Disk full"));
    await wrapper.get("[data-shortcut-save]").trigger("click");
    await flushPromises();
    expect(shortcutBindings("navigator", layout.settings?.app.keyboardShortcuts)).toEqual(["Mod+b"]);
    expect(wrapper.text()).toContain("Disk full");
    await wrapper.get("aside > button").trigger("click");
    await flushPromises();
    expect(layout.screen).toBe("settings");
    await dom("[data-shortcut-save-leave]").trigger("click");
    await flushPromises();
    expect(layout.screen).toBe("settings");
    expect(dom('[role="dialog"]').text()).toContain("Disk full");
    await dom("[data-shortcut-discard]").trigger("click");
    expect(layout.screen).toBe("workbench");
  });
});
