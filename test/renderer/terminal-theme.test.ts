import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { applyTheme } from "../../src/renderer/theme";
import { themeColors } from "../../src/shared/theme";
import { i18n } from "../../src/renderer/i18n";
import TerminalView from "../../src/renderer/features/tools/TerminalView.vue";

const terminal = vi.hoisted(() => ({
  options: {} as { theme?: { background: string; foreground: string }; disableStdin?: boolean },
  buffer: "existing terminal output",
  open: vi.fn(), loadAddon: vi.fn(), onData: vi.fn(), dispose: vi.fn(), reset: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  constructor(options: typeof terminal.options) { terminal.options = options; return terminal; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
afterEach(() => { applyTheme("light"); vi.unstubAllGlobals(); });

it("recolors an existing terminal without recreating it or clearing its output", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  applyTheme("light");
  const wrapper = mount(TerminalView, { props: { active: false, projectKey: "local" }, global: { plugins: [i18n] } });
  await nextTick();
  expect(terminal.options.theme?.background).toBe(themeColors.light.surface);
  applyTheme("teal");
  await nextTick();
  expect(terminal.options.theme?.foreground).toBe(themeColors.teal.text);
  applyTheme("dark");
  await nextTick();
  expect(terminal.options.theme?.background).toBe(themeColors.dark.surface);
  expect(terminal.options.theme?.foreground).toBe(themeColors.dark.text);
  expect(terminal.buffer).toBe("existing terminal output");
  expect(terminal.open).toHaveBeenCalledTimes(1);
  expect(terminal.reset).not.toHaveBeenCalled();
  expect(terminal.dispose).not.toHaveBeenCalled();
  wrapper.unmount();
  expect(terminal.dispose).toHaveBeenCalledTimes(1);
});
