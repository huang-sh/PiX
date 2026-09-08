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

  it("copies user and assistant messages without adding a copy button to the composer", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const copy = vi.spyOn(desktop, "copy");
    const { panel } = await mountComposer(invoke);
    try {
      await panel.get(".branch-message.user .copy-button").trigger("click");
      await flushPromises();
      expect(copy).toHaveBeenLastCalledWith("first");
      expect(panel.get(".branch-message.user .copy-button").attributes("aria-label")).toBe("Copied");
      await panel.get(".final-response .copy-button").trigger("click");
      expect(copy).toHaveBeenLastCalledWith("answer");
      expect(panel.find(".prompt-composer .copy-button").exists()).toBe(false);
      const text = "  草稿 **Markdown**\nsecond line  ";
      await panel.get("textarea").setValue(text);
      expect(panel.find(".prompt-composer .copy-button").exists()).toBe(false);
      expect(panel.get<HTMLTextAreaElement>("textarea").element.value).toBe(text);
      expect(promptCalls(invoke)).toHaveLength(0);
    } finally { panel.unmount(); }
  });

  it("turns the send button into a stop control while streaming and aborts from it", async () => {
    // Pi's abort() waits for the agent to go idle before returning, so the
    // control response already carries isStreaming=false — the composer must
    // unlock from that snapshot instead of staying stuck on "Pi is working".
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      if ((input as { action?: string }).action === "abort") {
        const settled = snapshot(first, "a1");
        settled.runtime.isStreaming = false;
        return settled as never;
      }
      return {} as never;
    });
    const { session, panel } = await mountComposer(invoke);
    invoke.mockClear();
    const submit = () => panel.get<HTMLButtonElement>(".composer-submit");
    expect(submit().attributes("aria-label")).toContain("Enter to send");

    session.current!.runtime.isStreaming = true;
    await flushPromises();
    // The stop control lives on the send button, not in the panel header.
    expect(panel.find("header .panel-header button").exists()).toBe(false);
    expect(submit().attributes("disabled")).toBeUndefined();
    expect(submit().attributes("aria-label")).toBe("Stop this run");
    expect(panel.get(".prompt-composer textarea").attributes("disabled")).toBeDefined();

    await submit().trigger("click");
    expect(invoke.mock.calls.filter(([route]) => route === "agent.control").map(([, input]) => input))
      .toContainEqual({ action: "abort" });
    await flushPromises();
    expect(panel.get(".prompt-composer textarea").attributes("disabled")).toBeUndefined();
    expect(submit().attributes("aria-label")).toContain("Enter to send");
    panel.unmount();
  });

  it("stops the selected branch run from the composer button in graph sessions", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    invoke.mockClear();
    session.current!.graph = {
      id: "g1",
      revision: 1,
      runs: [{ branchId: "b1", runId: "r1", nodeId: "turn:u1", status: "running" }],
    };
    await flushPromises();

    const stop = panel.get<HTMLButtonElement>(".composer-submit");
    expect(stop.attributes("aria-label")).toBe("Stop this run");
    await stop.trigger("click");
    expect(invoke.mock.calls.filter(([route]) => route === "agent.control").map(([, input]) => input))
      .toContainEqual({ action: "branchAbort", branchId: "b1", runId: "r1" });
    panel.unmount();
  });

  it("stops from the collapsed composer while the branch runs", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    session.focusedNode = "turn:u1";
    session.current!.graph = {
      id: "g1",
      revision: 1,
      runs: [{ branchId: "b1", runId: "r1", nodeId: "turn:u1", status: "running" }],
    };
    const panel = mount(BranchContextPanel, { global: { plugins: [i18n], attachTo: document.body } });
    await flushPromises();

    // Collapsed by default: the stop control rides the collapsed composer bar.
    const stop = panel.get(".composer-collapsed-stop");
    expect(stop.attributes("aria-label")).toBe("Stop this run");
    await stop.trigger("click");
    expect(invoke.mock.calls.filter(([route]) => route === "agent.control").map(([, input]) => input))
      .toContainEqual({ action: "branchAbort", branchId: "b1", runId: "r1" });

    // The expand affordance keeps opening the composer.
    await panel.get(".composer-collapsed").trigger("click");
    expect(panel.find(".prompt-composer").exists()).toBe(true);
    panel.unmount();
  });

  it("keeps Enter from sending while the composer shows the stop control", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    invoke.mockClear();
    session.current!.graph = {
      id: "g1",
      revision: 1,
      runs: [{ branchId: "b1", runId: "r1", nodeId: "turn:u1", status: "running" }],
    };
    await flushPromises();
    const textarea = panel.get<HTMLTextAreaElement>(".prompt-composer textarea");

    await textarea.setValue("fork while running");
    await textarea.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(invoke.mock.calls.filter(([route]) => route === "agent.control")).toHaveLength(0);

    // Once the run settles the button returns to send and Enter delivers again.
    session.current!.graph!.runs[0]!.status = "idle";
    await flushPromises();
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(textarea.element.value).toBe(""));
    expect(invoke.mock.calls.filter(([route]) => route === "agent.control").map(([, input]) => input))
      .toEqual(expect.arrayContaining([expect.objectContaining({ action: "promptAt", text: "fork while running" })]));
    panel.unmount();
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

  it("sends an image-only prompt from the chat panel and shows persisted images", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { panel, session } = await mountComposer(invoke);
    session.models = [{ ...session.current!.runtime.model!, input: ["text", "image"] }];
    await flushPromises();
    invoke.mockClear();
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "paste.png", { type: "image/png" });
    await panel.get(".prompt-composer textarea").trigger("paste", { clipboardData: { files: [file] } });
    await vi.waitFor(() => expect(panel.findAll(".composer-images img")).toHaveLength(1));
    await panel.get(".composer-submit").trigger("click");
    await flushPromises();
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
    expect(promptCalls(invoke)).toContainEqual({ action: "prompt", text: "", images: [image] });
    session.current = snapshot([{ ...first[0], message: { role: "user", content: [image] } }], "u1");
    session.focusedNode = "turn:u1";
    await flushPromises();
    expect(panel.get(".branch-message.user .message-images img").attributes("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
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

  it("inherits the target thinking level while allowing a local explicit override", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const { session, panel } = await mountComposer(invoke);
    const current = snapshot(first, "a1");
    current.projection.nodes[0]!.footer = { model: current.runtime.model, thinkingLevel: "low" };
    current.projection.nodes[1]!.footer = { model: current.runtime.model, thinkingLevel: "off" };
    session.applySnapshot(current);
    session.setUserThinking("high");
    await flushPromises();
    const thinking = () => panel.get('button[aria-label="Draft thinking level"]');
    expect(thinking().text()).toContain("low");

    await thinking().trigger("click");
    await flushPromises();
    (document.querySelector('[data-thinking-level="high"]') as HTMLElement).click();
    await flushPromises();
    expect(thinking().text()).toContain("high");
    const promptAt = vi.spyOn(session, "promptAt").mockResolvedValue(undefined);
    await panel.get(".prompt-composer textarea").setValue("local override");
    await panel.get(".composer-submit").trigger("click");
    await flushPromises();
    expect(promptAt).toHaveBeenLastCalledWith("turn:u1", "local override", current.runtime.model, "high", undefined);

    session.focusedNode = "turn:u2";
    await flushPromises();
    expect(thinking().text()).toContain("off");
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
