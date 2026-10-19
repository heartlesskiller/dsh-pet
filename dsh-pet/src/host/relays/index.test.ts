import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  RELAY_PROVIDERS,
  aggregateBalances,
  failureBackoffDelay,
  matchRelayProvider,
  queryAllBalances,
  querySiteBalance,
  resetFailureMemory,
  selectLowSites,
  supportedKinds,
} from './index.ts';
import { putCredential, upsertSite } from './store.ts';
import { classifiedError } from './providers/newapi.ts';
import type { RelayBalanceResult, RelayProvider, RelaySite } from './types.ts';

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

test('注册表：new-api / openai-compat / deepseek 已登记，sub2api / 未知类型未登记', () => {
  assert.ok(matchRelayProvider('new-api'));
  assert.ok(matchRelayProvider('openai-compat'));
  assert.ok(matchRelayProvider('deepseek'), 'deepseek 官方余额（2026-10-19 真 key 实测后登记）');
  // sub2api 契约里声明了但适配器还没写 → 必须落 unsupported，不能静默通过
  assert.equal(matchRelayProvider('sub2api'), undefined);
  assert.equal(matchRelayProvider('bogus'), undefined);
  assert.deepEqual(supportedKinds(), ['new-api', 'openai-compat', 'deepseek']);
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
  assert.equal(sum.unlimitedCount, 0);
});

// ---------- T02 新增：无限额度 / 换算率未确认 / 错误归类 ----------

/** 带 unlimited / rateUnconfirmed 标记的成功结果 */
function okResultExt(
  siteId: string,
  total: string,
  ext: { unlimited?: boolean; spent?: string; rateUnconfirmed?: boolean; scope?: 'account' | 'token' } = {},
): RelayBalanceResult {
  return {
    ok: true, siteId, provider: 'relay:new-api', shape: 'money', source: 'auto',
    ...(ext.scope !== undefined ? { scope: ext.scope } : {}),
    ...(ext.unlimited !== undefined ? { unlimited: ext.unlimited } : {}),
    ...(ext.spent !== undefined ? { spent: ext.spent } : {}),
    ...(ext.rateUnconfirmed !== undefined ? { rateUnconfirmed: ext.rateUnconfirmed } : {}),
    data: { currency: 'USD', total, granted: total, toppedUp: '0.00' },
  };
}

test('selectLowSites：F2 —— 无限额度站不参与低余额告警（它的 total 是已用金额）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a', lowThreshold: '5' });
  const b = mkSite(dir, { name: 'b', lowThreshold: '5' });
  const picked = selectLowSites(
    [a, b],
    [okResultExt(a.id, '34.58', { unlimited: true, spent: '34.58' }), okResultExt(b.id, '3.02')],
  );
  assert.deepEqual(picked.map((p) => p.name), ['b'], '无限站没有「剩余」概念，拿它比阈值会误报');
});

test('selectLowSites：OP-6 —— 换算率未确认的站不告警（数据不可靠不评估）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a', lowThreshold: '5' });
  const b = mkSite(dir, { name: 'b', lowThreshold: '5' });
  const picked = selectLowSites(
    [a, b],
    [okResultExt(a.id, '1.00', { rateUnconfirmed: true }), okResultExt(b.id, '3.02')],
  );
  assert.deepEqual(picked.map((p) => p.name), ['b'], '未确认换算率先提示核对，不拿来告警');
});

test('aggregateBalances：无限额度站不计入剩余合计，只进 unlimitedCount（A4）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a' });
  const b = mkSite(dir, { name: 'b' });
  const sum = aggregateBalances(
    [a, b],
    [okResult(a.id, '10.00', 'USD', '20.00'), okResultExt(b.id, '34.58', { unlimited: true, spent: '34.58' })],
  );
  assert.equal(sum.total, '10.00', '已用金额加进「剩余合计」是把语义搞反');
  assert.equal(sum.siteCount, 1, '无限站不计入可查站点数');
  assert.equal(sum.unlimitedCount, 1);
  assert.equal(sum.fullBalance, '20.00');
  assert.equal(sum.failedCount, 0, '无限站是查询成功，不是失败');
});

