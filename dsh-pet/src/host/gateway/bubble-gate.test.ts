/**
 * 气泡门控测试（docs/19 §8 A4）：1500ms 内低不压高；窗口后放行；同优先级放行；error 永不被吞。
 *
 * priority 口径复用 gateway/ingest.ts 的 SEVERITY_PRIORITY（测试直接 import 它——
 * 「不开第二张表」由此机械钉死：谁在门控里另立一套 severity 映射，这里就红）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBubbleGate } from './bubble-gate.ts';
import { SEVERITY_PRIORITY } from './ingest.ts';

const { info, warning, error } = SEVERITY_PRIORITY;

test('1500ms 窗口内低优先级不得覆盖高优先级（error 告警不被 info 盖掉）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('main', error), true, 'error 首发放行');
  now += 200;
  assert.equal(gate.pass('main', info), false, '窗口内的 info 被拒（静默合并）');
  now += 200;
  assert.equal(gate.pass('main', info), false, '记录未被低优先级刷新，继续拒');
});

test('窗口后放行（1500ms 是压制窗口，不是永久静音）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now, 1500);
  assert.equal(gate.pass('main', error), true);
  now += 1_499;
  assert.equal(gate.pass('main', info), false, '差 1ms 仍在窗口内');
  now += 1;
  assert.equal(gate.pass('main', info), true, '窗口一过就放行');
});

test('同优先级放行（防嘴被堵住：连续同 severity 气泡各有信息量）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('main', warning), true);
  now += 100;
  assert.equal(gate.pass('main', warning), true, '同优先级不被自己压');
  now += 100;
  assert.equal(gate.pass('main', info), false, 'warning 的记录仍压着 info');
});

test('error(20) 是最高优先级，永不被拒（窗口内外、任何记录之后）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('main', info), true);
  now += 10;
  assert.equal(gate.pass('main', error), true, 'error 穿透 info');
  now += 10;
  assert.equal(gate.pass('main', error), true, 'error 连发也放行（每条 error 都是事故）');
  assert.equal(gate.pass('main', warning), false, 'warning 仍被 error 的记录压着');
});

test('升级放行：warning 之后的 error 放行并记账，info 继续被压', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('main', warning), true);
  now += 100;
  assert.equal(gate.pass('main', error), true);
  now += 100;
  assert.equal(gate.pass('main', info), false, '记录已升级到 error');
});

test('per-pet 记账互不干扰（A 宠被压不影响 B 宠）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('pet-a', error), true);
  assert.equal(gate.pass('pet-b', info), true, '另一只宠没有 error 记录');
  now += 100;
  assert.equal(gate.pass('pet-a', info), false);
  assert.equal(gate.pass('pet-b', info), true, '同优先级放行');
});

test('默认窗口 1500ms（不传 holdMs 时的口径）', () => {
  let now = 10_000;
  const gate = createBubbleGate(() => now);
  assert.equal(gate.pass('main', warning), true);
  now += 1_500;
  assert.equal(gate.pass('main', info), true, '1500ms 整点已出窗（now - at < hold 是严格小于）');
});
