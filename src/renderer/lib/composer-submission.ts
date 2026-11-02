import type { ComposerDraft } from "../components/PromptComposer.vue";

/** Both human and agent submissions cross IPC with plain attachment objects. */
export function composerSubmission(draft: ComposerDraft) {
  const images = draft.images.map(image => ({ ...image }));
  return {
    text: [draft.text.trim(), ...(draft.files ?? []).map(file => `Attached file: ${file.path}`)].filter(Boolean).join("\n\n"),
    images: images.length ? images : undefined,
  };
}