test('aggregateBalances：全部无限 → siteCount 0 但 unlimitedCount 如实（不伪造 0 余额）', () => {
  const dir = tmp();
  const a = mkSite(dir, { name: 'a' });
  const sum = aggregateBalances([a], [okResultExt(a.id, '34.58', { unlimited: true, spent: '34.58' })]);
  assert.equal(sum.siteCount, 0);
  assert.equal(sum.total, '0.00');
  assert.equal(sum.unlimitedCount, 1);
});

/** 临时把注册表第一个 provider 换成假实现（跑完还原；不碰网络） */
async function withFakeProvider<T>(fetchImpl: () => Promise<Omit<RelayBalanceResult, 'siteId'> | never>, run: () => Promise<T>): Promise<T> {
  const fake: RelayProvider = {
    kinds: ['new-api'],
    credentialKinds: ['api-key'],
    fetch: async () => (await fetchImpl()) as never,
  };
  const original = RELAY_PROVIDERS[0];
  RELAY_PROVIDERS[0] = fake;
  try {
    return await run();
  } finally {
    RELAY_PROVIDERS[0] = original;
  }
}

test('querySiteBalance：修订 #11 —— rateConfirmed 未确认 → 成功结果带 rateUnconfirmed', async () => {
  const dir = tmp();
  const s = mkSite(dir); // 建站默认 rateConfirmed:false（store 显式写默认换算率）
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  await withFakeProvider(
    async () => ({ ok: true, provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' } }),
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.rateUnconfirmed, true, '未确认换算率必须打标');
    },
  );
  // 显式确认后 → 不带标记
  const confirmed = upsertSite(dir, { id: s.id, name: s.name, url: s.url, kind: 'new-api', rateConfirmed: true });
  await withFakeProvider(
    async () => ({ ok: true, provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' } }),
    async () => {
      const r = await querySiteBalance(dir, confirmed);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.ok(!('rateUnconfirmed' in r), '已确认就不该有标记键');
    },
  );
});

test('querySiteBalance：usesQuotaRate=false 的纯金额源（deepseek）→ 不打 rateUnconfirmed', async () => {
  // 2026-10-19 真数据实测发现的瑕疵：DeepSeek 读数直接是 CNY 金额、没有换算率可言，
  // 旧逻辑一律打标会让它永远无法参与低余额告警（¥4.88 该报不报）。
  const dir = tmp();
  const s = mkSite(dir, { kind: 'deepseek' }); // 建站默认 rateConfirmed:false
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  const fake: RelayProvider = {
    kinds: ['deepseek'],
    credentialKinds: ['api-key'],
    usesQuotaRate: false,
    fetch: async () =>
      ({ ok: true, provider: 'relay:deepseek', shape: 'money', source: 'auto', scope: 'account', data: { currency: 'CNY', total: '4.88', granted: '3.54', toppedUp: '1.34' } }) as never,
  };
  const original = RELAY_PROVIDERS[2]; // deepseek 槽位
  RELAY_PROVIDERS[2] = fake;
  try {
    const r = await querySiteBalance(dir, s);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(!('rateUnconfirmed' in r), '纯金额源不该被换算率标记挡住告警');
  } finally {
    RELAY_PROVIDERS[2] = original;
  }
});

test('querySiteBalance：A6 —— provider 抛 blocked / rate-limited → 归类为对应 reason', async () => {
  const dir = tmp();
  const s = mkSite(dir);
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  await withFakeProvider(
    async () => {
      throw classifiedError('relays: HTTP 403 疑似 Cloudflare 拦截', 'blocked', 403);
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, 'blocked');
      assert.match(r.message ?? '', /Cloudflare/);
    },
  );
  resetFailureMemory(); // 失败会记退避：下一段断言要清掉记忆，否则被退避短路
  await withFakeProvider(
    async () => {
      throw classifiedError('relays: HTTP 429 站点限流', 'rate-limited', 429);
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, 'rate-limited');
    },
  );
  resetFailureMemory();
  await withFakeProvider(
    async () => {
      throw new Error('plain failure');
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, 'fetch-error', '无分类 code 的普通错误归 fetch-error');
    },
  );
  resetFailureMemory();
});

