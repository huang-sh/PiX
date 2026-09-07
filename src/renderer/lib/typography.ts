// Canvas/inline-style renderers cannot inherit the app's CSS typography directly.
// Resolve the shared tokens instead of letting their own defaults shrink code.
export function readCodeTypography() {
  const style = getComputedStyle(document.documentElement);
  const fontSize = Number.parseFloat(style.getPropertyValue("--font-size-code")) || 13;
  const lineHeight = Number.parseFloat(style.getPropertyValue("--line-height-code")) || 1.6;
  // The token is authored across multiple lines; collapse the newlines so the
  // value stays valid inside synthesized `font` strings (glyph measurement),
  // not only as a CSS font-family list.
  const family = style.getPropertyValue("--font-mono").replace(/\s+/g, " ").trim();
  return {
    fontFamily: family || "ui-monospace, Consolas, monospace",
    fontSize,
    lineHeight: fontSize * lineHeight,
  };
}
