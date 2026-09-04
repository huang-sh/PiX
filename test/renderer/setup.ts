import { vi } from "vitest";
import type { DesktopApi } from "../../src/shared/types";

window.pix = {
  invoke: vi.fn(async () => ({})),
  onEvent: vi.fn(() => () => {}),
  copy: vi.fn(async () => {}),
} satisfies DesktopApi & { copy(text: string): Promise<void> };
