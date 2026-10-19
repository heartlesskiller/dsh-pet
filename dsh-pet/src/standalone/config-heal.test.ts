/**
 * 启动自愈（`scripts/config-heal.mjs` 的纯函数）。
 *
 * 钉的是这条不变式：**`display:"none"` 在独立模式下是死路，用户双击快捷方式必须能被自愈**；
 * 同时**只治 none 这一种**，别把用户有意设的 web/both 顺手改坏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backupSuffix, parseConfigText, planDisplayHeal, stripJsonComments } from '../../scripts/config-heal.mjs';

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
