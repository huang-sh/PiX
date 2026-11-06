// Opt-in live-model GUI test: no scripted responses or provider replacements.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './lib/electron-binary.mjs';
import { graphToolEvidence } from './lib/graph-tool-evidence.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const provider = process.env.PIX_REAL_PROVIDER, model = process.env.PIX_REAL_MODEL;
if (!provider || !model) throw new Error('Set PIX_REAL_PROVIDER and PIX_REAL_MODEL to opt in to external model calls');
const source = process.env.PIX_REAL_AGENT_DIR ?? join(homedir(), '.pix', 'agent');
const home = mkdtempSync(join(tmpdir(), 'pixie-real-')); chmodSync(home, 0o700);
const artifacts = join(root, 'artifacts', 'pixie-real-' + Date.now()); mkdirSync(artifacts, { recursive: true });
const workspace = join(home, 'workspace'), agent = join(home, '.pix', 'agent');
mkdirSync(workspace); mkdirSync(agent, { recursive: true, mode: 0o700 });
const authFile = join(agent, 'auth.json'), modelFile = join(agent, 'models.json');
process.once('exit', () => { rmSync(authFile, { force: true }); rmSync(modelFile, { force: true }); });
const credentials = JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8'));
if (!credentials[provider]) throw new Error('No saved credentials for ' + provider);
writeFileSync(authFile, JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
if (existsSync(join(source, 'models.json'))) {
  const config = JSON.parse(readFileSync(join(source, 'models.json'), 'utf8'));
  if (config.providers?.[provider]) writeFileSync(modelFile, JSON.stringify({ providers: { [provider]: config.providers[provider] } }), { mode: 0o600 });
}
const settings = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8'));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model,
  defaultThinkingLevel: 'off', defaultProjectTrust: 'always', retry: { enabled: false }, ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}) }));
writeFileSync(join(home, '.pix', 'gui.settings.json'), JSON.stringify({ language: 'en', closeToTray: false,
  pixie: { defaultModel: provider + '/' + model, restoreLastConversation: true } }));
