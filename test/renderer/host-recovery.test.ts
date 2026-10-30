import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import HostRecovery from "../../src/renderer/features/workbench/HostRecovery.vue";
import { i18n } from "../../src/renderer/i18n";
import type { HostConnectionState } from "../../src/shared/host-protocol";

const state: HostConnectionState = { connected: false, version: "0.0.32",
  host: { id: "old-host", version: "0.0.31", verified: true, clients: 1, running: 2, remoteConnections: 1 } };
afterEach(() => vi.useRealTimers());

it("keeps confirmed force recovery available while a verified host is cleaning up", async () => {
  i18n.global.locale.value = "en";
  const wrapper = mount(HostRecovery, { props: { state: { ...state, host: { ...state.host!, stopping: true } }, busy: false }, global: { plugins: [i18n] } });
  try {
    expect(wrapper.text()).toContain("still shutting down");
    expect(wrapper.get('[data-action="host-force"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-action="host-force"]').trigger("click");
    expect(wrapper.emitted("restart")).toBeUndefined();
    await wrapper.get('[data-action="host-force-confirm"]').trigger("click");
    expect(wrapper.emitted("restart")).toEqual([["old-host"]]);
  } finally { wrapper.unmount(); }
});

it("shows task status, pauses automatic retries during confirmation and defaults to cancel", async () => {
  vi.useFakeTimers();
  i18n.global.locale.value = "en";
  const wrapper = mount(HostRecovery, { props: { state, busy: false }, global: { plugins: [i18n] }, attachTo: document.body });
  try {
    expect(wrapper.text()).toContain("work in progress");
    expect(wrapper.text()).toContain("0.0.31");
    await vi.advanceTimersByTimeAsync(5000);
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.get('[data-action="host-force"]').trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-action="host-force-cancel"]').element);
    expect(wrapper.get('[role="alertdialog"]').text()).toContain("unsaved work may be lost");
    await vi.advanceTimersByTimeAsync(10000);
    expect(wrapper.emitted("restart")).toBeUndefined();
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.get('[data-action="host-force-cancel"]').trigger("click");
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(wrapper.emitted("restart")).toBeUndefined();
    await wrapper.get('[data-action="host-force"]').trigger("click");
    await wrapper.get('[data-action="host-force-confirm"]').trigger("click");
    expect(wrapper.emitted("restart")).toEqual([["old-host"]]);
  } finally { wrapper.unmount(); }
});

it("requires a new confirmation when the host changes and prevents unverified termination", async () => {
  const wrapper = mount(HostRecovery, { props: { state, busy: false }, global: { plugins: [i18n] } });
  try {
    await wrapper.get('[data-action="host-force"]').trigger("click");
    await wrapper.setProps({ state: { ...state, host: { ...state.host!, id: "new-host" } } });
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    await wrapper.setProps({ state: { ...state, host: { ...state.host!, verified: false } } });
    expect(wrapper.get('[data-action="host-force"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-action="host-logs"]').trigger("click");
    expect(wrapper.emitted("logs")).toHaveLength(1);
  } finally { wrapper.unmount(); }
});
