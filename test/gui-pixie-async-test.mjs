// Real Electron/renderer/host/Pi tool-loop regression with a deterministic offline model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './lib/electron-binary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { recursive: true });
const home = mkdtempSync(join(artifacts, 'gui-pixie-async-'));
const workspace = join(home, 'workspace'), agent = join(home, '.pix', 'agent');
mkdirSync(workspace); mkdirSync(join(agent, 'extensions'), { recursive: true });
writeFileSync(join(home, '.pix', 'gui.settings.json'), JSON.stringify({ language: 'en', closeToTray: false,
  pixie: { defaultModel: 'faux/gui-async', restoreLastConversation: true } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'faux', defaultModel: 'gui-async', defaultProjectTrust: 'always' }));
const release = join(home, 'release-worker'), releaseOther = join(home, 'release-other'), calls = join(home, 'model-calls.jsonl');
writeFileSync(join(agent, 'extensions', 'gui-async.js'), `
import { existsSync, appendFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai/providers/faux'))};
export default pi => {
  const faux = fauxProvider({ models: [{ id: 'gui-async', contextWindow: 128000 }] }); pi.registerProvider(faux.provider);
  const text = message => typeof message?.content === 'string' ? message.content : message?.content?.map(part => part.text ?? '').join('') ?? '';
  const respond = async context => {
    faux.appendResponses([respond]);
    const index = context.messages.findLastIndex(message => message.role === 'user');
    const input = text(context.messages[index]);
    const tool = context.messages.slice(index + 1).findLast(message => message.role === 'toolResult');
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ input: input.slice(0, 200), tool: tool?.toolName, error: tool?.isError }) + '\\n');
    const call = (name, args) => {
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
    };
    if (tool?.isError) return fauxAssistantMessage('GUI_TOOL_ERROR: ' + text(tool));
    if (input.startsWith('GUI_WORK')) {
      const start = Date.now();
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now() - start > 120000) throw new Error('Worker release timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return tool ? fauxAssistantMessage('GUI_WORK_RESULT: report.txt was written; independent verification is still needed.')
        : call('write', { path: 'report.txt', content: 'legacy-client-compatible\\n' });
    }
    if (input.startsWith('GUI_VERIFY')) {
      if (!tool) return call('read', { path: 'report.txt' });
      if (!text(tool).includes('legacy-client-compatible')) throw new Error('Compatibility evidence missing');
      return fauxAssistantMessage('GUI_VERIFY_RESULT: report.txt contains legacy-client-compatible. Verification passed.');
    }
    if (input.startsWith('GUI_BUSY')) {
      const start = Date.now();
      while (!existsSync(${JSON.stringify(releaseOther)})) {
        if (Date.now() - start > 120000) throw new Error('Other question release timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return fauxAssistantMessage('GUI_BUSY_ANSWER：另一个问题已处理，现在可以继续跟进后台任务。');
    }
    if (input.startsWith('GUI_OTHER')) return fauxAssistantMessage('GUI_OTHER_ANSWER：任务仍在后台运行，我可以继续处理你的其他问题。');
    if (input.startsWith('A delegated PiX run needs your attention.')) {
      const event = JSON.parse(input.split('<delegation_event>\\n')[1].split('\\n</delegation_event>')[0]);
      const state = tool ? JSON.parse(text(tool)) : null;
      if (!state) return call('canvas_read', { taskId: event.task.id });
      if (state.output && (!state.task.purpose.includes('legacy') || !state.task.source.text.includes('GUI_ASYNC'))) throw new Error('Original intent was lost');
      if (state.task?.instruction?.startsWith('GUI_WORK') && state.output) return call('canvas_delegate', { taskId: event.task.id, text: 'GUI_VERIFY: independently read report.txt and verify its contents',
        purpose: 'Verify legacy client compatibility evidence', acceptance: 'Read report.txt and confirm legacy-client-compatible',
        branch: true, provider: 'faux', modelId: 'gui-async'
      });
      if (state.task && !state.output) return fauxAssistantMessage('GUI_FOLLOWUP_QUEUED：原任务结果已收到，已在原会话分支安排独立验证。');
      return fauxAssistantMessage('GUI_ASYNC_COMPLETE：已恢复原任务目标，执行与独立验证都在原 PiX 会话中完成。旧客户端兼容性证据已确认。');
    }
    if (input.startsWith('GUI_ASYNC')) {
      const state = tool ? JSON.parse(text(tool)) : null;
      if (!state) return call('canvas_inspect', { });
      if (state.task) return fauxAssistantMessage('GUI_DISPATCHED：任务已异步派出。你可以继续提问，完成后我会自动跟进。');
      if (!state.session) return call('canvas_new_session', { context: state.context });
      return call('canvas_delegate', { context: state.context, nodeId: null,
        text: 'GUI_WORK: create the compatibility report', purpose: 'Preserve legacy client compatibility',
        acceptance: 'Produce report.txt and arrange independent verification', provider: 'faux', modelId: 'gui-async' });
    }
    return fauxAssistantMessage('GUI unexpected input: ' + input);
  }; faux.setResponses([respond]);
}
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
    const path = join(home, name + '.png'); writeFileSync(path, Buffer.from(result.data, 'base64')); return path;
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
const port = 10000 + Math.floor(Math.random() * 500);
const child = spawn(process.env.ELECTRON_BINARY ?? electronBinary(root), ['--no-sandbox', '--disable-gpu',
  `--user-data-dir=${join(home, 'electron')}`, `--remote-debugging-port=${port}`, root], {
  cwd: root, env: { ...process.env, PIX_HOME: home, PIX_PROJECT: workspace, PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1', PIX_HOST_LINGER_MS: '1000', ELECTRON_RENDERER_URL: '', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
});
let stderr = '', cdp;
child.stderr.on('data', data => { stderr += String(data); });
const result = { home, checks: {} };
const journal = () => JSON.parse(readFileSync(join(agent, 'pixie', 'delegations.json'), 'utf8')).tasks;
const pinia = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia`;
const state = () => cdp.evaluate(`(() => { const p=${pinia}; const x=p._s.get('pixie'); return { running:x.running,error:x.error,messages:x.snapshot?.projection.messages.map(m=>m.text),current:p._s.get('session').current?.session.path, nodes:p._s.get('session').current?.projection.nodes }; })()`);
try {
  cdp = await until(async () => {
    if (child.exitCode !== null) throw new Error('Electron exited: ' + stderr);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = pages.find(page => page.type === 'page'); if (!page) return;
    const connected = new Cdp(page.webSocketDebuggerUrl); await connected.open(); return connected;
  });
  await until(() => cdp.evaluate(`Boolean(document.querySelector('[data-pixie-sprite]'))`));
  await cdp.click('[data-pixie-sprite]');
  await until(() => cdp.evaluate(`Boolean(document.querySelector('[data-pixie-card] textarea:not(:disabled)'))`));
  await cdp.evaluate(`(() => { window.__pixieScrollTrace=[]; document.addEventListener('scroll', event => { const el=event.target; if (!el.classList?.contains('pixie-messages')) return; window.__pixieScrollTrace.push({top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight}); if(window.__pixieScrollTrace.length>40)window.__pixieScrollTrace.shift(); },true); })()`);
  await cdp.type('GUI_ASYNC：请保留旧客户端兼容性，生成报告并独立验证。');
  await until(async () => { const x=await state(); if (x.error) throw new Error(x.error); return !x.running && x.messages?.some(m=>m.includes('GUI_DISPATCHED')); });
  const original = journal()[0]; assert.equal(original.state, 'running');
  result.checks.dispatchReturnsBeforeWorker = true;
  result.dispatchedScreenshot = await cdp.shot('01-dispatched');
  await cdp.type('GUI_OTHER：后台任务运行期间，能继续处理别的问题吗？');
  await until(async () => { const x=await state(); return !x.running && x.messages?.some(m=>m.includes('GUI_OTHER_ANSWER')); });
  assert.equal(journal()[0].state, 'running'); result.checks.otherConversationWhileRunning = true;
  result.parallelScreenshot = await cdp.shot('02-other-conversation');
  // Use the real New session button, leaving the delegated graph in the background.
  await cdp.click('[data-action="navigator-panel"]');
  await until(() => cdp.evaluate(`Boolean(document.querySelector('[data-action="create-project-session"]'))`));
  await cdp.click('[data-action="create-project-session"]');
  const changed = await until(async () => { const x=await state(); return x.current && x.current!==original.target.session ? x : null; });
  result.checks.switchedSessionWhileRunning = true;
  await cdp.type('GUI_BUSY：继续处理另一个问题。');
  await until(async () => (await state()).running);
  writeFileSync(release, 'release');
  await until(() => journal()[0].state === 'settled' && journal()[0].notification === 'pending');
  assert.equal((await state()).running, true);
  assert.equal(journal().length, 1);
  result.checks.completionQueuedWhilePixieBusy = true;
  writeFileSync(releaseOther, 'release');
  await until(async () => { const x=await state(); if (x.error) throw new Error(x.error); return !x.running && x.messages?.some(m=>m.startsWith('GUI_ASYNC_COMPLETE')); }, 60000);
  const completed = await state(), tasks = journal();
  assert.equal(tasks.length, 2); assert.ok(tasks.every(t=>t.state==='settled' && t.notification==='delivered'));
  assert.equal(tasks[1].parentTaskId, tasks[0].id); assert.equal(tasks[1].target.session, original.target.session);
  assert.notEqual(tasks[1].branchId, tasks[0].branchId);
  assert.equal(completed.current, changed.current); assert.equal(completed.nodes.length, 0);
  assert.equal(readFileSync(join(workspace, 'report.txt'), 'utf8'), 'legacy-client-compatible\n');
  result.checks.contextRecoveredAfterOtherConversation = true;
  result.checks.verificationDelegatedToOriginalGraph = true;
  result.checks.backgroundFollowupDoesNotStealView = true;
  await until(() => cdp.evaluate(`document.querySelector('[data-pixie-card]').innerText.includes('GUI_ASYNC_COMPLETE')`));
  assert.equal(await cdp.evaluate(`document.querySelector('[data-pixie-card]').innerText.includes('<delegation_event>')`), false);
  result.checks.internalEventsHiddenFromChat = true;
  await until(() => cdp.evaluate(`(() => { const el=document.querySelector('.pixie-messages'); return el.scrollHeight-el.scrollTop-el.clientHeight < 48; })()`));
  result.checks.completionReplyVisibleWithoutManualScroll = true;
  await delay(300);
  result.completedScreenshot = await cdp.shot('03-completed');
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(original.target.session)})`);
  await until(async () => (await state()).nodes?.length === 2);
  await cdp.click('[data-action="pixie-collapse"]');
  await delay(300);
  result.graphScreenshot = await cdp.shot('04-original-session');
  result.checks.actualFileWriteAndReadTools = true;
  result.tasks = tasks; result.rendererExceptions = cdp.errors;
  assert.deepEqual(cdp.errors, []);
  writeFileSync(join(home, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.error = String(error);
  try { result.scrollTrace = await cdp.evaluate('window.__pixieScrollTrace'); } catch {}
  try { result.state = await state(); result.failureScreenshot = await cdp.shot('failure'); } catch {}
  writeFileSync(join(home, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
} finally {
  writeFileSync(release, 'cleanup');
  writeFileSync(releaseOther, 'cleanup');
  writeFileSync(join(home, 'electron.log'), stderr);
  cdp?.socket.close();
  child.kill();
  await delay(2000);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // Only the isolated test profile's host is eligible for cleanup.
  const hostFile = join(home, '.pix', 'run', 'host.json');
  if (existsSync(hostFile)) {
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    try { process.kill(host.pid, 'SIGTERM'); } catch {}
  }
}
