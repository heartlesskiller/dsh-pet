#!/usr/bin/env node
/**
 * launch-pet.mjs —— 一键启动桌面桌宠（桌面「桌宠」快捷方式经 launch-pet.cmd 指向这里）。
 *
 * 只做一件事：把独立服务拉起来（幂等）。
 *   - 服务本身会按配置（`display: both`）**自动拉起 Electron 桌宠窗口**，
 *     这里不再自己 spawn 一次 Electron —— 否则会出现两个桌宠窗口；
 *   - 服务用 detached 方式起，关掉这个脚本所在的窗口不影响它；
 *   - 已在运行（`GET /health` 自报 `dsh-pet-standalone`）就什么都不做，双击多次也只有一只桌宠。
 *
 * **失败时必须说清原因**（这是用户第一体验杀手：双击 → 什么都没发生 → 不会想到去看日志）。
 * 分类逻辑抽在 `./launch-hints.mjs`（纯函数、有单测），这里只负责打印 + 退出码；
 * 控制台窗口由 `launch-pet.cmd` 在失败时 `pause` 停住。
 *
 * 启动/探活的实现与 `open-admin.mjs` 共用 `./pet-service.mjs`（别在这里复制一份）。
 *
 * 日志：`<DSH_HOME>/dsh-pet/launcher.log`（DSH_HOME 缺省 %USERPROFILE%\.dsh）
 * 退出码：0 = 已启动/已在运行；1 = 失败；3 = 服务起来了但桌宠窗口没出来（同样是用户可见的故障）
 */
import { classifyLaunchFailure, formatLaunchFailure } from './launch-hints.mjs';
import { ensurePetService, LaunchFailure, log, petLogPath } from './pet-service.mjs';

const PORT = Number(process.env.DSH_PET_PORT || 3080);

try {
  const { alreadyRunning, output } = await ensurePetService(PORT);
  if (alreadyRunning) {
    log(`已在运行：http://127.0.0.1:${PORT}（无需重复启动）`);
  }
  // 服务起来了 ≠ 桌宠出来了：Electron 缺失时服务照跑、窗口在后台下载/永远不出现。
  // 这种"双击了但什么都没有"正是要消灭的体验，所以按失败处理（退出码 3）。
  const info = classifyLaunchFailure({ output, port: PORT });
  if (info.reason === 'electron-missing' || info.reason === 'electron-downloading') {
    log(formatLaunchFailure(info, petLogPath()));
    process.exitCode = 3;
  }
} catch (e) {
  // 分类要的是**原文**：LaunchFailure 带子进程输出；普通异常只能拿 message
  const output = (e instanceof LaunchFailure ? e.output : '') + '\n' + (e?.message ?? String(e));
  const info = classifyLaunchFailure({ output, port: PORT });
  log(formatLaunchFailure(info, petLogPath()));
  process.exitCode = 1;
}
