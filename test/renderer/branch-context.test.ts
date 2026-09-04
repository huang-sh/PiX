import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

describe("BranchContextPanel streaming scroll", () => {
  it("stops following output after the user scrolls up", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
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
    setActivePinia(pinia);
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

    expect(messages.scrollTop).toBe(1000);
  });
});

describe("BranchContextPanel model failures", () => {
  const failure = '401: {"message":"Authentication Fails, Your api key: ****20e8 is invalid","type":"authentication_error"}';

  it("renders a saved failed reply as an error bubble", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
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
    setActivePinia(pinia);
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
});
describe("BranchContextPanel process summary", () => {
  it("shows a disclosure chevron instead of the brain icon on the worked summary", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
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
