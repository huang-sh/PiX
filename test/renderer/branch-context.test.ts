import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

describe("BranchContextPanel streaming scroll", () => {
  it("keeps missing-stream runs visibly running and recovers output across node switches", async () => {
    const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const entries: RawSessionEntry[] = [
      { id: "u", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "user", content: "running prompt" } },
      { id: "a", parentId: "u", type: "message", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "saved intermediate reply" }] } },
      { id: "t", parentId: "a", type: "message", timestamp: "2026-01-01", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "saved tool output" }] } },
      { id: "other", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "user", content: "other branch" } },
    ];
    const snapshot = { session: { path: "s", id: "s" }, entries, projection: projectSession(entries, "other"),
      runtime: { available: true, isStreaming: false }, graph: { id: "s", epoch: "e", revision: 1,
        runs: [{ branchId: "A", runId: "a1", nodeId: "turn:u", status: "running" }] } } as SessionSnapshot;
    session.applySnapshot(snapshot); session.focusedNode = "turn:u";
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true, PromptComposer: true } } });
    const scope = { graphId: "s", branchId: "A", runId: "a1" };
    try {
      expect(wrapper.text()).not.toContain("Worked");
      expect(wrapper.find('.process-item.waiting[role="status"]').text()).toContain("Running");
      expect(wrapper.find('.final-response').exists()).toBe(false);
      await session.selectNode("turn:other"); await flushPromises();
      session.onAgentEvent({ ...scope, type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "recovered live output" }] } });
      await session.selectNode("turn:u"); await flushPromises();
      expect(wrapper.find('.agent-process.live').exists()).toBe(true);
      const contents = wrapper.findAllComponents({ name: "MarkdownRenderer" }).map(c => c.props('content'));
      expect(contents).toContain("saved intermediate reply");
      expect(contents).toContain("recovered live output");
      const settled = { ...snapshot, graph: { ...snapshot.graph!, revision: 2,
        runs: [{ ...snapshot.graph!.runs[0]!, status: "idle" as const }] } };
      session.applySnapshot(settled); await flushPromises();
      expect(wrapper.find('.agent-process.live').exists()).toBe(false);
      expect(wrapper.find('.final-response').exists()).toBe(true);
      expect(wrapper.text()).toContain("Worked");
    } finally { wrapper.unmount(); }
  });
  it("does not render hidden live output and shows the latest state when reopened", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const layout = useLayoutStore();
    const session = useSessionStore();
    session.onAgentEvent({ type: "agent_start" });
    session.onAgentEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "first" }] } });
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });
    expect(wrapper.find('.agent-process.live').exists()).toBe(false);
    session.onAgentEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "latest" }] } });
    await flushPromises();
    expect(wrapper.find('.agent-process.live').exists()).toBe(false);
    layout.layout.collapsed.chat = false; await flushPromises();
    expect(wrapper.find('.agent-process.live').exists()).toBe(true);
    expect(wrapper.findComponent({ name: "MarkdownRenderer" }).props('content')).toBe('latest');
    layout.layout.collapsed.chat = true; await flushPromises();
    expect(wrapper.find('.agent-process.live').exists()).toBe(false);
    wrapper.unmount();
  });
  it("bounds the live DOM, expands on demand, and retains full activity and tool results", async () => {
    const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    session.onAgentEvent({ type: "agent_start" });
    session.onAgentEvent({ type: "tool_execution_start", toolCallId: "read", toolName: "read" });
    session.onAgentEvent({ type: "tool_execution_end", toolCallId: "read", result: { content: [{ text: "tool".repeat(20000) }] } });
    session.onAgentEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(100000) }] } });
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });
    expect(wrapper.find('.process-tool pre').exists()).toBe(false);
    expect(wrapper.findComponent({ name: "MarkdownRenderer" }).props('content')).toHaveLength(32768);
    expect(session.activity!.items.at(-1)!.text).toHaveLength(100000);
    await wrapper.get('.agent-process.live .assistant .copy-button').trigger('click');
    expect(vi.mocked(window.pix!.copy!)).toHaveBeenLastCalledWith("a".repeat(100000));
    await wrapper.get('.agent-process.live .load-earlier-turns').trigger('click');
    expect(wrapper.findComponent({ name: "MarkdownRenderer" }).props('content')).toHaveLength(65536);
    const tool = wrapper.get('.process-tool');
    (tool.element as HTMLDetailsElement).open = true; await tool.trigger('toggle');
    expect(wrapper.get('.process-tool pre').text()).toHaveLength(80000);
    wrapper.unmount();
  });
  it("stops following output after the user scrolls up", async () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    session.onAgentEvent({ type: "agent_start" });
    session.onAgentEvent({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    });
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n] } });
    const messages = wrapper.get(".branch-messages").element as HTMLElement;
    Object.defineProperties(messages, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 500 },
    });

    messages.scrollTop = 400;
    await wrapper.get(".branch-messages").trigger("scroll");
    session.onAgentEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
    });
    await flushPromises();

    expect(messages.scrollTop).toBe(400);
  });

  it("resumes following when a node submits a new prompt", async () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n] } });
    const messages = wrapper.get(".branch-messages").element as HTMLElement;
    Object.defineProperties(messages, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 500 },
    });

    messages.scrollTop = 100;
    await wrapper.get(".branch-messages").trigger("scroll");
    session.pendingPrompt = {
      message: {
        entryId: "pending:1",
        turnId: "pending:1",
        role: "user",
        text: "new question",
        timestamp: new Date().toISOString(),
      },
      knownEntryIds: [],
      targetNodeId: null,
    };
    await flushPromises();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    expect(messages.scrollTop).toBe(1000);
  });
});

