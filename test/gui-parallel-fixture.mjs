// Local deterministic model for manual GUI concurrency checks. No external API calls.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { electronBinary } from './lib/electron-binary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = process.argv[2] ? resolve(process.argv[2]) : join(root, 'artifacts', `gui-parallel-${randomUUID()}`);
const relativeHome = relative(join(root, 'artifacts'), home);
if (!relativeHome || isAbsolute(relativeHome) || relativeHome.startsWith('..') || !basename(home).startsWith('gui-parallel-'))
  throw new Error('Use an isolated gui-parallel-* directory inside artifacts');
const cwd = join(home, 'workspace');
const agent = join(home, '.pi', 'agent');
const sessions = join(cwd, '.pi', 'sessions');
for (const path of [agent, sessions, join(home, '.pix')]) mkdirSync(path, { recursive: true });
const requests = [];
const held = new Map();
let child;
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.end('ok');
    for (const finish of held.values()) finish();
    child?.kill();
    return;
  }
  if (req.url === '/state') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ home, cwd, requests, held: [...held.keys()] })); return;
  }
  if (req.url?.startsWith('/release/')) {
    held.get(decodeURIComponent(req.url.slice(9)))?.(); res.end('ok'); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  const message = input.messages?.findLast(m => m.role === 'user');
  const text = typeof message?.content === 'string' ? message.content : message?.content?.map(c => c.text ?? '').join('');
  const item = { text, status: 'running', messages: input.messages, started: Date.now() }; requests.push(item);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const id = randomUUID();
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'gui-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  // Pi's read result contains optional undefined fields in memory. Exercise
  // real tool persistence before branching, rather than only plain text replies.
  const userIndex = input.messages?.findLastIndex(m => m.role === 'user') ?? -1;
  const toolReplies = input.messages?.slice(userIndex + 1).filter(m => m.role === 'tool').length ?? 0;
  if ((process.env.PIX_GUI_READ_TOOL === '1' && input.messages?.at(-1)?.role !== 'tool') ||
      toolReplies < Number(process.env.PIX_GUI_TOOL_ROUNDS ?? 0)) {
    emit({ role: 'assistant', content: `Inspecting workspace for ${text}. ` });
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: `read-${id}`, type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: '.pi/sessions/gui-parallel.jsonl' }) } }] });
    emit({}, 'tool_calls'); item.status = 'completed'; res.end('data: [DONE]\n\n'); return;
  }
  emit({ role: 'assistant', content: `Output for ${text}. ` + 'Initial output. '.repeat(Math.ceil(Number(process.env.PIX_GUI_STREAM_PREFIX_BYTES ?? 0) / 16)) });
  let chunks = 0;
  const timer = setInterval(() => emit({ content: 'Working. '.repeat(Number(process.env.PIX_GUI_STREAM_REPEAT ?? 1)) +
    (process.env.PIX_GUI_STREAM_LABEL === '1' ? ` [${text} ${++chunks}] ` : '') }), Number(process.env.PIX_GUI_STREAM_MS ?? 3000));
  const finish = () => {
    clearInterval(timer); held.delete(text); item.status = 'completed';
    emit({ content: `Finished ${text}.` }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
  };
  res.on('close', () => { clearInterval(timer); held.delete(text); if (item.status === 'running') item.status = 'aborted'; });
  if (text?.includes('HOLD')) held.set(text, finish); else setTimeout(finish, 500);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'gui-local': {
  baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
  models: [{ id: 'gui-model', name: 'GUI Test Model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'gui-local', defaultModel: 'gui-model', defaultProjectTrust: 'always' }));
writeFileSync(join(home, '.pix', 'gui.settings.json'), JSON.stringify({ language: 'en', openLastSessionOnStartup: true, closeToTray: false }));
const timestamp = new Date().toISOString();
const header = { type: 'session', version: 3, id: randomUUID(), timestamp, cwd };
const sessionPath = join(sessions, `gui-parallel.jsonl`);
const entries = [header,
  { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'gui-local', modelId: 'gui-model' },
  { type: 'message', id: 'root', parentId: 'model', timestamp, message: { role: 'user', content: 'GUI ROOT', timestamp: Date.now() } },
  { type: 'message', id: 'answer', parentId: 'root', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Completed root: create parallel branches from here.' }], api: 'openai-completions', provider: 'gui-local', model: 'gui-model', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
];
const mainEntries = [...entries];
for (let i = 0; i < Number(process.env.PIX_GUI_NATIVE_BRANCHES ?? 0); i++) {
  mainEntries.push({ ...entries[2], id: `native-${i}-user`, parentId: 'answer',
    message: { ...entries[2].message, content: `Main native branch ${i}` } });
  mainEntries.push({ ...entries[3], id: `native-${i}-answer`, parentId: `native-${i}-user`,
    message: { ...entries[3].message, content: [{ type: 'text', text: `Native answer ${i}` }] } });
}
if (!existsSync(sessionPath)) writeFileSync(sessionPath, mainEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
// Persist real independent sessions for the large-graph GUI regression.
const branchCount = Number(process.env.PIX_GUI_BRANCHES ?? 0);
const tree = `${sessionPath}.pix-tree`;
if (branchCount && !existsSync(tree)) {
  mkdirSync(tree);
  for (let i = 0; i < branchCount; i++) {
    const id = `fixture-${i}`, branchHeader = { ...header, id, parentSession: sessionPath };
    const baseline = entries.slice(1), own = [];
    for (let turn = 0; turn < Number(process.env.PIX_GUI_TURNS ?? 5); turn++) {
      own.push({ ...entries[2], id: `u${turn}`, parentId: turn ? `a${turn - 1}` : 'answer',
        message: { ...entries[2].message, content: `Branch ${i} turn ${turn}` } });
      own.push({ ...entries[3], id: `a${turn}`, parentId: `u${turn}`,
        message: { ...entries[3].message, content: [{ type: 'text', text: `Answer ${i}/${turn}` + ' Historical output.'.repeat(Math.ceil(Number(process.env.PIX_GUI_REPLY_BYTES ?? 0) / 19)) }] } });
    }
    const source = [branchHeader, ...baseline, ...own].map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(tree, `${id}.jsonl`), source);
    writeFileSync(join(tree, `${id}.jsonl.checkpoint`), source);
    writeFileSync(join(tree, `${id}.jsonl.origin.json`), JSON.stringify({ id, parentId: 'main', forkEntryId: 'answer',
      requestId: id, request: { text: `Branch ${i}` }, inherited: { model: 'model', root: 'root', answer: 'answer' },
      header: branchHeader, baseline, status: 'idle', runId: id }) + '\n');
  }
}
child = spawn(electronBinary(root), ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(home, 'electron')}`, `--remote-debugging-port=${process.env.PIX_GUI_DEBUG_PORT ?? 9827}`, root], {
  cwd: root, env: { ...process.env, PIX_HOME: home, PIX_PROJECT: cwd, PI_CODING_AGENT_DIR: agent, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', chunk => writeFileSync(join(home, 'electron.log'), chunk, { flag: 'a' }));
child.on('exit', () => { writeFileSync(join(home, 'requests.json'), JSON.stringify(requests, null, 2)); server.close(); });
console.log(JSON.stringify({ home, cwd, port, sessionPath, electronPid: child.pid }));
