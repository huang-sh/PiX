import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { ProjectGroup, ProjectInfo, RawSessionEntry, SessionSnapshot, SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";

const first: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-09-02T10:00:00Z", message: { role: "user", content: "first" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-02T10:00:01Z", message: { role: "assistant", content: "answer" } },
  { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-02T10:00:02Z", message: { role: "user", content: "second" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-02T10:00:03Z", message: { role: "assistant", content: "answer two" } },
];
const project: ProjectInfo = { name: "PiX", path: "D:/dev/PiX" };

function snapshot(entries: RawSessionEntry[], leafId: string): SessionSnapshot {
  return {
    session: {
      id: "session",
      path: "session.jsonl",
      cwd: ".",
      created: "2026-09-02T10:00:00Z",
      modified: "2026-09-02T10:00:00Z",
      messageCount: entries.length,
      firstMessage: "first",
    },
    entries,
    projection: projectSession(entries, leafId),
    runtime: {
      isStreaming: false,
      available: true,
      model: { provider: "openai", id: "gpt-5.4", reasoning: true },
      thinkingLevel: "high",
    } as SessionSnapshot["runtime"],
  };
}

function hydrate(session: ReturnType<typeof useSessionStore>, current: SessionSnapshot) {
  const projects: ProjectGroup[] = [{
    id: `local:${project.path}`,
    project,
    sessions: [],
    lastOpened: "2026-09-03T00:00:00Z",
    connected: true,
  }];
  session.hydrate(project, [], projects, current);
}

async function mountComposer(invoke: ReturnType<typeof vi.spyOn>) {
  const session = useSessionStore();
  const current = snapshot(first, "a1");
  hydrate(session, current);
  session.focusedNode = "turn:u1";
  const panel = mount(BranchContextPanel, { global: { plugins: [i18n], attachTo: document.body } });

  // Collapsed by default: only the slim toggle bar, no editor.
  expect(panel.find(".composer-collapsed").exists()).toBe(true);
  expect(panel.find(".prompt-composer").exists()).toBe(false);
  await panel.get(".composer-collapsed").trigger("click");
  expect(panel.find(".prompt-composer").exists()).toBe(true);

  return { session, panel, invoke };
}

function promptCalls(invoke: ReturnType<typeof vi.spyOn>) {
  return invoke.mock.calls
    .filter(([route, input]) => route === "agent.control" && (input as { action?: string }).action === "prompt")
    .map(([, input]) => input);
}

describe("chat panel composer", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("starts collapsed, expands, and submits through the same pipeline as typing in a node", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { panel } = await mountComposer(invoke);

    await panel.get(".prompt-composer textarea").setValue("continue from chat");
    const submit = panel.get<HTMLButtonElement>(".composer-submit");
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");
    await vi.waitFor(() => expect(panel.get<HTMLTextAreaElement>(".prompt-composer textarea").element.value).toBe(""));

    expect(invoke.mock.calls.filter(([route]) => route === "agent.control").map(([, input]) => input))
      .toContainEqual({ action: "prompt", text: "continue from chat" });
    panel.unmount();
  });

  it("sends on Enter and reserves Shift+Enter for newlines", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { panel } = await mountComposer(invoke);
    // desktop.invoke is the preloaded window.pix mock, so spy history survives
    // restoreAllMocks between tests; reset it so call counts stay per-test.
    invoke.mockClear();
    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");

    await textarea.setValue("via enter");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(textarea.element.value).toBe(""));
    expect(promptCalls(invoke)).toContainEqual({ action: "prompt", text: "via enter" });
    await flushPromises();

    await textarea.setValue("line one");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });
    await flushPromises();
    expect(textarea.element.value).toBe("line one");
    expect(promptCalls(invoke)).toHaveLength(1);
    panel.unmount();
  });

  it("does not send when Enter confirms an IME composition", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { panel } = await mountComposer(invoke);
    invoke.mockClear();
    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");

    await textarea.setValue("中文输入");
    await textarea.trigger("keydown", { key: "Enter", isComposing: true });
    await flushPromises();
    expect(textarea.element.value).toBe("中文输入");
    expect(promptCalls(invoke)).toHaveLength(0);
    panel.unmount();
  });

  it("moves sending to Ctrl+Enter when the enterToSend setting is off", async () => {
    useLayoutStore().settings = { app: { enterToSend: false } } as unknown as SettingsBundle;
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { panel } = await mountComposer(invoke);
    invoke.mockClear();
    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");

    await textarea.setValue("controlled");
    await textarea.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(textarea.element.value).toBe("controlled");
    expect(promptCalls(invoke)).toHaveLength(0);

    await textarea.trigger("keydown", { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(textarea.element.value).toBe(""));
    expect(promptCalls(invoke)).toContainEqual({ action: "prompt", text: "controlled" });
    panel.unmount();
  });

  it("clears the editor as soon as delivery starts", async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      if ((input as { action?: string }).action === "prompt") await delivery;
      return {} as never;
    });
    const { panel } = await mountComposer(invoke);

    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");
    await textarea.setValue("send now");
    void panel.get(".composer-submit").trigger("click");
    await vi.waitFor(() => expect(textarea.element.value).toBe(""));

    finishDelivery();
    panel.unmount();
  });

  it("keeps the typed text when delivery fails", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      if ((input as { action?: string }).action === "prompt") throw new Error("send failed");
      return {} as never;
    });
    const { panel } = await mountComposer(invoke);

    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");
    await textarea.setValue("retry me");
    await panel.get(".composer-submit").trigger("click");
    await vi.waitFor(() => expect(textarea.element.value).toBe("retry me"));
    panel.unmount();
  });

  it("keeps an explicitly picked thinking level across target changes", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    session.models = [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true }];

    await panel.get('button[aria-label="Draft thinking level"]').trigger("click");
    await flushPromises();
    (document.querySelector('[data-thinking-level="low"]') as HTMLElement).click();
    await flushPromises();
    expect(session.userThinking).toBe("low");
    expect(panel.get('button[aria-label="Draft thinking level"]').text()).toContain("low");

    // Switching the branch target must not drop the user's pick.
    session.focusedNode = "turn:u2";
    await flushPromises();
    expect(session.userThinking).toBe("low");
    expect(panel.get('button[aria-label="Draft thinking level"]').text()).toContain("low");
    panel.unmount();
  });

  it("resets the sticky thinking level when the session changes", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    session.setUserThinking("low");
    expect(session.userThinking).toBe("low");

    const other = snapshot(first, "a2");
    other.session.path = "another.jsonl";
    session.applySnapshot(other);
    expect(session.userThinking).toBeUndefined();
    panel.unmount();
  });

  it("model-driven clamps show locally without polluting the sticky level", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    session.setUserThinking("high");
    session.models = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      { provider: "xai", id: "grok-fast", name: "Grok Fast", reasoning: false },
    ];

    await panel.get(".node-model-select").trigger("click");
    await flushPromises();
    (document.querySelector('[data-model-provider="xai"]') as HTMLElement).click();
    await flushPromises();
    (document.querySelector('[data-model-id="grok-fast"]') as HTMLElement).click();
    await flushPromises();

    expect(panel.get('button[aria-label="Draft thinking level"]').text()).toContain("off");
    expect(session.userThinking).toBe("high");
    panel.unmount();
  });

});
