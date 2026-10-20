/**
 * 静态守卫：任务栏条目 + 托盘兜底退出 + 「窗口全关必须连服务一起停」。
 *
 * 钉的都是**会在用户侧静默失效**的接线（runtime/ 是不经 TS 构建的纯 JS，没有类型检查兜底）：
 *   1. `skipTaskbar: false` —— 用户要求「桌宠启动时任务栏应该有一个进程」
 *   2. `window-all-closed` 走 `quitPetGracefully()` 而**不是**裸 `app.quit()`
 *      （裸 quit 会留下活着的服务 → 再双击走 alreadyRunning 早退 → 宠物彻底消失且无法恢复）
 *   3. `createTray()` 存在，且定义体里有 `DPI_PROBE` 早退（探测子进程不能建托盘）
 *   4. `quitPetGracefully` 里 `POST /shutdown` 带超时（不然停服务失败会把用户困住）
 *   5. 任务栏标题与 pet.id 相关（不能是一个空白的 Electron 窗口）
 *
 * ⚠️ 所有断言**先剥注释**：本文件与 main.js 的注释里大量提到 `app.quit()`、`/shutdown`
 * 这些词作为反例，不剥注释会假通过（这条教训来自 sprite-bare-calls 那轮）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', '..', 'runtime', 'electron-helper', 'main.js');
const source = readFileSync(MAIN, 'utf8');

/** 剥掉行注释与块注释（断言"代码里没有 X"之前必须做，否则注释里的反例会假红/假绿） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const code = stripComments(source);

/** 抽取一个顶层函数体（`function name() {` 到列 0 的 `}`） */
function fnBody(name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(code);
  return m ? m[1] : '';
}

test('任务栏条目必须在：skipTaskbar 为 false', () => {
  assert.ok(/skipTaskbar:\s*false/.test(code), '窗口必须出现在任务栏（skipTaskbar: false）');
  assert.equal(/skipTaskbar:\s*true/.test(code), false, '不许残留 skipTaskbar: true');
  // 透明置顶窗被最小化/最大化会诡异地消失或铺满屏，必须一并禁掉
  for (const opt of ['minimizable', 'maximizable', 'fullscreenable']) {
    assert.ok(new RegExp(`${opt}:\\s*false`).test(code), `${opt} 必须为 false`);
  }
});

test('🔴 window-all-closed 必须走 quitPetGracefully，不许裸 app.quit()', () => {
  const m = /app\.on\('window-all-closed',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(code);
  assert.ok(m, '找不到 window-all-closed 处理器');
  const body = m[1];
  assert.ok(/quitPetGracefully\(/.test(body), '必须调用 quitPetGracefully()');
  assert.equal(/app\.quit\(/.test(body), false, '不许在 window-all-closed 里裸调 app.quit()（会留下活着的服务）');
});

test('🔴 quitPetGracefully 必须 POST /shutdown 且带超时，且 bridge 下不停服务', () => {
  const body = fnBody('quitPetGracefully');
  assert.ok(body.length > 200, '找不到 quitPetGracefully 函数体');
  assert.ok(/\/shutdown/.test(body), '必须 POST /shutdown 把服务一起停掉');
  assert.ok(/method:\s*'POST'/.test(body), '必须是 POST');
  assert.ok(/AbortSignal\.timeout\(/.test(body), '必须有超时（停服务失败不能把用户困住）');
  assert.ok(/shouldStopServiceOnQuit\(/.test(body), '必须按运行形态决定停不停服务');
  // 无论成败都要退出：finally 里必须收尾
  assert.ok(/\.finally\(/.test(body), '停服务无论成败都必须继续退出（.finally）');
  assert.ok(/app\.quit\(\)/.test(body), '这个函数里必须真的退出（这里允许 app.quit）');
});

test('🔴 createTray 存在，且 DPI 探测进程不建托盘', () => {
  assert.ok(/createTray\(\);/.test(code), '装配段必须调用 createTray()');
  const body = fnBody('createTray');
  assert.ok(body.length > 100, '找不到 createTray 函数体');
  assert.ok(/DPI_PROBE/.test(body), 'createTray 必须对 DPI 探测进程早退（否则多一个托盘图标）');
  assert.ok(/new Tray\(/.test(body), '必须真的建 Tray');
  assert.ok(/setToolTip\(/.test(body), '必须设 tooltip');
  assert.ok(/Menu\.buildFromTemplate\(/.test(body), '必须挂右键菜单');
});

test('托盘菜单来自纯模块（不在 main.js 里内联一份）', () => {
  assert.ok(/require\('\.\/tray-menu'\)/.test(code), 'main.js 必须 require ./tray-menu');
  assert.ok(/trayMenuModel\(/.test(code), '菜单项必须来自 trayMenuModel()');
  assert.ok(/shouldStopServiceOnQuit\(/.test(code), '停服务判定必须来自 shouldStopServiceOnQuit()');
});

test('任务栏标题与 pet.id 相关（不是一个空白的 Electron 窗口）', () => {
  const body = fnBody('petWindowTitle');
  assert.ok(body.length > 0, '必须有 petWindowTitle()');
  assert.ok(/pet\.id/.test(body), '标题必须含 pet.id');
  assert.ok(/dsh-pet 桌宠/.test(body), '标题必须含可辨识的名字');
  // 建窗时设一次 + did-finish-load 里再设一次（index.html 的 <title> 会覆盖前者）
  assert.ok(/title:\s*petWindowTitle\(pet\)/.test(code), '建窗时要用 petWindowTitle(pet)');
  assert.ok(/win\.setTitle\(petWindowTitle\(pet\)\)/.test(code), 'did-finish-load 里必须重设标题');
});

test('AppUserModelID 已设（任务栏归组与图标身份）', () => {
  assert.ok(/setAppUserModelId\(/.test(code), '必须 app.setAppUserModelId(...)，否则任务栏显示成 "Electron"');
});
