import { afterEach, describe, expect, it } from "vitest";
import { readCodeTypography } from "../../src/renderer/lib/typography";

const root = document.documentElement;
const originalStyle = root.getAttribute("style");
afterEach(() => {
  if (originalStyle === null) root.removeAttribute("style");
  else root.setAttribute("style", originalStyle);
});

describe("code typography", () => {
  it("resolves the shared font stack and converts line height to pixels for Markdown", () => {
    root.style.setProperty("--font-mono", 'Consolas, "Microsoft YaHei UI",\n    monospace');
    root.style.setProperty("--font-size-code", "13px");
    root.style.setProperty("--line-height-code", "1.6");
    expect(readCodeTypography()).toEqual({
      fontFamily: 'Consolas, "Microsoft YaHei UI", monospace', fontSize: 13, lineHeight: 20.8,
    });
  });

  it("uses readable defaults when mounted without the application stylesheet", () => {
    root.removeAttribute("style");
    expect(readCodeTypography()).toEqual({
      fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, lineHeight: 20.8,
    });
  });

  it("follows token changes instead of using a separate hardcoded code size", () => {
    root.style.setProperty("--font-size-code", "15px");
    root.style.setProperty("--line-height-code", "1.5");
    expect(readCodeTypography()).toMatchObject({ fontSize: 15, lineHeight: 22.5 });
  });
});
