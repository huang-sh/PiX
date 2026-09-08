import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionSummary } from "../../src/shared/types";
import SessionNavigator from "../../src/renderer/features/navigator/SessionNavigator.vue";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";

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
