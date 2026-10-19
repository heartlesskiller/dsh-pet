/**
 * 启动自愈（`scripts/config-heal.mjs` 的纯函数）。
 *
 * 钉的是这条不变式：**`display:"none"` 在独立模式下是死路，用户双击快捷方式必须能被自愈**；
 * 同时**只治 none 这一种**，别把用户有意设的 web/both 顺手改坏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { backupSuffix, parseConfigText, planDisplayHeal, stripJsonComments } from '../../scripts/config-heal.mjs';

/** 剥掉行/块注释：断言"代码里没有 X"时必须先剥注释，否则注释里的说明文字会误伤 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** pet-service.mjs 源码（顺序断言用） */
const petService = readFileSync(fileURLToPath(new URL('../../scripts/pet-service.mjs', import.meta.url)), 'utf8');

const cfg = (display: unknown) => ({ pets: [{ id: 'main', size: 462, display }] });

test('display 为 none → 要自愈成 desktop，并给出人话', () => {
  const plan = planDisplayHeal(cfg('none'));
  assert.equal(plan.changed, true);
  assert.ok(plan.reason.includes('不在桌面显示'), plan.reason);
  assert.ok(plan.reason.includes('桌面显示'), plan.reason);
  const pets = (plan.value as { pets: Array<{ display?: string; size?: number }> }).pets;
  assert.equal(pets[0].display, 'desktop');
  // 其他字段不许被动过
  assert.equal(pets[0].size, 462);
});

test('本来就是 desktop → 不改（changed=false，调用方不该写盘）', () => {
  const plan = planDisplayHeal(cfg('desktop'));
  assert.equal(plan.changed, false);
  assert.equal((plan.value as { pets: Array<{ display?: string }> }).pets[0].display, 'desktop');
});

test('只治 none：web / both / 缺失 / 非法值一律不动', () => {
  for (const display of ['web', 'both', undefined, 'nonsense', 42, null]) {
    const plan = planDisplayHeal(cfg(display));
    assert.equal(plan.changed, false, `display=${JSON.stringify(display)} 不该被自愈`);
  }
});

test('多只宠物：只改 none 的那只，其余原样', () => {
  const plan = planDisplayHeal({
    pets: [
      { id: 'a', display: 'none' },
      { id: 'b', display: 'web' },
      { id: 'c', display: 'none' },
      { id: 'd', display: 'both' },
    ],
  });
  assert.equal(plan.changed, true);
  assert.deepEqual(
    (plan.value as { pets: Array<{ id: string; display?: string }> }).pets.map((p) => [p.id, p.display]),
    [
      ['a', 'desktop'],
      ['b', 'web'],
      ['c', 'desktop'],
      ['d', 'both'],
    ],
  );
  assert.ok(plan.reason.includes('2 只'), plan.reason);
});

test('配置形状异常 → 不清洗，只回报原因', () => {
  assert.equal(planDisplayHeal(null).changed, false);
  assert.equal(planDisplayHeal('nope').changed, false);
  assert.equal(planDisplayHeal([{ display: 'none' }]).changed, false, '数组不是合法配置');
  assert.equal(planDisplayHeal({}).changed, false, '没有 pets 数组');
  assert.equal(planDisplayHeal({ pets: 'x' }).changed, false);
  assert.equal(planDisplayHeal({ pets: [null, 3] }).changed, false, '坏条目不该让整包崩');
});

// ---------- JSONC 解析 ----------

test('stripJsonComments：去掉行/块注释，字符串内的 // 不受影响', () => {
  const src = `{
    // 这是注释
    "url": "https://a.example.com", // 尾随注释
    /* 块注释
       跨行 */
    "name": "含 // 斜杠的字符串"
  }`;
  const out = stripJsonComments(src);
  assert.equal(out.includes('这是注释'), false);
  assert.equal(out.includes('块注释'), false);
  assert.equal(out.includes('尾随注释'), false);
  assert.ok(out.includes('https://a.example.com'), '字符串内容必须保留');
  assert.ok(out.includes('含 // 斜杠的字符串'), '字符串里的 // 不能被当注释');
});

test('parseConfigText：能解析带注释的配置；坏内容回报原因不抛', () => {
  const ok = parseConfigText('{ "pets": [ { "display": "none" } ] } // 注释');
  assert.equal(ok.ok, true);
  const bad = parseConfigText('{ "pets": [ }');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.message.includes('JSON'), bad.message);
  assert.equal(parseConfigText('').ok, false);
});

