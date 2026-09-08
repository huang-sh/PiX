import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo, SettingsBundle } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";
import MarkdownRenderer from "../../src/renderer/components/MarkdownRenderer.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

const project = { name: "demo", path: "D:\\dev\\PiX\\test-workspace" } as ProjectInfo;

function settingsWith(openLinksInApp: boolean): SettingsBundle {
  return {
    app: {
      language: "system",
      theme: "system",
      density: "comfortable",
      confirmDestructiveActions: true,
      browserHome: "https://pi.dev",
      openLastSessionOnStartup: false,
      enterToSend: true,
      openLinksInApp,
    },
    piGlobal: {},
    piProject: {},
    effective: {},
    paths: { app: "", global: "", project: null },
  };
}

async function mountWithLink(markdown: string, streaming = false) {
  const wrapper = mount(MarkdownRenderer, {
    props: { content: markdown, customId: "assistant:1", streaming },
    // Attached so click events bubble past the wrapper root; the
    // defaultPrevented assertion listens on the document.
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return wrapper;
}

/** True when a trusted-style click on the first link got preventDefault'ed. */
async function clickFirstLink(wrapper: { get: (sel: string) => { trigger: (t: string, o?: object) => Promise<void> } }, options?: object) {
  const prevented: boolean[] = [];
  const record = (event: Event) => prevented.push(event.defaultPrevented);
  document.addEventListener("click", record);
  await wrapper.get("a").trigger("click", options);
  document.removeEventListener("click", record);
  return prevented.at(-1) === true;
}

describe("MarkdownRenderer", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(window.pix!.invoke).mockClear();
  });

  it("updates one safe Markdown surface from streaming to final", async () => {
    const wrapper = await mountWithLink("# Res", true);
    const surface = wrapper.get(".agent-markdown").element;
    for (const content of ["# Result\n\n收到", "# Result\n\n收到多少", "# Result\n\n收到多少就显示多少"]) {
      await wrapper.setProps({ content });
      expect(wrapper.get("p").text()).toBe(content.split("\n\n")[1]);
    }
    await wrapper.setProps({
      content: "# Result\n\n- **done**\n\n<script>window.unsafe = true</script>",
      streaming: false,
    });
    await flushPromises();

    expect(wrapper.get(".agent-markdown").element).toBe(surface);
    expect(wrapper.get("h1").text()).toBe("Result");
    expect(wrapper.get("strong").text()).toBe("done");
    expect(wrapper.find("script").exists()).toBe(false);
    wrapper.unmount();
  });

  it("routes plain link clicks to the built-in browser when enabled", async () => {
    useLayoutStore().settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    const wrapper = await mountWithLink("see [pi docs](https://pi.dev/docs/guide)");

    expect(await clickFirstLink(wrapper)).toBe(true);

    expect(workspace.browserUrl).toBe("https://pi.dev/docs/guide");
    const tab = workspace.tabs.find((tab) => tab.kind === "browser");
    expect(tab?.url).toBe("https://pi.dev/docs/guide");
    expect(workspace.activeTab).toBe(tab?.id);
    expect(useLayoutStore().contentSection).toBe("browser");
    wrapper.unmount();
  });

  it("leaves modified clicks to the OS browser path", async () => {
    useLayoutStore().settings = settingsWith(true);
    const wrapper = await mountWithLink("see [pi docs](https://pi.dev/docs/guide)");

    await wrapper.get("a").trigger("click", { ctrlKey: true });
    wrapper.unmount();

    expect(useWorkspaceStore().browserUrl).toBe("https://pi.dev");
    expect(useLayoutStore().contentSection).toBe("home");
  });

  it("does not intercept when the setting is off", async () => {
    useLayoutStore().settings = settingsWith(false);
    const wrapper = await mountWithLink("see [pi docs](https://pi.dev/docs/guide)");

    await wrapper.get("a").trigger("click");
    wrapper.unmount();

    expect(useWorkspaceStore().browserUrl).toBe("https://pi.dev");
    expect(useLayoutStore().contentSection).toBe("home");
  });

  it("does not intercept non-web links such as mailto", async () => {
    useLayoutStore().settings = settingsWith(true);
    const wrapper = await mountWithLink("write [support](mailto:support@example.com)");

    await wrapper.get("a").trigger("click");
    wrapper.unmount();

    expect(useWorkspaceStore().tabs).toHaveLength(0);
    expect(useLayoutStore().notice).toBeUndefined();
  });

  it("opens relative links to project files in the Files tool", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const workspace = useWorkspaceStore();
    const wrapper = await mountWithLink("edit [example](./src/example.ts) and [root readme](/README.md)");

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();
    expect(workspace.tabs.map((tab) => tab.path)).toContain("src/example.ts");
    expect(useLayoutStore().contentSection).toBe("files");

    const links = wrapper.findAll("a");
    await links[1]!.trigger("click");
    await flushPromises();
    expect(workspace.tabs.map((tab) => tab.path)).toContain("README.md");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "src/example.ts" });
    wrapper.unmount();
  });

  it("opens file:// links under the project root as workspace files", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const wrapper = await mountWithLink(
      "see [notes](file:///D:/dev/PiX/test-workspace/docs/notes.md)",
    );

    await wrapper.get("a").trigger("click");
    await flushPromises();

    expect(useWorkspaceStore().tabs.map((tab) => tab.path)).toContain("docs/notes.md");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "docs/notes.md" });
    wrapper.unmount();
  });

  it("warns instead of navigating for links that escape the project", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const layout = useLayoutStore();
    const wrapper = await mountWithLink("steal [secrets](../../outside/secrets.txt)");

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();

    expect(useWorkspaceStore().tabs).toHaveLength(0);
    expect(layout.notice?.message).toContain("secrets.txt");
    expect(layout.notice?.level).toBe("warning");
    wrapper.unmount();
  });

  it("warns when the resolved file does not exist", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const layout = useLayoutStore();
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error("not found"));
    const wrapper = await mountWithLink("see [ghost](missing.md)");

    await wrapper.get("a").trigger("click");
    await flushPromises();

    expect(useWorkspaceStore().tabs).toHaveLength(0);
    expect(layout.notice?.message).toContain("missing.md");
    wrapper.unmount();
  });

  it("handles in-message anchors without touching the app URL", async () => {
    useLayoutStore().settings = settingsWith(true);
    const wrapper = await mountWithLink("jump to [section](#section)");

    expect(await clickFirstLink(wrapper)).toBe(true);
    expect(useWorkspaceStore().tabs).toHaveLength(0);
    expect(useLayoutStore().notice).toBeUndefined();
    expect(window.location.hash).toBe("");
    wrapper.unmount();
  });
});
