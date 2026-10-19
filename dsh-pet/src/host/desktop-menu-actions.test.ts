/**
 * 桌宠右键菜单「中转站管理 / 退出桌宠」契约测试。
 *
 * 背景：用户要求「退出和管理都通过点击桌宠的菜单来实现」。这两个动作此前只能靠桌面上的
 * 另外两个快捷方式（已删），现在搬进右键菜单 —— 两个壳都要有，且**都要有分发分支**，
 * 否则就是"菜单里有、点了没反应"的静默失败。
 *
 * 本文件钉住跨半侧契约（两半各自构建、无法互相 import，只能读源码断言）：
 *   ① 桌面壳（runtime/electron-helper/sprite.js）与浏览器壳（src/client/pet.ts）
 *      **都有**这两个菜单项，且**都有**对应 action 分支；
 *   ② URL 从 configUrl / location.origin 推导，**绝不写死 3080**（DSH 的端口不固定）；
 *   ③ 停机走**根路径** `/shutdown`（注册在 src/standalone/server.ts，不在 /dsh-pet-7340/ 下），
 *      且失败必须被容忍（DSH 模式下这个路由不存在，绝不能把用户的 DSH 一起退掉）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { quitPetLabel, shouldShutdownService } from '../shared/menu';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sprite = readSource('../../runtime/electron-helper/sprite.js');
const constants = readSource('../../runtime/electron-helper/constants.js');
const clientPet = readSource('../client/pet.ts');
const server = readSource('../standalone/server.ts');
const mainJs = readSource('../../runtime/electron-helper/main.js');
const preload = readSource('../../runtime/electron-helper/preload.js');

/** 剥掉行/块注释：断言"代码里没有 X"时必须先剥注释，否则注释里的说明文字会误伤 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------- 桌面壳 ----------

test('桌面壳：两个菜单项都在，且各有分发分支（否则点了没反应）', () => {
  assert.ok(/label: '中转站管理…', action: 'open-admin'/.test(sprite), '桌面壳必须有「中转站管理…」菜单项');
  assert.ok(/label: S\.quitPetLabel\(RUN_MODE\), action: 'quit-pet'/.test(sprite), '桌面壳必须有 quit-pet 菜单项（label 按形态变）');
  assert.ok(/leaf\.action === 'open-admin'/.test(sprite), 'onMenuAction 必须有 open-admin 分支');
  assert.ok(/leaf\.action === 'quit-pet'/.test(sprite), 'onMenuAction 必须有 quit-pet 分支');
});

test('桌面壳：open-admin 走系统默认浏览器，URL 从 configUrl 推导', () => {
  assert.ok(/openAdminPage\(ADMIN_URL\)/.test(sprite), 'open-admin 必须走 openAdminPage（独立通道）');
  assert.ok(/const ADMIN_URL = ORIGIN \+ '\/admin';/.test(constants), 'ADMIN_URL 必须由 ORIGIN 推导');
  // ORIGIN 来自 configUrl，端口随之变化 —— 绝不能写死
  assert.ok(/const ORIGIN = new URL\(CONFIG\.configUrl\)\.origin;/.test(constants));
});

test('桌面壳：quit-pet 先 POST /shutdown，失败容忍，且不 taskkill', () => {
  assert.ok(/S\.postAction\(SHUTDOWN_URL\)/.test(sprite), 'quit-pet 必须先请服务停机');
  assert.ok(/const SHUTDOWN_URL = ORIGIN \+ '\/shutdown';/.test(constants));
  // 失败必须被 catch 掉（DSH 模式下这个路由不存在）
  assert.ok(/\.catch\(\(\) => \{[\s\S]{0,200}DSH 模式下静默降级/.test(sprite), 'shutdown 失败必须静默降级');
  assert.equal(/taskkill|process\.kill/.test(stripComments(sprite)), false, '绝不许 taskkill（会留残影、可能误杀）');
});

// ---------- 浏览器壳 ----------

test('浏览器壳：两个菜单项都在，且各有分发分支', () => {
  assert.ok(/label: '中转站管理…', action: 'open-admin'/.test(clientPet), '浏览器壳必须有「中转站管理…」菜单项');
  assert.ok(/label: quitPetLabel\('bridge'\), action: 'quit-pet'/.test(clientPet), '浏览器壳必须有 quit-pet 菜单项（label 按形态变）');
  assert.ok(/leaf\.action === 'open-admin'/.test(clientPet), 'handleMenuAction 必须有 open-admin 分支');
  assert.ok(/leaf\.action === 'quit-pet'/.test(clientPet), 'handleMenuAction 必须有 quit-pet 分支');
});

test('浏览器壳：URL 用当前页面 origin 推导，不写死 3080', () => {
  assert.ok(/new URL\('\/admin', window\.location\.origin\)/.test(clientPet), '必须用 location.origin 推导');
  // 两个壳都不许出现写死的端口
  for (const [name, src] of [
    ['sprite.js', sprite],
    ['client/pet.ts', clientPet],
  ] as Array<[string, string]>) {
    assert.equal(/127\.0\.0\.1:\d+|localhost:\d+|:3080/.test(stripComments(src)), false, `${name} 里出现了写死的端口`);
  }
});

// ---------- 与宿主的契约 ----------

test('/shutdown 注册在根路径，且两个壳请求的正是这个路径', () => {
  assert.ok(/pathname === '\/shutdown'/.test(server), '宿主必须在根路径注册 /shutdown');
  assert.ok(/fetch\('\/shutdown'/.test(clientPet), '浏览器壳必须请求根路径 /shutdown');
  assert.ok(/ORIGIN \+ '\/shutdown'/.test(constants), '桌面壳必须请求根路径 /shutdown');
  // 不许走 /dsh-pet-7340/ 前缀（那条路上没有这个路由）
  assert.equal(/dsh-pet-7340\/shutdown/.test(clientPet), false, 'shutdown 不在插件前缀下');
  assert.equal(/BASE \+ '\/shutdown'/.test(constants), false, 'shutdown 不在 BASE（插件前缀）下');
});

test('shared/menu.ts 的 action 联合类型包含两个新动作', () => {
  const menu = readSource('../shared/menu.ts');
  assert.ok(/'open-admin'/.test(menu), 'MenuLeaf.action 必须含 open-admin');
  assert.ok(/'quit-pet'/.test(menu), 'MenuLeaf.action 必须含 quit-pet');
});

// ---------- 「退出桌宠」的安全判据（纯函数） ----------

test('shouldShutdownService：只有独立形态才去停服务', () => {
  assert.equal(shouldShutdownService('standalone'), true);
  // 🔴 bridge 必须 false：DSH 是用户的工作环境，万一它也有同名 /shutdown 路由，
  // 发这一下会把用户的 DSH 整个关掉 —— 后果不可接受，收益近乎零。
  assert.equal(shouldShutdownService('bridge'), false);
});

test('quitPetLabel：同一个 action，文案按形态变（不加第二套菜单）', () => {
  assert.equal(quitPetLabel('standalone'), '退出桌宠');
  assert.equal(quitPetLabel('bridge'), '桌面桌宠退走');
  assert.notEqual(quitPetLabel('bridge'), quitPetLabel('standalone'), '两种形态文案必须不同');
});

// ---------- 两个壳都按这个判据走 ----------

test('桌面壳：bridge 形态下 quit-pet 一个请求都不发', () => {
  // 判据来自 helper 收到的 config（bridge=1），不猜
  assert.ok(/const RUN_MODE = BRIDGE \? 'bridge' : 'standalone';/.test(constants), '必须由 BRIDGE 推导 RUN_MODE');
  assert.ok(/const BRIDGE = params\.get\('bridge'\) === '1';/.test(constants), 'BRIDGE 来自 config 参数');
  // quitPet 必须先过 shouldShutdownService 才可能碰网络
  assert.ok(/if \(!S\.shouldShutdownService\(RUN_MODE\)\) \{[\s\S]{0,200}window\.close\(\)/.test(sprite),
    'bridge 形态必须先关窗再 return，绝不能往下走到 postAction');
  // label 按形态变
  assert.ok(/label: S\.quitPetLabel\(RUN_MODE\), action: 'quit-pet'/.test(sprite), '菜单 label 必须按形态变');
});

test('浏览器壳：恒为 bridge 形态，quit-pet 不发任何请求', () => {
  assert.ok(/shouldShutdownService\('bridge'\)/.test(clientPet), '浏览器壳必须走同一个判据');
  assert.ok(/label: quitPetLabel\('bridge'\)/.test(clientPet), '浏览器壳 label 也用共享函数');
  // 浏览器壳里不得出现无条件发出的 /shutdown
  const stripped = stripComments(clientPet);
  assert.equal(/fetch\('\/shutdown'/.test(stripped) && !/shouldShutdownService/.test(stripped), false,
    '不得绕过判据直接 fetch /shutdown');
});

// ---------- 「显示位置 → 都不」是单向门，桌面壳必须拦一道 ----------

test('桌面壳：独立模式下「都不」有二次确认，且确认里说清了恢复办法', () => {
  assert.ok(/confirmNoneLeaf\(\)/.test(sprite), '桌面壳必须注入带确认的「都不」叶子');
  assert.ok(/RUN_MODE === 'standalone' \? \[confirmNoneLeaf\(\)\] : \[\]/.test(sprite),
    '确认只在独立模式加（浏览器壳跑在 DSH 里，有设置页，不加）');
  assert.ok(/leaf\.confirmText && !window\.confirm\(leaf\.confirmText\)/.test(sprite),
    'set-display 分支必须先过 confirmText 才执行');
  // 文案必须说清"去哪恢复"——否则用户确认了还是回不来
  assert.ok(/独立模式没有设置页/.test(sprite), '确认文案必须点明独立模式没有设置页');
  assert.ok(/启动器会自动改回桌面显示/.test(sprite), '确认文案必须告诉用户启动器会自愈');
});

test('GPU：win32 上既要 disableHardwareAcceleration 也要 Chromium 级 disable-gpu', () => {
  // 只调 disableHardwareAcceleration 不够：Chromium 仍会拉起 GPU 子进程，
  // 在 GPU 不可用的环境那个子进程 FATAL，整个 helper 退出 → 重启 → 再崩（最多 12 次）。
  assert.ok(/app\.disableHardwareAcceleration\(\)/.test(mainJs), '必须保留 disableHardwareAcceleration（#37 透明窗）');
  assert.ok(/appendSwitch\('disable-gpu'\)/.test(mainJs), '必须加 Chromium 级 disable-gpu');
  assert.ok(/appendSwitch\('disable-gpu-compositing'\)/.test(mainJs), '必须加 disable-gpu-compositing');
  // 两个开关都要在 win32 分支里（macOS/Linux 合成路径不同，别一刀切）
  const win32 = /if \(process\.platform === 'win32'\) \{([\s\S]*?)\n\}/.exec(mainJs);
  assert.ok(win32, '找不到 win32 分支');
  assert.ok(/disable-gpu/.test(win32[1]), 'disable-gpu 必须在 win32 分支内');
});

// ---------- open-admin 必须走独立通道（本 bug：复用 open-site 会被同源替换吃掉路径） ----------

test('🔴 open-admin 调 openAdminPage，绝不调 openDshSite', () => {
  // 根因：openDshSite → pet:open-site → 主进程 openSite() 发现与 DSH_PET_SITE_URL 同源时
  // 会把**整个 URL** 换成带令牌的站点根地址，/admin 的路径一起丢 → 用户只看到健康 JSON。
  const branch = /if \(leaf\.action === 'open-admin'\) \{([\s\S]*?)\n {4}\}/.exec(sprite);
  assert.ok(branch, '找不到 open-admin 分支');
  // 剥注释：注释里会提到 openDshSite 作为"不要这样做"的反例
  const body = stripComments(branch[1]);
  assert.ok(/openAdminPage\(ADMIN_URL\)/.test(body), 'open-admin 必须调 openAdminPage(ADMIN_URL)');
  assert.equal(/openDshSite/.test(body), false, 'open-admin 绝不许再走 openDshSite（会被同源替换吃路径）');
  // 方法缺失时要留声，不能静默
  assert.ok(/console\.error/.test(branch[1]), '桥方法不存在时必须 console.error，别静默失败');
});

test('🔴 pet:open-admin 处理器里不出现 DSH_PET_SITE_URL（不做同源替换）', () => {
  const handler = /ipcMain\.on\('pet:open-admin'[\s\S]*?\n {2}\}\);/.exec(mainJs);
  assert.ok(handler, 'main.js 必须注册 pet:open-admin');
  assert.equal(/DSH_PET_SITE_URL/.test(handler[0]), false, '新通道绝不读 DSH_PET_SITE_URL（那是 #87 的令牌替换，会吃路径）');
  assert.equal(/OPEN_TARGET/.test(handler[0]), false, '新通道不该判宿主形态');
  assert.ok(/shell\.openExternal\(url\)/.test(handler[0]), '必须直接 openExternal 收到的 url');
  // 只放行 http(s)
  assert.ok(/\^https\?:\[\/\]\[\/\]/.test(handler[0]), '必须校验 url 形状，别的直接忽略');
});

test('preload 暴露 openAdminPage，且发的是 pet:open-admin 通道', () => {
  assert.ok(/openAdminPage\(url\) \{\s*ipcRenderer\.send\('pet:open-admin'/.test(preload), 'preload 必须暴露 openAdminPage → pet:open-admin');
});

test('openSite / pet:open-site 的行为没被改动（#87 的令牌替换必须原样保留）', () => {
  // 这条是防回归：修 open-admin 时不许顺手改掉「打开网站」的令牌逻辑，否则 DSH 会 401
  assert.ok(/DSH_PET_SITE_URL/.test(mainJs), 'openSite 的令牌替换必须还在（#87）');
  assert.ok(/new URL\(authed\)\.origin === new URL\(url\)\.origin/.test(mainJs), '同源替换逻辑必须原样');
  assert.ok(/ipcMain\.on\('pet:open-site'/.test(mainJs), 'pet:open-site 通道必须还在');
  assert.ok(/openDshSite\(url\) \{\s*ipcRenderer\.send\('pet:open-site'/.test(preload), 'openDshSite 必须还在（「打开网站」用）');
});
