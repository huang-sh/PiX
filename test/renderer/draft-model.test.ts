import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RuntimeModel, SessionSnapshot, SettingsBundle } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

const branched: RuntimeModel = { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true };
const sibling: RuntimeModel = { provider: "xai", id: "grok-fast", name: "Grok Fast", reasoning: false };
const picked: RuntimeModel = { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true };

function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  const entries = [["root", null], ["a", "root"], ["b", "root"], ["c", "b"]].map(([id, parentId], i) => ({
    type: "message", id: id!, parentId, timestamp: String(i), message: { role: "user", content: id! },
  }));
  const current = {
    session: { id: "draft-model", path: "draft-model.jsonl", cwd: ".", created: "", modified: "", messageCount: 4, firstMessage: "root" },
    entries, projection: projectSession(entries, "c"),
    runtime: { available: true, isStreaming: false, model: sibling, thinkingLevel: "off" },
    graph: { id: "draft-model.jsonl", epoch: "one", revision: 1, runs: [] },
  } as unknown as SessionSnapshot;
  session.current = current;
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const draftNode = (parentId: string) =>
    graph.nodes.find((node: { id: string }) => node.id === `draft:${parentId}`) as
      { data: { onModel: (model: RuntimeModel) => void } } | undefined;
  return { graph, session, draftNode };
}

describe("draft model defaults", () => {
  it("inherits the model of the node it branches from, falling back to the session's", async () => {
    const { graph, session } = setup();
    const nodes = session.current!.projection.nodes;
    nodes.find((node) => node.id === "turn:root")!.footer = { model: branched, thinkingLevel: "high" };

    await graph.compose("turn:root");
    expect(graph.draftModel).toEqual(branched);

    // A node without a footer of its own falls back to the session's model.
    await graph.compose("turn:a");
    expect(graph.draftModel).toEqual(sibling);
  });

  it("writes an explicit pick as the default a new session starts from", async () => {
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({
      app: {}, piGlobal: {}, piProject: {}, effective: {}, paths: {},
    } satisfies SettingsBundle as never);
    const { graph, draftNode } = setup();

    // Merely composing on an inherited model changes nothing.
    await graph.compose("turn:root");
    await flushPromises();
    expect(invoke).not.toHaveBeenCalledWith("settings.update", expect.anything());

    // A pick is the "last set" model, on a branch or on the tip alike.
    draftNode("turn:root")!.data.onModel(picked);
    await flushPromises();
    expect(graph.draftModel).toEqual(picked);
    expect(invoke).toHaveBeenCalledWith("settings.update", {
      scope: "global",
      patch: { defaultProvider: "anthropic", defaultModel: "claude-sonnet" },
    });
  });
});
