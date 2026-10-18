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
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 失败时最多回读多少字节日志（错误总在末尾，不必整份读） */
const OUTPUT_CAP = 16 * 1024;

/**
 * 启动失败（带子进程输出原文，供 launch-hints.mjs 分类）。
 * 用独立类而不是 Error + message：分类要的是**原文**，不是我们拼的一句话。
 */
export class LaunchFailure extends Error {
  constructor(message, { output = '', port } = {}) {
    super(message);
    this.name = 'LaunchFailure';
    this.output = output;
    this.port = port;
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
 * @returns {{ alreadyRunning: boolean, entry: string, output: string }}
 */
export async function ensurePetService(port) {
  const entry = join(PKG, 'lib', 'standalone.js');
  if (!existsSync(entry)) {
    throw new LaunchFailure(`找不到 ${entry}，先跑一次 pnpm bundle`, { port });
  }
  if (await petHealth(port)) {
    return { alreadyRunning: true, entry, output: '' };
  }

  log(`启动服务：${entry} --port ${port}`);
  const logStart = (() => {
    try {
      return statSync(petLogPath()).size;
    } catch {
      return 0;
    }
  })();
  const fd = openSync(petLogPath(), 'a');
  const child = spawn(process.execPath, [entry, '--port', String(port)], {
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
