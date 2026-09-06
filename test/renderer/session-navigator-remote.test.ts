import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectGroup } from "../../src/shared/types";
import SessionNavigator from "../../src/renderer/features/navigator/SessionNavigator.vue";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";

const groups: ProjectGroup[] = [
  {
    id: "local:D:\\dev\\demo",
    project: { name: "demo", path: "D:\\dev\\demo" },
    sessions: [],
    lastOpened: new Date().toISOString(),
    connected: false,
  },
  {
    id: "ssh:build-box:/home/user/pix",
    project: {
      name: "pix",
      path: "/home/user/pix",
      remote: { kind: "ssh", host: "build-box" },
    },
    sessions: [
      {
        id: "s1",
        path: "/home/user/pix/.pi/sessions/s1.json",
        name: "fix bug",
        cwd: "/home/user/pix",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 4,
        firstMessage: "hello",
      },
    ],
    lastOpened: new Date().toISOString(),
    connected: true,
  },
  {
    id: "wsl:Ubuntu:/home/user/repos/api",
    project: {
      name: "api",
      path: "/home/user/repos/api",
      remote: { kind: "wsl", distro: "Ubuntu" },
    },
    sessions: [],
    lastOpened: new Date().toISOString(),
    connected: false,
  },
];

describe("session navigator remote projects", () => {
  it("keeps a disconnected project offline when cached sessions are synced", () => {
    const session = useSessionStore();
    session.disconnected(session.activeProjectId);
    session.syncProject();
    expect(session.projects.find((record) => record.id === session.activeProjectId)?.connected).toBe(false);
  });
  beforeEach(() => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    session.hydrate(
      groups[1]!.project,
      groups[1]!.sessions,
      JSON.parse(JSON.stringify(groups)),
    );
  });

  function mountNavigator() {
    return mount(SessionNavigator, { global: { plugins: [i18n] } });
  }

  it("renders remote projects with host/distro label and connection state", () => {
    const wrapper = mountNavigator();
    const sshRow = wrapper.find('[data-project-id="ssh:build-box:/home/user/pix"]');
    expect(sshRow.exists()).toBe(true);
    expect(sshRow.find(".project-main small").text()).toBe("build-box");
    expect(sshRow.find(".project-connection").classes()).toContain("connected");

    const wslRow = wrapper.find('[data-project-id="wsl:Ubuntu:/home/user/repos/api"]');
    expect(wslRow.find(".project-main small").text()).toBe("Ubuntu");
    expect(wslRow.find(".project-connection").classes()).not.toContain("connected");

    const localRow = wrapper.find('[data-project-id^="local:"]');
    expect(localRow.find(".project-connection").exists()).toBe(false);
  });

  it("shows remote sessions in the group once it is expanded", async () => {
    const wrapper = mountNavigator();
    const sshRow = wrapper.find('[data-project-id="ssh:build-box:/home/user/pix"]');
    expect(sshRow.find(".session-item").exists()).toBe(false);
    await sshRow.find(".project-main").trigger("click");
    expect(sshRow.find(".session-item strong").text()).toBe("fix bug");
  });

  it("matches projects when searching by remote host", async () => {
    const wrapper = mountNavigator();
    const session = useSessionStore();
    session.query = "build-box";
    await wrapper.vm.$nextTick();
    const ids = session.filteredProjects.map((record) => record.id);
    expect(ids).toEqual(["ssh:build-box:/home/user/pix"]);
  });
});
