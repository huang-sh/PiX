import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImagePreview from "../../src/renderer/components/ImagePreview.vue";
import MessageImages from "../../src/renderer/components/MessageImages.vue";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
const mounted: VueWrapper[] = [];

describe("image preview", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
    mounted.push(mount(ImagePreview, { attachTo: document.body, global: { plugins: [i18n] } }));
  });
  afterEach(() => {
    mounted.splice(0).reverse().forEach((wrapper) => wrapper.unmount());
    vi.unstubAllGlobals();
  });

  it("fetches only visible thumbnails, caches them across mounts, and reads the original on click", async () => {
    let visible!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { visible = callback; }
      observe() {} disconnect = disconnect;
    });
    const reference = { type: "image" as const, mimeType: "image/png", reference: { session: "visible.jsonl", entryId: "u", index: 0 } };
    const invoke = vi.mocked(window.pix!.invoke).mockReset().mockImplementation(async (_route, input) =>
      ({ ...image, data: (input as { thumbnail: boolean }).thumbnail ? "dGh1bWI=" : image.data }));
    const thumbnails = mount(MessageImages, { props: { images: [reference] }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(thumbnails);
    expect(invoke).not.toHaveBeenCalled();
    expect(thumbnails.find("img").exists()).toBe(false);
    visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("session.image", { ...reference.reference, thumbnail: true });
    expect(thumbnails.get("img").attributes("src")).toBe("data:image/png;base64,dGh1bWI=");
    expect(disconnect).toHaveBeenCalled();
    await thumbnails.get("button").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("session.image", { ...reference.reference, thumbnail: false });
    expect(document.querySelector("[data-image-preview] img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    useLayoutStore().imagePreview = undefined;
    thumbnails.unmount();
    const again = mount(MessageImages, { props: { images: [reference] }, global: { plugins: [i18n] } }); mounted.push(again);
    visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flushPromises();
    await again.get("button").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("closing a preview during loading cannot reopen it when the original arrives", async () => {
    let finish!: (value: typeof image) => void;
    vi.mocked(window.pix!.invoke).mockReset().mockImplementation((_route, input) =>
      (input as { thumbnail: boolean }).thumbnail ? Promise.resolve(image) : new Promise(resolve => { finish = resolve; }));
    const preview = useLayoutStore().previewImage({ type: "image", mimeType: "image/png",
      reference: { session: "slow.jsonl", entryId: "u", index: 0 } }, "slow");
    await flushPromises();
    expect(document.querySelector("[data-image-preview] [role=status]")).not.toBeNull();
    useLayoutStore().imagePreview = undefined;
    finish(image); await preview; await flushPromises();
    expect(useLayoutStore().imagePreview).toBeUndefined();
    expect(document.querySelector("[data-image-preview]")).toBeNull();
  });

  it("resumes lazy observation when a cached branch history becomes active again", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe = observe; disconnect = disconnect;
    });
    const shown = ref(true);
    const reference = { type: "image" as const, mimeType: "image/png", reference: { session: "kept.jsonl", entryId: "u", index: 0 } };
    const invoke = vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue(image);
    const host = mount(defineComponent({ components: { MessageImages }, setup: () => ({ shown, reference }),
      template: '<KeepAlive><MessageImages v-if="shown" :images="[reference]" /></KeepAlive>' }),
    { attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(host);
    await flushPromises();
    expect(invoke).not.toHaveBeenCalled();
    shown.value = false; await flushPromises();
    const count = observe.mock.calls.length;
    shown.value = true; await flushPromises();
    expect(observe.mock.calls.length).toBeGreaterThan(count);
    expect(observe.mock.lastCall![0].isConnected).toBe(true);
    callbacks.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flushPromises();
    expect(host.get("img").attributes("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("opens a full preview, toggles original size and closes with Escape or the backdrop", async () => {
    const thumbnails = mount(MessageImages, { props: { images: [image] }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(thumbnails);
    const trigger = thumbnails.get("button");
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger("click");
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview] img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo="));
    const zoom = document.querySelector<HTMLButtonElement>("[data-image-preview-zoom]")!;
    zoom.click();
    await flushPromises();
    expect(zoom.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".image-viewer-stage.is-zoomed")).not.toBeNull();
    document.querySelector("[data-image-preview]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview]")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element));

    await trigger.trigger("click");
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview]")).not.toBeNull());
    expect(document.querySelector("[data-image-preview-zoom]")!.getAttribute("aria-pressed")).toBe("false");
    document.querySelector<HTMLElement>("[data-image-preview-overlay]")!.click();
    await vi.waitFor(() => expect(useLayoutStore().imagePreview).toBeUndefined());
  });

  it("keeps a preview open when its graph hover card unmounts", async () => {
    const thumbnails = mount(MessageImages, { props: { images: [image] }, global: { plugins: [i18n] } });
    await thumbnails.get("button").trigger("click");
    thumbnails.unmount();
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview] img")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-image-preview-close]")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview]")).toBeNull());
  });

  it("previews draft attachments without sending or removing them", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const model = { provider: "local", id: "vision", input: ["text", "image"] as ("text" | "image")[] };
    const composer = mount(PromptComposer, {
      props: { runnable: true, model, models: [model], thinkingLevel: "off", onModel: vi.fn(), onThinking: vi.fn(), onSubmit },
      attachTo: document.body, global: { plugins: [i18n] },
    });
    mounted.push(composer);
    await composer.get("textarea").setValue("Keep this text");
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "image.png", { type: "image/png" });
    await composer.get("textarea").trigger("paste", { clipboardData: { files: [file] } });
    await vi.waitFor(() => expect(composer.find(".composer-image-open").exists()).toBe(true));
    await composer.get(".composer-image-open").trigger("click");
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview] img")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-image-preview-close]")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-image-preview]")).toBeNull());
    expect(composer.get<HTMLTextAreaElement>("textarea").element.value).toBe("Keep this text");
    expect(composer.findAll(".composer-images img")).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
    await composer.get(".composer-image-remove").trigger("click");
    expect(composer.find(".composer-images").exists()).toBe(false);
    expect(useLayoutStore().imagePreview).toBeUndefined();
  });
});
