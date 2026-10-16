import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RELAY_PROVIDER_PREFIX,
  normalizeBaseUrl,
  parseModels,
  parseQuotaPerUnit,
  parseUserSelf,
} from './newapi.ts';

const RATE = 500_000;

test('parseUserSelf：标准 one-api / new-api 响应', () => {
  const r = parseUserSelf(
    { success: true, message: '', data: { id: 1, username: 'abc', quota: 21090000, used_quota: 10000 } },
    { quotaPerUnit: RATE },
  );
  assert.deepEqual(r, {
    ok: true,
    provider: RELAY_PROVIDER_PREFIX + 'new-api',
    shape: 'money',
    source: 'auto',
    data: {
      currency: 'USD',
      total: '42.18', // 21090000 / 500000
      granted: '42.18',
      toppedUp: '0.00',
      fullBalance: '42.20', // (21090000 + 10000) / 500000 —— 档位基准由数据推出
    },
  });
});

test('parseUserSelf：只有 quota 没有 used_quota → 不设 fullBalance（没基准就不播档位动画）', () => {
  const r = parseUserSelf({ success: true, data: { quota: 500000 } }, { quotaPerUnit: RATE });
  assert.deepEqual(r.data, {
    currency: 'USD',
    total: '1.00',
    granted: '1.00',
    toppedUp: '0.00',
  });
  assert.ok(!('fullBalance' in r.data), 'fullBalance 键必须不存在（严格比对会炸）');
});

test('parseUserSelf：兼容没有 data 包裹、直接平铺的返回', () => {
  const r = parseUserSelf({ quota: 1000000, used_quota: 500000 }, { quotaPerUnit: RATE });
  assert.equal(r.data.total, '2.00');
  assert.equal(r.data.fullBalance, '3.00');
});

test('parseUserSelf：站点自定义换算率（站长改了 quota_per_unit）', () => {
  const r = parseUserSelf({ success: true, data: { quota: 250000, used_quota: 0 } }, { quotaPerUnit: 250_000 });
  assert.equal(r.data.total, '1.00');
  assert.equal(r.data.fullBalance, '1.00');
});

test('parseUserSelf：money 形态不变量 —— granted + toppedUp === total', () => {
  for (const q of [0, 1, 12345, 21090000]) {
    const r = parseUserSelf({ success: true, data: { quota: q, used_quota: 1 } }, { quotaPerUnit: RATE });
    const sum = (Math.round(Number(r.data.granted) * 100) + Math.round(Number(r.data.toppedUp) * 100)) / 100;
    assert.equal(sum.toFixed(2), r.data.total, 'quota=' + q);
  }
});

test('parseUserSelf：失败一律 throw，绝不伪造 0 余额', () => {
  assert.throws(() => parseUserSelf({ success: false, message: '令牌已过期' }, { quotaPerUnit: RATE }), /令牌已过期/);
  assert.throws(() => parseUserSelf({ success: true, data: {} }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf({ success: true, data: { quota: -1 } }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf({ success: true, data: { quota: 'x' } }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf(null, { quotaPerUnit: RATE }));
  assert.throws(() => parseUserSelf({ success: true, data: { quota: 1 } }, { quotaPerUnit: 0 }), /quotaPerUnit/);
});

test('parseModels：三种 OpenAI 兼容形状', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'gpt-4o' }, { id: 'claude-3' }] }), ['claude-3', 'gpt-4o']);
  assert.deepEqual(parseModels({ data: { models: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(parseModels(['x', 'y']), ['x', 'y']);
});

test('parseModels：去重 + 排序，保证同站多次拉取结果稳定', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
});

test('parseModels：空列表 / 找不到数组 → throw（不返回空列表冒充成功）', () => {
  assert.throws(() => parseModels({ data: [] }), /0 个模型/);
  assert.throws(() => parseModels({}), /找不到模型数组/);
  assert.throws(() => parseModels(null), /找不到模型数组/);
  assert.throws(() => parseModels({ data: [{ noId: 1 }] }), /0 个模型/);
});

test('parseQuotaPerUnit：拿得到且合法才返回，否则 undefined', () => {
  assert.equal(parseQuotaPerUnit({ data: { quota_per_unit: 500000 } }), 500000);
  assert.equal(parseQuotaPerUnit({ quota_per_unit: 250000 }), 250000);
  assert.equal(parseQuotaPerUnit({ data: {} }), undefined);
  assert.equal(parseQuotaPerUnit({ data: { quota_per_unit: 0 } }), undefined);
  assert.equal(parseQuotaPerUnit(null), undefined);
});

test('normalizeBaseUrl：去尾斜杠、去 /v1 后缀', () => {
  assert.equal(normalizeBaseUrl('https://a.com'), 'https://a.com');
  assert.equal(normalizeBaseUrl('https://a.com/'), 'https://a.com');
  assert.equal(normalizeBaseUrl('https://a.com/v1'), 'https://a.com');
  assert.equal(normalizeBaseUrl('https://a.com/v1/'), 'https://a.com');
  assert.equal(normalizeBaseUrl('  https://a.com/v1  '), 'https://a.com');
});

test('normalizeBaseUrl：非 http(s) / 空 / 非字符串 → throw', () => {
  assert.throws(() => normalizeBaseUrl('a.com'), /http/);
  assert.throws(() => normalizeBaseUrl(''), /为空/);
  assert.throws(() => normalizeBaseUrl(undefined));
  assert.throws(() => normalizeBaseUrl(null));
});