const input = { nonce: randomUUID(), currency: 'CNY', items: [{ quantity: 3, priceMinor: 1299 }, { quantity: 2, priceMinor: 2599 }, { quantity: 1, priceMinor: 499 }] };
const expected = { schemaVersion: 1, nonce: input.nonce, currency: input.currency, totalMinor: input.items.reduce((sum, item) => sum + item.quantity * item.priceMinor, 0) };
writeFileSync(join(workspace, 'TASK.md'), `订单兼容性任务。只访问当前项目，禁止访问其他目录或凭据。
先实际运行 node wait-input.mjs 等待外部系统提供 input.json；等待是任务的一部分，不要绕过或自造输入。
收到数据后，用整数分计算所有 quantity * priceMinor 之和。写 result.json，字段必须严格为 schemaVersion:1、nonce:原输入nonce、currency:原输入currency、totalMinor:总金额整数分。不要改验证脚本，不要自己执行 verify.mjs，独立验证由 Pixie 另派分支执行。
`);
writeFileSync(join(workspace, 'wait-input.mjs'), `import {existsSync,readFileSync} from 'node:fs';
const start=Date.now(); while(!existsSync('input.json')) { if(Date.now()-start>300000)throw new Error('Input not released'); await new Promise(r=>setTimeout(r,250)); } console.log(readFileSync('input.json','utf8'));
`);
writeFileSync(join(workspace, 'verify.mjs'), `import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync('input.json','utf8')); const result=JSON.parse(readFileSync('result.json','utf8')); const expected={schemaVersion:1,nonce:input.nonce,currency:input.currency,totalMinor:input.items.reduce((sum,item)=>sum+item.quantity*item.priceMinor,0)}; assert.deepEqual(result,expected); writeFileSync('verification.json',JSON.stringify({passed:true,nonce:input.nonce,totalMinor:expected.totalMinor})); console.log('INDEPENDENT_VERIFICATION_PASSED '+input.nonce);
`);
class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 0; this.pending = new Map(); this.errors = []; }
  async open() {
    await new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails);
      const p = this.pending.get(message.id); if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    });
    await this.send('Runtime.enable'); await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const value = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result?.value;
  }
  async click(selector) {
    let previous;
    const point = await until(async () => {
      const point = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return r.width && r.height && el.contains(document.elementFromPoint(x,y)) ? {x,y} : null; })()`);
      const stable = point && previous && Math.abs(point.x-previous.x)<1 && Math.abs(point.y-previous.y)<1;
      previous = point; return stable ? point : null;
    });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async type(text) {
    await this.click('[data-pixie-card] textarea');
    await this.send('Input.insertText', { text });
    await this.click('[data-pixie-card] .composer-submit');
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const path = join(artifacts, name + '.png'); writeFileSync(path, Buffer.from(result.data, 'base64')); return path;
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  let last;
  for (const start = Date.now(); Date.now() - start < timeout;) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await delay(150);
  }
  throw last ?? new Error('Timed out waiting for GUI condition');
}
const verifierSource = readFileSync(join(workspace, 'verify.mjs'), 'utf8');
const port = 10500 + Math.floor(Math.random() * 500);
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), PIX_HOME: home, PIX_PROJECT: workspace, PI_CODING_AGENT_DIR: agent,
  PI_SKIP_VERSION_CHECK: '1', PIX_HOST_LINGER_MS: '1000', ELECTRON_RENDERER_URL: '', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.PI_OFFLINE;
const child = spawn(process.env.ELECTRON_BINARY ?? electronBinary(root), ['--no-sandbox', '--disable-gpu',
  `--user-data-dir=${join(home, 'electron')}`, `--remote-debugging-port=${port}`, root], { cwd: root, env });
let stderr = '', cdp;
child.stderr.on('data', data => { stderr += String(data); });
const result = { home, artifacts, provider, model, startedAt: new Date().toISOString(), checks: {} };
const journal = () => existsSync(join(agent, 'pixie', 'delegations.json')) ? JSON.parse(readFileSync(join(agent, 'pixie', 'delegations.json'), 'utf8')).tasks : [];
const pinia = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia`;
const state = () => cdp.evaluate(`(() => { const p=${pinia}, x=p._s.get('pixie'); return {running:x.running,error:x.error,snapshot:JSON.parse(JSON.stringify(x.snapshot??null)),current:p._s.get('session').current?.session.path,nodes:p._s.get('session').current?.projection.nodes}; })()`);
function save(name, value) { writeFileSync(join(artifacts, name), JSON.stringify(value, null, 2)); }
function progress(stage) { result.stage = stage; console.log(JSON.stringify({ stage, at: new Date().toISOString(), tasks: journal().map(t=>({id:t.id,state:t.state,notification:t.notification})) })); }
function canvasCalls(snapshot) {
  return snapshot.entries.flatMap(entry => entry.message?.role === 'assistant' && Array.isArray(entry.message.content)
    ? entry.message.content.filter(part => part.type === 'toolCall' && part.name.startsWith('canvas_')) : []);
}
function toolAction(call) { return call.name.slice('canvas_'.length).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()); }
function assertFirstAttemptSuccess(snapshot) {
  assert.ok(!canvasCalls(snapshot).some(call => Object.hasOwn(call.arguments,'action')), 'native tools have no action argument');
  const failures = snapshot.entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolName?.startsWith('canvas_') && entry.message.isError)
    .map(entry => entry.message.content);
  assert.deepEqual(failures, [], 'every canvas call must succeed without learning from errors');
  assert.ok(!canvasCalls(snapshot).some(call => ['send','submit'].includes(toolAction(call))), 'tracked work must never fall back to untracked execution');
}
const ask = async text => {
  const before = (await state()).snapshot?.projection.messages.filter(m=>m.role==='user').length ?? 0;
  await cdp.type(text);
  await until(async () => { const x = await state(); if(x.error) throw new Error(x.error); return !x.running && x.snapshot?.projection.messages.filter(m=>m.role==='user').length > before; }, 180000);
  const x = await state(); save('pixie-transcript.json', x.snapshot);
  assertFirstAttemptSuccess(x.snapshot);
  const reply = x.snapshot.projection.messages.findLast(m=>m.role==='assistant');
  if (reply?.isError) throw new Error(reply.errorMessage ?? 'Model response failed');
  console.log(JSON.stringify({ reply: reply?.text })); return x;
};
try {
  progress('launch');
  cdp = await until(async () => {
    if (child.exitCode !== null) throw new Error('Electron exited');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = pages.find(page=>page.type==='page'); if (!page) return;
    const client = new Cdp(page.webSocketDebuggerUrl); await client.open(); return client;
  });
  await until(()=>cdp.evaluate(`Boolean(document.querySelector('[data-pixie-sprite]'))`));
  await cdp.click('[data-pixie-sprite]');
  await until(()=>cdp.evaluate(`Boolean(document.querySelector('[data-pixie-card] textarea:not(:disabled)'))`));
  await ask('做一项后台任务：读取当前项目 TASK.md，按要求生成 result.json。请异步派出，不要等待任务运行结束；完成后在同一个 PiX 会话中新建独立验证分支，由另一个 agent 直接执行 node verify.mjs 并生成 verification.json。只访问当前项目，不改验证脚本，不使用项目外临时文件。全部完成再汇报验收结果，不能仅凭执行者口述判定成功。');
  const original = journal()[0]; assert.ok(original, 'Pixie must choose tracked delegation');
  assert.equal(original.state, 'running'); assert.equal(existsSync(join(workspace,'input.json')),false);
  result.checks.realModelDispatchedAsynchronously = true; progress('dispatched');
  result.dispatchedScreenshot = await cdp.shot('01-dispatched');
  for (const question of ['先聊别的：你和执行 agent 的分工是什么？用一句话说明。', '还没验收时，你会怎么描述进度？不要查询后台，简单回答。', '验证失败时你会如何跟进？不要运行检查，只说处理原则。']) {
    await ask(question); assert.equal(journal()[0].state,'running');
  }
  result.checks.threeOtherConversationsWhileRunning = true; progress('other-conversations-complete');
  await cdp.click('[data-action="navigator-panel"]');
  await cdp.click('[data-action="create-project-session"]');
  const changed = await until(async () => { const x=await state(); return x.current && x.current!==original.target.session ? x : null; });
  result.checks.switchedVisibleSession = true;
  writeFileSync(join(workspace,'input.json'),JSON.stringify(input)); progress('input-released-no-more-user-prompts');
  await until(async () => {
    const x=await state(); save('pixie-transcript.json',x.snapshot); save('tasks.json',journal());
    if(x.error) throw new Error(x.error);
    return !x.running && existsSync(join(workspace,'verification.json')) && journal().length >= 2 && journal().every(t=>t.state==='settled'&&t.notification==='delivered');
  }, 360000);
  const completed=await state(), tasks=journal();
  assertFirstAttemptSuccess(completed.snapshot);
  assert.deepEqual(JSON.parse(readFileSync(join(workspace,'result.json'),'utf8')),expected);
  const verification = JSON.parse(readFileSync(join(workspace,'verification.json'),'utf8'));
  assert.ok(JSON.stringify(verification).includes(input.nonce), 'verification report ties back to the original input');
  assert.equal(readFileSync(join(workspace,'verify.mjs'),'utf8'), verifierSource, 'verification script was not changed');
  assert.ok(tasks.slice(1).some(t=>t.parentTaskId===original.id && t.target.session===original.target.session && t.branchId!==tasks[0].branchId));
  assert.equal(completed.current,changed.current); assert.equal(completed.nodes.length,0);
  result.checks.correctNonceCurrencySchemaAndIntegerTotal=true;
  result.checks.automaticIndependentVerificationInOriginalSession=true;
  result.checks.followupPreservesCurrentView=true;
  assert.ok(completed.snapshot.entries.some(e=>e.type==='custom_message'&&e.customType==='pixie.task-event'&&e.display===false));
  assert.ok(!completed.snapshot.projection.messages.some(m=>m.role==='user'&&m.text.includes('<delegation_event>')));
  result.checks.contextRestoredViaHiddenEvent=true;
  await delay(500); result.completedScreenshot=await cdp.shot('02-completed');
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(original.target.session)})`);
  await until(async()=> (await state()).nodes?.length >= 2);
  const graph = await cdp.evaluate(`JSON.parse(JSON.stringify(${pinia}._s.get('session').current))`); save('graph.json',graph);
  const { entries: executionEntries, calls: toolCalls } = graphToolEvidence(graph);
  save('tool-calls.json',toolCalls);
  const verificationCall = toolCalls.find(c=>c.branchId!==tasks[0].branchId&&c.name==='bash'&&c.arguments.command?.includes('verify.mjs'));
  assert.ok(verificationCall,'independent verifier actually ran the script');
  assert.ok(toolCalls.some(c=>c.name==='bash'&&c.arguments.command?.includes('wait-input.mjs')),'worker actually waited for external data');
  assert.ok(executionEntries.some(e=>e.message?.role==='toolResult' && e.message.toolCallId===verificationCall.id && !e.message.isError && JSON.stringify(e.message.content).includes('INDEPENDENT_VERIFICATION_PASSED '+input.nonce)), 'successful verification comes from actual tool output');
  result.checks.realToolsExecuted=true;
  const pixieTools=completed.snapshot.entries.flatMap(e=>e.message?.role==='assistant'&&Array.isArray(e.message.content)?e.message.content.filter(c=>c.type==='toolCall').map(c=>c.name):[]);
  assert.ok(pixieTools.length && pixieTools.every(name=>name.startsWith('canvas_')));
  result.checks.pixieOnlyCoordinates=true;
  assert.ok(!pixieTools.includes('canvas_skill'), 'ordinary delegation needs no auxiliary skill');
  progress('testing-canvas-controls');
  const controls = await ask('请操作当前画布：把生成 result.json 的执行节点标注为“订单执行”，选中并居中它；显示小地图，搜索“result.json”，过滤设为 all。然后在该节点后准备内容为“检查订单”的草稿，修改为“检查订单兼容性”，最后取消草稿。整个过程不要启动任何 agent。');
  const actions = canvasCalls(controls.snapshot).map(call=>toolAction(call));
  const calls = canvasCalls(controls.snapshot);
  for (const [skill, firstTool] of [['canvas-view','canvas_label'], ['canvas-editing','canvas_compose']]) {
    const loaded = calls.findIndex(call => call.name === 'canvas_skill' && call.arguments.name === skill);
    assert.ok(loaded >= 0 && loaded < calls.findIndex(call => call.name === firstTool), skill + ' must load before its tools');
  }
  result.checks.auxiliarySkillsLoadedOnDemand=true;
  // Assert the requested state, not redundant reads/selections of an already
  // selected node. The draft's intermediate edits do require actual calls.
  for (const action of ['inspect','newSession','delegate','compose','draft','cancelDraft']) assert.ok(actions.includes(action), 'real model exercised '+action);
  assert.ok(canvasCalls(controls.snapshot).some(call=>toolAction(call)==='compose'&&call.arguments.nodeId===tasks[0].nodeId&&call.arguments.text==='检查订单'));
  assert.ok(canvasCalls(controls.snapshot).some(call=>toolAction(call)==='draft'&&call.arguments.text==='检查订单兼容性'));
  const view = await cdp.evaluate(`(async () => JSON.parse(JSON.stringify(await ${pinia}._s.get('canvas').execute({action:'inspect',include:['draft','layout']}))))()`);
  assert.equal(view.nodes.find(node=>node.id===tasks[0].nodeId)?.label,'订单执行');
  assert.equal(view.selectedNodeId,tasks[0].nodeId);
  assert.equal(view.minimap,true); assert.equal(view.search.text,'result.json'); assert.equal(view.filter,'all');
  assert.equal(view.draft.visible,false); assert.equal(view.totalNodes,graph.projection.nodes.length);
  assert.ok(!view.runs.some(run=>run.status==='running'));
  result.checks.basicCanvasControls=true;
  result.checks.zeroCanvasErrors=true;
  result.canvasCalls=canvasCalls(controls.snapshot).map(call=>({name:call.name,arguments:call.arguments}));
  await cdp.click('[data-action="pixie-collapse"]'); await delay(300); result.graphScreenshot=await cdp.shot('03-graph');
  result.finalReply=completed.snapshot.projection.messages.findLast(m=>m.role==='assistant')?.text;
  result.tasks=tasks; result.rendererExceptions=cdp.errors; assert.deepEqual(cdp.errors,[]);
  result.checks.noExternalTmpFilesObserved = !toolCalls.some(call => call.name === 'bash' && /\/(?:private\/)?tmp\//.test(call.arguments.command ?? ''));
  assert.ok(result.checks.noExternalTmpFilesObserved, 'task forbids accessing files outside its workspace, including /tmp');
  result.passed=true; progress('passed');
} catch(error) {
  result.error=String(error); process.exitCode=1;
  try { save('pixie-transcript.json',(await state()).snapshot); result.failureScreenshot=await cdp.shot('failure'); } catch {}
  console.error(String(error));
} finally {
  writeFileSync(join(workspace,'input.json'),JSON.stringify(input));
  save('tasks.json',journal()); save('report.json',result);
  for(const file of ['TASK.md','input.json','result.json','verification.json','verify.mjs']) if(existsSync(join(workspace,file))) writeFileSync(join(artifacts,file),readFileSync(join(workspace,file)));
  cdp?.socket.close(); child.kill(); await delay(2000);
  if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');
  try { process.kill(JSON.parse(readFileSync(join(home,'.pix/run/host.json'),'utf8')).pid,'SIGTERM'); } catch {}
  rmSync(authFile,{force:true}); rmSync(modelFile,{force:true});
  console.log(JSON.stringify({ passed:result.passed??false, artifacts, stage:result.stage, checks:result.checks, error:result.error }));
}
