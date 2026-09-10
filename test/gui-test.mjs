import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const allowEmpty = process.env.PIX_GUI_EMPTY === "1";
const verifyHmr = process.argv.includes("--hmr");
const testHome = join(artifacts, verifyHmr ? "gui-home-hmr" : allowEmpty ? "gui-home-empty" : "gui-home");
const verifyWsl = process.argv.includes("--wsl");
const verifySsh = process.argv.includes("--ssh");
const sshTestArgs = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "stempdac.hpc4ai.unito.it"];
const sshWorkspace = verifySsh
  ? String(spawnSync("ssh", [...sshTestArgs, "mktemp -d /tmp/pix-ssh-gui-XXXXXX"], { encoding: "utf8", windowsHide: true }).stdout).trim()
  : "";
if (verifySsh && !/^\/tmp\/pix-ssh-gui-[A-Za-z0-9]+$/.test(sshWorkspace))
  throw new Error("Could not create the isolated SSH GUI test workspace");
if (sshWorkspace && spawnSync("ssh", [...sshTestArgs, `mkdir -p '${sshWorkspace}/sample'`], { windowsHide: true }).status !== 0)
  throw new Error("Could not prepare the SSH GUI test directory");
const wslWorkspace = verifyWsl
  ? String(
      spawnSync(
        "wsl.exe",
        ["--exec", "mktemp", "-d", "/tmp/pix-wsl-gui-XXXXXX"],
        { encoding: "utf8", windowsHide: true },
      ).stdout,
    ).trim()
  : "";
if (verifyWsl && !wslWorkspace)
  throw new Error("Could not create the WSL GUI test workspace");
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");
mkdirSync(artifacts, { recursive: true });
mkdirSync(testHome, { recursive: true });
let devServer;
let localeFile;
let localeSource;
if (verifyHmr) {
  cpSync(join(root, "src"), join(testHome, "src"), { recursive: true });
  cpSync(join(root, "package.json"), join(testHome, "package.json"));
  localeFile = join(testHome, "src/renderer/i18n.ts");
  localeSource = readFileSync(localeFile, "utf8");
  writeFileSync(localeFile, localeSource.replace(/^\s+(copyPath|copySessionId|revealSession):.*\r?\n/gm, ""));
  const { createServer } = await import("vite");
  const { default: vue } = await import("@vitejs/plugin-vue");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  devServer = await createServer({ configFile: false, root: join(testHome, "src/renderer"), publicDir: join(root, "resources"),
    plugins: [vue({ template: { compilerOptions: { isCustomElement: tag => tag === "webview" } } }), tailwindcss()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await devServer.listen();
}
mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
mkdirSync(join(testHome, ".pix"), { recursive: true });
writeFileSync(
  join(testHome, ".pi", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);
writeFileSync(
  join(testHome, ".pix", "settings.json"),
  JSON.stringify({
    // The graph assertions below need a session opened at boot.
    openLastSessionOnStartup: true,
    layout: {
      version: 3,
      widths: { navigator: 248, chat: 356, content: 320 },
      collapsed: { navigator: false, chat: false, content: true },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    },
  }),
);

const port = 9700 + Math.floor(Math.random() * 200);
const args = [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
];
const xvfb =
  process.platform === "linux"
    ? String(spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout).trim()
    : "";
const child = xvfb
  ? spawn(xvfb, ["-a", electron, ...args], { cwd: root, env: testEnv() })
  : spawn(electron, args, { cwd: root, env: testEnv(), windowsHide: true });

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

function testEnv() {
  return {
    ...process.env,
    ...(devServer ? { ELECTRON_RENDERER_URL: devServer.resolvedUrls.local[0] } : {}),
    PIX_HOME: testHome,
    PIX_PROJECT: allowEmpty ? root : join(root, "test", "workspace"),
    PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
}

async function retry(fn, timeout = 20_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null)
      throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try {
      return await fn();
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw error;
}

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
      message.error
        ? pending.reject(new Error(message.error.message))
        : pending.resolve(message.result);
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
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result?.value;
  }
  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.close();
    });
  }
}

