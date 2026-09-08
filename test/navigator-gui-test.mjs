import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { electronBinary } from './lib/electron-binary.mjs';

const root = process.cwd();
const home = mkdtempSync(join(root, 'artifacts', 'navigator-ui-'));
mkdirSync(join(home, '.pix'), { recursive: true });
mkdirSync(join(home, 'project'));
mkdirSync(join(home, 'project', '.pi'));
cpSync(join(root, 'test', 'workspace', '.pi', 'sessions'), join(home, 'project', '.pi', 'sessions'), { recursive: true });
writeFileSync(join(home, '.pix', 'settings.json'), JSON.stringify({ language: 'zh-CN', closeToTray: false, openLastSessionOnStartup: true }));
const port = 10000 + Math.floor(Math.random() * 1000);
const child = spawn(electronBinary(root), ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, 'electron')}`, root], {
  cwd: root, windowsHide: true,
  env: { ...process.env, PIX_HOME: home, PIX_PROJECT: join(home, 'project'), PI_OFFLINE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', data => stderr += data);
child.on('exit', (code) => console.log('Test Electron exited:', code, stderr.slice(-2000)));
let socket;
let sequence = 0;
const pending = new Map();
const errors = [];
async function retry(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try { return await fn(); } catch (e) { error = e; }
    await sleep(50);
  } while (Date.now() < deadline);
  throw error;
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const until = expression => retry(async () => assert.ok(await evaluate(expression), expression));
async function point(selector) {
  return evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
}
async function move(p) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }); }
async function click(selector, twice = false) {
  const p = await point(selector);
  await move(p);
  for (let count = 1; count <= (twice ? 2 : 1); count++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: count, ...p });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: count, ...p });
    if (twice && count === 1) await sleep(80);
  }
}
const button = '[data-action="navigator-panel"]';
const pinButton = '[data-action="navigator-pin"]';
const expanded = `document.querySelector('${button}').getAttribute('aria-expanded')==='true'`;
const pinned = `document.querySelector('${pinButton}').getAttribute('aria-pressed')==='true'`;
async function togglePin() {
  if (!await evaluate(expanded)) await click(button);
  await until(`document.querySelector('#navigator-panel').getBoundingClientRect().left===0 && ${expanded}`);
  const before = await evaluate(pinned);
  await click(pinButton);
  await until(before ? `!(${pinned})` : pinned);
}
const rects = `(() => { const nav=document.querySelector('#navigator-panel').getBoundingClientRect();const graph=document.querySelector('#graph-panel').getBoundingClientRect();return {nav:nav.width,graphX:graph.x,graphWidth:graph.width}; })()`;
const report = {};
try {
  const page = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(page => page.type === 'page');
    assert.ok(page); return page;
  });
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.once('open', resolve));
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  });
  await send('Runtime.enable');
  await until(`window.__pixTest && !__pixTest.state().loading && document.querySelector('#navigator-panel')`);
  await until(`__pixTest.state().current && document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('layout').panelsSettled`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(`!(${expanded})`);
  // Reverse transitions before they finish, including both nested splitters at once.
  for (let toggle = 0; toggle < 3; toggle++) {
    await click('[data-action="chat-panel"]');
    await click('[data-action="tool-panel"]');
    await sleep(60);
  }
  await until(`['chat','content'].every(id=>Math.abs(document.querySelector('#'+id+'-panel').getBoundingClientRect().width-__pixTest.state().layout.widths[id])<1)`);
  report.rapidRightToggles = await evaluate(`__pixTest.state().layout`);
  assert.equal(report.rapidRightToggles.widths.chat,356, 'rapid toggles preserve chat width');
  assert.equal(report.rapidRightToggles.widths.content,320, 'rapid toggles preserve tool width');
  for (const [panel, selector] of [['chat','.resize-handle:has(+ #chat-panel)'],['content','.resize-handle:has(+ #content-panel)']]) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#${panel}-panel')).transitionDuration`),'0s', `${panel} keyboard resize must not animate`);
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  }
  await click('[data-action="chat-panel"]');
  await click('[data-action="tool-panel"]');
  await until(`['chat','content'].every(id=>document.querySelector('#'+id+'-panel').getBoundingClientRect().width===0)`);
  await evaluate(`document.querySelector('${button}').focus()`);
  for (let toggle = 0; toggle < 3; toggle++) {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await sleep(60);
  }
  await until(`${expanded} && document.querySelector('#navigator-panel').getBoundingClientRect().left===0`);
  assert.equal(await evaluate(`document.querySelector('#navigator-panel').inert`),false, 'reopened navigator is interactive');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await until(`getComputedStyle(document.querySelector('#navigator-panel')).display==='none'`);
  // The new header control must support keyboard activation without auto-hiding under focus.
  await click(button);
  await until(`${expanded} && document.querySelector('#navigator-panel').getBoundingClientRect().left===0`);
  await evaluate(`document.querySelector('${pinButton}').focus()`);
  for (const expected of [true,false]) {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    assert.equal(await evaluate(pinned), expected, 'Space toggles the focused pin button');
    assert.ok(await evaluate(expanded), 'pinning only changes mode');
  }
  await move({x:1100,y:500});
  await sleep(2200);
  assert.ok(await evaluate(`${expanded} && document.activeElement.matches('${pinButton}')`), 'keyboard focus protects the floating panel');
  await evaluate(`document.querySelector('${button}').focus()`);
  await until(`getComputedStyle(document.querySelector('#navigator-panel')).display==='none'`);
  report.keyboardPin = 'passed';
  await togglePin();
  await until(`${expanded} && ${pinned}`);
  await until(`document.querySelector('#navigator-panel').getBoundingClientRect().left===0`);
  await until(`Boolean(document.querySelector('#chat-panel .copy-button'))`);
  // Exercise the real trigger with the outer clip guard disabled: collapsed
  // chat copy-status spans used to escape to .shell, and Tab reached their
  // invisible buttons, scrolling the navigator about 31px off the left edge.
  await evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'legacy-overflow';
    style.textContent = '.shell,.app-content{overflow:hidden!important}';
    document.head.append(style);
    document.querySelector('.graph-controls button:last-child').focus();
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  report.collapsedPanelFocus = await evaluate(`(() => {
    const shell = document.querySelector('.shell');
    const status = document.querySelector('#chat-panel .copy-button .sr-only');
    return { hiddenFocus: !!document.activeElement.closest('#chat-panel,#content-panel'),
      overflow: shell.scrollWidth-shell.clientWidth, scroll: shell.scrollLeft,
      navLeft: document.querySelector('#navigator-panel').getBoundingClientRect().left,
      statusContained: status.offsetParent === status.parentElement };
  })()`);
  assert.deepEqual(report.collapsedPanelFocus, {hiddenFocus:false,overflow:0,scroll:0,navLeft:0,statusContained:true});
  await evaluate(`document.querySelector('#chat-panel .copy-button').focus()`);
  assert.equal(await evaluate(`!!document.activeElement.closest('#chat-panel')`), false, 'collapsed panel also blocks programmatic focus');
  await evaluate(`document.querySelector('#legacy-overflow').remove()`);
  await click('[data-action="chat-panel"]');
  await until(`document.querySelector('#chat-panel').getBoundingClientRect().width>100`);
  await evaluate(`document.querySelector('#chat-panel .copy-button').focus({preventScroll:true})`);
  assert.equal(await evaluate(`!!document.activeElement.closest('#chat-panel')`), true, 'expanded panel regains focusability');
  await sleep(500);
  report.pinnedChat = await evaluate(`({nav:document.querySelector('#navigator-panel').getBoundingClientRect().width,chat:document.querySelector('#chat-panel').getBoundingClientRect().width,stored:__pixTest.state().layout.widths.chat})`);
  assert.ok(Math.abs(report.pinnedChat.chat - 356) < 2, 'pinning preserves the saved 356px chat width');
  assert.equal(report.pinnedChat.stored, 356);
  // Focus/scrollIntoView on overflowing content must never pan the workbench
  // itself. Only the navigator's project list is a scrolling surface.
  const checkNavigatorBounds = async () => {
    await move(await point('.session-search input'));
    for (const selector of ['.shell', '.app-content']) {
      await evaluate(`(() => {
        const parent = document.querySelector(${JSON.stringify(selector)});
        const probe = document.createElement('button');
        probe.dataset.boundaryProbe = '';
        probe.style.cssText = 'position:absolute;left:calc(100% + 40px);top:80px;width:20px;height:20px';
        parent.append(probe);
        probe.focus();
        probe.scrollIntoView({block:'nearest',inline:'nearest'});
      })()`);
      const bounds = await evaluate(`(() => {
        const nav = document.querySelector('#navigator-panel').getBoundingClientRect();
        const header = document.querySelector('.navigator-panel .panel-header').getBoundingClientRect();
        const shell = document.querySelector('.shell');
        const content = document.querySelector('.app-content');
        return {navLeft:nav.left, headerLeft:header.left, shellScroll:shell.scrollLeft, contentScroll:content.scrollLeft};
      })()`);
      assert.deepEqual(bounds, {navLeft:0,headerLeft:0,shellScroll:0,contentScroll:0}, `${selector}: ${JSON.stringify(bounds)}`);
      await evaluate(`document.querySelector('[data-boundary-probe]').remove()`);
    }
    return true;
  };
  report.pinnedBounds = await checkNavigatorBounds();
  await click(button);
  report.immediateCollapse = await evaluate(`({expanded:${expanded},pinned:${pinned}})`);
  assert.deepEqual(report.immediateCollapse, {expanded:false,pinned:true});
  await click(button);
  assert.ok(await evaluate(expanded), 'single click immediately expands');
  await click(button,true);
  assert.ok(await evaluate(`${expanded} && ${pinned}`), 'double click does not change pinning');
  await togglePin();
  report.floatingBounds = await checkNavigatorBounds();
  // Both right-side panels must retain pixels when the navigator changes the available space.
  await click('[data-action="tool-panel"]');
  await until(`document.querySelector('#content-panel').getBoundingClientRect().width>100`);
  await sleep(500);
  const rightWidths = () => evaluate(`({chat:document.querySelector('#chat-panel').getBoundingClientRect().width,content:document.querySelector('#content-panel').getBoundingClientRect().width,saved:__pixTest.state().layout.widths})`);
  const checkWidths = async () => {
    const widths = await rightWidths();
    assert.ok(Math.abs(widths.chat-356)<2, JSON.stringify(widths));
    assert.ok(Math.abs(widths.content-320)<2, JSON.stringify(widths));
    assert.equal(widths.saved.chat,356);
    assert.equal(widths.saved.content,320);
    return widths;
  };
  await checkWidths();
  await togglePin();
  await until(pinned);
  await sleep(500);
  report.bothPinned = await checkWidths();
  // Check the entire toggle, not just the settled widths: sizing transitions
  // used to move the chat even though its final pixel width was unchanged.
  report.pinnedToggleMotion = [];
  for (const [contentOpen, opening] of [[true,false],[true,true],[false,false],[false,true]]) {
    if (!contentOpen && !opening) {
      await click('[data-action="tool-panel"]');
      await sleep(500);
    }
    await evaluate(`(() => {
      const rect = () => ['#chat-panel','#content-panel','.branch-messages-inner','.chat-composer'].map(selector => {
        const r=document.querySelector(selector).getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      });
      window.navigatorMotion = {before:rect(),frames:[]};
      const end=performance.now()+1200;
      const sample=() => {
        // Sample after rendering, so ResizeObserver can apply pixel sizes first.
        setTimeout(() => window.navigatorMotion.frames.push(rect()),0);
        if(performance.now()<end) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    await click(button);
    await until(opening ? expanded : `!(${expanded})`);
    await sleep(800);
    const motion = await evaluate('window.navigatorMotion');
    const maxShift = Math.max(...motion.frames.flatMap(frame => frame.flatMap((rect,index) =>
      Object.keys(rect).map(key => Math.abs(rect[key]-motion.before[index][key])))));
    report.pinnedToggleMotion.push({contentOpen,opening,maxShift,frames:motion.frames.length});
    assert.ok(motion.frames.length>0, 'toggle has rendered samples');
    assert.equal(maxShift, 0, `pinned navigator ${opening?'expand':'collapse'} moves right panels by ${maxShift}px`);
    assert.equal((await rightWidths()).chat,356);
    if (contentOpen) await checkWidths();
  }
  await click('[data-action="tool-panel"]');
  await sleep(500);
  const resize = await point('.navigator-resize');
  await move(resize);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...resize});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:resize.x+80,y:resize.y});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:resize.x+80,y:resize.y});
  await until(`__pixTest.state().layout.widths.navigator>320`);
  await sleep(500);
  report.afterResize = await checkWidths();
  report.resizedBounds = await checkNavigatorBounds();
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(home, 'navigator-boundary.png'), Buffer.from(screenshot.data, 'base64'));
  await send('Page.reload');
  await until(`window.__pixTest && !__pixTest.state().loading && document.querySelector('#navigator-panel')`);
  await until(`__pixTest.state().current && document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('layout').panelsSettled`);
  assert.ok(await evaluate(`${pinned} && ${expanded}`), 'reload restores the pinned panel');
  await click('[data-action="chat-panel"]');
  await click('[data-action="tool-panel"]');
  await sleep(800);
  report.afterReload = await checkWidths();
  // Native pixel rendering must still follow the splitter's drag callbacks.
  for (const [panel, selector] of [['chat','.resize-handle:has(+ #chat-panel)'],['content','.resize-handle:has(+ #content-panel)']]) {
    for (const delta of [-40,40]) {
      const before = await rightWidths();
      const handle = await point(selector);
      await move(handle);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...handle});
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:handle.x+delta,y:handle.y});
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#${panel}-panel')).transitionDuration`),'0s', `${panel} drag disables transitions`);
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:handle.x+delta,y:handle.y});
      await sleep(300);
      const after = await rightWidths();
      assert.ok(Math.abs(after[panel]-before[panel]+delta)<2, `${panel} follows divider drag`);
      assert.equal(after[panel],after.saved[panel], `${panel} renders the saved pixel width`);
    }
  }
  report.afterRightPanelResize = await checkWidths();
  // Check overlay vs reserved-space layout in a normal and minimum-size window.
  report.modeGeometry = [];
  const geometry = () => evaluate(`(() => {
    const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};};
    const nav=rect('#navigator-panel'), graph=rect('#graph-panel');
    const header=rect('.navigator-panel .panel-header'), search=rect('.session-search'), footer=rect('.navigator-footer');
    return {nav,graph,header,search,footer,viewport:innerWidth,height:innerHeight,
      chat:rect('#chat-panel'),content:rect('#content-panel'),
      navOnTop:!!document.elementFromPoint(20,header.bottom+20)?.closest('#navigator-panel')};
  })()`);
  for (const viewport of [1280,1080]) {
    await send('Emulation.setDeviceMetricsOverride', {width:viewport,height:800,deviceScaleFactor:1,mobile:false});
    await sleep(500);
    for (const width of [210,420]) {
      const previousWidth=await evaluate(`document.querySelector('#navigator-panel').getBoundingClientRect().width`);
      await evaluate(`document.querySelector('.navigator-resize').focus()`);
      const key=width<previousWidth?'ArrowLeft':'ArrowRight';
      for(let step=0;step<Math.ceil(Math.abs(width-previousWidth)/10);step++) {
        await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='ArrowLeft'?37:39});
        await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:key==='ArrowLeft'?37:39});
      }
      await sleep(500);
      const fixed=await geometry();
      assert.ok(Math.abs(fixed.nav.width-width)<1,'navigator reaches requested width');
      assert.ok(Math.abs(fixed.graph.x-fixed.nav.right)<2, 'pinned graph starts after navigator');
      assert.ok(fixed.navOnTop && fixed.nav.x===0 && fixed.search.x>=0 && fixed.footer.bottom<=fixed.height+1, JSON.stringify(fixed));
      if(width===420) {
        const shot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(home,`mode-pinned-${viewport}.png`),Buffer.from(shot.data,'base64'));
      }
      await togglePin();
      await until(`!(${pinned}) && ${expanded}`);
      await move(await point('.session-search input'));
      await sleep(500);
      const floating=await geometry();
      assert.equal(floating.graph.x,0,'floating navigator does not shift graph');
      assert.ok(floating.navOnTop && floating.nav.x===0 && floating.search.right<=floating.nav.right && floating.footer.bottom<=floating.height+1,JSON.stringify(floating));
      if(width===420) {
        const shot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(home,`mode-floating-${viewport}.png`),Buffer.from(shot.data,'base64'));
      }
      await click(button);
      await until(`!(${expanded})`);
      await sleep(500);
      const hidden=await geometry();
      assert.ok(Math.abs(hidden.graph.width-floating.graph.width)<2,'floating open/close preserves graph width');
      assert.equal(await evaluate(`!!document.elementFromPoint(20,150)?.closest('#navigator-panel')`),false,'hidden navigator does not intercept graph');
      report.modeGeometry.push({viewport,width,fixed,floating,hiddenGraph:hidden.graph});
      await togglePin();
      await until(`${pinned} && ${expanded}`);
      await sleep(500);
    }
  }
  await move({x:900,y:80});
  await sleep(2200);
  assert.ok(await evaluate(expanded),'pinned navigator stays open without interaction');
  report.pinnedStaysOpen=true;
  await togglePin();
  await until(`!(${pinned}) && ${expanded}`);
  await move(await point('.session-search input'));
  await sleep(2200);
  assert.ok(await evaluate(expanded),'hovering floating navigator keeps it open');
  await move({x:900,y:80});
  await until(`!(${expanded})`);
  report.floatingAutoHides=true;
  await click(button);
  await until(expanded);
  await until(`document.querySelector('#navigator-panel').getBoundingClientRect().left===0`);
  await move(await point('.session-search input'));
  await until(`${expanded} && !(${pinned})`);
  await click('.project-actions button');
  await until(`!!document.querySelector('[data-navigator-menu]')`);
  await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').projects=[]`);
  await until(`!document.querySelector('[data-navigator-menu]')`);
  await evaluate(`document.activeElement?.blur()`);
  await move({x:1100,y:500});
  await sleep(2500);
  report.afterMenuUnmount = await evaluate(`({expanded:${expanded},pinned:${pinned},focus:document.activeElement.tagName})`);
  assert.equal(report.afterMenuUnmount.expanded,false, 'removed menu releases auto-hide');
  // Sample rendered frames through real button clicks.
  report.panelTransitions = [];
  for (const [panel, trigger, metric] of [
    ['navigator', button, 'opacity'],
    ['chat', '[data-action="chat-panel"]', 'width'],
    ['content', '[data-action="tool-panel"]', 'width'],
  ]) {
    for (let toggle = 0; toggle < 2; toggle++) {
      await evaluate(`(() => {
        const panel = document.querySelector('#${panel}-panel');
        const read = () => ({width:panel.getBoundingClientRect().width,opacity:getComputedStyle(panel).display==='none'?0:Number(getComputedStyle(panel).opacity)});
        window.panelMotion = {before:read(),frames:[]};
        window.panelMotionDone = new Promise(resolve => {
          const end = performance.now()+1000;
          const sample = () => {
            window.panelMotion.frames.push(read());
            if(performance.now()<end) requestAnimationFrame(sample);
            else resolve(window.panelMotion);
          };
          requestAnimationFrame(sample);
        });
      })()`);
      await click(trigger);
      const motion = await evaluate('window.panelMotionDone');
      const start = motion.before[metric], end = motion.frames.at(-1)[metric];
      const intermediate = motion.frames.filter(frame => frame[metric]>Math.min(start,end)+0.01 && frame[metric]<Math.max(start,end)-0.01);
      assert.ok(Math.abs(end-start)>0.5, `${panel} toggles`);
      assert.ok(intermediate.length>=2, `${panel} has multiple intermediate frames`);
      report.panelTransitions.push({panel,start,end,intermediate:intermediate.length});
    }
  }
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('[data-action="chat-panel"]');
  assert.ok(await evaluate(`getComputedStyle(document.querySelector('#chat-panel')).transitionDuration.split(',').every(value=>parseFloat(value)<0.001)`), 'reduced motion disables panel animation');
  assert.equal(errors.length,0);
  report.result = 'passed';
  console.log(JSON.stringify({home,...report},null,2));
} catch(error) {
  if(socket?.readyState === WebSocket.OPEN) console.log('Failure state', await evaluate(`({state:window.__pixTest?.state(),rects:${rects}})`).catch(String));
  console.error(stderr.slice(-1500));
  throw error;
} finally {
  writeFileSync(join(home,'report.json'),JSON.stringify({...report,errors},null,2));
  socket?.close();
  child.kill();
}
