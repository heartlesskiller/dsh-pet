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
 * 启动/探活的实现与 `open-admin.mjs` 共用 `./pet-service.mjs`（别在这里复制一份）。
 *
 * 日志：`<DSH_HOME>/dsh-pet/launcher.log`（DSH_HOME 缺省 %USERPROFILE%\.dsh）
 * 退出码：0 = 已启动/已在运行；非 0 = 失败（快捷方式侧据此提示）
 */
import { ensurePetService, log } from './pet-service.mjs';

const PORT = Number(process.env.DSH_PET_PORT || 3080);

try {
  const { alreadyRunning } = await ensurePetService(PORT);
  if (alreadyRunning) log(`已在运行：http://127.0.0.1:${PORT}（无需重复启动）`);
} catch (e) {
  log(`失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
