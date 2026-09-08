import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { APP_COMMANDS } from "../../src/shared/commands";
import { desktop } from "../../src/renderer/api";
import { createRunCommand } from "../../src/renderer/features/commands/runCommand";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

afterEach(() => vi.restoreAllMocks());

it("keeps the command injection key stable across module reloads", async () => {
  const before = (await import("../../src/renderer/features/commands/runCommand")).runCommandKey;
  vi.resetModules();
  const after = (await import("../../src/renderer/features/commands/runCommand")).runCommandKey;
  expect(after).toBe(before);
});

it("dispatches every app command and sends dynamic commands to the selected chat branch", async () => {
  setActivePinia(createPinia());
  const session = useSessionStore();
  const layout = useLayoutStore();
  const workspace = useWorkspaceStore();
  session.current = { session: { path: "session.jsonl", name: "Test" }, projection: {
    activeNodeId: "turn:user", nodes: [{ id: "turn:user", userEntryId: "user" }],
    messages: [{ role: "assistant", text: "Answer" }],
  } } as any;
  const control = vi.spyOn(session, "control").mockResolvedValue({ path: "export.html" } as never);
  const prompt = vi.spyOn(session, "promptAt").mockResolvedValue(undefined);
  const effects = ["importSession", "refresh", "create", "loadCommands"] as const;
  for (const effect of effects) vi.spyOn(session, effect).mockResolvedValue(undefined);
  vi.spyOn(layout, "save").mockResolvedValue(undefined);
  const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue(undefined as never);
  const copy = vi.spyOn(window.pix!, "copy").mockResolvedValue(undefined);
  const deps = { requestRename: vi.fn().mockResolvedValue(undefined), requestCompact: vi.fn(), closeSettings: vi.fn() };
  let run!: (name: string) => Promise<void>;
  const wrapper = mount(defineComponent({ setup() {
    run = createRunCommand(deps).runCommand;
    return () => null;
  } }), { global: { plugins: [i18n] } });
  for (const { name } of APP_COMMANDS) {
    control.mockClear();
    await run(name);
    expect(prompt, name).not.toHaveBeenCalled();
    const action = ({ export: "exportHtml", share: "exportHtml", session: "stats", fork: "fork", clone: "clone", reload: "reload" } as Record<string, string>)[name];
    if (action) expect(control, name).toHaveBeenCalledWith(expect.objectContaining({ action }));
    if (["settings", "model", "thinking", "scoped-models", "hotkeys", "trust", "login", "logout"].includes(name))
      expect(layout.screen, name).toBe("settings");
    if (["terminal", "files", "browser"].includes(name)) expect(layout.contentSection).toBe(name);
  }
  expect(deps.requestRename).toHaveBeenCalledWith("session.jsonl", "Test");
  expect(deps.requestCompact).toHaveBeenCalledOnce();
  expect(deps.closeSettings).toHaveBeenCalled();
  expect(copy).toHaveBeenCalledWith("Answer");
  expect(invoke).toHaveBeenCalledWith("app.quit");
  expect(workspace.utilityOutput).toContain("export.html");
  for (const effect of effects) expect(session[effect], effect).toHaveBeenCalled();
  await run("review");
  expect(prompt).toHaveBeenCalledWith("turn:user", "/review");
  expect(layout.layout.collapsed.chat).toBe(false);
  control.mockRejectedValueOnce(new Error("reload failed"));
  await run("reload");
  expect(layout.notice).toEqual({ level: "error", message: "reload failed" });
  workspace.record({ type: "notice", payload: { source: "extension", message: "Full command output\nSecond line" } });
  expect(workspace.utilityOutput).toContain("Full command output\nSecond line");
  wrapper.unmount();
});
