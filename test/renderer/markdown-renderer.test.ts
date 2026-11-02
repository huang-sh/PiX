import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo, SettingsBundle } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";
import MarkdownRenderer from "../../src/renderer/components/MarkdownRenderer.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

const project = { name: "demo", path: "D:\\dev\\PiX\\test\\workspace" } as ProjectInfo;
const macProject = { name: "demo", path: "/Users/foo/project" } as ProjectInfo;

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
      closeToTray: true,
      canvasDotGrid: true,
      canvasDotGridSpacing: 24,
      canvasDotGridDotSize: 4,
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
    vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({});
    vi.mocked(window.pix!.copy!).mockReset().mockResolvedValue(undefined);
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

  it("resizes list gutters as streaming counters grow and shrink", async () => {
    const wrapper = await mountWithLink("999. item", true);
    try {
      for (const [content, indent] of [
        ["999. item", "5ch"],
        ["1000. item", "6ch"],
        ["9999. item\n10000. item", "7ch"],
        ["999999999. item", "11ch"],
        ["1. item", "3ch"],
      ]) {
        await wrapper.setProps({ content });
        await vi.waitFor(() => expect(
          (wrapper.get("ol").element as HTMLOListElement).style.getPropertyValue("--ms-flow-list-indent"),
        ).toBe(indent));
      }
      await wrapper.setProps({ streaming: false });
      expect(wrapper.get("li").attributes("value")).toBe("1");
    } finally {
      wrapper.unmount();
    }
  });

  it("sizes nested and sibling ordered lists independently", async () => {
    const wrapper = await mountWithLink("99999. outer\n\n       1. inner\n\n## Separate\n\n1. sibling\n\n- bullet");
    try {
      await vi.waitFor(() => expect(wrapper.findAll("ol").map(list =>
        (list.element as HTMLOListElement).style.getPropertyValue("--ms-flow-list-indent"),
      )).toEqual(["7ch", "3ch", "3ch"]));
      expect((wrapper.get("ul").element as HTMLUListElement).style.getPropertyValue("--ms-flow-list-indent")).toBe("");
    } finally {
      wrapper.unmount();
    }
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

  it.each([
    [macProject, "[report](<./My Report.pdf>)"],
    [macProject, "[report](</Users/foo/project/My Report.pdf:12>)"],
    [macProject, "[literal](./report%3A12)"],
    [macProject, "[folder](./docs)"],
    [macProject, "[外部文档](</Users/foo/Downloads/中文 文档/技术白皮书.docx>)"],
    [macProject, "[外部行号](file:///Users/foo/Downloads/report.md:12)"],
    [project, "[notes](file:///D:/dev/PiX/test/workspace/docs/notes.md:3)"],
    [project, "[notes](D:/dev/PiX/test/workspace/notes.md)"],
    [project, "[外部文档](<D:/Downloads/中文 文档/报告.docx:3>)"],
  ])("opens file links with the default app from their context menu: %s %s", async (root, markdown) => {
    const layout = useLayoutStore(); layout.settings = settingsWith(false);
    const workspace = useWorkspaceStore(); workspace.project = root;
    const wrapper = await mountWithLink(markdown);
    try {
      await wrapper.get("a").trigger("contextmenu", { button: 2, clientX: 100, clientY: 100 });
      await flushPromises();
      const item = document.querySelector<HTMLElement>('[data-action="markdown-open-external"]');
      expect(item).not.toBeNull();
      expect(item!.hasAttribute("data-disabled")).toBe(false);
      item!.click(); await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("app.openFileLink", { href: wrapper.get("a").attributes("href") });
      expect(workspace.tabs).toHaveLength(0);
      expect(layout.contentSection).toBe("home");
    } finally { wrapper.unmount(); }
  });

  it.each(["https://pi.dev/docs", "mailto:support@example.com"])("opens external links through the system handler: %s", async url => {
    useLayoutStore().settings = settingsWith(true);
    const wrapper = await mountWithLink(`[**link**](${url})`);
    try {
      await wrapper.get("a strong").trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="markdown-open-external"]')!.click();
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("app.openExternal", { url });
      expect(useWorkspaceStore().tabs).toHaveLength(0);
    } finally { wrapper.unmount(); }
  });

  it.each(["remote", "changed project", "outside project"])("disables local opening for %s", async scenario => {
    const workspace = useWorkspaceStore();
    workspace.project = scenario === "remote" ? { ...macProject, remote: { kind: "ssh", host: "server" } } : macProject;
    const wrapper = await mountWithLink(scenario === "outside project" ? "[report](../report.pdf)" : "[report](report.pdf)");
    try {
      await wrapper.get("a").trigger("contextmenu", { button: 2 });
      if (scenario === "changed project") workspace.project = { name: "other", path: "/other" };
      await flushPromises();
      const item = document.querySelector<HTMLElement>('[data-action="markdown-open-external"]')!;
      expect(item.hasAttribute("data-disabled")).toBe(true);
      item.click(); await flushPromises();
      expect(window.pix!.invoke).not.toHaveBeenCalled();
    } finally { wrapper.unmount(); }
  });

  it.each([
    ["[文档](https://example.com/report?q=a%20b%26c%3Dd#section)", "https://example.com/report?q=a%20b%26c%3Dd#section", false],
    ["[报告](<./My Report.pdf:12>)", "./My Report.pdf:12", false],
    ["[中文文件](示例文档.txt)", "示例文档.txt", false],
    ["[特殊文件](./a%2Bb%23c%3Fd%2520.txt)", "./a+b#c?d%20.txt", false],
    ["[本地文件](file:///Users/foo/project/中文%20报告%23A.pdf)", "/Users/foo/project/中文 报告#A.pdf", false],
    ["[Windows文件](file:///D:/project/中文%20报告.md:12)", "D:/project/中文 报告.md:12", false],
    ["[异常编码](./bad%ZZ.txt)", "./bad%ZZ.txt", false],
    ["[远程文档](docs/report.md:12)", "docs/report.md:12", true],
  ])("copies the link address instead of its label: %s", async (markdown, address, remote) => {
    useWorkspaceStore().project = remote ? { ...macProject, remote: { kind: "ssh", host: "server" } } : macProject;
    const wrapper = await mountWithLink(markdown);
    try {
      await wrapper.get("a").trigger("contextmenu", { button: 2 });
      await flushPromises();
      const item = document.querySelector<HTMLElement>('[data-action="markdown-copy-address"]')!;
      expect(item.hasAttribute("data-disabled")).toBe(false);
      item.click(); await flushPromises();
      expect(window.pix!.copy).toHaveBeenCalledWith(address);
      expect(useLayoutStore().notice?.message).toBe(i18n.global.t("common.copied"));
      expect(window.pix!.invoke).not.toHaveBeenCalled();
      expect(useWorkspaceStore().tabs).toHaveLength(0);
    } finally { wrapper.unmount(); }
  });

  it("reports clipboard failures without reporting success", async () => {
    const wrapper = await mountWithLink("[docs](https://example.com/docs)");
    vi.mocked(window.pix!.copy!).mockRejectedValueOnce(new Error("clipboard unavailable"));
    try {
      await wrapper.get("a").trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="markdown-copy-address"]')!.click();
      await flushPromises();
      expect(useLayoutStore().notice?.message).toBe(i18n.global.t("common.copyFailed"));
      expect(useLayoutStore().notice?.level).toBe("error");
    } finally { wrapper.unmount(); }
  });

  it("leaves non-link context menus alone and does not offer anchors to the OS", async () => {
    const wrapper = await mountWithLink("text [section](#section)");
    try {
      for (const selector of ["p", "a"]) {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
        wrapper.get(selector).element.dispatchEvent(event);
        await flushPromises();
        expect(event.defaultPrevented).toBe(false);
        expect(document.querySelector('[data-action="markdown-open-external"]')).toBeNull();
      }
    } finally { wrapper.unmount(); }
  });

  it.each(["no default application", "Path was not found or is inaccessible: /project/report.docx", "Path escapes project"])("reports the actual link opening failure: %s", async error => {
    useWorkspaceStore().project = macProject;
    const wrapper = await mountWithLink("[report](report.pdf)");
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error(error));
    try {
      await wrapper.get("a").trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="markdown-open-external"]')!.click();
      await flushPromises();
      expect(useLayoutStore().notice?.message).toBe(i18n.global.t("links.openFailed", { error }));
      expect(useWorkspaceStore().tabs).toHaveLength(0);
    } finally { wrapper.unmount(); }
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
      "see [notes](file:///D:/dev/PiX/test/workspace/docs/notes.md)",
    );

    await wrapper.get("a").trigger("click");
    await flushPromises();

    expect(useWorkspaceStore().tabs.map((tab) => tab.path)).toContain("docs/notes.md");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "docs/notes.md" });
    wrapper.unmount();
  });

  it("opens drive-letter links under the project root as workspace files", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const wrapper = await mountWithLink(
      "see [example](D:/dev/PiX/test/workspace/src/example.ts)",
    );

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();

    expect(useWorkspaceStore().tabs.map((tab) => tab.path)).toContain("src/example.ts");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "src/example.ts" });
    wrapper.unmount();
  });

  it("opens backslash drive-letter links under the project root", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const wrapper = await mountWithLink(
      "see [example](D:\\dev\\PiX\\test\\workspace\\src\\example.ts)",
    );

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();

    expect(useWorkspaceStore().tabs.map((tab) => tab.path)).toContain("src/example.ts");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "src/example.ts" });
    wrapper.unmount();
  });

  it("warns for drive-letter links outside the project root", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = project;
    const layout = useLayoutStore();
    const wrapper = await mountWithLink("see [qc](D:/project/shuang/QC_overview.png)");

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();

    expect(useWorkspaceStore().tabs).toHaveLength(0);
    expect(layout.notice?.message).toContain("QC_overview.png");
    expect(layout.notice?.level).toBe("warning");
    wrapper.unmount();
  });

  it("opens POSIX absolute links under the project root as workspace files", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = macProject;
    const wrapper = await mountWithLink(
      "see [example](/Users/foo/project/src/example.ts)",
    );

    expect(await clickFirstLink(wrapper)).toBe(true);
    await flushPromises();

    expect(useWorkspaceStore().tabs.map((tab) => tab.path)).toContain("src/example.ts");
    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "src/example.ts" });
    wrapper.unmount();
  });

  it("keeps lone-slash links root-relative on POSIX-style roots", async () => {
    useLayoutStore().settings = settingsWith(true);
    useWorkspaceStore().project = macProject;
    const wrapper = await mountWithLink("see [readme](/README.md)");

    await wrapper.get("a").trigger("click");
    await flushPromises();

    expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "README.md" });
    wrapper.unmount();
  });

  it.each([
    [macProject, "[example.ts:12](/Users/foo/project/src/example.ts:12)", "src/example.ts", 12],
    [macProject, "[My Report.md](</Users/foo/project/My Project/My Report.md>)", "My Project/My Report.md", undefined],
    [macProject, "[报告.md:12](</Users/foo/project/My Project/报告.md:12>)", "My Project/报告.md", 12],
    [project, "[example.ts:12](D:/dev/PiX/test/workspace/src/example.ts:12)", "src/example.ts", 12],
    [project, "[My Report.md:12](<D:/dev/PiX/test/workspace/My Project/My Report.md:12>)", "My Project/My Report.md", 12],
    [project, "[notes:3](file:///D:/dev/PiX/test/workspace/docs/notes.md:3)", "docs/notes.md", 3],
    [macProject, "[literal colon](/Users/foo/project/notes%3A12)", "notes:12", undefined],
  ])("opens formatted file links: %s %s", async (root, markdown, path, line) => {
    useLayoutStore().settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = root;
    vi.mocked(window.pix!.invoke).mockImplementation(async (route, payload) => {
      if (route === "workspace.read" && (payload as { path: string }).path !== path)
        throw new Error("ENOENT: no such file or directory");
      return {};
    });
    const wrapper = await mountWithLink(markdown);
    try {
      expect(await clickFirstLink(wrapper)).toBe(true);
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path });
      expect(workspace.active?.path).toBe(path);
      expect(workspace.active?.line).toBe(line);
      expect(useLayoutStore().contentSection).toBe("files");
    } finally {
      wrapper.unmount();
    }
  });

  it.each([
    ["[report](/Users/foo/project/report:12)", "report:12"],
    ["[report](./report:12)", "report:12"],
    ["[report](file:///Users/foo/project/report:12)", "report:12"],
    ["[report](./:12)", ":12"],
  ])("preserves literal POSIX filenames ending in colon and digits: %s", async (markdown, path) => {
    useLayoutStore().settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = macProject;
    const wrapper = await mountWithLink(markdown);
    try {
      await clickFirstLink(wrapper);
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path });
      expect(window.pix!.invoke).not.toHaveBeenCalledWith("workspace.read", { path: path.replace(/:\d+$/, "") });
      expect(workspace.active?.path).toBe(path);
      expect(workspace.active?.line).toBeUndefined();
    } finally { wrapper.unmount(); }
  });

  it.each(["//server/share/project", "\\\\server\\share\\project"])("resolves line links on Windows UNC projects without probing alternate data streams: %s", async root => {
    useLayoutStore().settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = { name: "project", path: root };
    const wrapper = await mountWithLink("[example](./src/example.ts:12)");
    try {
      await clickFirstLink(wrapper);
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "src/example.ts" });
      expect(window.pix!.invoke).not.toHaveBeenCalledWith("workspace.read", { path: "src/example.ts:12" });
      expect(workspace.active?.line).toBe(12);
    } finally { wrapper.unmount(); }
  });

  it.each(["EACCES: permission denied", "Binary file"])("does not reinterpret an unreadable literal file as a line link: %s", async error => {
    const layout = useLayoutStore();
    layout.settings = settingsWith(true);
    useWorkspaceStore().project = macProject;
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error(error));
    const wrapper = await mountWithLink("[report](/Users/foo/project/report:12)");
    try {
      await clickFirstLink(wrapper);
      await flushPromises();
      expect(window.pix!.invoke).not.toHaveBeenCalledWith("workspace.read", { path: "report" });
      expect(useWorkspaceStore().tabs).toHaveLength(0);
      expect(layout.notice?.message).toContain("report:12");
    } finally { wrapper.unmount(); }
  });

  it.each(["ENOENT", "ENOTDIR"])("does not treat an errno name in a denied filename as the error code: %s", async name => {
    const layout = useLayoutStore();
    layout.settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = macProject;
    vi.mocked(window.pix!.invoke).mockImplementation(async (route, payload) => {
      if (route === "workspace.read" && (payload as { path: string }).path === `${name}:12`)
        throw new Error(`EACCES: permission denied, open '/Users/foo/project/${name}:12'`);
      return {};
    });
    const wrapper = await mountWithLink(`[report](/Users/foo/project/${name}:12)`);
    try {
      await clickFirstLink(wrapper);
      await flushPromises();
      expect(window.pix!.invoke).not.toHaveBeenCalledWith("workspace.read", { path: name });
      expect(workspace.tabs).toHaveLength(0);
      expect(layout.notice?.message).toContain(`${name}:12`);
    } finally { wrapper.unmount(); }
  });

  it.each(["ENOENT", "ENOTDIR"])("resolves a line link only when the errno prefix means the literal file is missing: %s", async code => {
    const layout = useLayoutStore();
    layout.settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = macProject;
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error(`${code}: cannot open '/Users/foo/project/report.ts:12'`));
    const wrapper = await mountWithLink("[report](/Users/foo/project/report.ts:12)");
    try {
      await clickFirstLink(wrapper);
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "report.ts:12" });
      expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: "report.ts" });
      expect(workspace.active?.path).toBe("report.ts");
      expect(workspace.active?.line).toBe(12);
      expect(layout.notice).toBeUndefined();
    } finally { wrapper.unmount(); }
  });

  it("does not resolve an old project's line link against a newly selected project", async () => {
    const layout = useLayoutStore();
    layout.settings = settingsWith(true);
    const workspace = useWorkspaceStore();
    workspace.project = macProject;
    let reject!: (error: Error) => void;
    vi.mocked(window.pix!.invoke).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const wrapper = await mountWithLink("[report](/Users/foo/project/report:12)");
    try {
      await clickFirstLink(wrapper);
      workspace.project = { name: "other", path: "/other" };
      reject(new Error("ENOENT: no such file or directory"));
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenCalledTimes(1);
      expect(workspace.tabs).toHaveLength(0);
      expect(layout.notice).toBeUndefined();
    } finally { wrapper.unmount(); }
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
