import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PromptImage, RuntimeModel } from "../../shared/types";
import { useLayoutStore } from "../stores/layout";
import { useSessionStore } from "../stores/session";

// Legacy sessions identify a submitted turn from the next projection. Graph
// submissions return their own node id, independently of concurrent sends.
const submitted = ref<{ parentId: string | null; knownNodeIds: Set<string> }>();

export function useDraftSubmit() {
  const session = useSessionStore();
  const layout = useLayoutStore();
  const { t } = useI18n();

  async function submitDraft(
    parentId: string | null,
    text: string,
    model?: RuntimeModel | null,
    thinkingLevel?: string,
    images?: PromptImage[],
    options?: { follow?: boolean; columnId?: string; requestId?: string },
  ): Promise<{ nodeId?: string } | false> {
    submitted.value = session.current?.graph ? undefined : {
      parentId,
      knownNodeIds: new Set(session.current?.projection.nodes.map((node) => node.id)),
    };
    if (layout.layout.collapsed.chat) void layout.setCollapsed("chat", false);
    try {
      const nodeId = await session.promptAt(parentId, text, model, thinkingLevel, images, options);
      return { nodeId };
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

  return { submitDraft, acceptSubmittedNode, clearSubmittedDraft };
}
