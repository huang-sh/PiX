import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import Workbench from "../../src/renderer/features/workbench/Workbench.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { desktop } from "../../src/renderer/api";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot, SettingsBundle } from "../../src/shared/types";

const settings = {
  app: {
    language: "system",
    theme: "system",
    density: "comfortable",
    confirmDestructiveActions: true,
    browserHome: "https://pi.dev",
    openLastSessionOnStartup: false,
    enterToSend: true,
    openLinksInApp: true,
    closeToTray: true,
    canvasDotGrid: true,
    canvasDotGridSpacing: 24,
    canvasDotGridDotSize: 4,
  },
  piGlobal: {},
  piProject: {},
  effective: {},
  paths: { app: "", global: "", project: "" },
} satisfies SettingsBundle;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const now = new Date().toISOString();

// Two branches sharing the first turn: turn:u1 is the common ancestor,
// turn:u2 and turn:u3 are sibling forks.
const entries: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: now, message: { role: "user", content: "shared prompt" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: now, message: { role: "assistant", content: "shared reply" } },
  { type: "message", id: "u2", parentId: "a1", timestamp: now, message: { role: "user", content: "left prompt" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: now, message: { role: "assistant", content: "left reply" } },
  { type: "message", id: "u3", parentId: "a1", timestamp: now, message: { role: "user", content: "right prompt" } },
  { type: "message", id: "a3", parentId: "u3", timestamp: now, message: { role: "assistant", content: "right reply" } },
];
// The continuation turn a pinned panel on turn:u3 submits.
const continued: RawSessionEntry[] = [...entries,
  { type: "message", id: "u4", parentId: "a3", timestamp: now, message: { role: "user", content: "fourth prompt" } },
  { type: "message", id: "a4", parentId: "u4", timestamp: now, message: { role: "assistant", content: "fourth reply" } },
];

function snapshot(leaf: string, path = "s.jsonl"): SessionSnapshot {
  return {
    session: { id: "s1", path, cwd: ".", created: now, modified: now, messageCount: entries.length, firstMessage: "shared prompt" },
    entries,
    projection: projectSession(entries, leaf),
    runtime: { available: true, isStreaming: false },
    graph: { id: "g1", epoch: "e1", revision: 1, runs: [] },
  } as unknown as SessionSnapshot;
}

