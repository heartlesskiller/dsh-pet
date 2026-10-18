#!/usr/bin/env node
/**
 * launch-pet.mjs —— 一键启动桌面桌宠（桌面快捷方式指向这里）。
 *
 * 只做一件事：把独立服务拉起来（幂等）。
 *   - 服务本身会按配置（`display: both`）**自动拉起 Electron 桌宠窗口**，
 *     这里不再自己 spawn 一次 Electron —— 否则会出现两个桌宠窗口；
 *   - 服务用 detached 方式起，关掉这个脚本所在的窗口不影响它；
 *   - 已在运行（`GET /health` 自报 `dsh-pet-standalone`）就什么都不做，双击多次也只有一只桌宠。
 *
 * 日志：`<DSH_HOME>/dsh-pet/launcher.log`（DSH_HOME 缺省 %USERPROFILE%\.dsh）
 * 退出码：0 = 已启动/已在运行；非 0 = 失败（快捷方式侧据此提示）
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const DATA_DIR = join(HOME, 'dsh-pet');
const LOG = join(DATA_DIR, 'launcher.log');
const PORT = Number(process.env.DSH_PET_PORT || 3080);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG, line);
  } catch {
    // 日志写不进去不该阻断启动
  }
  process.stdout.write(line);
}

async function petHealth() {
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.name === 'dsh-pet-standalone' ? body : null;
  } catch {
    return null;
  }
}

async function main() {
  const entry = join(PKG, 'lib', 'standalone.js');
  if (!existsSync(entry)) {
    log(`失败：找不到 ${entry}，先跑一次 pnpm bundle`);
    process.exitCode = 1;
    return;
  }

  if (await petHealth()) {
    log(`已在运行：${BASE}（无需重复启动）`);
    return;
  }

  log(`启动服务：${entry} --port ${PORT}`);
  const fd = openSync(LOG, 'a');
  const child = spawn(process.execPath, [entry, '--port', String(PORT)], {
    cwd: PKG,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await petHealth()) {
      log(`服务就绪：${BASE}（pid=${child.pid}）—— 桌宠窗口由服务自动拉起，稍等 1-3 秒出现`);
      return;
    }
  }

  log(`失败：${READY_TIMEOUT_MS / 1000}s 内没起来（端口 ${PORT} 被占用 / 数据目录无权限？），见 ${LOG}`);
  process.exitCode = 1;
}

await main();
