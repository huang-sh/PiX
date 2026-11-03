import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, nextTick, watch } from "vue";
import { expect, it, vi } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";

it("updates every branch immediately, renders once per frame, and supersedes queued frames on switches/hide/settle", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const paint = async () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback(0);
    }
    await nextTick(); await flushPromises();
  };
  const pinia = createPinia(); setActivePinia(pinia);
  const layout = useLayoutStore(); layout.layout.collapsed.chat = false;
  const session = useSessionStore();
  const entries: RawSessionEntry[] = ["A", "B"].map(id => ({ id, type: "message", parentId: null,
    timestamp: "2026-01-01", message: { role: "user", content: id } }));
  session.applySnapshot({ session: { path: "s" }, entries, projection: projectSession(entries, "A"),
    runtime: { available: true, isStreaming: true }, graph: { id: "s", epoch: "e", revision: 1,
      runs: ["A", "B"].map(id => ({ branchId: id, runId: id + "1", nodeId: "turn:" + id, status: "running" })) },
  } as SessionSnapshot);
  session.focusedNode = "turn:A";
  const update = (branchId: string, text: string, type = "message_update") => session.onAgentEvent({
    graphId: "s", branchId, runId: branchId + "1", type,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  update("A", "A0"); update("B", "B0");
  const renders: string[] = [];
  const MarkdownRenderer = defineComponent({ name: "MarkdownRenderer", props: ["content", "customId"],
    setup(props) { watch(() => props.content, value => renders.push(value), { immediate: true, flush: "sync" }); },
    template: "<div>{{ content }}</div>",
  });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer, PromptComposer: true } } });
  const displayed = () => wrapper.findComponent({ name: "MarkdownRenderer" }).props("content");
  try {
    await paint(); renders.length = 0;
    for (let i = 1; i <= 100; i++) {
      update("A", `A${i}`); update("B", `B${i}`);
      expect(session.branchActivities.A!.activity!.items[0]!.text).toBe(`A${i}`);
      expect(session.branchActivities.B!.activity!.items[0]!.text).toBe(`B${i}`);
      await nextTick(); // Separate Vue ticks still share one requested paint.
    }
    expect(renders).toEqual([]);
    expect(displayed()).toBe("A0");
    await paint();
    expect(renders).toEqual(["A100"]);

    update("A", "A queued"); await nextTick();
    await session.selectNode("turn:B"); await nextTick();
    expect(displayed()).toBe("B100"); // Does not wait for a frame or another token.
    await paint(); expect(displayed()).toBe("B100");
    renders.length = 0;
    update("A", "A background"); await nextTick(); await paint();
    expect(renders).toEqual([]);
    update("B", "B queued"); await nextTick();
    await session.selectNode("turn:A"); await nextTick();
    expect(displayed()).toBe("A background");
    await paint(); expect(displayed()).toBe("A background");

    update("A", "A hidden"); layout.layout.collapsed.chat = true; await nextTick();
    expect(wrapper.findComponent({ name: "MarkdownRenderer" }).exists()).toBe(false);
    await paint();
    layout.layout.collapsed.chat = false; await nextTick();
    expect(displayed()).toBe("A hidden");
    update("A", "final content", "message_end");
    session.onAgentEvent({ type: "agent_settled", graphId: "s", branchId: "A", runId: "A1" });
    await nextTick();
    expect(displayed()).toBe("final content");
    await paint(); expect(displayed()).toBe("final content");
  } finally {
    wrapper.unmount();
    expect(frames.size).toBe(0);
    vi.unstubAllGlobals();
  }
});

it("keeps pre-steer tool output out of the steered message's live view", async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  const layout = useLayoutStore(); layout.layout.collapsed.chat = false;
  const session = useSessionStore();
  const entry = (id: string, parent: string | null, message: Record<string, unknown>): RawSessionEntry =>
    ({ id, type: "message", parentId: parent, timestamp: "2026-01-01T00:00:0" + id.length + "Z", message }) as RawSessionEntry;
  const user1 = entry("u1", null, { role: "user", content: "task one" });
  const toolA = entry("ta", "u1", { role: "toolResult", toolCallId: "a", toolName: "toolA", content: "a done" });
  const toolB = entry("tb", "ta", { role: "toolResult", toolCallId: "b", toolName: "toolB", content: "b done" });
  const toolC = entry("tc", "tb", { role: "toolResult", toolCallId: "c", toolName: "toolC", content: "c done" });
  const user2 = entry("u2", "tc", { role: "user", content: "urgent steer" });
  const entries = [user1, toolA, toolB, toolC, user2];
  session.applySnapshot({ session: { path: "s" }, entries, projection: projectSession(entries, "u2"),
    runtime: { available: true, isStreaming: true }, graph: { id: "s", epoch: "e", revision: 1,
      runs: [{ branchId: "main", runId: "r1", nodeId: "turn:u2", status: "running" }] },
  } as SessionSnapshot);
  session.focusedNode = "turn:u2";
  // Live events the renderer saw before the steer, then the steer, then tool d.
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "agent_start" });
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "tool_execution_start", toolCallId: "c", toolName: "toolC", args: {} });
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "tool_execution_end", toolCallId: "c", result: { content: [] }, isError: false });
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "urgent steer" }] } });
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "tool_execution_start", toolCallId: "d", toolName: "toolD", args: {} });
  session.onAgentEvent({ graphId: "s", branchId: "main", runId: "r1", type: "tool_execution_update", toolCallId: "d",
    partialResult: { content: [{ type: "text", text: "d running" }] } });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { PromptComposer: true } } });
  try {
    await flushPromises(); await nextTick(); await flushPromises();
    const turns = wrapper.findAll(".chat-turn");
    expect(turns.length).toBe(2);
    turns[0]!.get("details.agent-process").element.open = true; // history rows render only inside an open disclosure
    await turns[0]!.get("details.agent-process").trigger("toggle");
    await nextTick();
    expect(turns[0]!.findAll(".process-tool strong").map(row => row.text())).toEqual(["toolA", "toolB", "toolC"]);
    // The steered turn shows only the live view, which must hold post-steer tools alone.
    expect(turns[1]!.find("details.agent-process").exists()).toBe(false);
    const live = wrapper.get("details.agent-process.live");
    expect(live.findAll(".process-tool strong").map(row => row.text())).toEqual(["toolD"]);
    // The reducer kept only the post-steer items in the live activity.
    expect(session.branchActivities.main!.activity!.items.map(item => (item as { title?: string }).title)).toEqual(["toolD"]);
  } finally { wrapper.unmount(); }
});
