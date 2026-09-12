import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, nextTick, onMounted } from "vue";
import { expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { projectSession } from "../../src/shared/session";
import { i18n } from "../../src/renderer/i18n";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";
import { createBranchMessageCache } from "../../src/renderer/lib/session-view";

function snapshot(count: number, chain = false): SessionSnapshot {
  const entries: RawSessionEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({ type: "message", id: `u${i}`, parentId: chain && i ? `a${i-1}` : null, timestamp: "2026-01-01", message: { role: "user", content: `prompt ${i}` } });
    entries.push({ type: "message", id: `t${i}`, parentId: `u${i}`, timestamp: "2026-01-01", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tool output\n".repeat(100) }] } });
    entries.push({ type: "message", id: `a${i}`, parentId: `t${i}`, timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } });
  }
  return {
    session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "prompt" },
    entries, projection: projectSession(entries, `a${count-1}`),
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
    graph: { id: "s.jsonl", epoch: "e", revision: 1, runs: [] },
  };
}

it.each([200, 1000])("keeps real Vue Flow's node input stable when selecting in a %i-node graph", async (count) => {
  const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
  const session = useSessionStore();
  const initial = snapshot(count);
  initial.graph!.runs = [{ branchId: "background", runId: "bg", nodeId: "turn:u2", status: "running" }];
  session.applySnapshot(initial);
  useLayoutStore().panelsSettled = true;
  session.focusedNode = "turn:u0";
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(2400);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
  const wrapper = mount(GraphPanel, { attachTo: document.body, global: {
    plugins: [pinia, i18n], stubs: { PromptNode: true, DraftNode: true, MiniMap: true, GraphOverview: true },
  } });
  await flushPromises();
  const graph = (wrapper.vm as any).$.setupState;
  try {
    await vi.waitFor(() => expect(graph.booted).toBe(true));
    const before = graph.nodes;
    const edges = graph.edges;
    const setNodes = vi.spyOn(graph.flow, "setNodes");
    const stringify = JSON.stringify;
    let cards = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(((value: any, ...args: any[]) => {
      if (value?.node?.id && "onCompose" in value) cards++;
      return (stringify as any)(value, ...args);
    }) as typeof JSON.stringify);
    const card = (id: string) => wrapper.findAllComponents({ name: "PromptNode" }).find(node => node.props("id") === id)!;
    expect(card("turn:u0").props("selected")).toBe(true);
    await session.selectNode("turn:u1"); await nextTick();
    expect(card("turn:u0").props("selected")).toBe(false);
    expect(card("turn:u1").props("selected")).toBe(true);
    expect(graph.nodes === before).toBe(true);
    expect(graph.edges).toBe(edges);
    await session.selectNode("turn:u0"); await nextTick();
    expect(card("turn:u0").props("selected")).toBe(true);
    expect(card("turn:u1").props("selected")).toBe(false);
    expect(setNodes).not.toHaveBeenCalled();
    expect(cards).toBe(0);
    // IPC delivers fresh objects even when only a background run's state changes.
    const background = snapshot(count);
    background.graph!.revision = 2;
    background.graph!.runs = [{ branchId: "background", runId: "bg", nodeId: "turn:u2", status: "running" }];
    session.applySnapshot(background); await nextTick();
    expect(graph.nodes).toBe(before);
    expect(setNodes).not.toHaveBeenCalled();
    expect(cards).toBe(0);
    const changed = snapshot(count); changed.graph!.revision = 3;
    changed.graph!.runs = background.graph!.runs;
    changed.projection.nodes[2]!.running = true;
    session.applySnapshot(changed); await nextTick();
    expect(graph.nodes[0]).toBe(before[0]);
    expect(graph.nodes[2].data.running).toBe(true);
    expect(graph.edges).toBe(edges);
  } finally { wrapper.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it("projects only the requested history window and reuses it across branch switches and background snapshots", () => {
  const data = snapshot(2000, true);
  const cached = createBranchMessageCache();
  const old = data.entries[2]!.message as { content: unknown };
  Object.defineProperty(old, "content", { get() { throw new Error("Older message text must not be processed"); }, configurable: true });
  const first = cached(data.entries, "a1999", 40);
  expect(first.messages.filter(message => message.role === "user")).toHaveLength(40);
  expect(first.messages[0]?.text).toBe("prompt 1960");
  expect(first.hasEarlier).toBe(true);
  cached(data.entries, "a1998", 40);
  expect(cached(data.entries, "a1999", 40)).toBe(first);
  Object.defineProperty(old, "content", { value: [{ type: "text", text: "answer 0" }], configurable: true });
  const fresh = structuredClone(data.entries);
  fresh[2]!.message = { role: "assistant", content: [{ type: "text", text: "older reply changed" }] };
  expect(cached(fresh, "a1999", 40)).toBe(first);
  const changed = structuredClone(fresh);
  changed.at(-1)!.message = { role: "assistant", content: [{ type: "text", text: "updated visible reply" }] };
  const updated = cached(changed, "a1999", 40);
  expect(updated).not.toBe(first);
  expect(updated.messages.at(-1)?.text).toBe("updated visible reply");
  expect(cached(fresh, "a39", 40).hasEarlier).toBe(false);
});

it("restores each branch's history page, expanded output and scroll position", async () => {
  const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
  const session = useSessionStore(); session.applySnapshot(snapshot(100, true));
  let markdownMounts = 0;
  const MarkdownRenderer = defineComponent({ name: "MarkdownRenderer", props: ["content", "customId"],
    setup() { onMounted(() => markdownMounts++); }, template: "<div>{{ content }}</div>" });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer, PromptComposer: true } } });
  try {
    await flushPromises();
    const root = wrapper.get(".branch-messages").element as HTMLElement;
    Object.defineProperties(root, { scrollHeight: { value: 5000, configurable: true }, clientHeight: { value: 500, configurable: true } });
    await wrapper.get(".load-earlier-turns").trigger("click");
    const details = wrapper.get("details.agent-process");
    (details.element as HTMLDetailsElement).open = true; await details.trigger("toggle");
    root.scrollTop = 123; await wrapper.get(".branch-messages").trigger("scroll");
    await session.selectNode("turn:u98"); await flushPromises();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);
    const mountsBeforeReturning = markdownMounts;
    root.scrollTop = 456; await wrapper.get(".branch-messages").trigger("scroll");
    await session.selectNode("turn:u99"); await flushPromises();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(80);
    expect(wrapper.find(".process-tool pre").exists()).toBe(true);
    expect(root.scrollTop).toBe(123);
    expect(markdownMounts).toBe(mountsBeforeReturning);
    await session.selectNode("turn:u98"); await flushPromises();
    expect(root.scrollTop).toBe(456);
    const restarted = snapshot(100, true); restarted.graph!.epoch = "new host";
    session.applySnapshot(restarted); await flushPromises();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);
    expect(root.scrollTop).toBe(5000);
  } finally { wrapper.unmount(); }
});

