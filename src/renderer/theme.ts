import { computed, readonly, ref } from "vue";
import { normalizeTheme, resolveTheme, themeColors, themeSchemes, type ColorScheme, type ThemeId, type ThemePreference } from "../shared/theme";
import { desktop } from "./api";

const resolved = ref<ThemeId>("light");
export const activeTheme = readonly(resolved);
export const colorScheme = computed<ColorScheme>(() => themeSchemes[resolved.value]);
let preference: ThemePreference = "light";
let systemTheme: MediaQueryList | undefined;

// The caption overlay is painted by the main process's own compositor, so its
// flip can only race the page's theme flip, never join it. Fire the sync in
// the same tick as the CSS change, carrying the applied theme: main then
// flips the overlay from the payload instead of re-reading the on-disk
// settings, which still hold the previous theme until the write lands.
function syncOverlay() {
  void desktop.invoke("theme.syncOverlay", { theme: preference }).catch(() => {});
}

export function applyTheme(value: ThemePreference) {
  preference = normalizeTheme(value);
  const theme = resolveTheme(preference, systemTheme?.matches ?? false);
  const scheme = themeSchemes[theme];
  const root = document.documentElement;
  root.dataset.theme = preference;
  root.dataset.colorScheme = scheme;
  root.style.colorScheme = scheme;
  for (const [name, color] of Object.entries(themeColors[theme]))
    root.style.setProperty(`--${name}`, color);
  resolved.value = theme;
  syncOverlay();
}

export function startTheme(initial: ThemePreference) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  systemTheme = media;
  const update = () => applyTheme(preference);
  media.addEventListener("change", update);
  applyTheme(initial);
  return () => {
    media.removeEventListener("change", update);
    if (systemTheme === media) systemTheme = undefined;
  };
}

// Root-level appearance controls beyond theme: UI density and the canvas dot
// grid drawn by .session-flow/.welcome/.graph-empty in app.css. Fallbacks
// there must match the defaults used here.
export function applyAppearance(app: { density?: "comfortable" | "compact"; canvasDotGrid?: boolean; canvasDotGridSpacing?: number; canvasDotGridDotSize?: number }) {
  const root = document.documentElement;
  root.dataset.density = app.density ?? "comfortable";
  if (app.canvasDotGrid === false) root.dataset.dotGrid = "off";
  else delete root.dataset.dotGrid;
  const spacing = Math.min(96, Math.max(8, Math.round(Number(app.canvasDotGridSpacing) || 24)));
  root.style.setProperty("--dot-grid-size", `${spacing}px`);
  // The setting is a diameter in px; the gradient stop is a radius.
  const dot = Math.min(6, Math.max(1, Math.round(Number(app.canvasDotGridDotSize) || 4)));
  root.style.setProperty("--dot-grid-dot", `${dot / 2}px`);
}
