import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDocument } from "../../src/shared/types";
import ToolPanel from "../../src/renderer/features/tools/ToolPanel.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

function fileDocument(partial: Partial<FileDocument> & { path: string }): FileDocument {
  return { name: partial.path, content: "", language: "markdown", readonly: false, truncated: false, ...partial };
}

async function mountWithFile(...documents: FileDocument[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const layout = useLayoutStore();
  const workspace = useWorkspaceStore();
  layout.contentTabs = ["files"];
  layout.contentSection = "files";
  workspace.project = { name: "project", path: "/project" };
  workspace.tabs = documents.map((doc) => ({
    id: `file:${doc.path}`,
    kind: "file" as const,
    title: doc.name,
    path: doc.path,
    document: doc,
    savedContent: doc.content,
  }));
  workspace.activeTab = workspace.tabs[0]!.id;
  const wrapper = mount(ToolPanel, { global: { plugins: [pinia, i18n], stubs: { PdfView: true } } });
  await flushPromises();
  return { wrapper, workspace };
}

describe("tool panel file previews", () => {
  beforeEach(() => {
    i18n.global.locale.value = "en";
  });

  it("renders markdown files as a preview and toggles into the editor", async () => {
    const { wrapper } = await mountWithFile(fileDocument({ path: "notes.md", content: "# Title\n\nSome markdown text" }));
    await vi.waitFor(() => expect(wrapper.get('[data-markdown-preview]').text()).toContain("Some markdown text"));

    const toggle = wrapper.get('[data-action="toggle-markdown-edit"]');
    expect(toggle.text()).toBe(i18n.global.t("tools.edit"));
    await toggle.trigger("click");
    expect(wrapper.find('[data-markdown-preview]').exists()).toBe(false);
    expect((wrapper.get(".file-editor").element as HTMLTextAreaElement).value).toBe("# Title\n\nSome markdown text");
    expect(wrapper.get('[data-action="toggle-markdown-edit"]').text()).toBe(i18n.global.t("tools.preview"));

    await wrapper.get('[data-action="toggle-markdown-edit"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.get('[data-markdown-preview]').text()).toContain("Some markdown text"));
  });

  it("resets the editor toggle when switching markdown files", async () => {
    const { wrapper, workspace } = await mountWithFile(
      fileDocument({ path: "a.md", content: "alpha" }),
      fileDocument({ path: "b.md", content: "beta" }),
    );
    await wrapper.get('[data-action="toggle-markdown-edit"]').trigger("click");
    expect(wrapper.find(".file-editor").exists()).toBe(true);

    workspace.activeTab = "file:b.md";
    await flushPromises();
    expect(wrapper.find(".file-editor").exists()).toBe(false);
    await vi.waitFor(() => expect(wrapper.get('[data-markdown-preview]').text()).toContain("beta"));
  });

  it("opens pdf documents in the pdf view instead of the editor", async () => {
    const { wrapper } = await mountWithFile(
      fileDocument({ path: "paper.pdf", language: "pdf", readonly: true, dataUrl: "data:application/pdf;base64,AAAA" }),
    );
    expect(wrapper.find("pdf-view-stub").exists()).toBe(true);
    expect(wrapper.find(".file-editor").exists()).toBe(false);
    expect(wrapper.find('[data-action="toggle-markdown-edit"]').exists()).toBe(false);
  });

  it("reveals linked lines in existing files, including repeated clicks and clamped lines", async () => {
    const { wrapper, workspace } = await mountWithFile(
      fileDocument({ path: "notes.md", content: "# Title\n\nTarget line\nLast line" }),
    );
    try {
      for (const [line, selected] of [[3, "Target line"], [3, "Target line"], [999, "Last line"]] as const) {
        await workspace.openFile("notes.md", line);
        await flushPromises();
        const editor = wrapper.get(".file-editor").element as HTMLTextAreaElement;
        expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe(selected);
        expect(workspace.active?.line).toBeUndefined();
        expect(workspace.tabs).toHaveLength(1);
      }
    } finally {
      wrapper.unmount();
    }
  });

  it("waits for the Files panel before revealing a linked line", async () => {
    const { wrapper, workspace } = await mountWithFile(
      fileDocument({ path: "notes.md", content: "# Title\nTarget line", readonly: true }),
    );
    try {
      const layout = useLayoutStore();
      layout.contentSection = "home";
      await flushPromises();
      await workspace.openFile("notes.md", 2);
      await flushPromises();
      expect(workspace.active?.line).toBe(2);
      layout.contentSection = "files";
      await flushPromises();
      const editor = wrapper.get(".file-editor").element as HTMLTextAreaElement;
      expect(editor.readOnly).toBe(true);
      expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe("Target line");
      expect(workspace.active?.line).toBeUndefined();
      expect(wrapper.find('[data-action="toggle-markdown-edit"]').exists()).toBe(true);
      await wrapper.get('[data-action="toggle-markdown-edit"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-markdown-preview]').text()).toContain("Target line"));
      expect(wrapper.find(".file-editor").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it("shows a notice for oversized binary documents", async () => {
    const { wrapper } = await mountWithFile(
      fileDocument({ path: "big.pdf", language: "pdf", readonly: true, truncated: true }),
    );
    expect(wrapper.find('[data-file-too-large]').exists()).toBe(true);
    expect(wrapper.find("pdf-view-stub").exists()).toBe(false);
  });

  it("copies absolute paths and opens files externally from the tree menu", async () => {
    const { wrapper, workspace } = await mountWithFile(
      fileDocument({ path: "notes.md", content: "# Title" }),
    );
    workspace.files = [{ name: "README.md", path: "README.md", kind: "file" }];
    await flushPromises();
    vi.mocked(window.pix!.copy).mockClear();

    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-copy-path"]')).toBeTruthy());
    document.querySelector<HTMLElement>('[data-action="tree-copy-path"]')!.click();
    await flushPromises();
    expect(vi.mocked(window.pix!.copy)).toHaveBeenCalledWith("/project/README.md");

    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-external"]')).toBeTruthy());
    document.querySelector<HTMLElement>('[data-action="tree-open-external"]')!.click();
    await flushPromises();
    expect(vi.mocked(window.pix!.invoke)).toHaveBeenCalledWith("app.openPath", { path: "README.md" });

    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-with"]')).toBeTruthy());
    document.querySelector<HTMLElement>('[data-action="tree-open-with"]')!.click();
    await flushPromises();
    expect(vi.mocked(window.pix!.invoke)).toHaveBeenCalledWith("app.openWith", { path: "README.md" });
  });
});