it("loads older turns and collapsed processes on demand without losing history", async () => {
  const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
  const session = useSessionStore(); session.applySnapshot(snapshot(100, true));
  const split = String.prototype.split;
  let cleanedOutputs = 0;
  const spy = vi.spyOn(String.prototype, "split").mockImplementation(function(this: string, ...args: any[]) {
    if (String(this).startsWith("tool output\n")) cleanedOutputs++;
    return (split as any).apply(this, args);
  });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true, PromptComposer: true } } });
  try {
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);
    expect(wrapper.findAll(".process-tool pre")).toHaveLength(0);
    // Each windowed turn mounts two renderers: the user prompt and the reply.
    expect(wrapper.findAll("markdown-renderer-stub")).toHaveLength(80);
    expect(cleanedOutputs).toBe(0);
    const disclosure = wrapper.find("details.agent-process");
    (disclosure.element as HTMLDetailsElement).open = true;
    await disclosure.trigger("toggle");
    expect(wrapper.findAll(".process-tool pre")).toHaveLength(1);
    expect(cleanedOutputs).toBe(1);
    // Other branches' snapshots must not collapse what the user is inspecting.
    const next = snapshot(100, true); next.graph!.revision = 2;
    session.applySnapshot(next); await nextTick();
    expect(wrapper.findAll(".process-tool pre")).toHaveLength(1);
    (disclosure.element as HTMLDetailsElement).open = false;
    await disclosure.trigger("toggle");
    expect(wrapper.findAll(".process-tool pre")).toHaveLength(0);
    const beforePaging = cleanedOutputs;
    await wrapper.get(".load-earlier-turns").trigger("click");
    expect(wrapper.findAll(".chat-turn")).toHaveLength(80);
    await wrapper.get(".load-earlier-turns").trigger("click");
    expect(wrapper.findAll(".chat-turn")).toHaveLength(100);
    expect(wrapper.find(".load-earlier-turns").exists()).toBe(false);
    // The renderer stub hides its content prop, so assert prompts through props.
    const rendersPrompt = (text: string) =>
      wrapper.findAllComponents({ name: "MarkdownRenderer" }).some((c) => c.props("content") === text);
    expect(rendersPrompt("prompt 0")).toBe(true);
    await session.selectNode("turn:u98"); await nextTick();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);
    expect(rendersPrompt("prompt 98")).toBe(true);
    expect(cleanedOutputs).toBe(beforePaging);
  } finally { spy.mockRestore(); wrapper.unmount(); }
});