describe("BranchContextPanel content-growth follow", () => {
  // Typewriter/smooth-streaming markdown grows the DOM across several frames
  // after each store event; only content-height observation (not store events)
  // can keep the view pinned to the live output. Drive the observer directly.
  class ResizeObserverStub {
    static instances: ResizeObserverStub[] = [];
    callback: ResizeObserverCallback;
    targets = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      ResizeObserverStub.instances.push(this);
    }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }

  function grow(wrapper: ReturnType<typeof mount>) {
    const inner = wrapper.get(".branch-messages-inner").element;
    for (const observer of ResizeObserverStub.instances)
      if (observer.targets.has(inner))
        observer.callback([], observer as unknown as ResizeObserver);
  }

  async function settle() {
    await flushPromises();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }

  beforeEach(() => {
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mountStreaming() {
    const pinia = createPinia(); setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    session.onAgentEvent({ type: "agent_start" });
    session.onAgentEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "stream" }] } });
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });
    const messages = wrapper.get(".branch-messages").element as HTMLElement;
    let height = 1000;
    Object.defineProperties(messages, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 500 },
    });
    return { wrapper, messages, growHeight: (value: number) => { height = value; } };
  }

  it("re-pins the bottom as streaming content grows the DOM", async () => {
    const { wrapper, messages, growHeight } = await mountStreaming();
    growHeight(1000); grow(wrapper); await settle();
    expect(messages.scrollTop).toBe(1000); // pinned at the old bottom after mount
    growHeight(1400); grow(wrapper); await settle();
    expect(messages.scrollTop).toBe(1400); // followed the growth to the new bottom
    wrapper.unmount();
  });

  it("stops following content growth after the user scrolls up", async () => {
    const { wrapper, messages, growHeight } = await mountStreaming();
    await settle();
    messages.scrollTop = 100;
    await wrapper.get(".branch-messages").trigger("scroll");
    growHeight(1600); grow(wrapper); await settle();
    expect(messages.scrollTop).toBe(100);
    wrapper.unmount();
  });

  it("keeps following when a programmatic scroll event arrives after more content", async () => {
    const { wrapper, messages, growHeight } = await mountStreaming();
    growHeight(1000); grow(wrapper); await settle();
    expect(messages.scrollTop).toBe(1000);
    growHeight(1400);
    await wrapper.get(".branch-messages").trigger("scroll");
    grow(wrapper); await settle();
    expect(messages.scrollTop).toBe(1400);
    wrapper.unmount();
  });
});

