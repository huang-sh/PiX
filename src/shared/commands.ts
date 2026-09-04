import type { RuntimeCommand } from "./types.js";

export const APP_COMMANDS = [
  { name: "settings", description: "Open PiX settings", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "tree", description: "Navigate session graph", source: "builtin" },
  { name: "thinking", description: "Set thinking level", source: "builtin" },
  { name: "scoped-models", description: "Configure model cycling", source: "builtin" },
  { name: "export", description: "Export session", source: "builtin" },
  { name: "import", description: "Import Pi JSONL", source: "builtin" },
  { name: "share", description: "Share exported session", source: "builtin" },
  { name: "copy", description: "Copy last assistant message", source: "builtin" },
  { name: "name", description: "Set session name", source: "builtin" },
  { name: "session", description: "Show session stats", source: "builtin" },
  { name: "changelog", description: "Show changelog", source: "builtin" },
  { name: "hotkeys", description: "Show shortcuts", source: "builtin" },
  { name: "fork", description: "Fork from a user message", source: "builtin" },
  { name: "clone", description: "Clone active branch", source: "builtin" },
  { name: "trust", description: "Configure project trust", source: "builtin" },
  { name: "login", description: "Configure provider auth", source: "builtin" },
  { name: "logout", description: "Remove provider auth", source: "builtin" },
  { name: "new", description: "Start new session", source: "builtin" },
  { name: "compact", description: "Compact context", source: "builtin" },
  { name: "resume", description: "Switch session", source: "builtin" },
  { name: "reload", description: "Reload Pi resources", source: "builtin" },
  { name: "quit", description: "Quit PiX", source: "builtin" },
  { name: "terminal", description: "Open terminal", source: "app" },
  { name: "files", description: "Open files", source: "app" },
  { name: "browser", description: "Open browser", source: "app" },
] as const satisfies readonly RuntimeCommand[];

export type AppCommandName = (typeof APP_COMMANDS)[number]["name"];