let cdp;
let remoteSshResult;
let imagePreview = false;
let wslStoppedPid = 0;
let wslLaunchDirectory = "";
function signalWslTestHost(pid, signal) {
  if (!Number.isInteger(pid) || pid < 1 || !/^\/tmp\/pix-wsl-gui-[A-Za-z0-9]+$/.test(wslWorkspace))
    throw new Error("Invalid WSL fault-injection target");
  const result = spawnSync("wsl.exe", ["--exec", "sh", "-lc",
    String.raw`if test -r "/proc/$1/cmdline"; then args=$(tr '\000' ' ' < "/proc/$1/cmdline"); case "$args" in *"--cwd $2 "*) kill "-$3" "$1" ;; *) exit 2 ;; esac; fi`,
    "sh", String(pid), wslLaunchDirectory, signal], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) throw new Error(`WSL test signal failed (${result.status}): ${result.stderr}`);
}
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find(
      (item) => item.type === "page" && item.webSocketDebuggerUrl,
    );
    if (!page) throw new Error("Electron page target missing");
    return page;
  });
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await retry(async () => {
    const ready = await cdp.evaluate(
      "window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))",
    );
    if (!ready) throw new Error(`PiX renderer is not ready\n${stderr}`);
  });
  await retry(async () => {
    const value = await cdp.evaluate(`({
      collapsed: window.__pixTest.state().layout.collapsed,
      chatWidth: document.querySelector('.chat')?.getBoundingClientRect().width,
      graphWidth: document.querySelector('.graph')?.getBoundingClientRect().width,
      sessionListsOpen: document.querySelectorAll('.project-sessions').length
    })`);
    // Boot never restores an expanded chat (even though the saved layout has it
    // open) and project session lists start collapsed.
    if (!value.collapsed.chat || (value.chatWidth ?? 0) >= 30 || value.sessionListsOpen)
      throw new Error(`Boot layout must start with chat and session lists collapsed: ${JSON.stringify(value)}`);
  });
  if (!allowEmpty) await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const flow = document.querySelector('.session-flow')?.getBoundingClientRect();
      const node = document.querySelector('.prompt-node.selected')?.getBoundingClientRect();
      return flow && node ? {
        x: Math.round((node.left + node.width / 2) - (flow.left + flow.width / 2)),
        y: Math.round((node.top + node.height / 2) - (flow.top + flow.height / 2))
      } : null;
    })()`);
    if (!value || Math.abs(value.x) > 12 || Math.abs(value.y) > 12)
      throw new Error(`Initial graph node ignored restored panels: ${JSON.stringify(value)}`);
  });
  const chrome = await cdp.evaluate(`(() => {
    const titlebar = document.querySelector('.app-titlebar')?.getBoundingClientRect();
    const content = document.querySelector('.app-content')?.getBoundingClientRect();
    return { count: document.querySelectorAll('.app-titlebar').length, height: titlebar?.height, contentTop: content?.top };
  })()`);
  if (chrome.count !== 1 || chrome.height !== 40 || chrome.contentTop !== 40)
    throw new Error(`Window titlebar is not a single 40px layer: ${JSON.stringify(chrome)}`);
  const workspacePicker = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-action=workspace-picker]');
    const rect = button?.getBoundingClientRect();
    return { count: document.querySelectorAll('[data-action=workspace-picker]').length, center: rect ? rect.left + rect.width / 2 : 0, viewportCenter: innerWidth / 2 };
  })()`);
  if (workspacePicker.count !== 1 || Math.abs(workspacePicker.center - workspacePicker.viewportCenter) > 2)
    throw new Error(`Workspace picker is not centered: ${JSON.stringify(workspacePicker)}`);
  await cdp.evaluate("document.querySelector('[data-action=workspace-picker]').click()");
  await retry(async () => {
    const actions = await cdp.evaluate(`({
      menu: Boolean(document.querySelector('[data-workspace-picker]')),
      local: document.querySelectorAll('[data-action=open-local-project]').length,
      remote: document.querySelectorAll('[data-action=connect-wsl]').length
    })`);
    if (!actions.menu || actions.local !== 1 || actions.remote !== 1)
      throw new Error(`Unified workspace actions are missing: ${JSON.stringify(actions)}`);
  });
  const workspaceShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, "workspace-picker.png"), Buffer.from(workspaceShot.data, "base64"));
  await cdp.evaluate("document.querySelector('[data-action=connect-wsl]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-wsl-dialog]'))")))
      throw new Error("WSL connection dialog did not open");
  });
  const remoteWizard = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[data-wsl-dialog]').getBoundingClientRect();
    return {
      width: Math.round(dialog.width),
      height: Math.round(dialog.height),
      steps: document.querySelectorAll('.remote-stepper li').length,
      methods: document.querySelectorAll('.remote-method').length
    };
  })()`);
  if (remoteWizard.width < 800 || remoteWizard.height < 500 || remoteWizard.steps !== 4 || remoteWizard.methods !== 2)
    throw new Error(`Remote wizard layout is incomplete: ${JSON.stringify(remoteWizard)}`);
  if (verifyWsl) {
    await cdp.evaluate("document.querySelector('[data-action=remote-method-wsl]').click(); document.querySelector('[data-action=remote-next]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("document.querySelectorAll('[data-wsl-distro] option').length > 0")))
        throw new Error("No WSL distribution appeared in the connection dialog");
    });
    await cdp.evaluate("document.querySelector('[data-action=wsl-submit]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-wsl-path]'))")))
        throw new Error("Remote directory browser did not open");
    }, 45_000);
    // The wizard starts the host at home, then changes its logical workspace.
    // Its process argv still contains that original directory.
    wslLaunchDirectory = await cdp.evaluate("window.__pixTest.state().remoteBrowseRoot");
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-wsl-path]');
      input.value = ${JSON.stringify(wslWorkspace)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action=remote-open-folder]').click();
    })()`);
    await retry(async () => {
      if (!(await cdp.evaluate("window.__pixTest.state().project?.remote?.kind === 'wsl' && Boolean(document.querySelector('.project-row.active .project-connection.connected'))")))
        throw new Error("PiX did not switch to the WSL project");
    }, 45_000);
    await cdp.evaluate("window.pix.invoke('settings.update', { scope: 'project', patch: { defaultProjectTrust: 'always' } })");
    const pidResult = await cdp.evaluate("window.pix.invoke('shell.run', { command: 'printf %s \"$PPID\"' })");
    wslStoppedPid = Number(pidResult.output.trim());
    signalWslTestHost(wslStoppedPid, "STOP");
    const faultStarted = Date.now();
    await retry(async () => {
      const value = await cdp.evaluate(`({
        banner: Boolean(document.querySelector('[data-action=remote-reconnect]')),
        connected: Boolean(document.querySelector('.project-row.active .project-connection.connected'))
      })`);
      if (!value.banner || value.connected) throw new Error(`WSL disconnect state is wrong: ${JSON.stringify(value)}`);
    }, 40_000);
    const faultMs = Date.now() - faultStarted;
    const disconnectedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "remote-wsl-disconnected.png"), Buffer.from(disconnectedShot.data, "base64"));
    signalWslTestHost(wslStoppedPid, "CONT");
    wslStoppedPid = 0;
    await cdp.evaluate("document.querySelector('[data-action=remote-reconnect]').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        banner: Boolean(document.querySelector('[data-action=remote-reconnect]')),
        connected: Boolean(document.querySelector('.project-row.active .project-connection.connected')),
        loading: window.__pixTest.state().loading
      })`);
      if (value.banner || !value.connected || value.loading) throw new Error(`WSL GUI reconnect failed: ${JSON.stringify(value)}`);
    }, 45_000);
    const connectedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "remote-wsl-reconnected.png"), Buffer.from(connectedShot.data, "base64"));
    writeFileSync(join(artifacts, "gui-wsl-remote.json"), JSON.stringify({ passed: true, faultMs, checks: ["wizard", "workspace", "disconnect-banner", "offline-indicator", "reconnect-button"] }, null, 2));
    console.log(JSON.stringify({ wslGuiReconnect: true, faultMs }));
    await cdp.evaluate("document.querySelector('[data-action=workspace-picker]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-action=disconnect-wsl]'))")))
        throw new Error("Remote disconnect action is missing from the workspace picker");
    });
    await cdp.evaluate("document.querySelector('[data-action=disconnect-wsl]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("!window.__pixTest.state().project?.remote && Boolean(document.querySelector('[data-action=workspace-picker]')) && Boolean(document.querySelector('.project-connection:not(.connected)'))")))
        throw new Error("PiX did not return to the local project");
    });
    // Switching workspaces intentionally does not auto-open a session. Select
    // the local fixture explicitly for the remaining non-remote GUI checks.
    if (!allowEmpty) await cdp.evaluate("window.__pixTest.openSession(window.__pixTest.state().sessions[0].path)");
  } else if (verifySsh) {
    await cdp.evaluate("document.querySelector('[data-action=remote-next]').click()");
    await retry(async () => {
      const found = await cdp.evaluate(`Boolean([...document.querySelectorAll('.remote-host-list button')].find(button => button.textContent.includes('stempdac.hpc4ai.unito.it')))`);
      if (!found) throw new Error("stempdac was not detected from SSH config");
    });
    await cdp.evaluate(`[...document.querySelectorAll('.remote-host-list button')].find(button => button.textContent.includes('stempdac.hpc4ai.unito.it')).click()`);
    const connectStarted = Date.now();
    await cdp.evaluate("document.querySelector('[data-action=wsl-submit]').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        path: window.__pixTest.state().remoteBrowseRoot,
        directoryStep: Boolean(document.querySelector('.remote-stepper li:nth-child(4).active'))
      })`);
      if (value.path !== "/home/shuang" || !value.directoryStep)
        throw new Error(`SSH connection step is not ready: ${JSON.stringify(value)}`);
    }, 300_000);
    await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
    remoteSshResult = await cdp.evaluate(`({
      remote: { kind: 'ssh', host: 'stempdac.hpc4ai.unito.it' },
      path: document.querySelector('[data-wsl-path]')?.value,
      folders: document.querySelectorAll('.remote-folder-list button').length,
      pageText: document.querySelector('.remote-dialog-page')?.textContent.trim().slice(0, 300)
    })`);
    remoteSshResult.connectMs = Date.now() - connectStarted;
    if (remoteSshResult.path !== "/home/shuang" || !remoteSshResult.folders)
      throw new Error(`SSH directory page is not ready: ${JSON.stringify(remoteSshResult)}`);
    const browseStarted = Date.now();
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-wsl-path]');
      input.value = ${JSON.stringify(sshWorkspace)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Go').click();
    })()`);
    await retry(async () => {
      const value = await cdp.evaluate(`({
        path: window.__pixTest.state().remoteBrowseRoot,
        error: document.querySelector('.wsl-dialog-error')?.textContent
      })`);
      if (value.path !== sshWorkspace || value.error)
        throw new Error(`SSH could not browse the test workspace: ${JSON.stringify(value)}`);
    });
    remoteSshResult.browseMs = Date.now() - browseStarted;
    Object.assign(remoteSshResult, await cdp.evaluate(`({
      path: document.querySelector('[data-wsl-path]')?.value,
      folders: document.querySelectorAll('.remote-folder-list button').length,
      pageText: document.querySelector('.remote-dialog-page')?.textContent.trim().slice(0, 300)
    })`));
    const remoteShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "remote-ssh-directory.png"), Buffer.from(remoteShot.data, "base64"));
    const openStarted = Date.now();
    await cdp.evaluate("document.querySelector('[data-action=remote-open-folder]').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        dialog: Boolean(document.querySelector('[data-wsl-dialog]')),
        path: window.__pixTest.state().project?.path
      })`);
      if (value.dialog || value.path !== sshWorkspace)
        throw new Error("SSH wizard did not close after opening the folder");
    });
    remoteSshResult.openMs = Date.now() - openStarted;
    const workspaceTree = await cdp.evaluate(`(async () => {
      const root = await window.pix.invoke('workspace.tree', { path: '' });
      const directory = root.find(node => node.kind === 'directory');
      const children = directory
        ? await window.pix.invoke('workspace.tree', { path: directory.path })
        : [];
      return {
        rootCount: root.length,
        directory: directory?.path,
        childCount: children.length,
        scoped: !directory || children.every(node => node.path.startsWith(directory.path + '/'))
      };
    })()`);
    if (!workspaceTree.rootCount || !workspaceTree.directory || !workspaceTree.scoped)
      throw new Error(`SSH workspace tree is not scoped to the opened folder: ${JSON.stringify(workspaceTree)}`);
    remoteSshResult.workspaceTree = workspaceTree;
    await cdp.evaluate("document.querySelector('[data-action=workspace-picker]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-action=disconnect-wsl]'))")))
        throw new Error("SSH disconnect action is missing from the workspace picker");
    });
    await cdp.evaluate("document.querySelector('[data-action=disconnect-wsl]').click()");
    await retry(async () => {
      if (await cdp.evaluate("Boolean(window.__pixTest.state().project?.remote)"))
        throw new Error("PiX did not disconnect from SSH");
    });
  } else {
    await cdp.evaluate("document.querySelector('[data-action=remote-next]').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('.remote-config'))")))
        throw new Error("Remote configuration step did not open");
    });
    await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 260))");
    const remoteShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "remote-wizard.png"), Buffer.from(remoteShot.data, "base64"));
    await cdp.evaluate("document.querySelector('[data-action=wsl-close]').click()");
    await retry(async () => {
      if (await cdp.evaluate("Boolean(document.querySelector('[data-wsl-dialog]'))"))
        throw new Error("WSL connection dialog did not close");
    });
  }
  if (verifySsh) {
    writeFileSync(
      join(artifacts, "gui-ssh-smoke.json"),
      JSON.stringify({ ...remoteSshResult, passed: true }, null, 2) + "\n",
    );
    console.log(JSON.stringify(remoteSshResult, null, 2));
  } else {
  await cdp.evaluate(
    "Promise.all(['navigator','chat'].filter(panel => window.__pixTest.state().layout.collapsed[panel]).map(panel => window.__pixTest.toggle(panel))).then(() => window.__pixTest.state().layout.collapsed.content ? undefined : window.__pixTest.toggle('content'))",
  );
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 300))");
  const sessionState = await cdp.evaluate(
    "({ project: window.__pixTest.state().project, sessions: window.__pixTest.state().sessions.length, current: Boolean(window.__pixTest.state().current), activeNode: window.__pixTest.state().current?.projection.activeNodeId })",
  );
  if (!sessionState.current && !allowEmpty)
    throw new Error(`Fixture session did not open: ${JSON.stringify(sessionState)}`);
  if (sessionState.current) {
    // The node footer must render the persisted context usage (the fixture
    // carries pix.node-footer entries), never the "—" placeholder.
    await retry(async () => {
      const usage = await cdp.evaluate(`(() => {
        const current = [...document.querySelectorAll('.prompt-node')].find((node) => node.classList.contains('current'));
        if (!current) return null;
        return {
          percent: current.querySelector('.node-context-usage b')?.textContent.trim(),
          window: current.querySelector('.node-context-usage em')?.textContent.trim(),
        };
      })()`);
      if (!usage || !/^\d+%$/.test(usage.percent) || usage.window === "—")
        throw new Error(`Current node context usage not rendered: ${JSON.stringify(usage)}`);
    });
  }
  const projectNavigator = await cdp.evaluate(`({
    projects: document.querySelectorAll('.project-group').length,
    active: document.querySelectorAll('.project-row.active').length,
    creates: document.querySelectorAll('[data-action=create-project-session]').length
  })`);
  if (!projectNavigator.projects || projectNavigator.active !== 1 || projectNavigator.creates !== projectNavigator.projects)
    throw new Error(`Project session navigator is incomplete: ${JSON.stringify(projectNavigator)}`);
  if (sessionState.current) {
    // Session lists boot collapsed; expand the active project for the menu steps.
    await cdp.evaluate("document.querySelector('.project-row.active .project-main').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('.session-item.active'))")))
        throw new Error("Active project session list did not expand");
    });
    const sessionLayout = await cdp.evaluate(`(() => {
      const row = document.querySelector('.session-item.active');
      const title = row.querySelector('strong'), time = row.querySelector('small');
      const originalTitle = title.textContent, originalWidth = row.style.width;
      const checks = [];
      try {
        for (const width of [140, 350]) {
          row.style.width = width + 'px';
          for (const text of ['Short', '很长的 Session 标题 '.repeat(30)]) {
            title.textContent = text;
            const rowRect = row.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
            const timeRect = time.getBoundingClientRect(), spanRect = time.parentElement.getBoundingClientRect();
            checks.push({ width, short: text === 'Short',
              singleLine: rowRect.height <= 34,
              rightAligned: Math.abs(timeRect.right - (spanRect.right - 8)) < 1,
              noOverlap: titleRect.right + 7 <= timeRect.left,
              timeVisible: time.scrollWidth <= time.clientWidth && timeRect.right <= rowRect.right,
              ellipsis: text === 'Short' || (title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis'),
            });
          }
        }
        return checks;
      } finally {
        title.textContent = originalTitle;
        row.style.width = originalWidth;
      }
    })()`);
    if (sessionLayout.some(check => !check.singleLine || !check.rightAligned || !check.noOverlap || !check.timeVisible || !check.ellipsis))
      throw new Error(`Session row layout regression: ${JSON.stringify(sessionLayout)}`);
    await cdp.evaluate("document.querySelector('.session-item.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 250 }))");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-action=session-rename]'))")))
        throw new Error("Session menu did not open");
    });
    if (verifyHmr) writeFileSync(localeFile, localeSource);
    for (const [locale, expected] of [
      ["en", ["Copy path", "Copy session ID", "Show in file manager"]],
      ["zh-CN", ["复制路径", "复制会话 ID", "在资源管理器中显示"]],
    ]) {
      await cdp.evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$i18n.locale = ${JSON.stringify(locale)}`);
      await retry(async () => {
        const labels = await cdp.evaluate(`['session-copy-path','session-copy-id','session-reveal'].map(action => document.querySelector('[data-action="'+action+'"]')?.textContent.trim())`);
        if (JSON.stringify(labels) !== JSON.stringify(expected)) throw new Error(`Untranslated session menu: ${JSON.stringify(labels)}`);
      });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(artifacts, `session-menu-${locale}.png`), Buffer.from(shot.data, "base64"));
    }
    await cdp.evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$i18n.locale = 'en'`);
    if (verifyHmr) {
      writeFileSync(localeFile, localeSource.replace('copyPath: "Copy path"', 'copyPath: "Copy full path"'));
      await retry(async () => {
        if (await cdp.evaluate(`document.querySelector('[data-action="session-copy-path"]')?.textContent.trim()`) !== "Copy full path")
          throw new Error("A second locale hot update did not reach the mounted menu");
      });
    }
    await cdp.evaluate("document.querySelector('[data-action=session-rename]').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        dialog: Boolean(document.querySelector('[data-rename-dialog]')),
        focused: document.activeElement === document.querySelector('[data-session-name]')
      })`);
      if (!value.dialog || !value.focused)
        throw new Error(`Session rename dialog is not usable: ${JSON.stringify(value)}`);
    });
    await cdp.evaluate("document.querySelector('[data-action=rename-cancel]').click()");
    await retry(async () => {
      if (await cdp.evaluate("Boolean(document.querySelector('[data-rename-dialog]'))"))
        throw new Error("Session rename dialog did not close");
    });
    // Deleting must confirm through the in-app dialog, never the native OS prompt.
    await cdp.evaluate("document.querySelector('.session-item.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 250 }))");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-action=session-delete]'))")))
        throw new Error("Session menu did not reopen for deletion");
    });
    await cdp.evaluate("document.querySelector('[data-action=session-delete]').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        dialog: Boolean(document.querySelector('[data-delete-dialog]')),
        danger: Boolean(document.querySelector('[data-delete-dialog] [data-action=delete-confirm]')),
        body: document.querySelector('[data-delete-dialog] .confirm-body')?.textContent ?? ''
      })`);
      if (!value.dialog || !value.danger || !value.body.trim())
        throw new Error(`Session delete confirmation is not the in-app dialog: ${JSON.stringify(value)}`);
      return value;
    });
    const deleteShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "gui-delete-dialog.png"), Buffer.from(deleteShot.data, "base64"));
    await cdp.evaluate("document.querySelector('[data-action=delete-cancel]').click()");
    await retry(async () => {
      if (await cdp.evaluate("Boolean(document.querySelector('[data-delete-dialog]'))"))
        throw new Error("Session delete dialog did not close");
    });
  }
  if ((await cdp.evaluate("document.querySelectorAll('[data-action=chat-panel]').length")) !== 1)
    throw new Error("Chat panel must have exactly one toggle");
  await cdp.evaluate("document.querySelector('[data-action=chat-panel]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().layout.collapsed.chat && window.__pixTest.state().layout.collapsed.content")))
      throw new Error("Chat panel did not collapse");
  });
  const selectedTitle = sessionState.current
    ? await cdp.evaluate("document.querySelector('.prompt-node .turn-copy strong').textContent.trim()")
    : "";
  if (sessionState.current) {
    await cdp.evaluate("document.querySelector('.prompt-node').click()");
    if (!(await cdp.evaluate("window.__pixTest.state().layout.collapsed.chat")))
      throw new Error("Single-clicking a graph node unexpectedly opened chat");
    await cdp.evaluate("document.querySelector('.prompt-node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  } else
    await cdp.evaluate("document.querySelector('[data-action=chat-panel]').click()");
  await retry(async () => {
    const value = await cdp.evaluate(`({
      expanded: !window.__pixTest.state().layout.collapsed.chat && document.querySelector('.chat').getBoundingClientRect().width >= 300,
      linkedContext: !window.__pixTest.state().current || document.querySelector('.branch-title small').textContent.trim() === ${JSON.stringify(selectedTitle)}
    })`);
    if (!value.expanded || !value.linkedContext)
      throw new Error(`Graph selection did not reveal matching chat context: ${JSON.stringify(value)}`);
  });
  // Selection keeps the viewport still when the node is already visible. Center
  // explicitly before checking geometry; readable typography changes card height.
  if (sessionState.current)
    await cdp.evaluate("document.querySelector('.graph-controls button:last-child').click()");
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
  const graphNode = sessionState.current
    ? await retry(async () => {
        const value = await cdp.evaluate(`(() => {
          const flow = document.querySelector('.session-flow').getBoundingClientRect();
          const selected = document.querySelector('.prompt-node.selected');
          const node = selected?.getBoundingClientRect();
          const footer = selected?.querySelector('.node-footer')?.getBoundingClientRect();
          // Vue Flow scales nodes inside the transformationpane, so measured
          // rects shrink with the viewport zoom. Normalize by the node's
          // computed (pre-transform) width to assert designed CSS sizes.
          const scale = node && selected ? node.width / parseFloat(getComputedStyle(selected).width) : 1;
          return node ? {
            selected: true,
            embeddedComposer: Boolean(selected.querySelector('textarea')),
            addAction: Boolean(selected.querySelector('.node-add')),
            centered: Math.abs((node.left + node.width / 2) - (flow.left + flow.width / 2)) < 90,
            centerDelta: Math.round((node.left + node.width / 2) - (flow.left + flow.width / 2)),
            geometry: { flowLeft: Math.round(flow.left), flowWidth: Math.round(flow.width), nodeLeft: Math.round(node.left), nodeWidth: Math.round(node.width), scale: Math.round(scale * 1000) / 1000 },
            footer: {
              height: Math.round((footer?.height ?? 0) / scale),
              context: Boolean(selected.querySelector('.node-context-usage')),
              controls: Number(Boolean(selected.querySelector('button[aria-label="Node model"]'))) + selected.querySelectorAll('.node-footer select').length
            },
            focusedNode: window.__pixTest.state().focusedNode,
            noOverlap: [...document.querySelectorAll('.prompt-node:not(.selected)')].every(item => {
              const other = item.getBoundingClientRect();
              return node.right <= other.left || node.left >= other.right || node.bottom <= other.top || node.top >= other.bottom;
            })
          } : null;
        })()`);
        if (!value?.selected || value.embeddedComposer || !value.addAction || !value.centered || !value.noOverlap || value.footer.height < 54 || value.footer.height > 60 || !value.footer.context || value.footer.controls !== 0)
          throw new Error(`Selected graph node is not stable and centered: ${JSON.stringify(value)}`);
        return value;
      })
    : { selected: true, embeddedComposer: false, addAction: true, centered: true, noOverlap: true };
  if (sessionState.current) {
    await cdp.evaluate("document.querySelector('.prompt-node.selected').dispatchEvent(new MouseEvent('mouseenter'))");
    graphNode.hoverMarkdown = await retry(async () => {
      const value = await cdp.evaluate(`(() => {
        const card = document.querySelector('.node-hover-card');
        const rect = card?.getBoundingClientRect();
        const node = document.querySelector('.prompt-node.selected')?.getBoundingClientRect();
        const overlapsX = Boolean(rect && node && rect.right >= node.left && rect.left <= node.right);
        const overlapsY = Boolean(rect && node && rect.bottom >= node.top && rect.top <= node.bottom);
        const gapX = rect && node ? Math.max(0, node.left - rect.right, rect.left - node.right) : Infinity;
        const gapY = rect && node ? Math.max(0, node.top - rect.bottom, rect.top - node.bottom) : Infinity;
        return {
          card: Boolean(card),
          markdownSections: card?.querySelectorAll('.markstream-vue').length ?? 0,
          renderedText: card?.textContent.trim().length ?? 0,
          withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
          nearNode: (gapX <= 16 && overlapsY) || (gapY <= 16 && overlapsX)
        };
      })()`);
      if (!value.card || value.markdownSections !== 2 || !value.renderedText || !value.withinViewport || !value.nearNode)
        throw new Error(`Graph hover preview did not render Markdown: ${JSON.stringify(value)}`);
      return value;
    });
    const hoverShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "gui-node-hover.png"), Buffer.from(hoverShot.data, "base64"));
    await cdp.evaluate("document.querySelector('.prompt-node.selected')?.dispatchEvent(new MouseEvent('mouseleave')); document.querySelector('.node-hover-card')?.dispatchEvent(new MouseEvent('mouseenter'))");
    await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 160))");
    if (!(await cdp.evaluate("Boolean(document.querySelector('.node-hover-card'))")))
      throw new Error("Graph hover preview closed while the pointer moved into it");
    await cdp.evaluate("document.querySelector('.node-hover-card').dispatchEvent(new MouseEvent('mouseleave'))");
    await retry(async () => {
      if (await cdp.evaluate("Boolean(document.querySelector('.node-hover-card'))"))
        throw new Error("Graph hover preview did not close");
    });
    await cdp.evaluate(`(() => {
      const node = document.querySelector('.prompt-node.selected');
      node.dispatchEvent(new MouseEvent('mouseenter'));
      node.querySelector('.node-add').dispatchEvent(new MouseEvent('mouseenter'));
    })()`);
    await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
    if (await cdp.evaluate("Boolean(document.querySelector('.node-hover-card'))"))
      throw new Error("Graph node preview opened while hovering the add action");
    await cdp.evaluate("document.querySelector('.prompt-node.selected .node-add').click()");
    await retry(async () => {
      const value = await cdp.evaluate(`({
        draft: Boolean(document.querySelector('.draft-node textarea')),
        settings: Boolean(document.querySelector('button[aria-label="Draft model"]') && document.querySelector('button[aria-label="Draft thinking level"]')),
        connected: Boolean(document.querySelector('.vue-flow__edge.draft-edge')),
        parentStable: !document.querySelector('.prompt-node textarea'),
        focused: document.activeElement === document.querySelector('.draft-node textarea'),
        fullyVisible: (() => {
          const flow = document.querySelector('.session-flow').getBoundingClientRect();
          const draft = document.querySelector('.draft-node').getBoundingClientRect();
          return draft.left >= flow.left && draft.right <= flow.right && draft.top >= flow.top && draft.bottom <= flow.bottom;
        })(),
        readableAndCentered: (() => {
          const flow = document.querySelector('.session-flow').getBoundingClientRect();
          const draft = document.querySelector('.draft-node').getBoundingClientRect();
          return draft.width >= 250 && draft.height <= 225 && Math.abs((draft.left + draft.width / 2) - (flow.left + flow.width / 2)) < 50;
        })()
      })`);
      if (!value.draft || !value.settings || !value.connected || !value.parentStable || !value.focused || !value.fullyVisible || !value.readableAndCentered)
        throw new Error(`Graph draft node is not connected: ${JSON.stringify(value)}`);
      return value;
    });
    await retry(async () => {
      const value = await cdp.evaluate(`(() => {
        const current = window.__pixTest.state().current;
        const expected = new Map(current.projection.nodes.map((node) => [node.id, node.footer?.thinkingLevel ?? "off"]));
        // Vue Flow only mounts visible nodes; larger readable cards need not all
        // fit onscreen while a draft is open. Compare each rendered node by ID.
        const shown = [...document.querySelectorAll('.vue-flow__node-prompt')]
          .map((element) => ({ id: element.dataset.id, level: element.querySelector('.node-thinking-value')?.textContent.trim() }));
        const selected = current.projection.nodes.find((node) => node.id === window.__pixTest.state().focusedNode)
          ?? current.projection.nodes.find((node) => node.id === current.projection.activeNodeId);
        const draft = document.querySelector('button[aria-label="Draft thinking level"]')?.textContent ?? "";
        return {
          count: shown.length > 0 && shown.every(node => node.level !== undefined),
          mirrorsProjection: shown.every(node => expected.has(node.id) && node.level === expected.get(node.id)),
          draftInherits: !selected || draft.includes(selected.footer?.thinkingLevel ?? "off"),
        };
      })()`);
      if (!value.count || !value.mirrorsProjection || !value.draftInherits)
        throw new Error(`Graph thinking-level display does not follow the projection: ${JSON.stringify(value)}`);
      return value;
    });
    await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
    const graphShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, "gui-graph-draft.png"), Buffer.from(graphShot.data, "base64"));
  }
  const closedGraphWidth = await cdp.evaluate(
    "document.querySelector('.graph').getBoundingClientRect().width",
  );
  const closedNavigatorWidth = await cdp.evaluate(
    "document.querySelector('.navigator').getBoundingClientRect().width",
  );
  const closedChatWidth = await cdp.evaluate(
    "document.querySelector('.chat').getBoundingClientRect().width",
  );
  if (closedNavigatorWidth > 260 || closedChatWidth > 370)
    throw new Error(`Side panels expanded past their startup widths: ${JSON.stringify({ closedNavigatorWidth, closedChatWidth })}`);
  const initialToolPanel = await cdp.evaluate(`({
    closed: window.__pixTest.state().layout.collapsed.content,
    tabs: window.__pixTest.state().contentTabs.length,
    addHidden: !document.querySelector('[data-action=add-tool-tab]')
  })`);
  if (!initialToolPanel.closed || initialToolPanel.tabs || !initialToolPanel.addHidden)
    throw new Error(`Empty tool panel was visible at startup: ${JSON.stringify(initialToolPanel)}`);
  await cdp.evaluate("document.querySelector('[data-action=tool-panel]').click()");
  const panelReady = await retry(async () => {
    const value = await cdp.evaluate(`({
      title: document.title,
      sessions: window.__pixTest.state().sessions.length,
      toolHome: Boolean(document.querySelector('.tool-home')),
      toolIntroRemoved: !document.querySelector('.tool-home-title'),
      toolHeaderRemoved: !document.querySelector('.tool-panel > .panel-header'),
      contentOpen: !window.__pixTest.state().layout.collapsed.content,
      graphWidth: document.querySelector('.graph').getBoundingClientRect().width,
      smooth: getComputedStyle(document.querySelector('#content-panel')).transitionDuration !== '0s',
      slideMotion: getComputedStyle(document.querySelector('.tool-panel')).transitionProperty.includes('transform'),
      selectionDoesNotCheckout: !window.__pixTest.state().current || window.__pixTest.state().current.projection.activeNodeId === ${JSON.stringify(sessionState.activeNode)}
    })`);
    if (!value.toolHome || !value.toolIntroRemoved || !value.toolHeaderRemoved || !value.contentOpen || !value.smooth || !value.slideMotion || (!allowEmpty && !value.sessions) || !value.selectionDoesNotCheckout)
      throw new Error("Tool panel home is not ready");
    return value;
  });
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
  let screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "gui-tool-home.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await cdp.evaluate(
    "document.querySelector('[data-tool-section=files]').click()",
  );
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'files' && !window.__pixTest.state().layout.collapsed.content && Boolean(document.querySelector('.file-workspace .file-empty')) && Boolean(document.querySelector('.file-explorer')) && !document.querySelector('.workspace-tabs') && !document.querySelector('.tool-home')")))
      throw new Error("Tool selection did not open Files");
  });
  await cdp.evaluate("document.querySelector('[data-file-path=\"README.md\"]')?.click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.code-editor')) && Boolean(document.querySelector('[data-file-tab=\"README.md\"]')) && document.querySelector('[data-file-path=\"README.md\"]')?.classList.contains('active')")))
      throw new Error("File did not open in the workspace");
  });
  const fileMainWidth = await cdp.evaluate("document.querySelector('.file-main').getBoundingClientRect().width");
  await cdp.evaluate("document.querySelector('[data-action=toggle-file-tree]').click()");
  await retry(async () => {
    const value = await cdp.evaluate("({ hidden: !document.querySelector('.file-explorer'), width: document.querySelector('.file-main').getBoundingClientRect().width })");
    if (!value.hidden || value.width <= fileMainWidth + 100)
      throw new Error(`File tree did not collapse: ${JSON.stringify(value)}`);
  });
  await cdp.evaluate("document.querySelector('[data-action=toggle-file-tree]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.file-explorer'))")))
      throw new Error("File tree did not reopen");
  });
  if (allowEmpty) {
    await cdp.evaluate("document.querySelector('[data-directory-path=\"resources\"] > summary')?.click()");
    await retry(async () => {
      if (!(await cdp.evaluate("Boolean(document.querySelector('[data-file-path=\"resources/icon.png\"]'))")))
        throw new Error("Workspace directory did not load its contents");
    });
  }
  const previewPath = allowEmpty ? "resources/icon.png" : "image-preview.svg";
  await cdp.evaluate(`document.querySelector('[data-file-path=${JSON.stringify(previewPath)}]')?.click()`);
  await retry(async () => {
    if (!(await cdp.evaluate("document.querySelector('.image-preview img')?.naturalWidth > 0")))
      throw new Error("Image preview did not render");
  });
  await cdp.evaluate("document.querySelector('[data-file-tab=\"README.md\"] .tool-tab-close')?.click()");
  imagePreview = true;
  await cdp.evaluate("document.querySelector('[data-action=add-tool-tab]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-tool-menu=terminal]'))")))
      throw new Error("New tool tab menu did not open");
  });
  await cdp.evaluate("document.querySelector('[data-tool-menu=terminal]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate(`(() => {
      const add = document.querySelector('[data-action=add-tool-tab]').getBoundingClientRect();
      const toggle = document.querySelector('[data-action=tool-panel]').getBoundingClientRect();
      return window.__pixTest.state().contentSection === 'terminal'
        && window.__pixTest.state().contentTabs.length === 2
        && document.querySelectorAll('.tool-tab').length === 2
        && add.width > 0
        && (add.bottom <= toggle.top || add.top >= toggle.bottom || add.right <= toggle.left || add.left >= toggle.right);
    })()`)))
      throw new Error("Function panel did not keep multiple tabs");
  });
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.terminal-host .xterm-helper-textarea'))")))
      throw new Error("Interactive terminal did not mount");
  });
  await cdp.evaluate("document.querySelector('.terminal-host .xterm-helper-textarea').focus()");
  await cdp.send("Input.insertText", {
    text: process.platform === "win32"
      ? "Write-Output pix-terminal-gui"
      : "printf 'pix-terminal-gui\\n'",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await retry(async () => {
    if (!(await cdp.evaluate("document.querySelector('.terminal-host .xterm-rows')?.textContent.includes('pix-terminal-gui')")))
      throw new Error("Interactive terminal did not execute typed input");
  });
  await cdp.evaluate("document.querySelector('[data-tool-tab=files] .tool-tab-main').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'files' && document.querySelector('[data-tool-tab=files]').classList.contains('active')")))
      throw new Error("Function panel tab did not switch back to Files");
  });
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
  panelReady.graphWidth = await cdp.evaluate("document.querySelector('.graph').getBoundingClientRect().width");
  panelReady.chatWidth = await cdp.evaluate("document.querySelector('.chat').getBoundingClientRect().width");
  if (panelReady.graphWidth + panelReady.chatWidth >= closedGraphWidth + closedChatWidth - 20)
    throw new Error(`Graph/chat did not shrink when tool panel opened: graph ${closedGraphWidth} -> ${panelReady.graphWidth}; chat ${closedChatWidth} -> ${panelReady.chatWidth}`);
  const result = await cdp.evaluate(`({
    ...${JSON.stringify(panelReady)},
    panels: ['navigator','graph','chat','content'].every(name => document.querySelector('.' + name))
  })`);
  result.graphNode = graphNode;
  result.chatToggle = true;
  result.initialChatExpanded = true;
  result.startupPanelWidths = { navigator: closedNavigatorWidth, chat: closedChatWidth };
  result.toolTabs = true;
  result.fileWorkspace = true;
  result.imagePreview = imagePreview;
  screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, allowEmpty ? "gui-empty.png" : "gui-smoke.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await cdp.evaluate("document.querySelector('[data-action=tool-panel]').click()");
  await retry(async () => {
    const value = await cdp.evaluate("({ closed: window.__pixTest.state().layout.collapsed.content, graphWidth: document.querySelector('.graph').getBoundingClientRect().width })");
    if (!value.closed || value.graphWidth <= panelReady.graphWidth + 20)
      throw new Error("Tool panel did not slide out");
  });
  await cdp.evaluate("document.querySelector('[data-action=tool-panel]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'files' && !window.__pixTest.state().layout.collapsed.content && Boolean(document.querySelector('.file-workspace'))")))
      throw new Error("Tool panel did not reopen its last tool");
  });
  result.reopenLastTool = true;
  await cdp.evaluate("document.querySelector('[data-action=tool-panel]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().layout.collapsed.content")))
      throw new Error("Tool panel did not close before navigation");
  });
  const workbenchBeforeSettings = await cdp.evaluate(`({
    graphTransform: document.querySelector('.vue-flow__transformationpane')?.style.transform,
    contentClosed: window.__pixTest.state().layout.collapsed.content
  })`);
  await cdp.evaluate("window.__pixTest.settings()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.settings-page .settings-card'))")))
      throw new Error("Settings page is blank");
  });
  await cdp.evaluate("document.querySelector('[data-settings-category=models]').click()");
  await retry(async () => {
    const value = await cdp.evaluate(`({
      title: document.querySelector('.settings-page h1')?.textContent,
      search: Boolean(document.querySelector('[data-model-search]')),
      providers: document.querySelectorAll('[data-provider]').length,
      providerSetups: document.querySelectorAll('[data-provider-setup]').length
    })`);
    if (value.title !== 'Model' || !value.search || !value.providers || value.providerSetups)
      throw new Error(`Combined model settings are not usable: ${JSON.stringify(value)}`);
  });
  if (await cdp.evaluate("Boolean(document.querySelector('[data-provider-models], [data-provider-setup]'))"))
    throw new Error("A provider was expanded by default");
  await cdp.evaluate("document.querySelector('[data-provider-configure=openai-codex]').click()");
  const oauthMethods = await cdp.evaluate("[...document.querySelectorAll('[data-provider-oauth=openai-codex]')].map((element) => element.dataset.oauthMethod).sort().join(',')");
  if (oauthMethods !== "browser,device-code")
    throw new Error(`OpenAI Codex OAuth methods are missing: ${oauthMethods}`);
  await cdp.evaluate("document.querySelector('[data-provider-configure=openai-codex]').click()");
  await cdp.evaluate(`(() => {
    const search = document.querySelector('[data-model-search]');
    search.value = 'openai';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-provider=openai]'))")))
      throw new Error("OpenAI provider was not searchable");
  });
  const alreadyConfigured = await cdp.evaluate("Boolean(document.querySelector('[data-provider=openai] .provider-status.configured'))");
  if (!alreadyConfigured) {
    await cdp.evaluate("document.querySelector('[data-provider-configure=openai]').click()");
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-provider-api-key=openai]');
      input.value = 'pix-gui-test-key';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await retry(async () => {
      if (!(await cdp.evaluate("!document.querySelector('[data-provider-api-key=openai]').closest('form').querySelector('button').disabled")))
        throw new Error("API key save action did not enable");
    });
    await cdp.evaluate("document.querySelector('[data-provider-api-key=openai]').closest('form').querySelector('button').click()");
    await retry(async () => {
      if (!(await cdp.evaluate("document.querySelector('[data-provider=openai] .provider-status').classList.contains('configured')")))
        throw new Error("API key was not persisted through Pi ModelRuntime");
    });
  }
  await retry(async () => {
    if (!(await cdp.evaluate(`(() => {
      const configured = document.querySelector('[data-provider-section=configured]');
      const other = document.querySelector('[data-provider-section=other]');
      const openai = document.querySelector('[data-provider=openai]');
      return Boolean(configured && other && openai && (configured.compareDocumentPosition(openai) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`)))
      throw new Error("Configured providers are not grouped above other providers");
  });
  await cdp.evaluate(`(() => {
    if (!document.querySelector('[data-provider-models=openai]'))
      document.querySelector('[data-provider=openai] .provider-model-toggle').click();
  })()`);
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-provider-models=openai] [data-model]'))")))
      throw new Error("OpenAI provider did not expand its model list");
  });
  await retry(async () => {
    const value = await cdp.evaluate(`({
      search: Boolean(document.querySelector('[data-model-search]')),
      models: document.querySelectorAll('[data-model]').length,
      actions: document.querySelectorAll('[data-model-action]').length,
      defaultOnly: Boolean(document.querySelector('[data-model-action=default]')) && !document.querySelector('[data-model-action=session]'),
      thinking: Boolean(document.querySelector('[data-setting-path=modelThinkingLevels]')),
      cycling: Boolean(document.querySelector('.model-cycle input'))
    })`);
    if (!value.search || !value.models || value.actions !== 1 || !value.defaultOnly || !value.thinking || !value.cycling)
      throw new Error(`Model settings are not usable: ${JSON.stringify(value)}`);
  });
  screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, "gui-settings.png"), Buffer.from(screenshot.data, "base64"));
  await cdp.evaluate("document.querySelector('[data-settings-category=appearance]').click()");
  const themePreview = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-setting-path=theme] select');
    const original = input.value;
    input.value = original === 'dark' ? 'light' : 'dark';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { original, preview: input.value };
  })()`);
  await retry(async () => {
    const value = await cdp.evaluate(`({
      theme: document.documentElement.dataset.theme,
      savingTheme: document.querySelector('[data-setting-path=theme] select')?.disabled,
      tuiTheme: Boolean(document.querySelector('[data-setting-path=tuiMode], [data-setting-path="terminal.showTerminalProgress"]')),
      advanced: Boolean(document.querySelector('[data-settings-category=advanced]'))
    })`);
    const saved = JSON.parse(readFileSync(join(testHome, ".pix", "settings.json"), "utf8"));
    if (value.theme !== themePreview.preview || value.savingTheme || saved.theme !== themePreview.preview || value.tuiTheme || value.advanced)
      throw new Error(`GUI appearance settings are not effective: ${JSON.stringify(value)}`);
  });
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-setting-path=theme] select');
    input.value = ${JSON.stringify(themePreview.original)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await retry(async () => {
    if (await cdp.evaluate("document.querySelector('[data-setting-path=theme] select').disabled"))
      throw new Error("Theme restore is still saving");
    const saved = JSON.parse(readFileSync(join(testHome, ".pix", "settings.json"), "utf8"));
    if (saved.theme !== themePreview.original) throw new Error("Theme restore was not persisted");
  });
  for (const [category, setting] of [
    ['general', 'defaultProjectTrust'],
    ['appearance', 'theme'],
    ['sessions', 'compaction.enabled'],
    ['agent', 'transport'],
    ['tools', 'images.autoResize'],
    ['shell', 'websocketConnectTimeoutMs']
  ]) {
    await cdp.evaluate(`document.querySelector('[data-settings-category="${category}"]').click()`);
    await retry(async () => {
      if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-setting-path="${setting}"]'))`)))
        throw new Error(`Missing ${category} setting: ${setting}`);
    });
  }
  await cdp.evaluate("document.querySelector('[data-settings-category=models]').click()");
  screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, "gui-settings-models.png"), Buffer.from(screenshot.data, "base64"));

  // Skills are real SKILL.md files under the Pi agent dir; the settings page
  // creates, toggles, and deletes them through the host, so assert the disk.
  const guiSkillDir = join(testHome, ".pi", "agent", "skills", "pix-gui-skill");
  const guiSkillFile = join(guiSkillDir, "SKILL.md");
  rmSync(guiSkillDir, { recursive: true, force: true });
  await cdp.evaluate("document.querySelector('[data-settings-category=skills]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.skill-card [data-skill-search]'))")))
      throw new Error("Skills settings did not render");
  });
  await cdp.evaluate("document.querySelector('[data-skill-new]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('form[data-skill-form]'))")))
      throw new Error("Skill editor did not open");
  });
  await cdp.evaluate(`(() => {
    const name = document.querySelector('[data-skill-name]');
    name.value = 'pix-gui-skill';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const description = document.querySelector('[data-skill-description]');
    description.value = 'Created by the PiX GUI test.';
    description.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await retry(async () => {
    if (await cdp.evaluate("document.querySelector('[data-skill-save]').disabled"))
      throw new Error("Skill save did not enable");
  });
  await cdp.evaluate("document.querySelector('form[data-skill-form]').requestSubmit()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-skill=\"pix-gui-skill\"]'))")))
      throw new Error("Created skill did not appear in the list");
  });
  if (!readFileSync(guiSkillFile, "utf8").includes("Created by the PiX GUI test."))
    throw new Error("Skill file did not keep its description");
  await cdp.evaluate("document.querySelector('[data-skill=\"pix-gui-skill\"] [data-skill-manual]').click()");
  await retry(async () => {
    if (!readFileSync(guiSkillFile, "utf8").includes("disable-model-invocation"))
      throw new Error("Manual-only toggle was not written to the skill file");
  });
  const guiSkillRemove = "document.querySelector('[data-skill=\"pix-gui-skill\"] .skill-row-actions button:last-child')";
  await cdp.evaluate(`${guiSkillRemove}.click()`);
  await retry(async () => {
    if (!(await cdp.evaluate(`Boolean(${guiSkillRemove}?.classList.contains('is-arming'))`)))
      throw new Error("Skill delete did not arm on the first press");
  });
  await cdp.evaluate(`${guiSkillRemove}.click()`);
  await retry(async () => {
    if (await cdp.evaluate("Boolean(document.querySelector('[data-skill=\"pix-gui-skill\"]'))"))
      throw new Error("Deleted skill is still listed");
  });
  if (existsSync(guiSkillDir)) throw new Error("Deleted skill directory is still on disk");

  await cdp.evaluate("document.querySelector('.settings-page > aside > button').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.shell'))")))
      throw new Error("Settings page did not return to the workbench");
  });
  const workbenchAfterSettings = await cdp.evaluate(`({
    graphTransform: document.querySelector('.vue-flow__transformationpane')?.style.transform,
    contentClosed: window.__pixTest.state().layout.collapsed.content
  })`);
  if (!workbenchAfterSettings.contentClosed || workbenchAfterSettings.graphTransform !== workbenchBeforeSettings.graphTransform)
    throw new Error(`Workbench layout changed after navigation: ${JSON.stringify({ workbenchBeforeSettings, workbenchAfterSettings })}`);
  result.workbenchPreserved = true;
  // The catalog the settings page just reloaded (the API key login above) must
  // reach the graph draft's model picker without a restart or session reopen.
  if (await cdp.evaluate("Boolean(window.__pixTest.state().current)")) {
    await cdp.evaluate(`(() => {
      if (!document.querySelector('.draft-node')) {
        const node = document.querySelector('.prompt-node.selected') ?? document.querySelector('.prompt-node');
        node.querySelector('.node-add').click();
      }
    })()`);
    await retry(async () => {
      if (!(await cdp.evaluate(`Boolean(document.querySelector('.draft-node button[aria-label="Draft model"]'))`)))
        throw new Error("Graph draft did not open after returning from settings");
    });
    await cdp.evaluate(`document.querySelector('.draft-node button[aria-label="Draft model"]').click()`);
    await retry(async () => {
      if (!(await cdp.evaluate(`Boolean(document.querySelector('.node-model-menu [data-model-provider=openai]'))`)))
        throw new Error("Graph draft model picker did not include the provider configured in settings");
    });
    await cdp.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.querySelector('.vue-flow__pane')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    })()`);
    await retry(async () => {
      if (await cdp.evaluate("Boolean(document.querySelector('.node-model-menu'))"))
        throw new Error("Draft model menu did not close");
    });
    result.graphPickerSynced = true;
  }
  await cdp.evaluate("document.querySelector('[data-tool-tab=terminal] .tool-tab-close').click()");
  await retry(async () => {
    if ((await cdp.evaluate("window.__pixTest.state().contentTabs.length")) !== 1)
      throw new Error("Tool tab did not close");
  });
  await cdp.evaluate("document.querySelector('[data-tool-tab=files] .tool-tab-close').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("document.querySelector('[data-tool-tab=files] .tool-tab-main')?.textContent.includes('Open file')")))
      throw new Error("Closing the last file did not restore Open file");
  });
  await cdp.evaluate("document.querySelector('[data-tool-tab=files] .tool-tab-close').click()");
  await retry(async () => {
    const value = await cdp.evaluate(`({
      closed: window.__pixTest.state().layout.collapsed.content,
      tabs: window.__pixTest.state().contentTabs.length,
      addHidden: !document.querySelector('[data-action=add-tool-tab]')
    })`);
    if (!value.closed || value.tabs || !value.addHidden)
      throw new Error(`Empty tool panel did not close: ${JSON.stringify(value)}`);
  });
  result.emptyToolPanelClosed = true;
  result.settings = true;
  result.exitSmooth = true;
  writeFileSync(
    join(artifacts, "gui-smoke.json"),
    JSON.stringify({ ...result, passed: true }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await devServer?.close();
  if (wslStoppedPid) {
    try { signalWslTestHost(wslStoppedPid, "CONT"); } catch (error) { console.error(error); }
  }
  await cdp?.close();
  if (process.platform === "win32" && child.pid)
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  if (sshWorkspace)
    spawnSync("ssh", [...sshTestArgs, `test "$(readlink -f '${sshWorkspace}')" = '${sshWorkspace}' && rm -rf -- '${sshWorkspace}'`], { stdio: "ignore", windowsHide: true });
  if (wslWorkspace)
    spawnSync(
      "wsl.exe",
      [
        "--exec",
        "sh",
        "-lc",
        'case "$1" in /tmp/pix-wsl-gui-*) rm -rf -- "$1" ;; *) exit 2 ;; esac',
        "sh",
        wslWorkspace,
      ],
      { stdio: "ignore", windowsHide: true },
    );
}
