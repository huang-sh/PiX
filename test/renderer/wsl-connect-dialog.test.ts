import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import WslConnectDialog from "../../src/renderer/features/workbench/WslConnectDialog.vue";
import { i18n } from "../../src/renderer/i18n";

function mountDialog(overrides: Record<string, unknown> = {}) {
  return mount(WslConnectDialog, {
    global: { plugins: [i18n] },
    props: {
      open: true,
      distributions: [],
      sshHosts: ["alpha", "beta", "gamma"],
      directories: [],
      directoryBusy: false,
      busy: false,
      ...overrides,
    },
  });
}

describe("remote connect wizard", () => {
  it("advances from step 1 to step 2 and renders the ssh placeholder with a literal @", async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-action="remote-next"]').trigger("click");

    expect(wrapper.find("h2").text()).toBe(i18n.global.t("remote.title2", { mode: "SSH" }));
    const placeholder = wrapper.find('[list="pix-ssh-hosts"]').attributes("placeholder");
    expect(placeholder).toContain("user@server");
  });

  it("shows a checking hint instead of claiming no hosts while detection is in flight", async () => {
    const wrapper = mountDialog({ sshHosts: [], sshLoading: true });
    await wrapper.find('[data-action="remote-next"]').trigger("click");

    expect(wrapper.find(".remote-config small").text()).toBe(
      i18n.global.t("remote.sshChecking"),
    );

    await wrapper.setProps({ sshHosts: ["alpha"], sshLoading: false });
    expect(wrapper.find(".remote-config small").text()).toBe(
      i18n.global.t("remote.sshHostsDetected"),
    );
  });

  it("emits probeWsl only when the WSL branch is chosen", async () => {
    const wrapper = mountDialog();

    expect(wrapper.emitted("probeWsl")).toBeUndefined();
    await wrapper.find('[data-action="remote-method-wsl"]').trigger("click");
    expect(wrapper.emitted("probeWsl")).toHaveLength(1);
  });

  it("shows a detecting hint until the distribution home is resolved", async () => {
    const wrapper = mountDialog({
      distributions: [{ name: "Ubuntu", home: "" }],
    });
    await wrapper.find('[data-action="remote-method-wsl"]').trigger("click");
    await wrapper.find('[data-action="remote-next"]').trigger("click");

    expect(wrapper.find("[data-wsl-distro]").exists()).toBe(true);
    expect(wrapper.find(".remote-config small").text()).toBe(
      i18n.global.t("remote.detectingHome"),
    );

    await wrapper.setProps({ distributions: [{ name: "Ubuntu", home: "/home/dev" }] });
    expect(wrapper.find(".remote-config small").text()).toBe(
      i18n.global.t("remote.initialDirectory", { path: "/home/dev" }),
    );
  });
});
