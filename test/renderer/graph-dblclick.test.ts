import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeAll, describe, expect, it } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import type { SessionSnapshot } from "../../src/shared/types";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const now = new Date().toISOString();

function snapshot(): SessionSnapshot {
  return {
    session: {
      id: "s1",
      path: "C:/tmp/s1.jsonl",
      name: "s1",
      cwd: "C:/tmp",
      created: now,
      modified: now,
      messageCount: 2,
      firstMessage: "hello",
    },
    entries: [
      { type: "user", id: "e1", parentId: null, timestamp: now, text: "hello" },
      { type: "assistant", id: "e2", parentId: "e1", timestamp: now, text: "world" },
    ],
    projection: {
      nodes: [
        {
          id: "turn-1",
          userEntryId: "e1",
          parentId: null,
          title: "hello",
          preview: "world",
          timestamp: now,
          rawEntryIds: ["e1", "e2"],
          leafEntryId: "e2",
          toolCallCount: 0,
          hasError: false,
          depth: 0,
        },
      ],
      edges: [],
      activeBranchNodeIds: ["turn-1"],
      activeBranchEntryIds: ["e1", "e2"],
      messages: [],
      leafId: "e2",
      activeNodeId: "turn-1",
    },
    runtime: {
      available: true,
      model: null,
      thinkingLevel: "off",
      availableThinkingLevels: [],
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pendingMessageCount: 0,
    },
  };
}

describe("GraphPanel node double-click opens the chat panel", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  it("expands chat when a prompt node is double-clicked", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot();
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    const node = wrapper.find(".vue-flow__node");
    expect(node.exists()).toBe(true);
    expect(layout.layout.collapsed.chat).toBe(true);

    await node.trigger("dblclick");
    await flushPromises();

    expect(layout.layout.collapsed.chat).toBe(false);
  });

  it("expands chat when the node footer strip is double-clicked", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot();
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    const footer = wrapper.find(".vue-flow__node .node-footer");
    expect(footer.exists()).toBe(true);

    await footer.trigger("dblclick");
    await flushPromises();

    expect(layout.layout.collapsed.chat).toBe(false);
  });
});
