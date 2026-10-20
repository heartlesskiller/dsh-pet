/**
 * 托盘菜单模型（`runtime/electron-helper/tray-menu.js`，纯函数）的单元测试。
 *
 * 托盘是**渲染端崩了也还在**的兜底退出入口（2026-10 事故：右键菜单挂不出来 → 用户
 * 在图形界面上关不掉桌宠）。所以菜单结构与「要不要停服务」的判定必须钉死。
 *
 * 与 `src/shared/menu.ts` 的对应关系：`trayMenuModel` 的 quit 文案对齐 `quitPetLabel()`，
 * `shouldStopServiceOnQuit` 对齐 `shouldShutdownService()`。两处各一份（runtime/ 是纯 JS，
 * 拿不到 shared 的 ESM 导出），所以这里也把「语义要一致」钉一下。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { trayMenuModel, shouldStopServiceOnQuit, TRAY_TOOLTIP } = require('../../runtime/electron-helper/tray-menu.js');

test('standalone（独立模式）：四项 + 分隔线，quit 叫「退出桌宠」', () => {
  const model = trayMenuModel({ bridge: false, adminUrl: 'http://127.0.0.1:3080/admin' });
  assert.equal(model.length, 4);
  assert.deepEqual(
    model.map((i) => i.label ?? i.type),
    ['打开中转站管理…', '重载配置', 'separator', '退出桌宠'],
  );
  // 结构细节
  assert.equal(model[2].type, 'separator');
  assert.equal(model[0].enabled, true, 'adminUrl 有值时可点');
  assert.equal(model[1].enabled, true);
  assert.equal(model[3].enabled, true);
});

test('bridge（DSH）：quit 文案是「关闭桌宠窗口」，不能叫「退出桌宠」', () => {
  // DSH 下服务是用户的 DSH，说「退出桌宠」会让人以为能关掉整个东西（实际只关自己的窗口）
  const model = trayMenuModel({ bridge: true, adminUrl: 'http://127.0.0.1:9/admin' });
  assert.equal(model[3].label, '关闭桌宠窗口');
  assert.notEqual(model[3].label, '退出桌宠');
});

test('adminUrl 为空 → 「打开中转站管理…」置灰（不是消失，用户能看出有这项）', () => {
  const model = trayMenuModel({ bridge: false, adminUrl: '' });
  assert.equal(model[0].id, 'open-admin');
  assert.equal(model[0].enabled, false);
  // 其它项不受影响
  assert.equal(model[1].enabled, true);
  assert.equal(model[3].enabled, true);
});

test('入参缺失/形状异常不抛（托盘在启动早期就要建起来）', () => {
  for (const bad of [undefined, null, {}, { bridge: 'yes' }, { adminUrl: 42 }]) {
    const model = trayMenuModel(bad);
    assert.equal(model.length, 4);
    assert.equal(model[3].label, '退出桌宠', '非 true 的 bridge 一律按独立模式');
    assert.equal(model[0].enabled, false, '非字符串 adminUrl 一律当空');
  }
});

test('shouldStopServiceOnQuit：只有独立模式才停服务', () => {
  assert.equal(shouldStopServiceOnQuit({ bridge: false }), true);
  assert.equal(shouldStopServiceOnQuit({ bridge: true }), false, 'bridge 下服务是 DSH 的，绝不能停');
  // 防御：缺参/脏值按独立模式处理（宁可多停一次自己的服务，也不能留着服务把再启动卡死）
  assert.equal(shouldStopServiceOnQuit({}), true);
  assert.equal(shouldStopServiceOnQuit(undefined), true);
});

test('托盘工具提示固定（任务栏/托盘里能认出是同一只）', () => {
  assert.equal(TRAY_TOOLTIP, 'dsh-pet 桌宠');
});
