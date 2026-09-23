import { describe, expect, it } from "vitest";
import { messages } from "../../src/renderer/i18n";

type MessageTree = Record<string, unknown>;

/** Flatten a locale tree into `dotted.path -> message text` leaves. */
function leafMessages(node: MessageTree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") leafMessages(value as MessageTree, path, out);
    else out[path] = String(value);
  }
  return out;
}

/** Named interpolation args a message uses, e.g. "{n} files" -> ["n"]. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const en = leafMessages(messages.en);
const zhCN = leafMessages(messages["zh-CN"]);

describe("i18n locale parity", () => {
  it("zh-CN defines exactly the message keys that en defines", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it("every message keeps the same interpolation placeholders in both locales", () => {
    for (const [path, text] of Object.entries(zhCN)) {
      expect(placeholders(text), path).toEqual(placeholders(en[path]));
    }
  });
});