// ---------- T05：失败退避 + 舰队 deadline ----------

test('failureBackoffDelay：1s 起倍增至 60s 封顶（纯函数）', () => {
  assert.equal(failureBackoffDelay(0), 1_000);
  assert.equal(failureBackoffDelay(1), 1_000);
  assert.equal(failureBackoffDelay(2), 2_000);
  assert.equal(failureBackoffDelay(3), 4_000);
  assert.equal(failureBackoffDelay(10), 60_000, '封顶 60s');
  assert.equal(failureBackoffDelay(999), 60_000);
});

test('querySiteBalance：连续失败 → 退避期内不再发起请求（429 对冲）', async () => {
  const dir = tmp();
  const s = mkSite(dir);
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  let calls = 0;
  const boom = async () => {
    calls += 1;
    throw classifiedError('relays: HTTP 500', 'http', 500);
  };
  await withFakeProvider(boom, async () => {
    const r1 = await querySiteBalance(dir, s);
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.equal(r1.reason, 'fetch-error');
  });
  assert.equal(calls, 1, '第一次真的打了');
  await withFakeProvider(boom, async () => {
    const r2 = await querySiteBalance(dir, s);
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.equal(r2.reason, 'rate-limited', '退避期内短路成 rate-limited');
    assert.match(r2.message ?? '', /失败退避中/);
  });
  assert.equal(calls, 1, '退避期内没有第二次请求——打一个正在失败的站没有意义');
  resetFailureMemory();
});

test('querySiteBalance：成功后清除失败记忆（恢复后立刻可查）', async () => {
  const dir = tmp();
  const s = mkSite(dir);
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  await withFakeProvider(
    async () => {
      throw classifiedError('relays: HTTP 500', 'http', 500);
    },
    async () => {
      await querySiteBalance(dir, s);
    },
  );
  resetFailureMemory(); // 不等 1s 退避：直接验证「成功即清除」的下一拍
  let calls = 0;
  await withFakeProvider(
    async () => {
      calls += 1;
      return { ok: true, provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' } };
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, true);
    },
  );
  assert.equal(calls, 1);
  // 成功后再来一次：仍然直通（记忆已清）
  await withFakeProvider(
    async () => {
      calls += 1;
      return { ok: true, provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' } };
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, true);
    },
  );
  assert.equal(calls, 2);
  resetFailureMemory();
});

test('queryAllBalances：deadline 到点 → 未开始的站点显式跳过（下周期重试），不静默丢', async () => {
  const dir = tmp();
  const sites = Array.from({ length: 8 }, (_, i) => mkSite(dir, { name: 'S' + i, url: 'https://s' + i + '.example.com' }));
  // 全部带凭证：4 个 worker 会同时挂在飞（每次 60ms），10ms deadline 到点后，
  // 剩下的站点应当被显式跳过而不是继续排队开打
  for (const s of sites) putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  let calls = 0;
  await withFakeProvider(
    async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' } };
    },
    async () => {
      const results = await queryAllBalances(dir, sites, { deadlineMs: 10 });
      assert.equal(results.length, sites.length, '每个站都要有结果（不能缺位）');
      const skipped = results.filter((r) => !r.ok && r.reason === 'fetch-error' && (r.message ?? '').includes('上限'));
      assert.ok(skipped.length >= 1, '超时后未开始的站必须显式跳过：' + JSON.stringify(results.map((r) => (r.ok ? 'ok' : r.reason))));
      assert.ok(calls < sites.length, '不该把全部站都打完：calls=' + calls);
    },
  );
  resetFailureMemory();
});

test('querySiteBalance：自动失败 + 有手工值 → 用手工值（message 说明原因，不冒充实时）', async () => {
  const dir = tmp();
  const s = mkSite(dir, { manualBalance: { amount: '3.02', currency: 'USD' } });
  putCredential(dir, s.id, { kind: 'api-key', secret: 'sk-test' });
  await withFakeProvider(
    async () => {
      throw classifiedError('relays: HTTP 429 站点限流', 'rate-limited', 429);
    },
    async () => {
      const r = await querySiteBalance(dir, s);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.source, 'manual');
      assert.equal(r.data.total, '3.02');
    },
  );
});
