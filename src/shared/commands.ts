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

// Subset of the agent session surface collectAgentCommands needs. The pi
// SDK's AgentSession exposes these as public members; typing them loosely
// keeps this pure helper testable against stand-ins.
export interface AgentCommandSource {
  promptTemplates?: ReadonlyArray<{ name: string; description?: string; argumentHint?: string }>;
  resourceLoader?: { getSkills?: () => { skills?: ReadonlyArray<{ name: string; description?: string }> } };
  extensionRunner?: { getRegisteredCommands?: () => ReadonlyArray<{ invocationName: string; description?: string }> };
  getCommands?: () => ReadonlyArray<RuntimeCommand>;
}

// Mirrors the pi RPC get_commands assembly (extension commands, then prompt
// templates, then skills as "skill:<name>"), so the GUI slash menu and the
// command palette list exactly what the TUI would autocomplete. A native
// getCommands() (added in later SDK versions) wins when present.
export function collectAgentCommands(agent: AgentCommandSource): RuntimeCommand[] {
  const native = agent.getCommands?.() ?? [];
  if (native.length) return native.map((command) => ({ ...command }));

  const commands: RuntimeCommand[] = [];
  for (const command of agent.extensionRunner?.getRegisteredCommands?.() ?? [])
    commands.push({ name: command.invocationName, description: command.description, source: "extension" });
  for (const template of agent.promptTemplates ?? [])
    commands.push({ name: template.name, description: template.description, source: "prompt", argumentHint: template.argumentHint });
  for (const skill of agent.resourceLoader?.getSkills?.()?.skills ?? [])
    commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill" });
  return commands;
}
