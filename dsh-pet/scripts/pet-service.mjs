/**
 * pet-service.mjs —— 独立模式「确保服务在跑」的共享实现。
 *
 * 为什么单独一个文件：`launch-pet.mjs`（启动）与 `open-admin.mjs`（打开管理页）
 * 都要「服务没起就拉起来、起了就复用」。复制一份必然漂移（端口判断、日志路径、
 * ready 超时各写一遍），而这个项目对「第二份实现」是零容忍的 —— 抽出来共用。
 *
 * 关键约束（踩过的坑，别改回去）：
 *   - **不自己 spawn Electron**：服务会按 `display: both` 自己拉桌宠窗口，
 *     脚本再 spawn 一次就是两只桌宠；
 *   - detached + windowsHide：关掉脚本所在窗口不影响常驻服务；
 *   - 已在运行就什么都不做：双击多次也只有一只桌宠。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needsRebuild, newestMtimeMs } from './build-freshness.mjs';
import { backupSuffix, parseConfigText, planDisplayHeal } from './config-heal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dsh-pet 包根（scripts/ 的上一级） */
export const PKG = resolve(HERE, '..');

export function petHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

export function petDataDir() {
  return join(petHome(), 'dsh-pet');
}

export function petLogPath() {
  return join(petDataDir(), 'launcher.log');
}

export function petBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** 启动器日志（服务与启动器共写同一个文件） */
export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(petDataDir(), { recursive: true });
    appendFileSync(petLogPath(), line);
  } catch {
    // 日志写不进去不该阻断启动
  }
  process.stdout.write(line);
}

/** 探活：认名字，不认端口（端口上可能是别的服务） */
export async function petHealth(port) {
  try {
    const res = await fetch(petBaseUrl(port) + '/health', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.name === 'dsh-pet-standalone' ? body : null;
  } catch {
    return null;
  }
}

// ---------- 端口占用者三态（S0 之后的真 bug 修在这里） ----------

/**
 * 端口占用者：
 * - `none`           端口空着（连接拒绝/超时）→ 可以去起服务
 * - `our-standalone` 独立模式桌宠已经在跑 → 直接用，不 spawn
 * - `foreign`        **能连上但不是我们的**（DSH 宿主 / 别的程序 / 404 / HTML）
 *                    → **绝不许 spawn**：DSH 也占着 3080，spawn 会撞端口然后干等 30 秒，
 *                    用户看到的就是"双击了，什么都没发生"。
 *
 * 这是本 bug 的根因：旧代码只有"能连上且 name 匹配"这一个布尔，
 * 于是 DSH 占着 3080 时被判成"没在跑"，一路走到撞端口。
 *
 * @param {{reachable: boolean, body: unknown}} probe
 * @returns {'none' | 'our-standalone' | 'foreign'}
 */
export function classifyPortOccupant(probe) {
  if (!probe || probe.reachable !== true) return 'none';
  const body = probe.body;
  const name = body !== null && typeof body === 'object' ? body.name : undefined;
  return name === 'dsh-pet-standalone' ? 'our-standalone' : 'foreign';
}

/**
 * 探一次端口：连不上 → `{reachable:false}`；连上 → 尽力解析 JSON 当 body。
 * 非 JSON（HTML 错误页 / 空响应）→ body 为 undefined，分类会落到 `foreign`。
 */
export async function probePortOccupant(port) {
  try {
    const res = await fetch(petBaseUrl(port) + '/health', { signal: AbortSignal.timeout(1500) });
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { reachable: true, body };
  } catch {
    return { reachable: false, body: undefined };
  }
}

/** 失败时最多回读多少字节日志（错误总在末尾，不必整份读） */
const OUTPUT_CAP = 16 * 1024;

/**
 * 启动失败（带子进程输出原文，供 launch-hints.mjs 分类）。
 * 用独立类而不是 Error + message：分类要的是**原文**，不是我们拼的一句话。
 */
export class LaunchFailure extends Error {
  constructor(message, { output = '', port, reason } = {}) {
    super(message);
    this.name = 'LaunchFailure';
    this.output = output;
    this.port = port;
    /** 已知原因（如 'foreign-occupant'）；分类器会优先用它，不必再从输出里猜 */
    this.reason = reason;
  }
}

/** 读日志里「本次启动之后新增」的部分（末尾 OUTPUT_CAP 字节） */
function readNewLog(logStart) {
  try {
    const size = statSync(petLogPath()).size;
    if (size <= logStart) return '';
    const len = Math.min(size - logStart, OUTPUT_CAP);
    const buf = Buffer.alloc(len);
    const fd = openSync(petLogPath(), 'r');
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** 构建产物（lib/standalone.js） */
const LIB_ENTRY = () => join(PKG, 'lib', 'standalone.js');

/**
 * 递归收集目录下所有文件的 mtime（纯数据收集，判断交给 needsRebuild）。
 * 只扫 `src/`：lib 与 runtime/shared-core.js 都只由 src/ 生成；
 * runtime/ 下其余文件是 Electron 直接加载的手写 JS，不参与 lib 构建。
 */
function collectMtimes(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of names) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      collectMtimes(full, out);
    } else if (item.isFile()) {
      try {
        out.push({ mtimeMs: statSync(full).mtimeMs });
      } catch {
        // 单个文件读不到不该让整次检测失败
      }
    }
  }
  return out;
}

