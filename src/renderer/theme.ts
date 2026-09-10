import { computed, readonly, ref } from "vue";
import { normalizeTheme, resolveTheme, themeColors, type ColorScheme, type ThemeId, type ThemePreference } from "../shared/theme";

const resolved = ref<ThemeId>("light");
export const activeTheme = readonly(resolved);
export const colorScheme = computed<ColorScheme>(() => resolved.value === "dark" ? "dark" : "light");
let preference: ThemePreference = "light";
let systemTheme: MediaQueryList | undefined;

export function applyTheme(value: ThemePreference) {
  preference = normalizeTheme(value);
  const theme = resolveTheme(preference, systemTheme?.matches ?? false);
  const scheme = theme === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = preference;
  root.dataset.colorScheme = scheme;
  root.style.colorScheme = scheme;
  for (const [name, color] of Object.entries(themeColors[theme]))
    root.style.setProperty(`--${name}`, color);
  resolved.value = theme;
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

// The session canvas dot grid is drawn by .session-flow in app.css from these
// root-level controls: a size variable and an off switch.
export function applyDotGrid(app: { canvasDotGrid?: boolean; canvasDotGridSize?: number }) {
  const root = document.documentElement;
  if (app.canvasDotGrid === false) root.dataset.dotGrid = "off";
  else delete root.dataset.dotGrid;
  const size = Math.min(96, Math.max(8, Math.round(Number(app.canvasDotGridSize) || 24)));
  root.style.setProperty("--dot-grid-size", `${size}px`);
}
