#!/usr/bin/env node
/**
 * stop-pet.mjs —— 关闭桌宠（桌面「关闭桌宠」快捷方式指向这里）。
 *
 * 走 `POST /shutdown`：服务收尾（先释放插件 effect，桌宠窗口随之自己退场），
 * 不做 `taskkill` —— 强杀会让 Electron 留下半透明残影，也可能误杀同名的别的进程。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const DATA_DIR = join(HOME, 'dsh-pet');
const LOG = join(DATA_DIR, 'launcher.log');
const PORT = Number(process.env.DSH_PET_PORT || 3080);
const BASE = `http://127.0.0.1:${PORT}`;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG, line);
  } catch {
    // ignore
  }
  process.stdout.write(line);
}

async function alive() {
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.name === 'dsh-pet-standalone' ? body : null;
  } catch {
    return null;
  }
}

if (!(await alive())) {
  log('没有在运行的桌宠（端口 ' + PORT + ' 上没有 dsh-pet 服务）。');
  process.exit(0);
}

try {
  await fetch(BASE + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(3000) });
} catch {
  // 服务先回话再收尾，连接被掐断也算成功
}

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  if (!(await alive())) {
    log('已关闭。');
    process.exit(0);
  }
}

log('服务 15s 内未退出，可能卡在收尾（桌面 Helper 正在退出）；可再点一次或手动结束 node 进程。');
process.exitCode = 1;
