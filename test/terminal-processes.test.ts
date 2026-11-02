import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellService } from "../src/main/services.js";

async function terminalFixture(job: (shell: ShellService, id: string, untilOutput: (text: string) => Promise<void>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "pix-terminal-processes-"));
  const previous = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  let output = "";
  let onExit: () => void;
  const exited = new Promise<void>(resolve => { onExit = resolve; });
  const shell = new ShellService(home, event => {
    const payload = (event as { payload?: { data?: string; exitCode?: number } }).payload;
    output += payload?.data ?? "";
    if (payload?.exitCode !== undefined) onExit();
  });
  let id: string;
  try {
    // A plain sh also works: child-process checks do not need shell integration.
    process.env.HOME = home;
    process.env.SHELL = "/bin/sh";
    id = shell.create(80, 24).id;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  try {
    shell.writeTerminal(id, process.platform === "win32"
      ? "Write-Output ('PIx_'+'READY')\r" : "printf 'PIx_%s\\n' READY\r");
    const untilOutput = (text: string) => until(() => output.includes(text));
    await untilOutput("PIx_READY");
    await job(shell, id, untilOutput);
  } finally {
    shell.dispose();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for terminal child processes");
}

test("terminal child processes distinguish an idle shell from a foreground command", { timeout: 20000 }, async () => {
  await terminalFixture(async (shell, id) => {
    assert.deepEqual(await shell.terminalWork(), { commands: 0, unknown: 0 });
    shell.writeTerminal(id, process.platform === "win32" ? "ping.exe -n 60 127.0.0.1\r" : "sleep 60\r");
    await until(async () => (await shell.terminalWork()).commands === 1);
    shell.writeTerminal(id, "\x03");
    await until(async () => (await shell.terminalWork()).commands === 0);
    assert.equal((await shell.terminalWork()).unknown, 0);
  });
});

test("a returned prompt still counts live background child processes", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  await terminalFixture(async (shell, id, untilOutput) => {
    try {
      shell.writeTerminal(id, "sleep 60 & printf 'PIx_%s\\n' BACKGROUND\r");
      await untilOutput("PIx_BACKGROUND");
      assert.deepEqual(await shell.terminalWork(), { commands: 1, unknown: 0 });
    } finally {
      shell.writeTerminal(id, "kill %1\r");
      await until(async () => (await shell.terminalWork()).commands === 0);
    }
  });
});

test("shell-only loops are outside the simple child-process check", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  await terminalFixture(async (shell, id, untilOutput) => {
    shell.writeTerminal(id, "printf 'PIx_%s\\n' BUILTIN; while :; do :; done\r");
    await untilOutput("PIx_BUILTIN");
    assert.deepEqual(await shell.terminalWork(), { commands: 0, unknown: 0 });
    shell.writeTerminal(id, "\x03");
  });
});

test("a failed process lookup keeps terminal activity unknown", { timeout: 15000 }, async () => {
  await terminalFixture(async shell => {
    const previous = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "pix-missing-process-tools");
      assert.deepEqual(await shell.terminalWork(), { commands: 0, unknown: 1 });
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    }
  });
});

for (const changed of [false, true]) test(`a slow process lookup stays responsive and rejects stale idle results (input=${changed})`, { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-slow-process-"));
  const previous = process.env.PATH;
  const shell = new ShellService(null, () => {});
  shell.terminals.set("fixture", { pid: process.pid, write() {}, kill() {} } as any);
  writeFileSync(join(directory, "ps"), "#!/bin/sh\n/bin/sleep 0.3\n", { mode: 0o700 });
  let complete = false;
  let lookup: Promise<{ commands: number; unknown: number }> | undefined;
  try {
    process.env.PATH = directory;
    lookup = Promise.resolve(shell.terminalWork()).then(result => { complete = true; return result; });
    if (changed) shell.writeTerminal("fixture", "sleep 60\r");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(complete, false, "process inspection must not block input, events or other host requests");
    assert.deepEqual(await lookup, { commands: 0, unknown: Number(changed) });
  } finally {
    await lookup;
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    shell.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