test('backupSuffix：带日期时间，同一天多次自愈不会互相覆盖', () => {
  const a = backupSuffix(new Date(2026, 9, 18, 13, 5, 9));
  assert.equal(a, '20261018-130509');
  const b = backupSuffix(new Date(2026, 9, 18, 13, 5, 10));
  assert.notEqual(a, b);
});

// ---------- 运行形态：standalone 下 web 也是死路（用户第二次踩的就是这个） ----------

test('standalone 模式：none 与 web 都要自愈（独立模式没有网页界面）', () => {
  for (const dead of ['none', 'web']) {
    const plan = planDisplayHeal(cfg(dead), { mode: 'standalone' });
    assert.equal(plan.changed, true, `standalone 下 ${dead} 是死路，必须自愈`);
    const pets = (plan.value as { pets: Array<{ display?: string }> }).pets;
    assert.equal(pets[0].display, 'desktop');
  }
  // 两种原因的人话要区分
  assert.ok(planDisplayHeal(cfg('none'), { mode: 'standalone' }).reason.includes('不在桌面显示'));
  assert.ok(planDisplayHeal(cfg('web'), { mode: 'standalone' }).reason.includes('只在网页显示'));
  assert.ok(planDisplayHeal(cfg('web'), { mode: 'standalone' }).reason.includes('没有网页界面'));
});

test('standalone 模式：desktop / both 不动（用户有意为之）', () => {
  for (const ok of ['desktop', 'both']) {
    assert.equal(planDisplayHeal(cfg(ok), { mode: 'standalone' }).changed, false, `${ok} 不该被自愈`);
  }
});

test('🔴 bridge 模式：web 不改（回归保护 —— DSH 下 web 是合法的）', () => {
  assert.equal(planDisplayHeal(cfg('web')).changed, false, '不传 mode 时只治 none');
  assert.equal(planDisplayHeal(cfg('web'), { mode: 'bridge' }).changed, false, 'bridge 下 web 合法');
  // 但 none 在两种模式下都要治
  assert.equal(planDisplayHeal(cfg('none'), { mode: 'bridge' }).changed, true);
});

test('缺失 / 非法值：两种模式下都不动，只警告', () => {
  for (const mode of ['standalone', 'bridge'] as const) {
    for (const bad of [undefined, 'nonsense', 42, null]) {
      assert.equal(planDisplayHeal(cfg(bad), { mode }).changed, false, `display=${JSON.stringify(bad)} 不该被自愈`);
    }
  }
});

// ---------- 调用顺序：自愈必须在 alreadyRunning 早退之前（Bug 2） ----------

test('🔴 顺序断言：healDisplay() 必须出现在 alreadyRunning 早退之前', () => {
  // 曾经的 bug：自愈放在 spawn 之前 → 服务已经在跑时走了早退，自愈一次都没执行，
  // 用户连点 4 次快捷方式都没用。这条钉死位置。
  const healAt = petService.indexOf('const healed = healDisplay();');
  const earlyReturn = petService.indexOf('return { alreadyRunning: true');
  assert.ok(healAt > 0, 'pet-service.mjs 里找不到 healDisplay() 调用');
  assert.ok(earlyReturn > 0, '找不到 alreadyRunning 早退');
  assert.ok(healAt < earlyReturn, `自愈（${healAt}）必须在 alreadyRunning 早退（${earlyReturn}）之前`);
  // 还要在端口探测之前（探测可能抛 foreign，抛了就轮不到自愈）
  const probeAt = petService.indexOf('classifyPortOccupant(await probe(port))');
  assert.ok(healAt < probeAt, '自愈必须在端口探测之前（foreign 会抛错，抛了就轮不到自愈）');
});

test('🔴 自愈改了配置但服务已在跑 → 必须提示重载，且绝不自动 shutdown', () => {
  const branch = /if \(occupant === 'our-standalone'\) \{([\s\S]*?)\n {4}\}/.exec(petService);
  assert.ok(branch, '找不到 alreadyRunning 分支');
  // 剥注释：注释里写着"不自动 /shutdown"是说明，不是调用
  const body = stripComments(branch[1]);
  assert.ok(/healed\.changed/.test(body), '必须判断本次是否自愈过');
  assert.ok(/重载配置/.test(body), '必须提示用户「右键桌宠 → 重载配置」');
  assert.ok(/旧配置运行/.test(body), '必须说明"正在用旧配置运行"');
  // 绝不自动 shutdown：那会不经用户同意杀掉他眼前的桌宠
  assert.equal(/shutdown/.test(body), false, 'alreadyRunning 分支里绝不出现 shutdown');
});
