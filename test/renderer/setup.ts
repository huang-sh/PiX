import { vi } from "vitest";
import type { DesktopApi } from "../../src/shared/types";

window.pix = {
  invoke: vi.fn(async () => ({})),
  onEvent: vi.fn(() => () => {}),
  copy: vi.fn(async () => {}),
  // Mirror webUtils.getPathForFile: resolve from the File's hidden path property,
  // which tests set per file; absent paths surface as "" like Electron does.
  filePath: vi.fn((file: File) => (file as File & { path?: string }).path ?? ""),
} satisfies DesktopApi & { copy(text: string): Promise<void>; filePath(file: File): string };
