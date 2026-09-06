import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../src/renderer/i18n";
import TerminalView from "../../src/renderer/features/tools/TerminalView.vue";

const { terminals } = vi.hoisted(() => ({ terminals: [] as any[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    output: string[] = [];
    constructor() { terminals.push(this); }
    loadAddon() {}
    open() {}
    onData() {}
    focus() {}
    write(text: string) { this.output.push(text); }
    writeln(text: string) { this.output.push(text); }
    reset() { this.output = []; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
afterEach(() => vi.unstubAllGlobals());

it("disables a disconnected terminal and creates a fresh shell on reconnect without erasing its output", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let created = 0;
  const invoke = vi.mocked(window.pix!.invoke).mockReset();
  invoke.mockImplementation(async (route) => route === "terminal.create" ? { id: `shell-${++created}` } : {});
  const wrapper = mount(TerminalView, {
    props: { active: true, projectKey: "ssh:host:/project", connected: true },
    global: { plugins: [i18n] },
  });
  try {
    await flushPromises();
    const terminal = terminals.at(-1);
    terminal.write("previous output");
    expect(created).toBe(1);
    expect(terminal.options.disableStdin).toBe(false);
    await wrapper.setProps({ connected: false });
    expect(terminal.options.disableStdin).toBe(true);
    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(created).toBe(1);
    await wrapper.setProps({ connected: true });
    await flushPromises();
    expect(created).toBe(2);
    expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.output).toContain("previous output");
  } finally {
    wrapper.unmount();
  }
});
