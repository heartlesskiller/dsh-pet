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

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sprite = readSource('../../runtime/electron-helper/sprite.js');
const constants = readSource('../../runtime/electron-helper/constants.js');
const clientPet = readSource('../client/pet.ts');
const server = readSource('../standalone/server.ts');

/** 剥掉行/块注释：断言"代码里没有 X"时必须先剥注释，否则注释里的说明文字会误伤 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------- 桌面壳 ----------

test('桌面壳：两个菜单项都在，且各有分发分支（否则点了没反应）', () => {
  assert.ok(/label: '中转站管理…', action: 'open-admin'/.test(sprite), '桌面壳必须有「中转站管理…」菜单项');
  assert.ok(/label: '退出桌宠', action: 'quit-pet'/.test(sprite), '桌面壳必须有「退出桌宠」菜单项');
  assert.ok(/leaf\.action === 'open-admin'/.test(sprite), 'onMenuAction 必须有 open-admin 分支');
  assert.ok(/leaf\.action === 'quit-pet'/.test(sprite), 'onMenuAction 必须有 quit-pet 分支');
});

test('桌面壳：open-admin 走系统默认浏览器，URL 从 configUrl 推导', () => {
  assert.ok(/openDshSite\(ADMIN_URL\)/.test(sprite), 'open-admin 必须复用 openDshSite（系统默认浏览器）');
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
  assert.ok(/label: '退出桌宠', action: 'quit-pet'/.test(clientPet), '浏览器壳必须有「退出桌宠」菜单项');
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
