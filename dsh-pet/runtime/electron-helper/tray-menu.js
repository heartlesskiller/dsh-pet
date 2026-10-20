/**
 * dsh-pet desktop helper —— 托盘菜单模型（纯判定部分）。
 *
 * 【为什么需要托盘】2026-10 的真实事故：右键菜单因渲染端异常挂不出来，而**退出入口只有右键菜单**
 * → 用户在图形界面上彻底关不掉桌宠，只能靠 `curl POST /shutdown` 救。
 * 托盘是主进程对象，**不依赖渲染端**，渲染崩了它还在 —— 这才是真正的兜底图形出口。
 *
 * 【为什么单独一个文件】与 `topmost-watchdog.js` 同一套做法：CommonJS、纯函数、
 * **不 require('electron')**。这样菜单结构能在 node:test 里直接单测，不需要起 Electron。
 *
 * 【与 src/shared/menu.ts 的关系】两处都有「退出」文案与「要不要停服务」的判定：
 *   - 文案对齐 `quitPetLabel()`：bridge 下服务不属于我们，不能叫「退出桌宠」
 *   - 判定对齐 `shouldShutdownService()`：只有独立模式才去停服务
 * 那套是给渲染端右键菜单用的（经 shared-core 打进浏览器壳），这套是给主进程托盘用的
 * （runtime/ 是不经 TS 构建的纯 JS，拿不到 shared 的 ESM 导出），所以只能各写一份。
 * **改任意一处请同步另一处**；也正因为有漂移风险，两个文件的注释互相指向。
 */

'use strict';

/** 托盘工具提示（与窗口标题同一套叫法，便于用户在任务栏/托盘里认出是同一只） */
const TRAY_TOOLTIP = 'dsh-pet 桌宠';

/**
 * 构造托盘菜单模型（Electron 无关的普通对象数组）。
 *
 * @param {{bridge?: boolean, adminUrl?: string}} input
 *   - `bridge`：跑在 DSH 里为 true（服务不属于我们，退出只关窗）
 *   - `adminUrl`：中转站管理页地址；为空则该项置灰（独立模式才有 /admin）
 * @returns {Array<{id?:string, label?:string, type?:string, enabled?:boolean}>}
 */
function trayMenuModel(input) {
  const bridge = input && input.bridge === true;
  const adminUrl = input && typeof input.adminUrl === 'string' ? input.adminUrl : '';
  return [
    { id: 'open-admin', label: '打开中转站管理…', enabled: Boolean(adminUrl) },
    { id: 'reload', label: '重载配置', enabled: true },
    { type: 'separator' },
    // 文案与 quitPetLabel() 对齐：bridge 下服务是 DSH 的，说「退出桌宠」会误导
    { id: 'quit', label: bridge ? '关闭桌宠窗口' : '退出桌宠', enabled: true },
  ];
}

/**
 * 退出时要不要顺手停服务。
 *
 * 语义等同 `src/shared/menu.ts::shouldShutdownService`：**只有独立模式**才停。
 * bridge（DSH）下服务是用户的 DSH，我们无权也不该去停它。
 *
 * @param {{bridge?: boolean}} input
 * @returns {boolean}
 */
function shouldStopServiceOnQuit(input) {
  return !(input && input.bridge === true);
}

module.exports = { trayMenuModel, shouldStopServiceOnQuit, TRAY_TOOLTIP };
