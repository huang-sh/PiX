import { desktop } from "../api";

// Non-image attachments are delivered to the agent as local file paths:
// the model reads them itself with workspace tools instead of us inlining content.
export interface PromptFile {
  name: string;
  path: string;
}

export const MAX_PROMPT_FILES = 8;

export async function promptFilePath(file: File): Promise<PromptFile> {
  const path = desktop.filePath(file);
  if (path) return { name: file.name, path };
  if (desktop.attachFile) return desktop.attachFile(file);
  throw new Error("draft.filesPath");
}