describe("BranchContextPanel model failures", () => {
  const failure = '401: {"message":"Authentication Fails, Your api key: ****20e8 is invalid","type":"authentication_error"}';

  it("renders a saved failed reply as an error bubble", () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const entries: RawSessionEntry[] = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-03T17:31:08Z", message: { role: "user", content: "hello" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-09-03T17:31:09Z",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: failure },
      },
    ];
    session.current = {
      session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: 2, firstMessage: "" },
      entries,
      projection: projectSession(entries, "a1"),
      runtime: { isStreaming: false },
    } as unknown as SessionSnapshot;

    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n] } });

    expect(wrapper.get(".error-response .error-message").text())
      .toBe("401: Authentication Fails, Your api key: ****20e8 is invalid");
    expect(wrapper.find(".final-response").exists()).toBe(false);
  });

  it("surfaces live failures while the agent is streaming", async () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    session.onAgentEvent({ type: "agent_start" });
    session.onAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
    session.onAgentEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: failure },
    });
    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.get(".process-item.error").text())
      .toBe("401: Authentication Fails, Your api key: ****20e8 is invalid");
  });

  it("renders a failed final reply even when earlier replies had text", () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const entries: RawSessionEntry[] = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-03T17:31:08Z", message: { role: "user", content: "finish it" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-09-03T17:31:09Z",
        message: { role: "assistant", content: [{ type: "text", text: "Let me add an end-to-end check" }] },
      },
      {
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-09-03T17:31:11Z",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: failure },
      },
    ];
    session.current = {
      session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: 3, firstMessage: "" },
      entries,
      projection: projectSession(entries, "a2"),
      runtime: { isStreaming: false },
    } as unknown as SessionSnapshot;

    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });

    // Earlier text in the turn belongs to the process, never to the answer.
    expect(wrapper.get(".error-response .error-message").text())
      .toBe("401: Authentication Fails, Your api key: ****20e8 is invalid");
    expect(wrapper.find(".final-response").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows a reply cut off mid-stream together with its failure", () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const entries: RawSessionEntry[] = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-03T17:31:08Z", message: { role: "user", content: "finish it" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-09-03T17:31:09Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half an answer" }],
          stopReason: "error",
          errorMessage: "Connection closed by proxy server before the response completed",
        },
      },
    ];
    session.current = {
      session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: 2, firstMessage: "" },
      entries,
      projection: projectSession(entries, "a1"),
      runtime: { isStreaming: false },
    } as unknown as SessionSnapshot;

    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });

    // A truncated partial is progress, not the turn's answer.
    expect(wrapper.get(".error-response .error-message").text())
      .toBe("Connection closed by proxy server before the response completed");
    expect(wrapper.get(".progress-response").findComponent({ name: "MarkdownRenderer" }).props("content"))
      .toBe("half an answer");
    expect(wrapper.find(".final-response").exists()).toBe(false);
    wrapper.unmount();
  });
});
describe("BranchContextPanel process summary", () => {
  it("shows a disclosure chevron instead of the brain icon on the worked summary", () => {
    const pinia = createPinia();
    setActivePinia(pinia); useLayoutStore().layout.collapsed.chat = false;
    const session = useSessionStore();
    const entries: RawSessionEntry[] = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-03T17:31:08Z", message: { role: "user", content: "run it" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-09-03T17:31:09Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking\nTool: read" },
            { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
          ],
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-09-03T17:31:10Z",
        message: { role: "toolResult", toolCallId: "call-read", toolName: "read", content: "ok" },
      },
      {
        type: "message",
        id: "a2",
        parentId: "r1",
        timestamp: "2026-09-03T17:31:11Z",
        message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
      },
    ];
    session.current = {
      session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: 4, firstMessage: "" },
      entries,
      projection: projectSession(entries, "a2"),
      runtime: { isStreaming: false },
    } as unknown as SessionSnapshot;

    const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n] } });

    const summary = wrapper.get(".agent-process:not(.live) > summary");
    expect(summary.find(".lucide-brain").exists()).toBe(false);
    expect(summary.find(".lucide-chevron-right").exists()).toBe(true);
    expect(summary.text()).toContain("Worked");
  });
});
