import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  aggregateBalances,
  matchRelayProvider,
  queryAllBalances,
  querySiteBalance,
  selectLowSites,
  supportedKinds,
} from './index.ts';
import { putCredential, upsertSite } from './store.ts';
import type { RelayBalanceResult, RelaySite } from './types.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'relay-idx-'));
}

function mkSite(dir: string, over: Partial<Parameters<typeof upsertSite>[1]> = {}): RelaySite {
  return upsertSite(dir, { name: 'S', url: 'https://s.example.com', kind: 'new-api', ...over });
}

function okResult(siteId: string, total: string, currency = 'USD', fullBalance?: string): RelayBalanceResult {
  return {
    ok: true, siteId, provider: 'relay:new-api', shape: 'money', source: 'auto',
    data: { currency, total, granted: total, toppedUp: '0.00', ...(fullBalance ? { fullBalance } : {}) },
  };
}

function badResult(siteId: string, reason: 'fetch-error' | 'credential-missing' | 'unsupported' = 'fetch-error'): RelayBalanceResult {
  return { ok: false, siteId, provider: 'relay:new-api', reason };
}

test('注册表：new-api 已登记，sub2api / 未知类型未登记', () => {
  assert.ok(matchRelayProvider('new-api'));
  // sub2api / openai-compat 契约里声明了但适配器还没写 → 必须落 unsupported，不能静默通过
  assert.equal(matchRelayProvider('sub2api'), undefined);
  assert.equal(matchRelayProvider('openai-compat'), undefined);
  assert.equal(matchRelayProvider('bogus'), undefined);
  assert.deepEqual(supportedKinds(), ['new-api']);
});

test('querySiteBalance：未登记类型 → unsupported（不静默失败）', async () => {
  const dir = tmp();
  const s = mkSite(dir, { kind: 'sub2api' as never });
  const r = await querySiteBalance(dir, s);
  assert.deepEqual(r, { ok: false, siteId: s.id, provider: 'relay:sub2api', reason: 'unsupported', message: '未登记的站点类型 sub2api' });
});

test('querySiteBalance：无凭证 + 有手工值 → 用手工值并标注 manual（不发请求）', async () => {
  const dir = tmp();
  const s = mkSite(dir, { manualBalance: { amount: '3.02', currency: 'USD' } });
  const r = await querySiteBalance(dir, s);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.source, 'manual');
  assert.equal(r.data.total, '3.02');
});

test('querySiteBalance：无凭证 + 无手工值 → credential-missing（绝不返回 0）', async () => {
  const dir = tmp();
  const s = mkSite(dir);
  const r = await querySiteBalance(dir, s);
  assert.deepEqual(r, { ok: false, siteId: s.id, provider: 'relay:new-api', reason: 'credential-missing', message: '未配置凭证' });
});

test('querySiteBalance：凭证种类为 manual → 直接用手工值，不发任何请求', async () => {
  const dir = tmp();
  const s = mkSite(dir, { manualBalance: { amount: '1.00', currency: 'USD' } });
  putCredential(dir, s.id, { kind: 'manual', secret: '' });
  const r = await querySiteBalance(dir, s);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.source, 'manual');
  assert.equal(r.data.total, '1.00');
});

test('queryAllBalances：并发跑批，每个站点都有结果（无凭证场景，全程不发网络请求）', async () => {
  const dir = tmp();
  const sites = Array.from({ length: 9 }, (_, i) => mkSite(dir, { name: 'S' + i, url: 'https://s' + i + '.example.com' }));
  const results = await queryAllBalances(dir, sites);
  assert.equal(results.length, sites.length);
  assert.ok(results.every((r) => r.ok === false && r.reason === 'credential-missing'));
  // 顺序与入站顺序一致（不能因为并发而错位）
  assert.deepEqual(results.map((r) => r.siteId), sites.map((s) => s.id));
});

