import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import { releaseInstallReservations, type InstallReservation } from "../host/client.js";
import { prepareInstallation, type InstallPrompt } from "../main/install-guard.js";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
interface ProcessIdentity { pid: number; birth: string; desktop?: boolean }
interface Receipt { ownerPid: number; reservations: InstallReservation[] }
interface GuiContext { uid: number; gid: number; env: NodeJS.ProcessEnv }
const { values: args } = parseArgs({ options: {
  prepare: { type: "boolean" }, finish: { type: "boolean" },
  target: { type: "string", multiple: true }, receipt: { type: "string" }, "owner-pid": { type: "string" },
  ui: { type: "string" }, language: { type: "string" },
} });
const receipt = resolve(args.receipt ?? "");
const helper = join(dirname(process.argv[1]!), "installer-helper.ps1");
const zh = args.language === "zh-CN" || (args.language !== "en" && /^(zh|Chinese)/i.test(process.env.LANG ?? ""));
async function windows(action: string, extra: string[] = []) {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", action, ...extra], { windowsHide: true, timeout: action === "show" ? 0 : 15_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}
async function discover(targets: string[]) {
  const homes = new Set([process.env.PIX_HOME ?? homedir()]);
  const processes: ProcessIdentity[] = [];
  let gui: GuiContext | undefined;
  if (process.platform === "win32") {
    const found = await windows("inspect", ["-Targets", JSON.stringify(targets)]);
    processes.push(...found.processes.filter((item: ProcessIdentity) => item.pid !== process.pid));
    for (const home of found.homes) {
      try {
        const address = JSON.parse(readFileSync(join(home, ".pix/run/host.json"), "utf8"));
        if (processes.some(item => item.pid === address.pid)) homes.add(home);
      } catch (error) { if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
  } else if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^[1-9]\d*$/.test(name) || Number(name) === process.pid) continue;
      let executable: string;
      try { executable = readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, ""); }
      catch (error) { if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      if (!targets.includes(executable)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const env = Object.fromEntries(readFileSync(`/proc/${name}/environ`, "utf8").split("\0").filter(item => item.includes("=")).map(item => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; }));
        const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
        processes.push({ pid: Number(name), birth: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!,
          desktop: env.ELECTRON_RUN_AS_NODE !== "1" && !argv.some(arg => arg.startsWith("--type=")) });
        const home = env.PIX_HOME || env.HOME;
        if (home) homes.add(home);
        if (!gui && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
          const status = readFileSync(`/proc/${name}/status`, "utf8");
          const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
          const gid = Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]);
          if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid)) gui = { uid, gid, env };
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
  }
  return { homes: [...homes], processes, gui };
}
async function linuxDialog(title: string, detail: string, buttons: string[], gui: GuiContext) {
  // Package hooks run as root; native dialogs belong to the desktop user.
  const credentials = process.getuid?.() === 0 ? { uid: gui.uid, gid: gui.gid } : {};
  const choices = buttons.flatMap((button, i) => [i === 0 ? "TRUE" : "FALSE", button]);
  for (const [binary, parameters] of [
    ["zenity", ["--list", "--radiolist", "--hide-header", "--column=Select", "--column=Action", "--print-column=2", `--title=${title}`, `--text=${detail.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`, ...choices]],
    ["kdialog", ["--title", title, "--menu", detail, ...buttons.flatMap((button, i) => [String(i), button])]],
  ] as const) {
    try {
      const { stdout } = await exec(binary, [...parameters], { env: gui.env, ...credentials, maxBuffer: 1024 * 1024 });
      const answer = binary === "zenity" ? buttons.indexOf(stdout.trim()) : Number(stdout.trim());
      return Number.isInteger(answer) && answer >= 0 && answer < buttons.length ? answer : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return 0;
    }
  }
  throw new Error("PiX tasks are unchanged. Retry installation from an interactive terminal, or quit PiX completely first.");
}
async function show(prompt: InstallPrompt, gui?: GuiContext) {
  const zh = args.language ? args.language === "zh-CN" : /^zh/i.test(gui?.env.LANG ?? process.env.LANG ?? "");
  const title = zh ? (prompt.confirm ? "确认终止任务并安装？" : "PiX 仍有任务在运行") : (prompt.confirm ? "Interrupt tasks and install?" : "PiX still has running tasks");
  const detail = prompt.confirm
    ? (zh ? "本地任务和终端命令将中断，PiX 窗口将关闭，客户端将断开。未保存内容可能丢失；远程任务可能继续运行。确认后会先正常退出，必要时才强制终止。" : "Local tasks and shell commands will be interrupted, PiX windows will close, and clients will disconnect. Unsaved work may be lost; remote tasks may continue. PiX first tries a normal shutdown and forces termination only if necessary.")
    : prompt.detail;
  const buttons = prompt.confirm ? (zh ? ["取消", "终止并安装"] : ["Cancel", "Interrupt and Install"]) : (zh ? ["取消安装", "重新检查", "终止并安装…"] : ["Cancel Installation", "Check Again", "Interrupt and Install…"]);
  if (args.ui === "windows") return windows("show", ["-Title", title, "-Detail", detail, "-Buttons", JSON.stringify(buttons)]);
  if (args.ui === "terminal" && !process.stdin.isTTY && gui && process.env.DEBIAN_FRONTEND !== "noninteractive")
    return linuxDialog(title, detail, buttons, gui);
  if (args.ui !== "terminal" || !process.stdin.isTTY || process.env.DEBIAN_FRONTEND === "noninteractive")
    throw new Error(`${title}\n${prompt.detail}\n${zh ? "已取消安装，任务保持运行。请在交互终端重新安装，或先从 PiX 菜单完整退出。" : "Installation cancelled; tasks are unchanged. Retry from an interactive terminal, or quit PiX completely first."}`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${title}\n${detail}\n${buttons.map((button, index) => `${index}: ${button}`).join("\n")}`);
    const answer = (await input.question(zh ? "请选择 [默认 0]：" : "Choose [default 0]: ")).trim();
    return /^[0-2]$/.test(answer) && Number(answer) < buttons.length ? Number(answer) : 0;
  } finally { input.close(); }
}
async function closeProcesses(targets: string[], snapshot: ProcessIdentity[], force: boolean) {
  const current = async () => {
    const now = (await discover(targets)).processes;
    if (now.some(candidate => !snapshot.some(item => item.pid === candidate.pid && item.birth === candidate.birth)))
      throw new Error("Another PiX instance started during installation. No files were replaced; check again before installing.");
    return snapshot.filter(item => now.some(candidate => candidate.pid === item.pid && candidate.birth === item.birth));
  };
  let remaining = await current();
  if (process.platform === "win32" && remaining.length) await windows("close", ["-Targets", JSON.stringify(targets), "-Processes", JSON.stringify(remaining)]);
  if (process.platform === "linux") for (const item of remaining.filter(item => item.desktop)) {
    // Unattached recovery windows cannot receive the host's shutdown event.
    // Signal main processes only, leaving their renderers to normal app Quit.
    try { process.kill(item.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  let deadline = Date.now() + 10_000;
  let forced = false;
  while ((remaining = await current()).length) {
    if (Date.now() >= deadline) {
      if (!force || forced) throw new Error(zh ? "PiX 窗口未能退出，安装尚未开始。请完整退出 PiX 后重试。" : "PiX windows could not quit; installation has not started. Quit PiX completely and retry.");
      if (process.platform === "win32") await windows("kill", ["-Targets", JSON.stringify(targets), "-Processes", JSON.stringify(remaining)]);
      else for (const item of remaining) { try { process.kill(item.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      forced = true;
      deadline = Date.now() + 5000;
    }
    await delay(200);
  }
}
function readReceipt(): Receipt | undefined {
  if (!existsSync(receipt)) return;
  if (!lstatSync(receipt).isFile()) throw new Error("Invalid installer receipt");
  const saved = JSON.parse(readFileSync(receipt, "utf8")) as Receipt;
  if (!Number.isInteger(saved.ownerPid) || saved.ownerPid <= 0 || !Array.isArray(saved.reservations)
    || !saved.reservations.every(item => typeof item.home === "string" && item.ownerPid === saved.ownerPid && typeof item.token === "string"))
    throw new Error("Invalid installer receipt");
  return saved;
}
function finish(saved: Receipt) {
  releaseInstallReservations(saved.reservations);
  rmSync(receipt);
}
async function main() {
  if (!args.receipt || Boolean(args.prepare) === Boolean(args.finish)) throw new Error("Choose prepare or finish with an installer receipt");
  const saved = readReceipt();
  if (args.finish) { if (saved) finish(saved); return; }
  if (saved) {
    if (alive(saved.ownerPid)) throw new Error("Another PiX installation is in progress");
    finish(saved);
  }
  const ownerPid = Number(args["owner-pid"]);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid || !alive(ownerPid) || !args.target?.length)
    throw new Error("The installer is no longer running");
  const targets = args.target.map(path => resolve(path));
  const found = await discover(targets);
  const state: Receipt = { ownerPid, reservations: [] };
  writeFileSync(receipt, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  try {
    const reservations = await prepareInstallation({ ...found, ownerPid, show: prompt => show(prompt, found.gui),
      stopped: force => closeProcesses(targets, found.processes, force),
      save: reservations => { state.reservations = reservations; writeFileSync(receipt, JSON.stringify(state)); },
    });
    if (!reservations) { finish(state); process.exitCode = 2; }
  } catch (error) {
    try { finish(state); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${String(error)}\n${String(cleanupError)}`, { cause: error });
    }
    throw error;
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
