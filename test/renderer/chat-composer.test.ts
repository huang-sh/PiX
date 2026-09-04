import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { ProjectGroup, ProjectInfo, RawSessionEntry, SessionSnapshot } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";

const first: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-09-02T10:00:00Z", message: { role: "user", content: "first" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-02T10:00:01Z", message: { role: "assistant", content: "answer" } },
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

});
