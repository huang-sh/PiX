import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryKind } from "../../src/renderer/stores/history";
import { i18n } from "../../src/renderer/i18n";
import { history, resetForTest, track, togglePanel, undoDepth } from "../../src/renderer/stores/history";
import HistoryButton from "../../src/renderer/components/HistoryButton.vue";

describe("HistoryButton", () => {
  let wrapper: ReturnType<typeof mount<typeof HistoryButton>>;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    wrapper?.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
    resetForTest();
  });

  function mountBtn() {
    wrapper = mount(HistoryButton, {
      attachTo: document.body,
      global: { plugins: [i18n] },
    });
  }

  it("hides the badge when undoDepth is 0", async () => {
    resetForTest();
    mountBtn();
    expect(wrapper.find(".history-floating-badge").exists()).toBe(false);
  });

  it("shows the badge with the current depth after tracking entries", async () => {
    resetForTest();
    track({ kind: "pin" as HistoryKind, label: "A", undo: async () => true, redo: async () => true });
    track({ kind: "pin" as HistoryKind, label: "B", undo: async () => true, redo: async () => true });
    mountBtn();
    expect(wrapper.get(".history-floating-badge").text()).toBe("2");
  });

  it("caps the badge at 99+ for depths above 99", async () => {
    resetForTest();
    for (let i = 0; i < 105; i += 1) {
      track({ kind: "pin" as HistoryKind, label: `Entry ${i}`, undo: async () => true, redo: async () => true });
    }
    mountBtn();
    expect(wrapper.get(".history-floating-badge").text()).toBe("99+");
  });

  it("clicking toggles history.panelOpen", async () => {
    resetForTest();
    mountBtn();
    expect(history.panelOpen).toBe(false);
    await wrapper.trigger("click");
    expect(history.panelOpen).toBe(true);
    await wrapper.trigger("click");
    expect(history.panelOpen).toBe(false);
  });

  it("adds the open-state class when panelOpen is true", async () => {
    resetForTest();
    // Open the panel first so panelOpen is true at mount time
    togglePanel();
    expect(history.panelOpen).toBe(true);
    mountBtn();
    expect(wrapper.find(".history-floating-btn-open").exists()).toBe(true);
  });

  it("aria-label and title contain the shortcut hint", async () => {
    resetForTest();
    mountBtn();
    const btn = wrapper.get("button");
    expect(btn.attributes("aria-label")).toBe(i18n.global.t("history.button.title"));
    expect(btn.attributes("title")).toBe(i18n.global.t("history.button.title"));
  });
});