it("reuses expanded history during streaming and refreshes it when its content changes", async () => {
  const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
  const session = useSessionStore();
  const current = snapshot(100, true);
  current.graph!.runs = [{ branchId: "main", runId: "run", nodeId: "turn:u99", status: "running" }];
  current.runtime.isStreaming = true;
  session.applySnapshot(current); session.focusedNode = "turn:u99";
  const scope = { graphId: "s.jsonl", branchId: "main", runId: "run" };
  session.onAgentEvent({ ...scope, type: "agent_start" });
  session.onAgentEvent({ ...scope, type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "live" }] } });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true, PromptComposer: true } } });
  const split = String.prototype.split;
  let cleaned = 0;
  const spy = vi.spyOn(String.prototype, "split").mockImplementation(function(this: string, ...args: any[]) {
    if (String(this).startsWith("tool output\n")) cleaned++;
    return (split as any).apply(this, args);
  });
  try {
    const details = wrapper.find("details.agent-process:not(.live)");
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle"); await flushPromises();
    expect(cleaned).toBe(1);
    const messages = session.messageWindow(40).messages;
    for (let i = 0; i < 10; i++) {
      session.onAgentEvent({ ...scope, type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "live".repeat(i + 2) }] } });
      await nextTick();
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await nextTick();
    expect(session.messageWindow(40).messages).toBe(messages);
    expect(cleaned).toBe(1);
    expect(wrapper.findAll(".process-tool pre")).toHaveLength(1);
    expect(wrapper.findAllComponents({ name: "MarkdownRenderer" }).at(-1)!.props("content")).toBe("live".repeat(11));

    const updated = snapshot(100, true);
    updated.graph = { ...current.graph!, revision: 2 };
    updated.runtime.isStreaming = true;
    updated.entries.find(entry => entry.id === "t60")!.message = {
      role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tool output\nchanged payload\nTool: bash" }],
    };
    updated.projection = projectSession(updated.entries, "a99");
    session.applySnapshot(updated); await nextTick();
    expect(wrapper.get(".process-tool pre").text()).toBe("tool output\nchanged payload");
    expect(cleaned).toBe(2);
    (details.element as HTMLDetailsElement).open = false;
    await details.trigger("toggle");
    expect(wrapper.find(".process-tool pre").exists()).toBe(false);
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    expect(wrapper.get(".process-tool pre").text()).toContain("changed payload");
  } finally { spy.mockRestore(); wrapper.unmount(); }
});
