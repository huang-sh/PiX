// Shared by the renderer, terminal and Electron window chrome.
export type ThemeId = "light" | "dark" | "teal";
export type ThemePreference = ThemeId | "system";
export type ColorScheme = "light" | "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "dark" || value === "system" || value === "teal" ? value : "light";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ThemeId {
  return preference === "system" ? systemDark ? "dark" : "light" : preference;
}

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
    // Standalone amber for agent-in-progress states; accents stay blue so a
    // running node can contrast instead of reading as another accent shade.
    "running": "#d97706",
    "warn": "#d97706",
    "shadow": "0 12px 36px rgba(28, 36, 48, 0.10), 0 2px 6px rgba(28, 36, 48, 0.04)",
    "accent-foreground": "#ffffff",
    "danger-foreground": "#ffffff"
  },
  "teal": {
    "background": "#eef2f1",
    "surface": "#ffffff",
    "surface-subtle": "#f8faf9",
    "navigator": "#f3f6f5",
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
    "running": "#d97706",
    "warn": "#d97706",
    "shadow": "0 18px 55px rgba(21, 49, 41, 0.14)",
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
    "danger": "#b54852",
    "running": "#f59e0b",
    "warn": "#f59e0b",
    "shadow": "0 18px 58px rgba(0,0,0,.34)",
    "accent-foreground": "#172238",
    "danger-foreground": "#ffffff"
  }
} as const;
