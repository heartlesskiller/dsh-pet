/**
 * 启动失败分类（`scripts/launch-hints.mjs`）的契约测试。
 *
 * 这一层钉的是**用户看到的那句话**。失败路径平时没人走，等用户报"双击没反应"时
 * 才发现文案对不上就晚了 —— 所以：
 *   1. 每种失败用**真机文案**做 fixture（不是编的字符串）；
 *   2. 再读一遍源码，断言这些标记串**仍然存在**——上游改了消息这里立刻红，
 *      而不是等分类悄悄退化成 unknown。
 *
 * 全部无 GUI、无网络、无子进程。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  classifyLaunchFailure,
  firstErrorLine,
  foreignOccupantHint,
  formatLaunchFailure,
} from '../../scripts/launch-hints.mjs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ---------- 真机文案 fixture ----------

/** 单实例锁拒绝（src/standalone/instance-lock.ts 的原文） */
const OUT_LOCK =
  'dsh-pet-standalone: 已有实例在运行（PID=1234，端口=3080，启动于 2026-10-18T00:00:00.000Z）。锁文件：C:/x/standalone.lock。';
/** 端口被占（src/standalone/server.ts 的原文） */
const OUT_PORT =
  'dsh-pet-standalone: Error: 端口 3080 已被占用。独立模式只跑一个实例（第二个实例会起出两只桌宠、双倍轮询中转站）；若这是第二次启动，请先结束已有实例；确需换端口请显式传 --port。';
/** Electron 下载失败（src/host/index.ts 的原文） */
const OUT_ELECTRON_DL =
  '[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.';
/** Electron 解析失败（src/host/helper-process.ts 的原文） */
const OUT_ELECTRON_RESOLVE =
  'dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.';
/** 缺构建产物（launch-pet 自己的文案） */
const OUT_NOT_BUILT = '找不到 D:\\dev\\dsh-pet-agent\\dsh-pet\\lib\\standalone.js，先跑一次 pnpm bundle';

test('单实例锁拒绝 → already-running（提示去开管理页/先关旧的）', () => {
  const info = classifyLaunchFailure({ output: OUT_LOCK, port: 3080 });
  assert.equal(info.reason, 'already-running');
  assert.ok(info.title.includes('已经在运行'), info.title);
  assert.ok(info.hint.includes('中转站管理'), '要告诉用户去哪儿，而不是只报错');
  assert.ok(info.hint.includes('关闭桌宠'));
});

test('端口被占 → port-busy，标题带上具体端口', () => {
  const info = classifyLaunchFailure({ output: OUT_PORT, port: 3091 });
  assert.equal(info.reason, 'port-busy');
  assert.ok(info.title.includes('3091'), '端口号要出现，用户才知道该关谁：' + info.title);
  assert.ok(info.hint.includes('DSH_PET_PORT'), '要给出可执行的替代方案');
});

