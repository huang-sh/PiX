import test from "node:test";
import assert from "node:assert/strict";
import { collectAgentCommands } from "../src/shared/commands.js";

test("collects extension, prompt, and skill commands in RPC get_commands order", () => {
  const agent = {
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: "ext-cmd", description: "from extension" }] },
    promptTemplates: [{ name: "review", description: "Review code", argumentHint: "<file>" }],
    resourceLoader: { getSkills: () => ({ skills: [{ name: "code", description: "Coding skill" }] }) },
  };
  assert.deepEqual(collectAgentCommands(agent), [
    { name: "ext-cmd", description: "from extension", source: "extension" },
    { name: "review", description: "Review code", source: "prompt", argumentHint: "<file>" },
    { name: "skill:code", description: "Coding skill", source: "skill" },
  ]);
});

test("a native getCommands() result wins when present", () => {
  const agent = {
    getCommands: () => [{ name: "native", source: "builtin" as const }],
    promptTemplates: [{ name: "review", description: "ignored", source: "prompt" }],
  };
  assert.deepEqual(collectAgentCommands(agent), [{ name: "native", source: "builtin" }]);
});

test("tolerates sessions without any command surface", () => {
  assert.deepEqual(collectAgentCommands({}), []);
});

test("argumentHint stays optional for sources without one", () => {
  const agent = { promptTemplates: [{ name: "plain" }] };
  assert.deepEqual(collectAgentCommands(agent), [
    { name: "plain", description: undefined, source: "prompt", argumentHint: undefined },
  ]);
});
