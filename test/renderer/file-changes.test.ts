import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";
import FileChanges from "../../src/renderer/features/branch-context/FileChanges.vue";
import BranchHistory from "../../src/renderer/features/branch-context/BranchHistory.vue";
import FileDiff from "../../src/renderer/features/tools/FileDiff.vue";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import type { FileChange } from "../../src/shared/file-changes";

const change: FileChange = { path: "src/example.ts", ref: "12345678-1234-1234-1234-123456789abc", status: "modified", added: 4, removed: 2 };
beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({});
  useWorkspaceStore().project = { name: "plain directory", path: "/project" };
});
const card = (changes = [change]) => mount(FileChanges, { props: { changes, sessionPath: "/sessions/one.jsonl" }, global: { plugins: [i18n] } });

it("renders totals and opens this round's saved diff without invoking Git", async () => {
  const wrapper = card();
  expect(wrapper.get('summary').text()).toContain("1 file changed");
  expect(wrapper.get('summary').text()).toContain("+4");
  expect(wrapper.get('summary').text()).toContain("−2");
  vi.mocked(window.pix!.invoke).mockImplementation(async route => route === "changes.read" ? "-old\n+new\n" : {});
  await wrapper.get('button').trigger('click'); await flushPromises();
  expect(window.pix!.invoke).toHaveBeenCalledWith("changes.read", { session: "/sessions/one.jsonl", ref: change.ref });
  const workspace = useWorkspaceStore();
  expect(workspace.active?.kind).toBe("turn-change");
  expect(workspace.active?.patch).toBe("-old\n+new\n");
  expect(useLayoutStore().contentSection).toBe("changes");
  expect(vi.mocked(window.pix!.invoke).mock.calls.some(([route]) => route.startsWith("git."))).toBe(false);
  wrapper.unmount();
});

it("opens the current file and shows partial totals without pretending conflicts are zero changes", async () => {
  const wrapper = card([change, { ...change, path: "other", ref: "22345678-1234-1234-1234-123456789abc", added: null, removed: null, reason: "conflict" }]);
  expect(wrapper.get('summary').text()).toContain("Partial");
  expect(wrapper.text()).toContain("Interleaved changes");
  expect(wrapper.findAll('button')[2]!.attributes('disabled')).toBeDefined();
  vi.mocked(window.pix!.invoke).mockImplementation(async route => route === "workspace.read" ? { path: change.path, name: "example.ts", content: "new", language: "typescript" } : {});
  await wrapper.findAll('button')[1]!.trigger('click'); await flushPromises();
  expect(window.pix!.invoke).toHaveBeenCalledWith("workspace.read", { path: change.path });
  expect(useLayoutStore().contentSection).toBe("files");
  wrapper.unmount();
});

it("places each card after its final answer, including stopped turns, and hides running/empty cards", async () => {
  const wrapper = mount(BranchHistory, { props: {
    viewKey: "one", sessionPath: "/sessions/one.jsonl", processMessages: new Map(), expandedProcesses: new Set<string>(),
    duration: () => "1s", errorText: () => "stopped", turns: [
      { id: "one", process: [], terminal: { entryId: "a", turnId: "one", text: "done", role: "assistant", timestamp: "" }, fileChanges: [change] },
      { id: "two", process: [], terminal: { entryId: "b", turnId: "two", text: "", role: "assistant", timestamp: "", isError: true }, fileChanges: [change] },
      { id: "three", process: [], running: true, fileChanges: [change] },
      { id: "four", process: [], fileChanges: [] },
    ],
  }, global: { plugins: [i18n], stubs: { MarkdownRenderer: true } } });
  expect(wrapper.findAll('.file-changes')).toHaveLength(2);
  const first = wrapper.findAll('.chat-turn')[0]!;
  expect(first.get('.final-response').element.nextElementSibling?.classList.contains('file-changes')).toBe(true);
  wrapper.unmount();
});

it("keeps immutable diffs in separate tabs and discards results after a project switch", async () => {
  const workspace = useWorkspaceStore();
  vi.mocked(window.pix!.invoke).mockResolvedValue("first patch");
  await workspace.openTurnChange("one", change);
  vi.mocked(window.pix!.invoke).mockResolvedValue("second patch");
  await workspace.openTurnChange("two", { ...change, ref: "22345678-1234-1234-1234-123456789abc" });
  expect(workspace.tabs.map(tab => tab.patch)).toEqual(["first patch", "second patch"]);
  let finish!: (patch: string) => void;
  vi.mocked(window.pix!.invoke).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const request = workspace.openTurnChange("three", change);
  workspace.hydrate({ name: "other", path: "/other" });
  finish("old project's patch"); await request;
  expect(workspace.tabs).toHaveLength(0);
  let finishFile!: (value: unknown) => void;
  vi.mocked(window.pix!.invoke).mockReturnValue(new Promise(resolve => { finishFile = resolve; }));
  const file = workspace.openFile("old.txt");
  workspace.hydrate({ name: "third", path: "/third" });
  finishFile({ path: "old.txt", name: "old.txt", content: "old" }); await file;
  expect(workspace.tabs).toHaveLength(0);
});

it("escapes file contents and bounds large diff rendering", async () => {
  const wrapper = mount(FileDiff, { props: { patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-<script>evil()</script>\n+safe\n" + " context\n".repeat(2100) }, global: { plugins: [i18n] } });
  expect(wrapper.find('script').exists()).toBe(false);
  expect(wrapper.findAll('.diff-row')).toHaveLength(2000);
  expect(wrapper.get('.removed').text()).toContain("<script>");
  await wrapper.get('button').trigger('click');
  expect(wrapper.findAll('.diff-row').length).toBeGreaterThan(2000);
  wrapper.unmount();
});

it("uses one number column with original and updated positions available on hover", () => {
  const wrapper = mount(FileDiff, { props: { patch: [
    '--- a/file', '+++ b/file', '@@ -3,3 +8,3 @@', ' context', '--- old text', '+++ new text', ' tail',
    '@@ -20 +25 @@', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file',
    '@@ -0,0 +1,2 @@', '+first', '+second', '@@ -9,2 +0,0 @@', '-deleted', '-also deleted',
  ].join('\n') }, global: { plugins: [i18n] } });
  const numbered = wrapper.findAll('.diff-row').filter(row => row.get('.line-number').text());
  expect(numbered.map(row => row.get('.line-number').text())).toEqual(['8', '4', '9', '10', '20', '25', '1', '2', '9', '10']);
  expect(wrapper.findAll('.diff-row').every(row => row.findAll('.line-number').length === 1)).toBe(true);
  expect(numbered[0]!.get('.line-number').attributes('title')).toBe('Original line 3\nUpdated line 8');
  expect(numbered[1]!.get('.line-number').attributes('title')).toBe('Original line 4');
  expect(numbered[2]!.get('.line-number').attributes('title')).toBe('Updated line 9');
  expect(wrapper.findAll('.removed').map(row => row.get('.line-content').text())).toContain('--- old text');
  expect(wrapper.findAll('.added').map(row => row.get('.line-content').text())).toContain('+++ new text');
  expect(wrapper.findAll('.hunk, .header').every(row => !row.get('.line-number').text())).toBe(true);
  wrapper.unmount();
});
