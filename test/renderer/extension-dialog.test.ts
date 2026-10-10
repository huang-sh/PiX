import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { expect, it, vi } from "vitest";
import ExtensionDialogHost from "../../src/renderer/components/ExtensionDialogHost.vue";
import { i18n } from "../../src/renderer/i18n";
import type { DesktopEvent, ExtensionDialog } from "../../src/shared/types";

it("replays pending dialogs without reviving dismissed requests and routes replies to their host", async () => {
  let emit!: (event: DesktopEvent) => void;
  let replay!: (requests: ExtensionDialog[]) => void;
  const events = vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
  const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation((route) =>
    route === "ui.pending" ? new Promise(resolve => { replay = resolve as typeof replay; }) : Promise.resolve(true) as any);
  const wrapper = mount(ExtensionDialogHost, { attachTo: document.body, global: { plugins: [createPinia(), i18n] } });
  const request: ExtensionDialog = { id: "remote", projectId: "ssh", kind: "select", title: "Choose server", source: "remote project", options: ["one", "two"] };
  const input: ExtensionDialog = { id: "local", kind: "input", title: "Verification code", source: "local project" };
  const form = () => document.querySelector<HTMLFormElement>("[data-extension-dialog] form")!;
  try {
    emit({ type: "ui.request", payload: request });
    emit({ type: "ui.dismiss", payload: { id: request.id } });
    replay([request, input]);
    await flushPromises();
    expect(document.querySelector("[data-extension-dialog]")!.textContent).toContain(input.title);
    const field = document.querySelector<HTMLInputElement>("[data-extension-dialog] input")!;
    field.value = "1234"; field.dispatchEvent(new Event("input", { bubbles: true }));
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("ui.respond", { id: "local", value: "1234", projectId: undefined });
    emit({ type: "ui.request", payload: request });
    await flushPromises();
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("ui.respond", { id: "remote", value: "one", projectId: "ssh" });
    emit({ type: "ui.request", payload: { ...input, id: "cancel" } });
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-extension-dialog] button[type="button"]')!.click();
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("ui.respond", { id: "cancel", value: undefined, projectId: undefined });
    emit({ type: "ui.request", payload: { ...request, id: "disconnected" } });
    emit({ type: "remote.connection", payload: { projectId: "ssh", connected: false } });
    await flushPromises();
    expect(document.querySelector("[data-extension-dialog]")).toBeNull();
  } finally { wrapper.unmount(); events.mockRestore(); invoke.mockRestore(); }
});
