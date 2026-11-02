import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop } from "../../src/renderer/api";
import CustomModelForm from "../../src/renderer/features/settings/CustomModelForm.vue";
import { i18n } from "../../src/renderer/i18n";

let wrapper: ReturnType<typeof mount>;
beforeEach(async () => {
  vi.mocked(desktop.invoke).mockReset();
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(CustomModelForm, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
  await wrapper.get('[name="provider"]').setValue("custom");
  await wrapper.get('[name="baseUrl"]').setValue("https://models.example/v1");
  await wrapper.get('[name="apiKey"]').setValue("secret");
});
afterEach(() => {
  wrapper.unmount();
  for (const [, payload] of vi.mocked(desktop.invoke).mock.calls)
    expect(() => structuredClone(payload)).not.toThrow();
});

it("fetches, searches and selects multiple models, excludes existing ones and saves the batch", async () => {
  vi.mocked(desktop.invoke).mockImplementation(async (_route, payload) => {
    if ((payload as { action: string }).action === "discoverModels") return [
      { id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "old", exists: true },
    ];
    return { ok: true };
  });
  await wrapper.get('[data-discover-models]').trigger("click");
  await flushPromises();
  expect(desktop.invoke).toHaveBeenCalledWith("agent.control", {
    action: "discoverModels", provider: "custom", baseUrl: "https://models.example/v1", api: "openai-completions", apiKey: "secret",
  });
  expect(wrapper.get('[data-discovered-model="old"]').attributes("disabled")).toBeDefined();
  await wrapper.get('[data-discovered-model-search]').setValue("Alpha");
  await wrapper.get('[data-select-all-models]').trigger("click");
  expect((wrapper.get('[data-discovered-model="alpha"]').element as HTMLInputElement).checked).toBe(true);
  await wrapper.get('[data-discovered-model-search]').setValue("");
  expect((wrapper.get('[data-discovered-model="beta"]').element as HTMLInputElement).checked).toBe(false);
  await wrapper.get('[data-discovered-model="beta"]').setValue(true);
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  await flushPromises();
  expect(desktop.invoke).toHaveBeenLastCalledWith("agent.control", {
    action: "addCustomModels", provider: "custom", baseUrl: "https://models.example/v1", api: "openai-completions", apiKey: "secret",
    contextWindow: 128000, maxTokens: 16384, reasoning: false, imageInput: false,
    models: [{ modelId: "alpha", name: "Alpha" }, { modelId: "beta", name: "Beta" }],
  });
  expect(wrapper.emitted("saved")).toEqual([["custom", "alpha"]]);
});

it("adds comma/newline-separated manual IDs once and retains the batch on a failed save", async () => {
  vi.mocked(desktop.invoke).mockRejectedValue(new Error("Save failed"));
  await wrapper.get('[name="modelId"]').setValue(" alpha, beta\nalpha\n gamma ");
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  await flushPromises();
  expect(desktop.invoke).toHaveBeenLastCalledWith("agent.control", expect.objectContaining({
    action: "addCustomModels", models: [{ modelId: "alpha" }, { modelId: "beta" }, { modelId: "gamma" }],
  }));
  expect(wrapper.get('[role="alert"]').text()).toBe("Save failed");
  expect((wrapper.get('[name="apiKey"]').element as HTMLInputElement).value).toBe("secret");
  expect((wrapper.get('[name="modelId"]').element as HTMLTextAreaElement).value).toContain("gamma");
  expect(wrapper.emitted("saved")).toBeUndefined();
});

it("keeps fetched selections and credentials after a failed batch save, then retries without duplicates", async () => {
  vi.mocked(desktop.invoke).mockResolvedValueOnce([{ id: "alpha", name: "Alpha" }, { id: "beta" }]);
  await wrapper.get('[data-discover-models]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-select-all-models]').trigger("click");
  await wrapper.get('[name="modelId"]').setValue(" alpha, gamma\nbeta ");
  vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("Save failed"));
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe("Save failed");
  for (const id of ["alpha", "beta"])
    expect((wrapper.get(`[data-discovered-model="${id}"]`).element as HTMLInputElement).checked).toBe(true);
  expect((wrapper.get('[name="apiKey"]').element as HTMLInputElement).value).toBe("secret");
  const failedPayload = structuredClone(vi.mocked(desktop.invoke).mock.calls.at(-1)![1]);
  expect(failedPayload).toMatchObject({ action: "addCustomModels", models: [
    { modelId: "alpha", name: "Alpha" }, { modelId: "beta" }, { modelId: "gamma" },
  ] });
  vi.mocked(desktop.invoke).mockResolvedValueOnce({ ok: true });
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  await flushPromises();
  expect(vi.mocked(desktop.invoke).mock.calls.at(-1)![1]).toEqual(failedPayload);
  expect(wrapper.emitted("saved")).toEqual([["custom", "alpha"]]);
});

it("keeps manual entry available after discovery fails and resets selections when provider settings change", async () => {
  vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("HTTP 404"));
  await wrapper.get('[data-discover-models]').trigger("click");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe("HTTP 404");
  await wrapper.get('[name="modelId"]').setValue("manual");
  vi.mocked(desktop.invoke).mockResolvedValueOnce([{ id: "alpha" }]);
  await wrapper.get('[data-discover-models]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-select-all-models]').trigger("click");
  await wrapper.get('[name="baseUrl"]').setValue("https://other.example/v1");
  expect(wrapper.find('[data-discovered-model="alpha"]').exists()).toBe(false);
  vi.mocked(desktop.invoke).mockResolvedValueOnce({ ok: true });
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  await flushPromises();
  expect(desktop.invoke).toHaveBeenLastCalledWith("agent.control", expect.objectContaining({ action: "addCustomModel", modelId: "manual", baseUrl: "https://other.example/v1" }));
});

it("prevents duplicate operations while fetching and rejects an empty selection", async () => {
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  expect(wrapper.get('[role="alert"]').text()).toContain("Select a model");
  expect(desktop.invoke).not.toHaveBeenCalled();
  let resolve!: (models: unknown) => void;
  vi.mocked(desktop.invoke).mockImplementation(() => new Promise(done => { resolve = done; }));
  await wrapper.get('[data-discover-models]').trigger("click");
  expect(wrapper.get('[data-discover-models]').attributes("disabled")).toBeDefined();
  await wrapper.get('[data-custom-model-form]').trigger("submit");
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
  resolve([]);
  await flushPromises();
  expect(wrapper.text()).toContain("returned no models");
  expect(wrapper.get('[data-discover-models]').attributes("disabled")).toBeUndefined();
});
