// Opt-in external-model verification. Credentials are copied to an isolated,
// private profile, never logged, and removed during teardown.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const provider = process.env.PIX_REAL_PROVIDER;
const model = process.env.PIX_REAL_MODEL;
if (!provider || !model) throw new Error('Set PIX_REAL_PROVIDER and PIX_REAL_MODEL to opt in to paid external model calls');
const source = process.env.PIX_REAL_AGENT_DIR ?? join(homedir(), '.pix', 'agent');
const home = mkdtempSync(join(tmpdir(), 'pix-cli-real-'));
process.once('exit', () => rmSync(home, { recursive: true, force: true }));
chmodSync(home, 0o700);
const cwd = join(home, 'workspace'), agent = join(home, '.pix', 'agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true, mode: 0o700 });
const credentials = JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8'));
if (!credentials[provider]) throw new Error(`No saved credentials for ${provider}`);
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
const sourceModels = join(source, 'models.json');
if (existsSync(sourceModels)) {
  const models = JSON.parse(readFileSync(sourceModels, 'utf8'));
  if (models.providers?.[provider]) writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: models.providers[provider] } }), { mode: 0o600 });
}
const settingsPath = join(source, 'settings.json');
const proxy = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')).httpProxy : undefined;
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model,
  defaultThinkingLevel: 'off', defaultProjectTrust: 'always', defaultTools: ['read', 'write'], retry: { enabled: false }, ...(proxy ? { httpProxy: proxy } : {}) }));
const nonce = randomUUID();
writeFileSync(join(cwd, 'input.json'), JSON.stringify({ nonce, values: [1, 3, 5, 7] }));
for (const name of ['A', 'B']) writeFileSync(join(cwd, `branch-${name}.json`), JSON.stringify({ branch: name, nonce: `${nonce}-${name}`, values: name === 'A' ? [2, 4, 6] : [10, 20, 30] }));
const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1' };
let hostPid;
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/pix.mjs'), '--cwd', cwd, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Real agent test timed out: ${args[0]}`)); }, 180000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      let events; try { events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return reject(new Error('CLI emitted invalid JSON')); }
      if (code !== 0) return reject(new Error(events.findLast(event => event.type === 'error')?.message ?? stderr ?? `CLI exited ${code}`));
      resolve(events);
    });
  });
}
const tools = events => events.filter(event => event.type === 'agent' && event.event.toolName).map(event => event.event.toolName);
try {
  console.log(`Testing ${provider}/${model} with real read/write tools in an isolated workspace`);
  const result = await cli(['run', 'Read input.json using the read tool. Calculate the sum of its values. Use the write tool to create output.json containing exactly the input nonce and the sum, as JSON {"nonce":...,"sum":...}. Only access files in this workspace. Do not inspect credentials or other directories. Reply with a short completion message.', '--json', '--thinking', 'off', '--timeout', '150']);
  const initial = result.findLast(event => event.type === 'result');
  assert.ok(initial);
  const status = await cli(['host', 'status']); hostPid = status[0].pid;
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'output.json'), 'utf8')), { nonce, sum: 16 });
  assert.ok(tools(result).includes('read') && tools(result).includes('write'), 'real model selected and executed both tools');
  console.log('Root task passed; running two real agent continuations from its node');
  const branches = await Promise.all(['A', 'B'].map(name => cli(['fork', initial.nodeId,
    `Read branch-${name}.json using the read tool. Sum its values. Use the write tool to create result-${name}.json with exactly {"branch":the input branch,"nonce":the input nonce,"sum":the sum}. Only access workspace files. Do not read result files from any other branch. Reply briefly.`,
    '--session', initial.session, '--json', '--thinking', 'off', '--timeout', '150'])));
  for (const [index, name] of ['A', 'B'].entries()) {
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, `result-${name}.json`), 'utf8')), { branch: name, nonce: `${nonce}-${name}`, sum: name === 'A' ? 12 : 60 });
    assert.ok(tools(branches[index]).includes('read') && tools(branches[index]).includes('write'));
  }
  const tree = (await cli(['tree', initial.session, '--json']))[0].snapshot;
  assert.equal(tree.projection.nodes.length, 3);
  assert.equal(tree.projection.nodes.filter(node => node.parentId === initial.nodeId).length, 2);
  const report = { passed: true, provider, model, timestamp: new Date().toISOString(),
    tasks: 3, treeNodes: tree.projection.nodes.length, treeBranches: tree.graph.runs.length,
    tools: [result, ...branches].map(events => [...new Set(tools(events))]),
    checked: ['real external model inference', 'actual read and write execution', 'output values and nonces', 'parallel CLI processes', 'shared PiX parent node', 'two child paths persisted'] };
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts', 'cli-real-agent.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  if (!hostPid) {
    try { hostPid = JSON.parse(readFileSync(join(home, '.pix/run/host.json'), 'utf8')).pid; } catch {}
  }
  if (hostPid) {
    try { process.kill(hostPid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 100; i++) {
      try { process.kill(hostPid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  // Remove temporary credentials even after a model or assertion failure.
  rmSync(join(agent, 'auth.json'), { force: true });
  rmSync(home, { recursive: true, force: true });
}
