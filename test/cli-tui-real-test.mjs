// Opt-in real-model task through a real PTY and the interactive Pi TUI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node-pty';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalScreen } from './lib/terminal-screen.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const provider = process.env.PIX_REAL_PROVIDER, model = process.env.PIX_REAL_MODEL;
if (!provider || !model) throw new Error('Set PIX_REAL_PROVIDER and PIX_REAL_MODEL to opt in to paid model calls');
const source = process.env.PIX_REAL_AGENT_DIR ?? join(homedir(), '.pix/agent');
// Keep macOS Unix socket paths below sockaddr_un's limit.
const home = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pix-tui-real-'));
chmodSync(home, 0o700);
const agent = join(home, '.pix/agent'), cwd = join(home, 'workspace');
mkdirSync(agent, { recursive: true, mode: 0o700 }); mkdirSync(cwd);
let terminal, screen;
async function until(check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Real TUI task timed out\n${screen?.viewport}`);
}
try {
  const credentials = JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8'));
  if (!credentials[provider]) throw new Error(`No saved credentials for ${provider}`);
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
  if (existsSync(join(source, 'models.json'))) {
    const models = JSON.parse(readFileSync(join(source, 'models.json'), 'utf8'));
    if (models.providers?.[provider]) writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: models.providers[provider] } }), { mode: 0o600 });
  }
  const settingsPath = join(source, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model,
    defaultThinkingLevel: 'off', defaultTools: ['read', 'write'], defaultProjectTrust: 'always',
    retry: { enabled: false }, ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}) }));
  const nonce = randomUUID();
  writeFileSync(join(cwd, 'input.json'), JSON.stringify({ nonce, values: [2, 4, 6, 8] }));
  const executable = process.env.PIX_REAL_CLI ?? process.execPath;
  terminal = spawn(executable, [...(process.env.PIX_REAL_CLI ? [] : [join(root, 'bin/pix.mjs')]), '--cwd', cwd], {
    cwd: root, cols: 100, rows: 32, name: 'xterm-256color',
    env: { ...process.env, HOME: home, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1' },
  });
  let exit;
  const exited = new Promise(resolve => terminal.onExit(value => { exit = value; resolve(value); }));
  screen = terminalScreen(terminal, 100, 32);
  await until(() => { if (exit) throw new Error(`TUI exited before task: ${screen.text}`); return screen.viewport.includes('enter send'); }, 30000);
  terminal.write('Read input.json using the read tool. Sum its values. Use the write tool to create output.json containing exactly {"nonce":the input nonce,"sum":the sum}. Only access files in this workspace. Do not inspect credentials or other directories. Reply with a short Markdown completion message.\r');
  await until(() => { if (exit) throw new Error(`TUI exited during task: ${screen.text}`); return existsSync(join(cwd, 'output.json')) && screen.viewport.includes('Ready'); });
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'output.json'), 'utf8')), { nonce, sum: 20 });
  const sessions = join(cwd, '.pi/sessions');
  const session = join(sessions, readdirSync(sessions).find(name => name.endsWith('.jsonl')));
  const entries = readFileSync(session, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const tools = entries.filter(entry => entry.message?.role === 'toolResult').map(entry => entry.message.toolName);
  assert.ok(tools.includes('read') && tools.includes('write'));
  assert.match(screen.text, /read/); assert.match(screen.text, /write/);
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts/cli-tui-real-screen.txt'), screen.viewport);
  terminal.write('/tree\r');
  await until(() => screen.viewport.includes('Session Tree'), 10000);
  writeFileSync(join(root, 'artifacts/cli-tui-real-tree.txt'), screen.viewport);
  terminal.write('\x1b');
  await until(() => !screen.viewport.includes('Session Tree'), 10000);
  terminal.write('/exit\r');
  const result = await exited;
  assert.equal(result.exitCode, 0);
  assert.ok(screen.raw.includes('\x1b[?2004l'), 'bracketed-paste mode was restored');
  const report = { passed: true, provider, model, timestamp: new Date().toISOString(),
    launcher: process.env.PIX_REAL_CLI ? 'packaged desktop runtime' : 'system Node.js',
    tools: [...new Set(tools)], checked: ['real interactive PTY', 'real external model inference',
      'actual read/write tools', 'output nonce and sum', 'native Pi tool cards', 'native Pi tree selector', 'normal exit and terminal restoration'] };
  writeFileSync(join(root, 'artifacts/cli-tui-real-agent.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  screen?.dispose(); terminal?.kill();
  try { process.kill(JSON.parse(readFileSync(join(home, '.pix/run/host.json'), 'utf8')).pid, 'SIGTERM'); } catch {}
  const socket = join(home, 'Library/Caches/pi-computer-use/bridge.sock');
  if (existsSync(socket)) await new Promise(resolve => {
    const client = createConnection(socket);
    const timer = setTimeout(() => client.destroy(), 1500);
    client.on('connect', () => client.write(JSON.stringify({ id: 'cleanup', cmd: 'shutdown' }) + '\n'));
    client.on('data', () => client.end()); client.on('error', () => client.destroy());
    client.on('close', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(home, { recursive: true, force: true });
}
