// Focused GUI check for the floating Pixie sprite: boot presence above the
// graph controls, greeting→idle and the card-summon wave, click toggling,
// drag pinning without accidental card opens, the cancelled-drag click guard,
// static posters under emulated prefers-reduced-motion, the settings toggle
// hiding/restoring the sprite, the right-click function menu (open, settings
// jump, hide entry), and a pinned position surviving a restart via the
// layout state.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-home-pixie");
rmSync(testHome, { recursive: true, force: true });
mkdirSync(join(testHome, ".pix"), { recursive: true });
writeFileSync(join(testHome, ".pix", "gui.settings.json"), JSON.stringify({}));
const agentDir = join(testHome, ".pix", "agent");
const canvasWorkspace = join(testHome, "workspace");
mkdirSync(canvasWorkspace, { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "canvas-test" }));
// A real model/tool loop, entirely offline: Pixie controls the actual renderer,
// while graph agents answer normally through their own runtime instances.
writeFileSync(join(agentDir, "extensions", "canvas-test.js"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi => {
  const faux = fauxProvider({ models: [{ id: "canvas-test", contextWindow: 128000 }] });
  pi.registerProvider(faux.provider);
  let stage = 0, attempts = 0;
  const respond = async context => {
    const user = context.messages.find(message => message.role === "user");
    if (!JSON.stringify(user).includes("Pixie canvas integration")) {
      faux.appendResponses([respond]);
      return fauxAssistantMessage("Graph task completed.");
    }
    if (++attempts > 60) throw new Error("Canvas integration did not complete");
    const last = [...context.messages].reverse().find(message => message.role === "toolResult");
    if (last?.isError) return fauxAssistantMessage("Canvas tool failed: " + JSON.stringify(last));
    const state = last ? JSON.parse(last.content.find(part => part.type === "text").text) : undefined;
    if (stage === 0 || stage === 1) {
      const name = stage++ === 0 ? 'canvas-editing' : 'canvas-view';
      faux.appendResponses([respond]);
      return fauxAssistantMessage([fauxToolCall('canvas_skill', { name })], { stopReason: 'toolUse' });
    }
    const call = command => {
      faux.appendResponses([respond]);
      return fauxAssistantMessage([fauxToolCall("canvas_" + command.action.replace(/[A-Z]/g, c => "_" + c.toLowerCase()), Object.fromEntries(Object.entries(command).filter(([key]) => key !== "action")))], { stopReason: "toolUse" });
    };
    if (stage === 2) { stage++; return call({ action: "inspect" }); }
    if (stage === 3) { stage++; return call({ action: "newSession", context: state.context }); }
    if (stage === 4) { stage++; return call({ action: "send", context: state.context, nodeId: null, text: "Canvas root", provider: "faux", modelId: "canvas-test" }); }
    if (stage >= 5 && stage <= 7) {
      const needed = stage - 4;
      if (state.totalNodes === undefined || state.totalNodes < needed || state.runs?.some(run => run.status === "running")) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return call({ action: "inspect" });
      }
      const root = state.nodes.find(node => !node.parentId);
      if (stage === 7) { stage++; return call({ action: "label", context: state.context, nodeId: root.id, text: "Created by Pixie" }); }
      stage++;
      return call({ action: "send", context: state.context, nodeId: root.id, text: "Canvas branch " + (stage - 5), provider: "faux", modelId: "canvas-test" });
    }
    return fauxAssistantMessage("Canvas integration complete.");
  };
  faux.setResponses([respond]);
}
`);
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");

const results = {};
const retry = async (fn, timeout = 15_000) => {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    try { return await fn(); } catch (cause) { error = cause; await new Promise(r => setTimeout(r, 150)); }
  }
  throw error;
};

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", pointerType: "mouse", ...extra });
  }
  // A plain press+release hit-tests but targets <html> for the click; the
  // move first is what makes Chromium synthesize the click on the element.
  async click(x, y) {
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y, { clickCount: 1 });
    await this.mouse("mouseReleased", x, y, { clickCount: 1 });
  }
  async rightClick(x, y) {
    await this.mouse("mouseMoved", x, y);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", pointerType: "mouse", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", pointerType: "mouse", clickCount: 1 });
  }
  async shot(name) {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, name), Buffer.from(result.data, "base64"));
  }
  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      this.socket.addEventListener("close", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.close();
    });
  }
}

let stderr = "";
async function launch() {
  const port = 9900 + Math.floor(Math.random() * 90);
  const child = spawn(electron, [
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${join(testHome, "electron")}`,
    `--remote-debugging-port=${port}`,
    root,
  ], {
    cwd: root,
    env: { ...process.env, PIX_HOME: testHome, PIX_PROJECT: canvasWorkspace, PI_OFFLINE: "1" },
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const cdp = await retry(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) throw new Error("no page target yet");
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return cdp;
  });
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(window.__pixTest && document.querySelector("[data-pixie-sprite]"))`)))
      throw new Error("sprite not ready");
  });
  return { child, cdp };
}

const spriteRect = (cdp) => cdp.evaluate(`(() => {
  const el = document.querySelector("[data-pixie-sprite]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom };
})()`);
const spriteSrc = (cdp) => cdp.evaluate(`document.querySelector("[data-pixie-sprite] img")?.getAttribute("src")`);
const cardVisible = (cdp) => cdp.evaluate(`document.querySelector("[data-pixie-card]")?.checkVisibility() === true`);
const cardRect = cdp => cdp.evaluate(`(() => {
  const r = document.querySelector('[data-pixie-card]').getBoundingClientRect();
  return { left:r.left, top:r.top, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
})()`);
const spriteCenter = (cdp) => cdp.evaluate(`(() => {
  const r = document.querySelector("[data-pixie-sprite]").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
// Opens Settings on the Pixie category and returns the sprite toggle's center.
const openSpriteToggle = async (cdp) => {
  await cdp.evaluate(`window.__pixTest.settings()`);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-settings-category="pixie"]'))`)))
      throw new Error("pixie settings category missing");
  });
  await cdp.evaluate(`document.querySelector('[data-settings-category="pixie"]').click()`);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-settings] input.switch"))`)))
      throw new Error("sprite toggle row missing");
  });
  return cdp.evaluate(`(() => {
    const r = document.querySelector("[data-pixie-settings] input.switch").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
};

let first;
try {
  first = await launch();
  const { cdp } = first;

  // Boot: clear of the graph controls, real decode, then the greeting hands
  // back to idle.
  const initial = await retry(async () => {
    const rect = await spriteRect(cdp);
    if (!rect) throw new Error("sprite missing");
    return rect;
  });
  if (initial.right > 40 || initial.bottom < 62 || initial.bottom > 90 || Math.round(initial.width) !== 96)
    throw new Error(`sprite not parked above the graph controls: ${JSON.stringify(initial)}`);
  results.defaultCorner = true;
  if (!(await cdp.evaluate(`(() => new Promise(resolve => {
    const img = document.querySelector("[data-pixie-sprite] img");
    const done = () => resolve(img.complete && img.naturalWidth === 256);
    if (img.complete) done(); else { img.onload = done; img.onerror = done; setTimeout(done, 3000); }
  }))()`)))
    throw new Error("sprite webp did not decode");
  results.decodedWebp = true;
  await retry(async () => {
    if (!(await spriteSrc(cdp)).endsWith("idle.webp")) throw new Error("greeting still playing");
  }, 12_000);
  results.settlesToIdle = true;
  await cdp.shot("gui-pixie-idle.png");

  // A click opens the card and summons a wave; the next click collapses it.
  const center = await spriteCenter(cdp);
  await cdp.click(center.x, center.y);
  await retry(async () => { if (!(await cardVisible(cdp))) throw new Error("card did not open"); });
  results.clickOpensCard = true;
  if (!(await spriteSrc(cdp)).endsWith("wave.webp")) throw new Error(`no wave on summon: ${await spriteSrc(cdp)}`);
  results.summonWaves = true;
  await cdp.shot("gui-pixie-wave.png");
  // Empty conversations can resize too; dragging must anchor the top-left.
  const originalCard = await cardRect(cdp);
  const grip = await cdp.evaluate(`(() => {
    const r = document.querySelector('.pixie-resize').getBoundingClientRect();
    return { x:r.right-6, y:r.bottom-6 };
  })()`);
  await cdp.mouse("mouseMoved", grip.x, grip.y);
  await cdp.mouse("mousePressed", grip.x, grip.y, { clickCount: 1 });
  await cdp.mouse("mouseMoved", grip.x + 100, grip.y + 130, { buttons: 1 });
  await cdp.mouse("mouseReleased", grip.x + 100, grip.y + 130, { clickCount: 1 });
  const resizedCard = await cardRect(cdp);
  if (resizedCard.width < originalCard.width + 90 || resizedCard.height < originalCard.height + 100
    || Math.abs(resizedCard.left-originalCard.left)>1 || Math.abs(resizedCard.top-originalCard.top)>1)
    throw new Error(`card resize failed: ${JSON.stringify({originalCard,resizedCard})}`);
  results.emptyCardResizes = true;
  const dragHandle = async (direction, dx, dy) => {
    const at = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-resize="${direction}"]');
      const r = el.getBoundingClientRect();
      return { x:r.left+r.width/2, y:r.top+r.height/2, cursor:getComputedStyle(el).cursor };
    })()`);
    const expectedCursor = direction.length === 1 ? (/[ns]/.test(direction) ? "ns-resize" : "ew-resize")
      : (["nw", "se"].includes(direction) ? "nwse-resize" : "nesw-resize");
    if (at.cursor !== expectedCursor) throw new Error(`wrong ${direction} resize cursor: ${at.cursor}`);
    await cdp.mouse("mouseMoved", at.x, at.y);
    await cdp.mouse("mousePressed", at.x, at.y, { clickCount: 1 });
    await cdp.mouse("mouseMoved", at.x + dx, at.y + dy, { buttons: 1 });
    await cdp.mouse("mouseReleased", at.x + dx, at.y + dy, { clickCount: 1 });
  };
  for (const direction of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
    const before = await cardRect(cdp);
    const dx = direction.includes("w") ? -24 : direction.includes("e") ? 24 : 0;
    const dy = direction.includes("n") ? -18 : direction.includes("s") ? 18 : 0;
    await dragHandle(direction, dx, dy);
    const after = await cardRect(cdp);
    const expected = { left:before.left+(dx<0 ? dx : 0), top:before.top+(dy<0 ? dy : 0),
      right:before.right+(dx>0 ? dx : 0), bottom:before.bottom+(dy>0 ? dy : 0) };
    for (const edge of Object.keys(expected)) if (Math.abs(after[edge]-expected[edge])>1)
      throw new Error(`${direction} resize moved wrong edge: ${JSON.stringify({before,after,expected})}`);
    await dragHandle(direction, -dx, -dy);
  }
  results.allEdgesAndCornersResize = true;
  await dragHandle("nw", 2000, 2000);
  const minimum = await cardRect(cdp);
  if (Math.abs(minimum.width-380)>1 || Math.abs(minimum.height-240)>1
    || Math.abs(minimum.right-resizedCard.right)>1 || Math.abs(minimum.bottom-resizedCard.bottom)>1)
    throw new Error(`north-west resize minimum failed: ${JSON.stringify(minimum)}`);
  await dragHandle("nw", -(resizedCard.width-380), -(resizedCard.height-240));
  results.resizeMinimumKeepsOppositeCorner = true;
  await cdp.shot("gui-pixie-resized.png");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 500, deviceScaleFactor: 1, mobile: false });
  await retry(async () => {
    const r = await cardRect(cdp);
    if (r.left < 0 || r.top < 44 || r.right > 480 || r.bottom > 500) throw new Error("resized card escaped viewport");
  });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await retry(async () => {
    const r = await cardRect(cdp);
    if (Math.abs(r.width-resizedCard.width)>1 || Math.abs(r.height-resizedCard.height)>1) throw new Error("viewport shrink overwrote preferred size");
  });
  results.cardFitsViewport = true;
  await cdp.click(center.x, center.y);
  await retry(async () => { if (await cardVisible(cdp)) throw new Error("card did not collapse"); });
  results.clickCollapses = true;

  // A drag pins the sprite (and persists) without opening the card.
  await cdp.mouse("mouseMoved", center.x, center.y);
  await cdp.mouse("mousePressed", center.x, center.y);
  await cdp.mouse("mouseMoved", center.x + 120, center.y - 80, { buttons: 1 });
  await cdp.mouse("mouseReleased", center.x + 120, center.y - 80);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-sprite]").style.left)`))) throw new Error("not pinned");
  });
  if (await cardVisible(cdp)) throw new Error("drag opened the card");
  results.dragPins = true;

  // Dropping onto the bottom-right controls band is lifted above it.
  const corner = await cdp.evaluate(`({ x: window.innerWidth - 60, y: window.innerHeight - 40 })`);
  const held = await spriteCenter(cdp);
  await cdp.mouse("mouseMoved", held.x, held.y);
  await cdp.mouse("mousePressed", held.x, held.y);
  await cdp.mouse("mouseMoved", corner.x, corner.y, { buttons: 1 });
  await cdp.mouse("mouseReleased", corner.x, corner.y);
  const pinned = await retry(async () => {
    const rect = await spriteRect(cdp);
    if (!rect) throw new Error("sprite missing");
    return rect;
  });
  if (pinned.bottom > 73 || pinned.bottom < 40)
    throw new Error(`drop onto the controls was not lifted: ${JSON.stringify(pinned)}`);
  results.dragAvoidsControls = true;

  // A cancelled drag arms the click guard with no click to consume it; the
  // next activation must still work. pointerType must be "mouse": an untyped
  // synthetic pointer reads as touch, reka's long-press opens the context
  // menu off a stale timer, and its dismissal leaks body[pointer-events:none]
  // — every later real click would die on <html>.
  await cdp.evaluate(`(() => {
    const b = document.querySelector("[data-pixie-sprite]");
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "mouse", button: 0, clientX: 300, clientY: 300 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, pointerType: "mouse", clientX: 500, clientY: 200 }));
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 7, pointerType: "mouse" }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await cdp.evaluate(`document.querySelector("[data-pixie-sprite]").click()`);
  await retry(async () => { if (!(await cardVisible(cdp))) throw new Error("guard outlived the cancelled drag"); });
  results.cancelledDragGuard = true;
  await cdp.evaluate(`document.querySelector("[data-pixie-sprite]").click()`);
  await retry(async () => { if (await cardVisible(cdp)) throw new Error("card stuck open"); });

  // Reduced motion swaps every mood for its static poster.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await retry(async () => {
    if (!(await spriteSrc(cdp)).endsWith(".png")) throw new Error("poster not in use");
  });
  results.reducedMotionPoster = true;
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await retry(async () => {
    if (!(await spriteSrc(cdp)).endsWith(".webp")) throw new Error("webp not restored");
  });

  // The Pixie settings toggle hides and restores the sprite.
  const box = await openSpriteToggle(cdp);
  await cdp.click(box.x, box.y);
  await retry(async () => {
    if (await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-sprite]"))`)) throw new Error("sprite still shown");
  }, 8000);
  results.settingHides = true;
  await cdp.click(box.x, box.y);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-sprite]"))`))) throw new Error("sprite not restored");
  }, 8000);
  results.settingRestores = true;
  await cdp.shot("gui-pixie-settings.png");
  // Leave the settings screen so the sprite is directly reachable again.
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await retry(async () => {
    if (await cdp.evaluate(`Boolean(document.querySelector(".settings-page"))`)) throw new Error("settings still open");
  });

  // Right-click opens the function menu; the settings entry jumps straight
  // to the Pixie category.
  const menuAt = await spriteCenter(cdp);
  await cdp.rightClick(menuAt.x, menuAt.y);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-menu]"))`))) throw new Error("menu did not open");
  });
  results.menuOpens = true;
  await cdp.shot("gui-pixie-menu.png");
  const settingsItem = await cdp.evaluate(`(() => {
    const r = document.querySelector('[data-action="pixie-menu-settings"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp.click(settingsItem.x, settingsItem.y);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector("[data-pixie-settings]"))`))) throw new Error("menu did not jump to pixie settings");
  });
  results.menuJumpsToSettings = true;
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await retry(async () => {
    if (await cdp.evaluate(`Boolean(document.querySelector(".settings-page"))`)) throw new Error("settings still open");
  });

  // Restart: the pinned position comes back from the layout state.
  await cdp.close();
  await new Promise((resolve) => {
    first.child.once("exit", resolve);
    first.child.kill();
    setTimeout(resolve, 5000);
  });
  const second = await launch();
  try {
    const restored = await retry(async () => {
      const rect = await spriteRect(second.cdp);
      if (!rect) throw new Error("sprite missing after restart");
      return rect;
    });
    if (Math.abs(restored.left - pinned.left) > 3 || Math.abs(restored.top - pinned.top) > 3)
      throw new Error(`pinned position lost: ${JSON.stringify(pinned)} → ${JSON.stringify(restored)}`);
    results.positionSurvivesRestart = true;
    const openAt = await spriteCenter(second.cdp);
    await second.cdp.click(openAt.x, openAt.y);
    await retry(async () => {
      const r = await cardRect(second.cdp);
      if (!(await cardVisible(second.cdp)) || Math.abs(r.width-resizedCard.width)>1 || Math.abs(r.height-resizedCard.height)>1)
        throw new Error("card size did not survive restart");
    });
    results.cardSizeSurvivesRestart = true;
    await second.cdp.evaluate(`document.querySelector('.pixie-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
    await retry(async () => {
      if (Math.abs((await cardRect(second.cdp)).width-(resizedCard.width-20))>1) throw new Error("keyboard resize failed");
    });
    await second.cdp.evaluate(`document.querySelector('.pixie-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await retry(async () => {
      if (Math.abs((await cardRect(second.cdp)).width-originalCard.width)>1) throw new Error("reset size failed");
    });
    results.cardKeyboardResizeAndReset = true;
    await second.cdp.click(openAt.x, openAt.y);
    await second.cdp.shot("gui-pixie-restored.png");

    // The menu's hide entry removes the sprite; the settings row brings it back.
    const hideAt = await spriteCenter(second.cdp);
    await second.cdp.rightClick(hideAt.x, hideAt.y);
    await retry(async () => {
      if (!(await second.cdp.evaluate(`Boolean(document.querySelector("[data-pixie-menu]"))`))) throw new Error("menu did not open");
    });
    const hideItem = await second.cdp.evaluate(`(() => {
      const r = document.querySelector('[data-action="pixie-menu-hide"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await second.cdp.click(hideItem.x, hideItem.y);
    await retry(async () => {
      if (await second.cdp.evaluate(`Boolean(document.querySelector("[data-pixie-sprite]"))`)) throw new Error("hide entry left the sprite shown");
    }, 8000);
    results.menuHides = true;
    const row = await openSpriteToggle(second.cdp);
    await second.cdp.click(row.x, row.y);
    await retry(async () => {
      if (!(await second.cdp.evaluate(`Boolean(document.querySelector("[data-pixie-sprite]"))`))) throw new Error("sprite not re-enabled");
    }, 8000);
    results.spriteReenabled = true;
    const canvasResult = await second.cdp.evaluate(`(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const pixie = pinia._s.get('pixie');
      pixie.model = { provider: 'faux', id: 'canvas-test' };
      const sent = await pixie.send('Pixie canvas integration');
      const session = pinia._s.get('session');
      return { sent, error: pixie.error, nodes: session.current?.projection.nodes,
        messages: pixie.snapshot?.projection.messages.map(message => message.text) };
    })()`);
    const rootNode = canvasResult.nodes?.find(node => node.label === "Created by Pixie");
    if (!canvasResult.sent || !rootNode || canvasResult.nodes.some(node => node.hasError)
      || canvasResult.nodes.filter(node => node.parentId === rootNode.id).length !== 2
      || !canvasResult.messages.some(text => text.includes("Canvas integration complete.")))
      throw new Error(`Pixie did not operate the real canvas: ${JSON.stringify(canvasResult)}`);
    results.canvasCreatesNodesAndBranches = true;
    await second.cdp.shot("gui-pixie-canvas.png");
    await second.cdp.evaluate(`(() => {
      const p=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      p._s.get('pixie').visible=true;
    })()`);
    const expandedCard = await cardRect(second.cdp);
    await second.cdp.mouse("mouseMoved", expandedCard.right-8, expandedCard.bottom-8);
    await second.cdp.mouse("mousePressed", expandedCard.right-8, expandedCard.bottom-8, { clickCount: 1 });
    await second.cdp.mouse("mouseMoved", expandedCard.left+380-8, expandedCard.top+240-8, { buttons: 1 });
    await second.cdp.mouse("mouseReleased", expandedCard.left+380-8, expandedCard.top+240-8, { clickCount: 1 });
    const resizeBlocksScroll = await second.cdp.evaluate(`(() => {
      const r=document.querySelector('.pixie-messages').getBoundingClientRect();
      return Boolean(document.elementFromPoint(r.right-2,r.top+r.height/2)?.closest('.pixie-resize'));
    })()`);
    if (resizeBlocksScroll) throw new Error('edge resize handle covers the transcript scrollbar');
    results.resizeLeavesScrollbarAccessible = true;
    await second.cdp.evaluate(`(() => {
      const p=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      p._s.get('pixie').error='Connection failed with details. '.repeat(30);
    })()`);
    await second.cdp.shot("gui-pixie-small-error.png");
    const small = await second.cdp.evaluate(`(() => {
      const card=document.querySelector('[data-pixie-card]');
      const box=card.getBoundingClientRect(), send=card.querySelector('.composer-submit').getBoundingClientRect();
      return { height:box.height, bottom:box.bottom, sendBottom:send.bottom, sendTop:send.top };
    })()`);
    if (small.sendBottom>small.bottom || small.sendTop<0) throw new Error(`small card hid its send control: ${JSON.stringify(small)}`);
    results.smallCardKeepsComposerUsable = true;
    await second.cdp.evaluate(`(() => {
      const p=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      p._s.get('pixie').error='';
      document.querySelector('[data-pixie-card] textarea').style.height='190px';
    })()`);
    const tallInput = await second.cdp.evaluate(`(() => {
      const card=document.querySelector('[data-pixie-card]'), composer=card.querySelector('.pixie-composer');
      composer.scrollTop=composer.scrollHeight;
      const box=card.getBoundingClientRect(), send=card.querySelector('.composer-submit').getBoundingClientRect();
      return { bottom:box.bottom, sendBottom:send.bottom, scroll:composer.scrollTop };
    })()`);
    if (tallInput.sendBottom>tallInput.bottom || !tallInput.scroll)
      throw new Error(`resized textarea hid its send control: ${JSON.stringify(tallInput)}`);
    results.tallInputRemainsScrollable = true;
    await second.cdp.close();
  } finally {
    second.child.kill();
  }
} finally {
  writeFileSync(join(artifacts, "gui-pixie-stderr.log"), stderr);
  if (first) first.child.kill();
}

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(JSON.stringify(results, null, 2));
if (failed.length || Object.keys(results).length < 17) {
  console.error(`\npixie sprite GUI test FAILED\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\npixie sprite GUI test passed");