describe("pinned chat columns", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    setActivePinia(createPinia());
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  it("pins at most two nodes and warns when the slots are full", async () => {
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    await layout.openChatColumn("turn:u2");
    // Pinning widens the slot so equal columns stay readable.
    expect(layout.layout.widths.chat).toBeGreaterThanOrEqual(640);
    await layout.openChatColumn("turn:u3");
    expect(layout.chatColumns).toEqual(["turn:u2", "turn:u3"]);
    expect(layout.layout.widths.chat).toBeGreaterThanOrEqual(960);
    expect(layout.layout.collapsed.chat).toBe(false);

    // Re-pinning an open node only expands the panel.
    await layout.openChatColumn("turn:u2");
    expect(layout.chatColumns).toEqual(["turn:u2", "turn:u3"]);

    await layout.openChatColumn("turn:u1");
    expect(layout.chatColumns).toEqual(["turn:u2", "turn:u3"]);
    expect(layout.notice?.message).toBe(i18n.global.t("branch.panelLimit"));

    // Closing the last pin restores the width the slot had before pinning.
    layout.closeChatColumn("turn:u2");
    expect(layout.chatColumns).toEqual(["turn:u3"]);
    layout.closeChatColumn("turn:u3");
    expect(layout.layout.widths.chat).toBe(356);

    // An already-wide slot keeps the user's width, pins and all.
    layout.layout.widths.chat = 1200;
    await layout.openChatColumn("turn:u2");
    await layout.openChatColumn("turn:u3");
    expect(layout.layout.widths.chat).toBe(1200);

    // A manual resize between pinning and closing wins over the restore.
    layout.layout.widths.chat = 700;
    layout.closeChatColumn("turn:u2");
    layout.closeChatColumn("turn:u3");
    expect(layout.layout.widths.chat).toBe(700);

    // Column state is session UI state, never part of the persisted layout.
    const saved = vi.mocked(desktop.invoke).mock.calls.at(-1)!.at(1) as { layout: Record<string, unknown> };
    expect(saved.layout).not.toHaveProperty("chatColumns");
  });

  it("resolves each column's message window independently of the focus", () => {
    const session = useSessionStore();
    session.applySnapshot(snapshot("a2"));
    session.focusedNode = "turn:u2";

    expect(session.messageWindow(40).messages.map((message) => message.text)).toContain("left reply");
    expect(session.messageWindowFor("turn:u3", 40).messages.map((message) => message.text)).toContain("right reply");
    expect(session.messageWindowFor("turn:u3", 40).messages.some((message) => message.text === "left reply")).toBe(false);
    expect(session.nodeFor("turn:u3")?.title).toContain("right prompt");
  });

  it("binds a pinned panel to its node while the primary panel follows the focus", async () => {
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = false;
    const session = useSessionStore();
    session.applySnapshot(snapshot("a2"));
    session.focusedNode = "turn:u2";
    layout.chatColumns = ["turn:u3"];

    const stubs = { MarkdownRenderer: true, PromptComposer: true };
    const pinned = mount(BranchContextPanel, { props: { nodeId: "turn:u3" }, global: { plugins: [i18n], stubs } });
    const primary = mount(BranchContextPanel, { global: { plugins: [i18n], stubs } });

    expect(pinned.find(".branch-title small").text()).toContain("right prompt");
    expect(pinned.find('[data-action="chat-column-close"]').exists()).toBe(true);
    // The primary column closes the whole panel, not a single column.
    expect(primary.find('[data-action="chat-column-close"]').exists()).toBe(false);
    expect(primary.find('[data-action="chat-panel-close"]').exists()).toBe(true);

    // Moving the focus re-renders the primary column but leaves the pinned one.
    await session.selectNode("turn:u1");
    await flushPromises();
    expect(primary.find(".branch-title small").text()).toContain("shared prompt");
    expect(pinned.find(".branch-title small").text()).toContain("right prompt");
    const replies = (panel: typeof pinned) =>
      panel.findAllComponents({ name: "MarkdownRenderer" }).map((rendered) => rendered.props("content"));
    expect(replies(pinned)).toContain("right reply");
    expect(replies(primary)).toContain("shared reply");
    expect(replies(primary)).not.toContain("right reply");

    await pinned.get('[data-action="chat-column-close"]').trigger("click");
    expect(layout.chatColumns).toEqual([]);
    await primary.get('[data-action="chat-panel-close"]').trigger("click");
    expect(layout.layout.collapsed.chat).toBe(true);
    pinned.unmount();
    primary.unmount();
  });

  it("keeps typed input in the column whose composer bar was clicked", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = false;
    const session = useSessionStore();
    session.applySnapshot(snapshot("a2"));
    session.focusedNode = "turn:u2";
    layout.chatColumns = ["turn:u3"];

    const stubs = { MarkdownRenderer: true };
    const primary = mount(BranchContextPanel, { attachTo: document.body, global: { plugins: [pinia, i18n], stubs } });
    const pinned = mount(BranchContextPanel, { props: { nodeId: "turn:u3" }, attachTo: document.body, global: { plugins: [pinia, i18n], stubs } });

    await primary.get(".composer-collapsed").trigger("click");
    await flushPromises();

    // The shared composer state opens in every column, but only the column the
    // user clicked may take the focus — a later-mounted column must not steal it.
    expect(primary.find("textarea").exists()).toBe(true);
    expect(pinned.find("textarea").exists()).toBe(true);
    expect(primary.element.contains(document.activeElement)).toBe(true);
    expect(pinned.element.contains(document.activeElement)).toBe(false);

    primary.unmount();
    pinned.unmount();
    document.body.innerHTML = "";
  });

  it("pins a column from a Ctrl+double-click, never from a Ctrl+click", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot("a2");
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    const nodes = wrapper.findAll(".vue-flow__node");
    expect(nodes.length).toBeGreaterThan(1);

    // A plain click highlights the card without switching the chat panel, and
    // commands on "the selected node" follow the highlight.
    const focusedBefore = session.focusedNode;
    const clicked = nodes[0]!.attributes("data-id")!;
    await nodes[0]!.trigger("click");
    await flushPromises();
    expect(layout.chatColumns).toEqual([]);
    expect(layout.layout.collapsed.chat).toBe(true);
    expect(session.focusedNode).toBe(focusedBefore);
    expect(session.highlightedNode).toBe(clicked);
    expect(session.selectedNode?.id).toBe(clicked);
    expect(nodes[0]!.find(".prompt-node").classes()).toContain("selected");

    // Ctrl on a single click changes nothing — the gesture lives on the double-click.
    await nodes[1]!.trigger("click", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual([]);
    expect(layout.layout.collapsed.chat).toBe(true);

    await nodes[1]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toHaveLength(1);
    expect(layout.layout.collapsed.chat).toBe(false);

    // Pinning keeps the highlight; the primary panel still follows the focus.
    expect(session.highlightedNode).toBe(nodes[1]!.attributes("data-id"));
    expect(session.selectedNode?.id).toBe(session.highlightedNode);
    await nodes[2]!.trigger("dblclick");
    await flushPromises();
    expect(session.highlightedNode).toBeNull(); // aligning the panel clears it
    expect(session.selectedNode?.id).toBe(session.focusedNode);
    wrapper.unmount();
  });

  it("retargets the panel of a branch instead of stacking panels on one path", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot("a2");
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    // DOM order follows the projection: turn:u1, turn:u2, turn:u3 — u2 and u3
    // are sibling forks UNDER turn:u1, so every node shares a path with u1.
    const nodes = wrapper.findAll(".vue-flow__node");

    await nodes[1]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u2"]);

    // An ancestor of the pinned node shares its history — retarget, no new column.
    await nodes[0]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u1"]);

    // A descendant replaces the same column again.
    await nodes[2]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u3"]);

    // An unrelated branch gets its own column.
    await nodes[1]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u3", "turn:u2"]);

    // Opening a shared ancestor retargets its branch's first column only.
    await nodes[0]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u1", "turn:u2"]);
    wrapper.unmount();
  });

  it("reveals the primary panel on a double-click and pins one on Ctrl+double-click", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot("a2");
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = true;

    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    const nodes = wrapper.findAll(".vue-flow__node");

    // A plain double-click opens the node in the primary panel, no pin.
    await nodes[2]!.trigger("dblclick");
    await flushPromises();
    expect(layout.chatColumns).toEqual([]);
    expect(layout.layout.collapsed.chat).toBe(false);
    expect(session.focusedNode).toBe("turn:u3");

    // The Ctrl gesture pins a side column and leaves the selection alone.
    const focusBefore = session.focusedNode;
    await nodes[1]!.trigger("click", { ctrlKey: true });
    await nodes[1]!.trigger("dblclick", { ctrlKey: true });
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:u2"]);
    expect(session.focusedNode).toBe(focusBefore);
    wrapper.unmount();
  });

  it("advances a pinned column to its own submission without moving the primary focus", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.layout.collapsed.chat = false;
    layout.layout.composer.open = true;
    const session = useSessionStore();
    session.applySnapshot(snapshot("a2"));
    session.focusedNode = "turn:u1";
    layout.chatColumns = ["turn:u3"];
    vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      const action = (input as { action?: string }).action;
      if (action !== "promptAt") return {} as never;
      const requestId = (input as { requestId?: string }).requestId!;
      return {
        ...snapshot("a2"),
        entries: continued,
        projection: projectSession(continued, "a4"),
        graph: { id: "g1", epoch: "e1", revision: 2, runs: [
          { branchId: "BR", runId: "r1", requestId, nodeId: "turn:u4", status: "running" as const },
        ] },
      } as never;
    });

    const pinned = mount(BranchContextPanel, {
      props: { nodeId: "turn:u3" },
      global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } },
    });
    await pinned.get("textarea").setValue("continue here");
    await pinned.get("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();

    // The pinned column followed its branch; the primary selection is intact
    // and the draft cleared because the prompt was delivered.
    expect(layout.chatColumns).toEqual(["turn:u4"]);
    expect(session.focusedNode).toBe("turn:u1");
    expect(pinned.get("textarea").element.value).toBe("");
    // Workbench rebinds the column to the advanced node id.
    await pinned.setProps({ nodeId: layout.chatColumns[0] });
    await flushPromises();
    expect(pinned.find(".branch-title small").text()).toContain("fourth prompt");
    pinned.unmount();
  });

  it("resolves, reverts, and drops pinned columns as their runs settle", () => {
    const layout = useLayoutStore();
    const ids = new Set(["turn:u2", "turn:u3", "turn:u4"]);
    const run = { branchId: "BR", runId: "r1" };
    const running = [{ ...run, nodeId: null, status: "running" as const, pending: { text: "x", parentNodeId: "turn:u3" } }];

    layout.chatColumns = ["pending:r1"];
    layout.trackChatColumns(ids, running);
    expect(layout.chatColumns).toEqual(["pending:r1"]); // still waiting for its node

    layout.trackChatColumns(ids, [{ ...run, nodeId: "turn:u4", status: "running" }]);
    expect(layout.chatColumns).toEqual(["turn:u4"]); // resolved to the new node

    // A settled run carries no pending of its own; the parent comes from the
    // in-flight frame the column remembered.
    layout.chatColumns = ["pending:r1"];
    layout.trackChatColumns(ids, running);
    layout.trackChatColumns(ids, [{ ...run, nodeId: null, status: "interrupted" }]);
    expect(layout.chatColumns).toEqual(["turn:u3"]); // fell back to the parent

    // A run that was never seen in flight closes its column.
    layout.chatColumns = ["pending:r2"];
    layout.trackChatColumns(ids, [{ ...run, runId: "r2", nodeId: null, status: "interrupted" }]);
    expect(layout.chatColumns).toEqual([]);

    layout.chatColumns = ["pending:r1"];
    layout.trackChatColumns(ids, []);
    expect(layout.chatColumns).toEqual([]); // vanished run closes the column

    layout.chatColumns = ["turn:u2", "turn:gone"];
    layout.trackChatColumns(ids, []);
    expect(layout.chatColumns).toEqual(["turn:u2"]); // deleted nodes close their columns
  });

  it("merges columns when an advance lands on an already-pinned node", () => {
    const layout = useLayoutStore();
    layout.chatColumns = ["turn:u2", "turn:u3"];
    layout.advanceChatColumn("turn:u2", "turn:u3");
    expect(layout.chatColumns).toEqual(["turn:u3"]);
  });

  it("restores the pre-pin width at boot", () => {
    vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    const layout = useLayoutStore();
    const saved = (chat: number) => ({
      version: 4,
      widths: { navigator: 248, chat, content: 320 },
      collapsed: { navigator: true, chat: false, content: true },
      minimap: false,
      composer: { open: false },
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" as const },
      chatPinWidth: { from: 356, to: 960 },
    });
    layout.hydrate(settings, saved(960));
    expect(layout.layout.widths.chat).toBe(356);
    expect(layout.layout.chatPinWidth).toBeUndefined();
    // A user width that drifted from the widened value survives untouched.
    layout.hydrate(settings, saved(700));
    expect(layout.layout.widths.chat).toBe(700);
  });

  it("renders one column per pin beside the primary and prunes dead bindings", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSessionStore();
    const layout = useLayoutStore();
    session.current = snapshot("a2");
    layout.layout.collapsed.chat = false;
    layout.chatColumns = ["turn:u2", "turn:u3"];

    const wrapper = mount(Workbench, {
      attachTo: document.body,
      global: {
        plugins: [pinia, i18n],
        stubs: {
          SplitterGroup: { template: "<div><slot /></div>" },
          SplitterPanel: { template: "<div><slot /></div>" },
          SplitterResizeHandle: true,
          GraphPanel: true,
          ToolPanel: true,
          BranchContextPanel: { props: ["nodeId"], template: '<div class="chat" :data-node="nodeId ?? \'primary\'" />' },
        },
      },
    });
    await flushPromises();

    const columns = () => wrapper.findAll(".chat-columns > .chat");
    expect(columns().map((column) => column.attributes("data-node"))).toEqual(["primary", "turn:u2", "turn:u3"]);

    // A snapshot that dropped a pinned node closes its column.
    session.applySnapshot({ ...snapshot("a2"), projection: projectSession(entries.filter((entry) => entry.id !== "u3" && entry.id !== "a3"), "a2") } as unknown as SessionSnapshot);
    await nextTick();
    expect(columns().map((column) => column.attributes("data-node"))).toEqual(["primary", "turn:u2"]);

    // Switching sessions clears every pin.
    session.applySnapshot(snapshot("a3", "other.jsonl"));
    await nextTick();
    expect(layout.chatColumns).toEqual([]);
    expect(columns().map((column) => column.attributes("data-node"))).toEqual(["primary"]);

    wrapper.unmount();
    document.body.innerHTML = "";
  });
});
