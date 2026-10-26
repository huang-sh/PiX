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

it("keeps browser sign-in nonmodal, collapses manual input, and dismisses it when the callback completes", async () => {
  let emit!: (event: DesktopEvent) => void;
  const events = vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
  const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async route => route === "ui.pending" ? [] : true as any);
  const focused = document.createElement("button");
  document.body.append(focused);
  focused.focus();
  const wrapper = mount(ExtensionDialogHost, { attachTo: document.body, global: { plugins: [createPinia(), i18n] } });
  const request: ExtensionDialog = { id: "oauth", kind: "oauth", title: "Manual fallback", source: "openai", placeholder: "http://127.0.0.1:1455/auth/callback" };
  try {
    await flushPromises();
    emit({ type: "ui.request", payload: request });
    await flushPromises();
    expect(document.querySelector("[data-extension-dialog]")).toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.querySelector(".dialog-overlay")).toBeNull();
    expect(document.activeElement).toBe(focused);
    expect(document.querySelector<HTMLDetailsElement>("[data-oauth-notice] details")!.open).toBe(false);
    expect(invoke.mock.calls.filter(([route]) => route === "ui.respond")).toHaveLength(0);
    // A pending sign-in must not hold unrelated interactive requests in the queue.
    emit({ type: "ui.request", payload: { id: "confirm", kind: "confirm", title: "Confirm action", source: "extension" } });
    await flushPromises();
    expect(document.querySelector("[data-extension-dialog]")!.textContent).toContain("Confirm action");
    emit({ type: "ui.dismiss", payload: { id: "confirm" } });
    emit({ type: "ui.dismiss", payload: { id: request.id } });
    await flushPromises();
    expect(document.querySelector("[data-oauth-notice]")).toBeNull();
    expect(invoke.mock.calls.filter(([route]) => route === "ui.respond")).toHaveLength(0);
  } finally { wrapper.unmount(); focused.remove(); events.mockRestore(); invoke.mockRestore(); }
});

it("submits manual OAuth fallback to its host and can cancel a subsequent sign-in without reusing its answer", async () => {
  let emit!: (event: DesktopEvent) => void;
  const request: ExtensionDialog = { id: "oauth-manual", projectId: "ssh", kind: "oauth", title: "Manual fallback", source: "openai" };
  const events = vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
  const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async route => route === "ui.pending" ? [request] : true as any);
  const wrapper = mount(ExtensionDialogHost, { attachTo: document.body, global: { plugins: [createPinia(), i18n] } });
  try {
    await flushPromises();
    const details = document.querySelector<HTMLDetailsElement>("[data-oauth-notice] details")!;
    details.open = true;
    const form = details.querySelector("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(invoke).not.toHaveBeenCalledWith("ui.respond", expect.anything());
    const field = details.querySelector("input")!;
    field.value = "  http://127.0.0.1:1455/auth/callback?code=example&state=test  ";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(submit.disabled).toBe(false);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("ui.respond", { id: request.id, projectId: "ssh", value: field.value.trim() });
    expect(document.querySelector("[data-oauth-notice]")).toBeNull();
    emit({ type: "ui.request", payload: { ...request, id: "oauth-cancel" } });
    await flushPromises();
    expect(document.querySelector<HTMLDetailsElement>("[data-oauth-notice] details")!.open).toBe(false);
    expect(document.querySelector<HTMLInputElement>("[data-oauth-notice] input")!.value).toBe("");
    document.querySelector<HTMLButtonElement>('[data-oauth-notice] > footer button')!.click();
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("ui.respond", { id: "oauth-cancel", projectId: "ssh", value: undefined });
    expect(document.querySelector("[data-oauth-notice]")).toBeNull();
  } finally { wrapper.unmount(); events.mockRestore(); invoke.mockRestore(); }
});
