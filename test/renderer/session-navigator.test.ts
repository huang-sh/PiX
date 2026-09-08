import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import type { ProjectGroup, SessionSummary } from "../../src/shared/types";
import SessionNavigator from "../../src/renderer/features/navigator/SessionNavigator.vue";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";

const summary = (id: string): SessionSummary => ({
  id,
  path: `/sessions/${id}.jsonl`,
  name: id,
  cwd: "/project",
  created: "2026-09-03T00:00:00Z",
  modified: "2026-09-03T00:00:00Z",
  messageCount: 1,
  firstMessage: id,
});

describe("session project navigator", () => {
  it("opens rename and delete from the session context menu without opening the session", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const record: ProjectGroup = {
      id: "local:/project",
      project: { name: "project", path: "/project" },
      sessions: [{ ...summary("session-title"), modified: new Date().toISOString() }],
      lastOpened: new Date().toISOString(),
      connected: true,
    };
    useSessionStore().projects = [record];
    const wrapper = mount(SessionNavigator, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    try {
      await wrapper.get(".project-main").trigger("click");
      const row = wrapper.get(".session-item");
      expect(row.get("strong").text()).toBe("session-title");
      expect(row.get("small").text()).toBe(i18n.global.t("time.now"));
      expect(wrapper.find(".session-menu").exists()).toBe(false);
      expect(wrapper.get(".session-row").findAll("button")).toHaveLength(1);
      for (const [action, event, args] of [
        ["session-rename", "rename", [record, record.sessions[0]!.path, "session-title"]],
        ["session-delete", "removeProjectSession", [record, record.sessions[0]!.path]],
      ] as const) {
        await row.trigger("contextmenu", { button: 2, clientX: 100, clientY: 100 });
        await flushPromises();
        expect(wrapper.emitted("openProjectSession")).toBeUndefined();
        expect(wrapper.emitted("menuOpenChange")?.at(-1)).toEqual([true]);
        const item = document.querySelector<HTMLElement>(`[data-action="${action}"]`);
        expect(item).not.toBeNull();
        item!.click();
        await flushPromises();
        expect(wrapper.emitted(event)?.[0]).toEqual(args);
        expect(wrapper.emitted("menuOpenChange")?.at(-1)).toEqual([false]);
      }
      for (const [action, value] of [["session-copy-path", record.sessions[0]!.path], ["session-copy-id", "session-title"]]) {
        await row.trigger("contextmenu", { button: 2 });
        await flushPromises();
        document.querySelector<HTMLElement>(`[data-action="${action}"]`)!.click();
        await flushPromises();
        expect(window.pix!.copy).toHaveBeenLastCalledWith(value);
        expect(useLayoutStore().notice?.message).toBe(i18n.global.t("common.copied"));
      }
      await row.trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="session-reveal"]')!.click();
      await flushPromises();
      expect(window.pix!.invoke).toHaveBeenLastCalledWith("app.revealSession", { id: record.id, path: record.sessions[0]!.path });
      expect(wrapper.emitted("openProjectSession")).toBeUndefined();
      vi.mocked(window.pix!.copy!).mockRejectedValueOnce(new Error("clipboard unavailable"));
      await row.trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="session-copy-id"]')!.click();
      await flushPromises();
      expect(useLayoutStore().notice).toEqual({ message: i18n.global.t("common.copyFailed"), level: "error" });
      vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error("file not found"));
      await row.trigger("contextmenu", { button: 2 });
      await flushPromises();
      document.querySelector<HTMLElement>('[data-action="session-reveal"]')!.click();
      await flushPromises();
      expect(useLayoutStore().notice).toEqual({ message: i18n.global.t("nav.revealFailed"), level: "error" });
      useSessionStore().projects[0]!.project.remote = { kind: "ssh", host: "server" };
      await row.trigger("contextmenu", { button: 2 });
      await flushPromises();
      expect(document.querySelector('[data-action="session-reveal"]')!.getAttribute("aria-disabled")).toBe("true");
      document.querySelector<HTMLElement>('[data-action="session-copy-path"]')!.click();
      await flushPromises();
      expect(window.pix!.copy).toHaveBeenLastCalledWith(record.sessions[0]!.path);
      await row.trigger("click");
      expect(wrapper.emitted("openProjectSession")?.[0]).toEqual([record, record.sessions[0]!.path]);
      await row.trigger("contextmenu", { button: 2 });
      await flushPromises();
      useSessionStore().projects = [];
      await flushPromises();
      expect(document.querySelector("[data-navigator-menu]")).toBeNull();
      expect(wrapper.emitted("menuOpenChange")?.at(-1)).toEqual([false]);
    } finally {
      wrapper.unmount();
    }
  });

  it("groups sessions and creates a session for the selected project", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const local: ProjectGroup = {
      id: "local:D:/PiX",
      project: { name: "PiX", path: "D:/PiX" },
      sessions: Array.from({ length: 6 }, (_, index) => summary(`local-${index}`)),
      lastOpened: "2026-09-03T00:00:00Z",
      connected: true,
    };
    const remote: ProjectGroup = {
      id: "ssh:server:/data/project",
      project: {
        name: "data20T",
        path: "/data/project",
        remote: { kind: "ssh", host: "server" },
      },
      sessions: [summary("remote")],
      lastOpened: "2026-09-02T00:00:00Z",
      connected: false,
    };
    const session = useSessionStore();
    session.projects = [local, remote];
    session.activeProjectId = local.id;
    const wrapper = mount(SessionNavigator, { global: { plugins: [pinia, i18n] } });

    expect(wrapper.find("[data-action=navigator-pin]").exists()).toBe(false);

    // Session lists start collapsed; search still surfaces matching sessions.
    expect(wrapper.findAll(".project-group")).toHaveLength(2);
    expect(wrapper.findAll(".session-row")).toHaveLength(0);
    expect(wrapper.findAll(".project-main")[0]!.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll(".project-main")[0]!.find(".lucide-folder").exists()).toBe(true);
    session.query = "local-4";
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".project-group")[0]!.findAll(".session-row")).toHaveLength(1);
    session.query = "";
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".session-row")).toHaveLength(0);

    await wrapper.findAll("[data-action=create-project-session]")[1]!.trigger("click");
    expect(wrapper.emitted("createProjectSession")?.[0]?.[0]).toEqual(remote);

    await wrapper.findAll(".project-main")[0]!.trigger("click");
    expect(wrapper.findAll(".project-group")[0]!.findAll(".session-row")).toHaveLength(5);
    expect(wrapper.findAll(".project-main")[0]!.find(".lucide-folder-open").exists()).toBe(true);
    expect(wrapper.find(".project-connection").classes()).not.toContain("connected");

    await wrapper.find(".show-more").trigger("click");
    expect(wrapper.findAll(".project-group")[0]!.findAll(".session-row")).toHaveLength(6);

    await wrapper.findAll(".project-main")[0]!.trigger("click");
    expect(wrapper.findAll(".project-group")[0]!.find(".project-sessions").exists()).toBe(false);
    expect(wrapper.findAll(".project-main")[0]!.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll(".project-main")[0]!.find(".lucide-folder").exists()).toBe(true);
  });
});
