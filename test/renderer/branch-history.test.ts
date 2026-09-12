import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import type { Pinia } from "pinia";
import BranchHistory, { type HistoryTurn } from "../../src/renderer/features/branch-context/BranchHistory.vue";
import { i18n } from "../../src/renderer/i18n";

function turn(overrides: Partial<HistoryTurn> = {}): HistoryTurn {
  return {
    id: "turn:1",
    process: [],
    ...overrides,
  };
}

function mountHistory(turns: HistoryTurn[]) {
  const pinia: Pinia = createPinia();
  setActivePinia(pinia);
  return mount(BranchHistory, {
    props: {
      viewKey: "main",
      turns,
      processMessages: new Map(),
      expandedProcesses: new Set<string>(),
      duration: () => "1s",
      errorText: (message: { errorMessage?: string }) => message.errorMessage ?? "",
    },
    global: { plugins: [pinia, i18n] },
  });
}

describe("BranchHistory user message", () => {
  it("renders the user prompt as markdown", () => {
    const wrapper = mountHistory([turn({ user: { entryId: "e1", turnId: "turn:1", role: "user", text: "fix **this** bug", timestamp: "" } })]);
    expect(wrapper.get(".branch-message.user strong").text()).toBe("this");
    expect(wrapper.get(".branch-message.user").text()).toContain("fix this bug");
  });

  it("keeps the empty-state placeholder when a user turn has no text", () => {
    const wrapper = mountHistory([turn({ user: { entryId: "e1", turnId: "turn:1", role: "user", text: "", timestamp: "" } })]);
    expect(wrapper.get(".branch-message.user").text()).toBe(i18n.global.t("common.empty"));
  });
});
