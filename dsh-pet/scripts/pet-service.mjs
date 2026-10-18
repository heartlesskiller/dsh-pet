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
import { appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
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

/**
 * 确保独立服务在跑。
 * @param port 端口（默认 3080，可用 DSH_PET_PORT 覆盖）
 * @returns {{ alreadyRunning: boolean, entry: string }}
 */
export async function ensurePetService(port) {
  const entry = join(PKG, 'lib', 'standalone.js');
  if (!existsSync(entry)) {
    throw new Error(`找不到 ${entry}，先跑一次 pnpm bundle`);
  }
  if (await petHealth(port)) {
    return { alreadyRunning: true, entry };
  }

  log(`启动服务：${entry} --port ${port}`);
  const fd = openSync(petLogPath(), 'a');
  const child = spawn(process.execPath, [entry, '--port', String(port)], {
    cwd: PKG,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await petHealth(port)) {
      log(`服务就绪：${petBaseUrl(port)}（pid=${child.pid}）—— 桌宠窗口由服务自动拉起，稍等 1-3 秒出现`);
      return { alreadyRunning: false, entry };
    }
  }
  throw new Error(`30s 内没起来（端口 ${port} 被占用 / 数据目录无权限？），见 ${petLogPath()}`);
}
