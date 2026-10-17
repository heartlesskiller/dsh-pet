import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_QUOTA_PER_UNIT,
  detectQuotaPerUnit,
  quotaToAmount,
  quotaPerUnitOf,
  sumQuota,
  usedPercent,
} from './money.ts';

test('DEFAULT_QUOTA_PER_UNIT：one-api / new-api 默认 500000 quota = 1 USD', () => {
  assert.equal(DEFAULT_QUOTA_PER_UNIT, 500_000);
});

test('quotaToAmount：默认换算率下的 canonical 值', () => {
  assert.equal(quotaToAmount(500_000), '1.00');
  assert.equal(quotaToAmount(250_000), '0.50');
  assert.equal(quotaToAmount(21090000), '42.18'); // 21090000 / 500000
  assert.equal(quotaToAmount(0), '0.00');
  assert.equal(quotaToAmount(1), '0.00'); // 不足 1 分，如实归零（不是伪造，是真没有）
});

test('quotaToAmount：按站点覆盖换算率', () => {
  assert.equal(quotaToAmount(250_000, 250_000), '1.00');
  assert.equal(quotaToAmount(500_000, 1_000_000), '0.50');
  assert.equal(quotaToAmount(21090000, 500_000), '42.18');
});

test('quotaToAmount：结果必为两位小数且是「分」的整数倍', () => {
  for (const q of [1, 7, 1234, 999999, 21090000, 123456789]) {
    const s = quotaToAmount(q);
    assert.match(s, /^\d+\.\d{2}$/, '必须是两位小数：' + s);
    assert.equal(Number(s) * 100, Math.round(Number(s) * 100), '不能有超过分的精度：' + s);
  }
});

test('quotaToAmount：非法输入一律 throw，不静默当 0', () => {
  assert.throws(() => quotaToAmount(-1));
  assert.throws(() => quotaToAmount(NaN));
  assert.throws(() => quotaToAmount(Infinity));
  assert.throws(() => quotaToAmount('abc'));
  assert.throws(() => quotaToAmount(undefined));
});

test('quotaToAmount：换算率非法一律 throw（0 / 负 / NaN 会让余额变 Infinity）', () => {
  assert.throws(() => quotaToAmount(1000, 0));
  assert.throws(() => quotaToAmount(1000, -500));
  assert.throws(() => quotaToAmount(1000, NaN));
  assert.throws(() => quotaToAmount(1000, Infinity));
});

test('quotaPerUnitOf：有限正数原样返回', () => {
  assert.equal(quotaPerUnitOf(500_000), 500_000);
  assert.equal(quotaPerUnitOf('250000'), 250_000);
  assert.throws(() => quotaPerUnitOf(0));
});

test('quotaPerUnitOf：绝不静默默认 —— 缺省值一律 throw（修订 #11）', () => {
  // 「站点没配就用默认」的兜底入口已拆除：调用方必须显式给值，
  // 建站时由 store 显式写默认值并标记 rateConfirmed:false
  assert.throws(() => quotaPerUnitOf(undefined), /非法/);
  assert.throws(() => quotaPerUnitOf(null), /非法/);
  assert.throws(() => quotaPerUnitOf(''), /非法/);
  assert.equal(quotaPerUnitOf(250_000), 250_000);
  assert.throws(() => quotaPerUnitOf(0));
  assert.throws(() => quotaPerUnitOf(-1));
});

test('detectQuotaPerUnit：从 /api/status 探测换算率（修订 #19，探测是第一路径）', () => {
  // 真站响应形状（docs/10 §1）：data.quota_per_unit = 500000
  assert.equal(detectQuotaPerUnit({ data: { quota_per_unit: 500000 } }), 500_000);
  assert.equal(detectQuotaPerUnit({ data: { quota_per_unit: 250000 } }), 250_000);
  // 兼容没有 data 包裹、直接平铺的返回
  assert.equal(detectQuotaPerUnit({ quota_per_unit: 500000 }), 500_000);
});

test('detectQuotaPerUnit：探测不到 → undefined（调用方标 rateUnconfirmed，不静默默认）', () => {
  assert.equal(detectQuotaPerUnit({ data: {} }), undefined);
  assert.equal(detectQuotaPerUnit({ data: { quota_per_unit: 0 } }), undefined);
  assert.equal(detectQuotaPerUnit({ data: { quota_per_unit: 'x' } }), undefined);
  assert.equal(detectQuotaPerUnit({}), undefined);
  assert.equal(detectQuotaPerUnit(null), undefined);
  assert.equal(detectQuotaPerUnit('not-json'), undefined);
});

test('sumQuota：剩余 + 已用 = 历史总额', () => {
  assert.equal(sumQuota(21090000, 10000), 21100000);
  assert.equal(sumQuota(0, 0), 0);
  assert.throws(() => sumQuota(-1, 5));
  assert.throws(() => sumQuota(NaN, 5));
});

test('usedPercent：由剩余与总额推出，不猜基准', () => {
  // 剩余 21090000 / 总额 21100000 → 已用 0.4739…%
  const p = usedPercent(21090000, 21100000);
  assert.ok(p !== undefined);
  assert.ok(Math.abs(p - (10000 / 21100000) * 100) < 1e-9);
});

test('usedPercent：总额 <= 0 → undefined（没基准就不播档位动画，不猜）', () => {
  assert.equal(usedPercent(100, 0), undefined);
  assert.equal(usedPercent(100, -5), undefined);
  assert.equal(usedPercent(NaN, 100), undefined);
});

test('usedPercent：下界夹 0，上界不夹（超额如实报 >100%）', () => {
  assert.equal(usedPercent(120, 100), 0); // 剩余 > 总额 → 视为未消耗
  assert.equal(usedPercent(0, 100), 100);
  // 站点改了汇率 / 额度被回收，导致「剩余」口径变负：如实报 >100%，不夹、也不报负数
  const over = usedPercent(-50, 100);
  assert.ok(over !== undefined && over > 100, '超额必须如实报出来，实测 ' + String(over));
  assert.equal(over, 150);
});
