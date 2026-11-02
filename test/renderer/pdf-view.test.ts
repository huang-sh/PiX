import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfView from "../../src/renderer/features/tools/PdfView.vue";
import { i18n } from "../../src/renderer/i18n";

// "data:application/pdf;base64,AAAA"
const dataUrl = `data:application/pdf;base64,${btoa("pdf-bytes")}`;

const pdfjs = vi.hoisted(() => {
  const pages = [1, 2].map(() => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  }));
  const book = {
    numPages: 2,
    getPage: vi.fn(async (number: number) => pages[number - 1]!),
  };
  // getDocument returns a loading task synchronously; the document arrives
  // and is torn down through the task, mirroring pdfjs-dist.
  const task = { promise: Promise.resolve(book), destroy: vi.fn(async () => {}) };
  return { pages, task, getDocument: vi.fn(() => task) };
});
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: { workerSrc: "" }, getDocument: pdfjs.getDocument }));

const getContext = HTMLCanvasElement.prototype.getContext;

async function mountView() {
  const wrapper = mount(PdfView, { props: { dataUrl }, global: { plugins: [i18n] } });
  await vi.waitFor(() => expect(wrapper.element.querySelectorAll("canvas")).toHaveLength(2));
  return wrapper;
}

describe("pdf view", () => {
  beforeEach(() => {
    i18n.global.locale.value = "en";
    pdfjs.getDocument.mockClear();
    pdfjs.task.destroy.mockClear();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}) as CanvasRenderingContext2D);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLCanvasElement.prototype.getContext = getContext;
  });

  it("renders every page and reports the page count", async () => {
    expect(i18n.global.t("tools.pdfPages", { count: 1 })).toBe("Pages: 1");
    const wrapper = await mountView();
    expect(pdfjs.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    expect(wrapper.text()).toContain(i18n.global.t("tools.pdfPages", { count: 2 }));
    expect(wrapper.get(".pdf-zoom-level").text()).toBe("100%");
    wrapper.unmount();
    expect(pdfjs.task.destroy).toHaveBeenCalled();
  });

  it("re-renders pages when zooming and clamps the range", async () => {
    const wrapper = await mountView();
    await wrapper.get('[data-action="pdf-zoom-in"]').trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.get(".pdf-zoom-level").text()).toBe("125%");
      expect(wrapper.element.querySelector("canvas")?.style.width).toBe("125px");
    });

    const zoomOut = wrapper.get('[data-action="pdf-zoom-out"]');
    for (let click = 0; click < 8; click++) await zoomOut.trigger("click");
    expect(wrapper.get(".pdf-zoom-level").text()).toBe("25%");
    expect(zoomOut.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("reports failures instead of an empty canvas area", async () => {
    pdfjs.getDocument.mockReturnValueOnce({
      promise: Promise.reject(new Error("corrupt pdf")),
      destroy: vi.fn(async () => {}),
    });
    const wrapper = mount(PdfView, { props: { dataUrl }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(wrapper.text()).toContain(i18n.global.t("tools.pdfFailed")));
    expect(wrapper.element.querySelectorAll("canvas")).toHaveLength(0);
    wrapper.unmount();
  });
});
