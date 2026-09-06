import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PromptImage, RuntimeModel } from "../../shared/types";
import { useLayoutStore } from "../stores/layout";
import { useSessionStore } from "../stores/session";

// One shared registry of in-flight submitted drafts: whichever surface collected the
// prompt (graph draft node or chat composer), the graph watches it to detect and
// center the freshly created node — identical behavior for both input paths.
const submitted = ref<{ parentId: string | null; knownNodeIds: Set<string> }>();

export function useDraftSubmit() {
  const session = useSessionStore();
  const layout = useLayoutStore();
  const { t } = useI18n();
  const submittedNodeId = ref<string>();

  async function submitDraft(
    parentId: string | null,
    text: string,
    model?: RuntimeModel | null,
    thinkingLevel?: string,
    images?: PromptImage[],
  ): Promise<boolean> {
    submittedNodeId.value = undefined;
    submitted.value = session.current?.graph ? undefined : {
      parentId,
      knownNodeIds: new Set(session.current?.projection.nodes.map((node) => node.id)),
    };
    if (layout.layout.collapsed.chat) void layout.setCollapsed("chat", false);
    try {
      submittedNodeId.value = await session.promptAt(parentId, text, model, thinkingLevel, images);
      return true;
    } catch (error) {
      submitted.value = undefined;
      const message = error instanceof Error ? error.message : String(error);
      layout.showNotice(
        message.includes("No API key found")
          ? t("graph.noApiKeyNotice")
          : message,
        "error",
      );
      return false;
    }
  }

  function acceptSubmittedNode() {
    if (!submitted.value) return undefined;
    const { knownNodeIds, parentId } = submitted.value;
    const node = session.current?.projection.nodes.find(
      (item) => !knownNodeIds.has(item.id) && item.parentId === parentId,
    );
    if (!node) return undefined;
    submitted.value = undefined;
    return node.id;
  }

  function clearSubmittedDraft() {
    submitted.value = undefined;
  }

  return { submitDraft, acceptSubmittedNode, clearSubmittedDraft, submittedNodeId };
}