/** 跑一条构建命令；返回是否成功（输出直接进 launcher.log，用户能看到） */
function runBuild(label, args) {
  log(`[build] ${label}…`);
  const fd = openSync(petLogPath(), 'a');
  const result = spawnSync(process.execPath, args, {
    cwd: PKG,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  if (result.status === 0) {
    log(`[build] ${label} 完成`);
    return true;
  }
  log(`[build] ${label} 失败（exit=${result.status}）`);
  return false;
}

/** 原子写 JSON：临时文件 + rename（改用户配置必须走这条） */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** 主配置文件路径（与 host 同一份：$DSH_HOME/dsh-pet/main-config.jsonc） */
const CONFIG_FILE = () => join(petDataDir(), 'main-config.jsonc');

/**
 * 自愈 `display:"none"` → `"desktop"`。
 *
 * 为什么必须做：菜单「显示位置 → 都不」会把桌宠从两端同时藏掉，而独立模式**没有设置页**、
 * 菜单又长在那个看不见的桌宠上 —— 用户双击快捷方式什么都没发生，且无从改回。
 * 用户双击这个快捷方式，意图就是"我要看到桌宠"。
 *
 * 纪律：**改用户配置前必须备份**（原子写：临时文件 + rename），备份名带日期时间。
 * 配置损坏时**不清洗**，只警告 —— 写坏一个已经坏的文件只会更坏。
 */
function healDisplay() {
  const file = CONFIG_FILE();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { changed: false }; // 没有配置文件：用包内默认（display 默认就是 desktop），无需自愈
  }
  const parsed = parseConfigText(text);
  if (!parsed.ok) {
    log(`配置损坏，未做自愈（${parsed.message}）：${file}`);
    return { changed: false };
  }
  const plan = planDisplayHeal(parsed.value, { mode: 'standalone' });
  if (!plan.changed) return { changed: false };

  // 先备份，再原子写
  const backup = `${file}.bak-${backupSuffix()}`;
  try {
    copyFileSync(file, backup);
    writeJsonAtomic(file, plan.value);
  } catch (e) {
    log(`自愈失败（配置未改动）：${e instanceof Error ? e.message : String(e)}`);
    return { changed: false };
  }
  log(plan.reason);
  log(`原配置已备份到：${backup}`);
  return { changed: true };
}

/**
 * 源码比产物新就重建。**构建失败绝不静默启动旧代码** —— 抛出去让 .cmd pause 住，
 * 用户看到"构建失败，仍在用旧版"而不是默默跑旧行为。
 */
async function ensureFreshBuild() {
  const libMtime = (() => {
    try {
      return statSync(LIB_ENTRY()).mtimeMs;
    } catch {
      return NaN;
    }
  })();
  const srcNewest = newestMtimeMs(collectMtimes(join(PKG, 'src')));
  if (!needsRebuild(libMtime, srcNewest)) return;

  log('检测到源码更新，重新构建…');
  // 两个产物都由 src/ 生成：桌面菜单在 shared-core.js 里，服务在 lib/ 里。
  // 先建 shared-core 再建 lib，让 lib 保持最新（检测只比 src，不受产物顺序影响）。
  const coreOk = runBuild('桌面共享核心（shared-core.js）', [join('scripts', 'build-desktop-core.mjs')]);
  const libOk = runBuild('构建 lib/standalone.js（tsdown）', [
    join('node_modules', 'tsdown', 'bin', 'tsdown.js'),
  ]);
  if (!coreOk || !libOk) {
    throw new LaunchFailure('构建失败，仍在用旧版（见日志里的 [build] 行）', {
      reason: 'build-failed',
      output: '',
    });
  }
}

/**
 * 确保独立服务在跑。
 *
 * 与上一版的区别：**子进程退出时不再只会等超时**。现在会听 `exit` 事件、回读本次
 * 新增的日志，把原文交给 `LaunchFailure` —— 这样调用方才能说清"为什么没起来"
 * （端口被占 / 单实例锁拒绝 / Electron 缺失），而不是笼统一句 30s 超时。
 *
 * stdio 仍全部重定向到日志文件（不接管道）：接管道的话父进程一退出就会关掉读端，
 * 常驻服务继续打日志会撞 EPIPE 而崩 —— 这是之前踩过的坑。
 *
 * @param port 端口（默认 3080，可用 DSH_PET_PORT 覆盖）
 * @param port 端口
 * @param deps 可注入 `probe` / `spawnFn`（单测用；默认走真实探测与真实 spawn）
 * @returns {{ alreadyRunning: boolean, entry: string, output: string }}
 */
export async function ensurePetService(port, deps = {}) {
  const probe = deps.probe ?? probePortOccupant;
  const spawnService = deps.spawnFn ?? spawn;
  const entry = join(PKG, 'lib', 'standalone.js');
  if (!existsSync(entry)) {
    throw new LaunchFailure(`找不到 ${entry}，先跑一次 pnpm bundle`, { port });
  }

  // 🔴 自愈必须放在**最前面**（在下面的 alreadyRunning 早退之前）。
  // 曾经放在 spawn 之前 → 服务已经在跑时走了早退，自愈一次都没执行，
  // 用户连点 4 次快捷方式都没用（这就是"双击没反应"的直接原因）。
  // 独立模式下 display 为 none / web 都是死路（没有网页界面），每次启动都治。
  const healed = healDisplay();

  // 先分清端口上是谁。**判断在 spawn 之前**，因为 DSH 也占 3080：
  // 判成"没在跑"就会一路撞端口 + 干等 30 秒，用户看到的是"双击没反应"。
  const occupant = classifyPortOccupant(await probe(port));
  if (occupant === 'our-standalone') {
    // 自愈改了配置、但服务正带着旧配置在跑 → 明确告知，**不自动 /shutdown**
    // （那会不经用户同意杀掉他眼前的桌宠）。
    if (healed.changed) {
      log('配置已修正为「桌面显示」，但桌宠正在用旧配置运行。');
      log('请右键桌宠 → 重载配置，或双击「关闭桌宠」后再双击「桌宠」。');
    }
    return { alreadyRunning: true, entry, output: '' };
  }
  if (occupant === 'foreign') {
    // 立刻失败，绝不 spawn、绝不进下面的等待循环
    throw new LaunchFailure(`端口 ${port} 被别的程序占用（不是独立模式桌宠）`, {
      port,
      reason: 'foreign-occupant',
      output: '',
    });
  }
  // occupant === 'none'：端口空着，可以去起服务

  // 陈旧检测：源码比构建产物新 → 先重建，再启动。
  // 不重建的话用户改了代码双击还是旧行为，会以为"改了没生效"。
  await ensureFreshBuild();

  log(`启动服务：${entry} --port ${port}`);
  const logStart = (() => {
    try {
      return statSync(petLogPath()).size;
    } catch {
      return 0;
    }
  })();
  const fd = openSync(petLogPath(), 'a');
  const child = spawnService(process.execPath, [entry, '--port', String(port)], {
    cwd: PKG,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });

  /** 子进程退出记录（null = 还活着）；等到它退出就不必再空等 30 秒 */
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await petHealth(port)) {
      // 把本次启动新增的日志原文交回去：调用方用 launch-hints 自己判
      //（"Electron 缺失"不是同步失败，只是桌宠窗口出不来，必须靠日志判断）
      const output = readNewLog(logStart);
      log(`服务就绪：${petBaseUrl(port)}（pid=${child.pid}）—— 桌宠窗口由服务自动拉起，稍等 1-3 秒出现`);
      return { alreadyRunning: false, entry, output };
    }
    if (exited !== null) {
      // 早点失败：子进程已经退出且健康检查没通过 → 用它的输出判断原因
      throw new LaunchFailure(`服务进程退出（code=${exited.code}）`, {
        output: readNewLog(logStart),
        port,
      });
    }
  }
  throw new LaunchFailure(`30s 内没起来（端口 ${port} 被占用 / 数据目录无权限？）`, {
    output: readNewLog(logStart),
    port,
  });
}
