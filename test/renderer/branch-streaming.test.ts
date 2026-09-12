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
  // The turn's user prompt also renders as markdown; the streamed assistant
  // reply is the last renderer in the turn.
  const displayed = () => wrapper.findAllComponents({ name: "MarkdownRenderer" }).at(-1)!.props("content");
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
    // History stays mounted and hidden; what collapse must tear down at once
    // is the live streaming view.
    expect(wrapper.find("details.agent-process.live").exists()).toBe(false);
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