test('selectLowSites：低于阈值才选中；手工值不参与告警', () => {
  const dir = tmp();
  const low = mkSite(dir, { name: 'low', lowThreshold: '5' });
  const fine = mkSite(dir, { name: 'fine', lowThreshold: '5' });
  const manual = mkSite(dir, { name: 'manual', lowThreshold: '5' });
  const noThreshold = mkSite(dir, { name: 'none' });
  const results: RelayBalanceResult[] = [
    okResult(low.id, '3.02'),
    okResult(fine.id, '99.00'),
    { ok: true, siteId: manual.id, provider: 'relay:new-api', shape: 'money', source: 'manual',
      data: { currency: 'USD', total: '0.01', granted: '0.01', toppedUp: '0.00' } },
    okResult(noThreshold.id, '0.01'),
    badResult(fine.id),
  ];
  const picked = selectLowSites([low, fine, manual, noThreshold], results);
  assert.equal(picked.length, 1, '只有 low 该被选中');
  assert.equal(picked[0].name, 'low');
  assert.equal(picked[0].amount, '3.02');
});

test('selectLowSites：站点没配阈值时用全局默认；两个都没有就不判（不猜）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a' });
  const b = mkSite(dir, { name: 'b' });
  const results = [okResult(a.id, '1.00'), okResult(b.id, '1.00')];
  assert.equal(selectLowSites([a, b], results).length, 0, '没有阈值就不判');
  assert.equal(selectLowSites([a, b], results, '5').length, 2, '全局默认兜底');
});

test('selectLowSites：站点阈值覆盖全局默认', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a', lowThreshold: '0.5' });
  const results = [okResult(a.id, '1.00')];
  // 全局默认 5 会把 a 判为低余额，但站点自己的 0.5 不该
  assert.equal(selectLowSites([a], results, '5').length, 0);
});

test('selectLowSites：按剩余升序（最紧见的排最前）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a', lowThreshold: '10' });
  const b = mkSite(dir, { name: 'b', lowThreshold: '10' });
  const c = mkSite(dir, { name: 'c', lowThreshold: '10' });
  const picked = selectLowSites([a, b, c], [okResult(a.id, '8'), okResult(b.id, '2'), okResult(c.id, '5')]);
  assert.deepEqual(picked.map((p) => p.name), ['b', 'c', 'a']);
});

test('aggregateBalances：同币种合计；fullBalance 仅在全都有时给出', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a' });
  const b = mkSite(dir, { name: 'b' });
  const results = [okResult(a.id, '10.50', 'USD', '20.00'), okResult(b.id, '3.25', 'USD', '5.00')];
  const sum = aggregateBalances([a, b], results);
  assert.equal(sum.currency, 'USD');
  assert.equal(sum.total, '13.75');
  assert.equal(sum.fullBalance, '25.00');
  assert.equal(sum.siteCount, 2);
  assert.equal(sum.failedCount, 0);
  assert.deepEqual(sum.otherCurrencies, []);

  // 有一个站点没有 fullBalance → 整体不设基准（不猜）
  const mixed = aggregateBalances([a, b], [okResult(a.id, '10.50', 'USD', '20.00'), okResult(b.id, '3.25', 'USD')]);
  assert.equal(mixed.fullBalance, undefined);
  assert.equal(mixed.total, '13.75', '合计仍要算');
});

test('aggregateBalances：多币种不混算 —— 取站点数最多的作主口径，其余如实列出', () => {
  const dir = tmp();
  const usd1 = mkSite(dir, { name: 'usd1' });
  const usd2 = mkSite(dir, { name: 'usd2' });
  const cny = mkSite(dir, { name: 'cny' });
  const sum = aggregateBalances(
    [usd1, usd2, cny],
    [okResult(usd1.id, '10.00', 'USD'), okResult(usd2.id, '5.00', 'USD'), okResult(cny.id, '100.00', 'CNY')],
  );
  assert.equal(sum.currency, 'USD');
  assert.equal(sum.total, '15.00');
  assert.equal(sum.siteCount, 2, 'CNY 站不计入主口径');
  assert.deepEqual(sum.otherCurrencies, ['CNY']);
});

test('aggregateBalances：全部失败 → 0 站点、币种兜底 USD、failedCount 正确', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a' });
  const sum = aggregateBalances([a], [badResult(a.id), badResult(a.id, 'credential-missing')]);
  assert.equal(sum.siteCount, 0);
  assert.equal(sum.failedCount, 2);
  assert.equal(sum.total, '0.00');
  assert.equal(sum.fullBalance, undefined);
});

test('aggregateBalances：空输入不炸', () => {
  const sum = aggregateBalances([], []);
  assert.equal(sum.siteCount, 0);
  assert.equal(sum.total, '0.00');
  assert.deepEqual(sum.lowSites, []);
});
