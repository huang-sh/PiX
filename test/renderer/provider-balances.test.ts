import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { toRaw } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProviderBalances from "../../src/renderer/features/settings/ProviderBalances.vue";
import UsagePanel from "../../src/renderer/features/settings/UsagePanel.vue";
import UsageSettingsPanel from "../../src/renderer/features/settings/UsageSettingsPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { applyDiff } from "../../src/renderer/lib/settings-diff";
import type { SettingsBundle } from "../../src/shared/types";
import type { ProviderBalance } from "../../src/shared/provider-balances";
import type { UsageOverview } from "../../src/shared/usage";

enableAutoUnmount(afterEach);
const card = (provider: string, remaining = 12): ProviderBalance => ({ provider, name: provider,
  amounts: [{ currency: "USD", remaining }], updatedAt: "2026-10-30T09:00:00Z" });
const query = { url: "https://relay.example/balance", path: "data.balance", currency: "USD", multiplier: 1 };
const render = () => mount(ProviderBalances, { global: { plugins: [i18n] } });
beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  useLayoutStore().settings = { app: { usage: { unbilledProviders: ["coding"] } } } as SettingsBundle;
  vi.mocked(desktop.invoke).mockReset().mockResolvedValue([card("one"), card("two")]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("shows balance currencies, stale timestamps and unsupported providers separately from estimated spend", async () => {
  vi.mocked(desktop.invoke).mockResolvedValue([{ ...card("one", -1), stale: true, error: "rateLimited" },
    { provider: "coding", name: "Coding plan", amounts: [], error: "unsupported" }]);
  const wrapper = render(); await flushPromises();
  expect(wrapper.get('[data-balance-provider="one"]').text()).toContain("last successful reading");
  expect(wrapper.get('[data-balance-provider="one"] time').attributes("datetime")).toBe("2026-10-30T09:00:00Z");
  expect(wrapper.get('.balance-amount').classes()).toContain("depleted");
  expect(wrapper.get('[data-balance-provider="coding"]').text()).toContain("Automatic balance queries are unavailable");
  expect(wrapper.get('[data-balance-provider="coding"]').find(".balance-amount").exists()).toBe(false);
});

it("refreshes one provider without replacing another provider's card", async () => {
  const wrapper = render(); await flushPromises();
  vi.mocked(desktop.invoke).mockResolvedValue([card("one", 8)]);
  await wrapper.get('[data-balance-refresh="one"]').trigger("click"); await flushPromises();
  expect(desktop.invoke).toHaveBeenLastCalledWith("usage.balances", { provider: "one", refresh: true });
  expect(wrapper.get('[data-balance-provider="one"] .balance-amount').text()).toContain("8.00");
  expect(wrapper.get('[data-balance-provider="two"] .balance-amount').text()).toContain("12.00");
});

it("removes a logged-out provider when its card refresh returns no configured account", async () => {
  const wrapper = render(); await flushPromises();
  vi.mocked(desktop.invoke).mockResolvedValue([]);
  await wrapper.get('[data-balance-refresh="one"]').trigger("click"); await flushPromises();
  expect(wrapper.find('[data-balance-provider="one"]').exists()).toBe(false);
  expect(wrapper.get('[data-balance-provider="two"] .balance-amount').text()).toContain("12.00");
});

it("keeps displayed readings when the list refresh fails", async () => {
  const wrapper = render(); await flushPromises();
  vi.mocked(desktop.invoke).mockRejectedValue(new Error("transport unavailable"));
  await wrapper.get('[data-balance-refresh-all]').trigger("click"); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("Could not load");
  expect(wrapper.findAll("[data-balance-provider]")).toHaveLength(2);
  vi.mocked(desktop.invoke).mockResolvedValue([card("one", 8)]);
  await wrapper.get('[data-balance-refresh="one"]').trigger("click"); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('[data-balance-provider="one"] .balance-amount').text()).toContain("8.00");
});

it("saves plain query settings, resets only the selected query and keeps billing preferences", async () => {
  const layout = useLayoutStore();
  layout.settings!.app.usage!.balanceQueries = { one: query, two: { ...query, url: "https://other.example/balance" } };
  const save = vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => {
    structuredClone(patch);
    const next = structuredClone(toRaw(layout.settings!));
    applyDiff(next.app as unknown as Record<string, unknown>, patch);
    layout.settings = next;
  });
  const wrapper = render(); await flushPromises();
  await wrapper.get('[data-balance-configure="one"]').trigger("click");
  await wrapper.get('[data-balance-path]').setValue("data.total_available");
  await wrapper.get('[data-balance-multiplier]').setValue("0.000002");
  await wrapper.get('[data-balance-form]').trigger("submit"); await flushPromises();
  expect(save).toHaveBeenLastCalledWith({ usage: { balanceQueries: {
    one: { ...query, path: "data.total_available", multiplier: 0.000002 },
  } } });
  expect(layout.settings!.app.usage!.unbilledProviders).toEqual(["coding"]);
  expect(layout.settings!.app.usage!.balanceQueries!.two).toEqual({ ...query, url: "https://other.example/balance" });
  await wrapper.get('[data-balance-configure="one"]').trigger("click");
  await wrapper.get('[data-balance-reset]').trigger("click"); await flushPromises();
  expect(save).toHaveBeenLastCalledWith({ usage: { balanceQueries: { one: null } } });
  expect(layout.settings!.app.usage!.balanceQueries).toEqual({ two: { ...query, url: "https://other.example/balance" } });
});

