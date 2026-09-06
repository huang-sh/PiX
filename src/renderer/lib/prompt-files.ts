import { desktop } from "../api";

// Non-image attachments are delivered to the agent as local file paths:
// the model reads them itself with workspace tools instead of us inlining content.
export interface PromptFile {
  name: string;
  path: string;
}

export const MAX_PROMPT_FILES = 8;

export function promptFilePath(file: File): PromptFile {
  const path = desktop.filePath(file);
  if (!path) throw new Error("draft.filesPath");
  return { name: file.name, path };
}