test('EADDRINUSE 英文形态同样归 port-busy（不靠中文匹配）', () => {
  const info = classifyLaunchFailure({ output: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080', port: 3080 });
  assert.equal(info.reason, 'port-busy');
});

test('Electron 两种失败形态 → electron-missing（都给出 DSH_PET_ELECTRON_PATH）', () => {
  for (const output of [OUT_ELECTRON_DL, OUT_ELECTRON_RESOLVE]) {
    const info = classifyLaunchFailure({ output, port: 3080 });
    assert.equal(info.reason, 'electron-missing', output);
    assert.ok(info.title.includes('桌宠窗口没能创建'), info.title);
    assert.ok(info.hint.includes('DSH_PET_ELECTRON_PATH'));
  }
});

test('Electron 正在后台下载 → electron-downloading（服务活着但窗口还没出来）', () => {
  const info = classifyLaunchFailure({
    output: '[dsh-pet] Electron not found, downloading to D:////x////electron////electron.exe ...',
    port: 3080,
  });
  assert.equal(info.reason, 'electron-downloading');
  assert.ok(info.title.includes('后台下载'), info.title);
  assert.ok(info.hint.includes('DSH_PET_ELECTRON_PATH'));
});

test('下载失败的日志里同时含"下载中"标记 → 必须判失败而不是"下载中"（顺序不能反）', () => {
  const both = OUT_ELECTRON_DL + '\n[dsh-pet] Electron not found, downloading to D:////x////electron////electron.exe ...';
  assert.equal(classifyLaunchFailure({ output: both, port: 3080 }).reason, 'electron-missing');
});

test('缺构建产物 → not-built（提示先 bundle）', () => {
  const info = classifyLaunchFailure({ output: OUT_NOT_BUILT, port: 3080 });
  assert.equal(info.reason, 'not-built');
  assert.ok(info.hint.includes('pnpm bundle'));
});

test('认不出来 → unknown，并附上输出里最像错误的那一行（绝不编原因）', () => {
  const info = classifyLaunchFailure({ output: 'foo\nbar\nTypeError: x is not a function\nbaz', port: 3080 });
  assert.equal(info.reason, 'unknown');
  assert.equal(info.detail, 'TypeError: x is not a function');
  assert.equal(info.title, '启动失败');
  assert.ok(info.hint.includes('日志'));
});

test('空输出 → unknown（不抛错、不崩）', () => {
  const info = classifyLaunchFailure({});
  assert.equal(info.reason, 'unknown');
  assert.equal(info.detail, '');
});

test('优先级固定：锁 > 端口 > Electron（同时命中时不许乱序）', () => {
  const all = OUT_LOCK + '\n' + OUT_PORT + '\n' + OUT_ELECTRON_DL;
  assert.equal(classifyLaunchFailure({ output: all }).reason, 'already-running');
  assert.equal(classifyLaunchFailure({ output: OUT_PORT + '\n' + OUT_ELECTRON_DL }).reason, 'port-busy');
});

test('firstErrorLine：倒着找带 error 的行；都没有就取最后一个非空行', () => {
  assert.equal(firstErrorLine('a\nError: boom\nb'), 'Error: boom');
  assert.equal(firstErrorLine('a\nb\n'), 'b');
  assert.equal(firstErrorLine(''), '');
});

test('formatLaunchFailure：含标题/建议/日志路径，且是可直接 print 的块', () => {
  const text = formatLaunchFailure(classifyLaunchFailure({ output: OUT_PORT, port: 3080 }), 'C:/x/launcher.log');
  assert.ok(text.includes('✗'));
  assert.ok(text.includes('端口'));
  assert.ok(text.includes('→'));
  assert.ok(text.includes('C:/x/launcher.log'));
  // 首尾换行：贴在别的输出后面不会挤成一行
  assert.ok(text.startsWith('\n'));
  assert.ok(text.endsWith('\n'));
});

// ---------- 与上游文案的耦合（改了消息这里就红） ----------

test('分类用的标记串在上游源码里仍然存在（防止改文案后分类悄悄退化）', () => {
  const lockSrc = read('../standalone/instance-lock.ts');
  assert.ok(lockSrc.includes('已有实例在运行'), 'instance-lock 的锁冲突文案变了 → 请同步 launch-hints');

  const serverSrc = read('../standalone/server.ts');
  assert.ok(serverSrc.includes('已被占用'), 'server.ts 的端口占用文案变了 → 请同步 launch-hints');

  const helperSrc = read('../host/helper-process.ts');
  assert.ok(helperSrc.includes('desktop pet unavailable'), 'helper-process 的 Electron 告警变了 → 请同步 launch-hints');
  assert.ok(
    helperSrc.includes('cannot resolve Electron executable'),
    'helper-process 的 Electron 解析失败文案变了 → 请同步 launch-hints',
  );
});

// ---------- 端口被"别人"占：DSH 用户的主路径 ----------

test('显式 reason=foreign-occupant（无子进程输出）也能正确分类', () => {
  const info = classifyLaunchFailure({ reason: 'foreign-occupant', port: 3080 });
  assert.equal(info.reason, 'foreign-occupant');
  assert.ok(info.title.includes('不是独立模式桌宠'), info.title);
  assert.equal(info.detail, '');
});

test('port-busy 文案不再给 DSH 用户错误建议（不许只说"关掉它/换端口"）', () => {
  const info = classifyLaunchFailure({ output: OUT_PORT, port: 3080 });
  // 必须同时说清两种情况：DSH 在跑（别关、别换端口）vs 其它程序（可以关/换）
  assert.ok(info.hint.includes('DSH'), '必须提到 DSH 这种情况');
  assert.ok(info.hint.includes('设置页'), 'DSH 用户要被告知去哪儿');
  assert.ok(info.hint.includes('DSH_PET_PORT'), '其它程序的情况仍要给换端口的办法');
  assert.ok(
    info.hint.includes('互相覆盖'),
    '换端口的副作用（并行实例互相覆盖站点配置）必须写明 —— 否则用户照做会丢站点',
  );
});

test('foreignOccupantHint：launcher 与 admin 两处文案不同，各自指向正确', () => {
  const launcher = foreignOccupantHint('launcher', 3080);
  assert.ok(launcher.includes('DSH'));
  assert.ok(launcher.includes('不需要双击这个快捷方式'));
  // 两处文案**有意不同**：launcher 这条不该把用户往设置页引（他点的是「桌宠」）
  assert.equal(launcher.includes('设置页'), false, 'launcher 文案不该指向设置页');

  const admin = foreignOccupantHint('admin', 3080);
  assert.ok(admin.includes('3080'));
  assert.ok(admin.includes('DSH 设置页'));
  assert.ok(admin.includes('中转站管理'));
  assert.ok(admin.includes('桌宠配置'), '要指明设置页里的位置');
});

test('🔴 admin 提示必须**三行完整**，且第二行（落点）带「DSH 设置页 + 中转站管理」', () => {
  // 只显示第一行 = 用户知道"有问题"但不知道"去哪"，等于没修好。
  // 这条钉的是内容完整性：三行都在，落点那行两个关键名词都在。
  const lines = foreignOccupantHint('admin', 3080).split('\n');
  assert.equal(lines.length, 3, `必须正好三行，实际 ${lines.length} 行：${JSON.stringify(lines)}`);

  assert.ok(lines[0].includes('不是独立模式的桌宠'), '第一行：说清是什么问题');
  assert.ok(lines[1].includes('DSH 设置页'), '第二行（落点）必须含「DSH 设置页」');
  assert.ok(lines[1].includes('中转站管理'), '第二行（落点）必须含「中转站管理」');
  assert.ok(lines[2].includes('不需要双击'), '第三行：告诉用户这个快捷方式不用点');
  // 没有被截断：三行各自非空
  for (const [i, line] of lines.entries()) assert.ok(line.trim().length > 0, `第 ${i + 1} 行为空`);
});