it("rejects invalid query fields without saving and retains the form on a save failure", async () => {
  const save = vi.spyOn(useLayoutStore(), "updateAppSettings").mockRejectedValue(new Error("save failed"));
  const wrapper = render(); await flushPromises();
  await wrapper.get('[data-balance-configure="one"]').trigger("click");
  await wrapper.get('[data-balance-url]').setValue(query.url);
  await wrapper.get('[data-balance-path]').setValue("data.__proto__.balance");
  await wrapper.get('[data-balance-form]').trigger("submit"); await flushPromises();
  expect(save).not.toHaveBeenCalled();
  expect(wrapper.get('[role="alert"]').text()).toContain("Check the HTTP(S)");
  await wrapper.get('[data-balance-path]').setValue(query.path);
  await wrapper.get('[data-balance-form]').trigger("submit"); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("Could not save");
  expect(wrapper.find('[data-balance-form]').exists()).toBe(true);
});

it("refreshes while visible, pauses while hidden and clears its timer on unmount", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const wrapper = render(); await flushPromises();
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000); await flushPromises();
  expect(desktop.invoke).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(desktop.invoke).toHaveBeenCalledTimes(2);
  wrapper.unmount(); visibility.mockReturnValue("visible");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(desktop.invoke).toHaveBeenCalledTimes(2);
});

it("ignores an old list response after query settings change", async () => {
  let old!: (value: ProviderBalance[]) => void;
  vi.mocked(desktop.invoke).mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  const wrapper = render();
  useLayoutStore().settings!.app.usage!.balanceQueries = { one: query };
  await flushPromises();
  old([card("outdated")]); await flushPromises();
  expect(wrapper.find('[data-balance-provider="outdated"]').exists()).toBe(false);
  expect(wrapper.find('[data-balance-provider="one"]').exists()).toBe(true);
});

it("separates statistics and balances, retains edits and filters, and pauses polling on the other tab", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "usage.overview" ? overview(2) : [card("one")]);
  const wrapper = mount(UsageSettingsPanel, { attachTo: document.body, global: { plugins: [i18n] } });
  await flushPromises();
  const balanceReads = () => vi.mocked(desktop.invoke).mock.calls.filter(([route]) => route === "usage.balances").length;
  const switchTab = async (name: string) => {
    await wrapper.get(`[data-usage-tab="${name}"]`).trigger("mousedown", { button: 0, ctrlKey: false });
    await flushPromises();
    for (const panel of wrapper.findAll('[data-usage-panel]'))
      expect(panel.isVisible()).toBe(panel.attributes("data-usage-panel") === name);
  };
  expect(wrapper.get('[data-usage-tab="statistics"]').attributes("aria-selected")).toBe("true");
  expect(balanceReads()).toBe(0);
  await wrapper.get('[data-usage-range="today"]').trigger("click"); await flushPromises();
  await switchTab("balances");
  expect(balanceReads()).toBe(1);
  await wrapper.get('[data-balance-configure="one"]').trigger("click");
  await wrapper.get('[data-balance-url]').setValue("https://relay.example/unsaved");
  await switchTab("statistics");
  expect(wrapper.get('[data-usage-range="today"]').classes()).toContain("active");
  await vi.advanceTimersByTimeAsync(60_000); await flushPromises();
  expect(balanceReads()).toBe(1);
  await switchTab("balances");
  expect(balanceReads()).toBe(2);
  expect(wrapper.get<HTMLInputElement>('[data-balance-url]').element.value).toBe("https://relay.example/unsaved");
});

const overview = (cost: number, agents: UsageOverview["agents"] = []): UsageOverview => ({ generatedAt: "", range: "today", sessionCount: 1,
  totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost }, today: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
  estimatedCost: 0, days: [], models: [], projects: [], agents, sessions: [] });

it("keeps the newest usage period when earlier reads finish late", async () => {
  const pending: Array<(value: UsageOverview) => void> = [];
  vi.mocked(desktop.invoke).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  const wrapper = mount(UsagePanel, { global: { plugins: [i18n] } });
  await wrapper.get('[data-usage-range="today"]').trigger("click");
  pending[1]!(overview(2)); await flushPromises();
  pending[0]!(overview(99)); await flushPromises();
  expect(wrapper.get('.usage-card-cost strong').text()).toBe("$2.00");
});

it("splits Pixie's own usage from canvas agent usage once Pixie has sessions", async () => {
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "usage.overview" ? overview(1.25, [
    { agent: "pixie", sessions: 2, usage: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.25 }, estimatedCost: 0 },
    { agent: "canvas", sessions: 1, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1 }, estimatedCost: 0 },
  ]) : []);
  const wrapper = mount(UsagePanel, { global: { plugins: [i18n] } });
  await flushPromises();
  const rows = wrapper.findAll("[data-usage-agent]");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.attributes("data-usage-agent")).toBe("pixie");
  expect(rows[0]!.text()).toContain("Pixie (coordinator)");
  expect(rows[0]!.text()).toContain("$0.2500");
  expect(rows[1]!.text()).toContain("Canvas agents");
  expect(rows[1]!.text()).toContain("$1.00");
  // Totals stay the sum of both agents.
  expect(wrapper.get('.usage-card-cost strong').text()).toBe("$1.25");
});

it("keeps the previous single-agent appearance when Pixie has no usage", async () => {
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "usage.overview" ? overview(1, [
    { agent: "pixie", sessions: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, estimatedCost: 0 },
    { agent: "canvas", sessions: 1, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1 }, estimatedCost: 0 },
  ]) : []);
  const wrapper = mount(UsagePanel, { global: { plugins: [i18n] } });
  await flushPromises();
  expect(wrapper.find("[data-usage-agent]").exists()).toBe(false);
});
