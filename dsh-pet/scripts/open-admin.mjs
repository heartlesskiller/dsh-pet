#!/usr/bin/env node
/**
 * open-admin.mjs —— 打开「中转站管理」页（桌面「中转站管理」快捷方式指向这里）。
 *
 * 做两件事：
 *   1. 确保独立服务在跑（复用 ./pet-service，**不自己 spawn Electron** ——
 *      服务会按 display 配置自己拉桌宠，重复 spawn 会出两只）；
 *   2. 用系统默认浏览器打开 `http://127.0.0.1:<port>/admin`。
 *
 * 管理页是独立模式唯一的站点管理入口（T06 在 DSH 里是设置页 slot，独立模式没有
 * slot 生命周期，见 src/standalone/admin-page.ts）。页面零数据嵌入，凭证一律脱敏。
 */
import { spawn } from 'node:child_process';

import { ensurePetService, log, petBaseUrl } from './pet-service.mjs';

const PORT = Number(process.env.DSH_PET_PORT || 3080);
const URL_TO_OPEN = petBaseUrl(PORT) + '/admin';

async function openBrowser(url) {
  // Windows：`start` 需要空标题位，否则带引号的 URL 会被当成标题。
  // rundll32 方案对含 & 的 URL 不稳定，这里用 cmd /c start。
  const child = spawn('cmd', ['/c', 'start', '', url], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

try {
  const { alreadyRunning } = await ensurePetService(PORT);
  log(`${alreadyRunning ? '服务已在运行' : '服务已启动'}，打开管理页：${URL_TO_OPEN}`);
  await openBrowser(URL_TO_OPEN);
} catch (e) {
  log(`失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
