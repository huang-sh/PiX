// Shared by the renderer, terminal and Electron window chrome.
export type ThemeId = "light" | "dark" | "teal" | "peach" | "paper" | "graphite";
export type ThemePreference = ThemeId | "system";
export type ColorScheme = "light" | "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "dark" || value === "system" || value === "teal" || value === "peach" || value === "paper" || value === "graphite" ? value : "light";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ThemeId {
  return preference === "system" ? systemDark ? "dark" : "light" : preference;
}

// Which color scheme each theme renders as. Drives the root `color-scheme`
// (native widgets, KaTeX, light-dark()) and the terminal ANSI palettes.
export const themeSchemes = {
  "light": "light",
  "paper": "light",
  "teal": "light",
  "peach": "light",
  "dark": "dark",
  "graphite": "dark"
} as const satisfies Record<ThemeId, ColorScheme>;

export const themeColors = {
  "light": {
    "background": "#f5f7fa",
    "surface": "#ffffff",
    "surface-subtle": "#f5f7fa",
    "navigator": "#f5f7fa",
    "context": "#ffffff",
    "tool-surface": "#ffffff",
    "muted-surface": "#e9eef5",
    "border": "#d6dee9",
    "border-strong": "#a5b3c5",
    "text": "#172033",
    "muted": "#475569",
    "faint": "#596579",
    "accent": "#2563eb",
    "accent-strong": "#1d4ed8",
    "accent-soft": "#eff6ff",
    "ring": "rgba(37, 99, 235, 0.14)",
    "danger": "#b54852",
    "success": "#16803c",
    // Standalone amber for agent-in-progress states; accents stay blue so a
    // running node can contrast instead of reading as another accent shade.
    "running": "#d97706",
    "warn": "#d97706",
    "shadow": "0 12px 36px rgba(28, 36, 48, 0.10), 0 2px 6px rgba(28, 36, 48, 0.04)",
    "accent-foreground": "#ffffff",
    "danger-foreground": "#ffffff"
  },
  // deepseek-harness design language: pure-white canvas, near-black ink text,
  // blue kept for links, focus and selection rather than filled controls.
  "paper": {
    "background": "#f9fafb",
    "surface": "#ffffff",
    "surface-subtle": "#f5f6f7",
    "navigator": "#f9fafb",
    "context": "#ffffff",
    "tool-surface": "#ffffff",
    "muted-surface": "#f1f3f5",
    "border": "#e6e6e6",
    "border-strong": "#d4d4d4",
    "text": "#0f1115",
    "muted": "#61666b",
    "faint": "#81858c",
    // The harness blue (#4176e6) and red are darkened one step so they clear
    // the 4.5:1 floor in both the text and the filled-control role.
    "accent": "#3568da",
    "accent-strong": "#2f4c8f",
    "accent-soft": "#edf3fe",
    "ring": "rgba(53, 104, 218, 0.14)",
    "danger": "#d52121",
    "success": "#15803d",
    "running": "#d97706",
    "warn": "#d97706",
    // The hairline-stroke-plus-glow elevation from the same design language.
    "shadow": "0 0 1px rgba(15, 17, 21, 0.20), 0 12px 32px rgba(15, 17, 21, 0.08)",
    "accent-foreground": "#ffffff",
    "danger-foreground": "#ffffff"
  },
  "teal": {
    "background": "#eef2f1",
    "surface": "#ffffff",
    "surface-subtle": "#f4f8f6",
    "navigator": "#f7f9fa",
    "context": "#fbfcfc",
    "tool-surface": "#f7f9fa",
    "muted-surface": "#edf2f0",
    "border": "#dce4e1",
    "border-strong": "#c8d4d0",
    "text": "#17201e",
    "muted": "#687772",
    "faint": "#6f7d77",
    // Use the legacy hover green for filled controls to keep white labels readable.
    "accent": "#247b5d",
    "accent-strong": "#1e684f",
    "accent-soft": "#e5f4ee",
    "ring": "rgba(50, 157, 120, 0.24)",
    "danger": "#b54852",
    "success": "#16803c",
    "running": "#d97706",
    "warn": "#d97706",
    "shadow": "0 18px 55px rgba(21, 49, 41, 0.14)",
    "accent-foreground": "#ffffff",
    "danger-foreground": "#ffffff"
  },
  "peach": {
    "background": "#fff8f3",
    "surface": "#ffffff",
    "surface-subtle": "#fdf3ec",
    "navigator": "#fdf6f0",
    "context": "#fffdfb",
    "tool-surface": "#fdf6f0",
    "muted-surface": "#f9ece2",
    "border": "#f3e4da",
    "border-strong": "#dfc3b1",
    "text": "#4a3f3a",
    "muted": "#6f6057",
    "faint": "#9a8b82",
    // Deep peach for filled controls so white labels stay readable on it.
    "accent": "#b04a22",
    "accent-strong": "#a8481f",
    "accent-soft": "#ffe3d4",
    "ring": "rgba(255, 138, 92, 0.28)",
    "danger": "#b3402c",
    "success": "#16803c",
    "running": "#d97706",
    "warn": "#d97706",
    "shadow": "0 12px 36px rgba(196, 138, 92, 0.14), 0 2px 6px rgba(196, 138, 92, 0.08)",
    "accent-foreground": "#ffffff",
    "danger-foreground": "#ffffff"
  },
  "dark": {
    "background": "#0f1513",
    "surface": "#141c19",
    "surface-subtle": "#18221e",
    "navigator": "#121a17",
    "context": "#151e1b",
    "tool-surface": "#131c1a",
    "muted-surface": "#1d2925",
    "border": "#283732",
    "border-strong": "#3a4e47",
    "text": "#edf6f2",
    "muted": "#9aaba5",
    "faint": "#70827c",
    "accent": "#8da6ce",
    "accent-strong": "#b2c6e5",
    "accent-soft": "#202e43",
    "ring": "rgba(141,166,206,.2)",
    // A token feeds both a text role and a fill role, which need opposite
    // values: light enough to read on this scheme's surfaces, dark enough that
    // the fill keeps its foreground legible. Dark therefore flips accent and
    // danger foregrounds to the dark ink instead of inheriting the light
    // scheme's white. danger and success stay in one contrast band so added and
    // removed diff lines read as equals.
    "danger": "#f2777a",
    "success": "#3fb950",
    "running": "#f59e0b",
    "warn": "#f59e0b",
    "shadow": "0 18px 58px rgba(0,0,0,.34)",
    "accent-foreground": "#172238",
    "danger-foreground": "#172238"
  },
  // deepseek-harness dark mode: layered charcoal with white-alpha hairline
  // borders; the accent flips to the light end of the brand ramp, so filled
  // controls take the dark-ink foreground like the "dark" theme above.
  "graphite": {
    "background": "#151517",
    "surface": "#232324",
    "surface-subtle": "#2c2c2e",
    "navigator": "#1b1b1c",
    "context": "#232324",
    "tool-surface": "#1b1b1c",
    "muted-surface": "#353638",
    "border": "rgba(255, 255, 255, 0.10)",
    "border-strong": "rgba(255, 255, 255, 0.16)",
    "text": "#f9fafb",
    "muted": "#cfd3d6",
    "faint": "#adb2b8",
    "accent": "#7aaaff",
    "accent-strong": "#b7c8fe",
    "accent-soft": "#34415b",
    "ring": "rgba(122, 170, 255, 0.24)",
    "danger": "#f86666",
    "success": "#4ed17e",
    "running": "#f59e0b",
    "warn": "#f59e0b",
    "shadow": "0 0 1px rgba(0, 0, 0, 0.60), 0 16px 40px rgba(0, 0, 0, 0.50)",
    "accent-foreground": "#0f1115",
    "danger-foreground": "#0f1115"
  }
} as const;
