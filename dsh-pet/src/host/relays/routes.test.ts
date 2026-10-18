/**
 * 中转站路由层纯逻辑测试：路径解析 / 入参校验 / 脱敏自检。
 *
 * 全部无 GUI、无网络、无磁盘副作用（脱敏自检只对内存里的字符串做断言）。
 * 与 ./index.test.ts、./store.test.ts 同风格：node:test + 临时目录注入。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  aggregateModelMatrix,
  assertNoSecret,
  collectSecrets,
  normalizeManualBalance,
  parseCredential,
  parseDetectInput,
  parseFocusInput,
  parseRelayRoute,
  relayError,
  relayFail,
} from './routes.ts';
import { loadSites, putCredential, upsertSite } from './store.ts';
import type { RelayModelCache } from './types.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'relay-routes-'));
}

// ---------- 路径解析 ----------

test('parseRelayRoute：六种形状各自归位', () => {
  assert.deepEqual(parseRelayRoute('relays'), { action: 'collection' });
  assert.deepEqual(parseRelayRoute('relays/abc-123'), { action: 'item', id: 'abc-123' });
  assert.deepEqual(parseRelayRoute('relays/abc/refresh'), { action: 'refresh', id: 'abc' });
  assert.deepEqual(parseRelayRoute('relays/refresh-all'), { action: 'refresh-all' });
  assert.deepEqual(parseRelayRoute('relays/abc/health'), { action: 'health', id: 'abc' });
  assert.deepEqual(parseRelayRoute('relays/abc/manual-balance'), { action: 'manual-balance', id: 'abc' });
});

test('parseRelayRoute：T03 三端点 + 站点级 models 各自归位', () => {
  assert.deepEqual(parseRelayRoute('relays/detect'), { action: 'detect' });
  assert.deepEqual(parseRelayRoute('relays/models'), { action: 'models' });
  assert.deepEqual(parseRelayRoute('relays/focus'), { action: 'focus' });
  assert.deepEqual(parseRelayRoute('relays/abc/models'), { action: 'site-models', id: 'abc' });
});

test('parseRelayRoute：多段 / 空 id / 未知子动作 → unknown（不猜意图）', () => {
  assert.equal(parseRelayRoute('relays/a/b/c').action, 'unknown');
  assert.equal(parseRelayRoute('relays/').action, 'unknown');
  assert.equal(parseRelayRoute('relays/abc/bogus').action, 'unknown');
  assert.equal(parseRelayRoute('relay').action, 'unknown');
  assert.equal(parseRelayRoute('relaysx').action, 'unknown');
});

test('parseRelayRoute：id 段允许中文与常见标识符字符', () => {
  // id 由服务端 randomUUID() 生成，但路径解析不该把合法字符判死
  assert.deepEqual(parseRelayRoute('relays/%E4%B8%AD%E6%96%87'), { action: 'item', id: '%E4%B8%AD%E6%96%87' });
  assert.deepEqual(parseRelayRoute('relays/a.b-c_d~1'), { action: 'item', id: 'a.b-c_d~1' });
});

// ---------- 错误口径 ----------

test('relayFail / relayError 的形状与上游既有分支一致', () => {
  assert.deepEqual(relayFail('not-found', 'x'), { ok: false, reason: 'not-found', message: 'x' });
  assert.deepEqual(relayError('x'), { error: 'x' });
});

// ---------- 手工余额 ----------

test('normalizeManualBalance：空 amount = 清除（撤销降级路径）', () => {
  assert.deepEqual(normalizeManualBalance({ amount: '', currency: 'USD' }), { ok: true, clear: true });
  assert.deepEqual(normalizeManualBalance({}), { ok: true, clear: true });
  assert.deepEqual(normalizeManualBalance(null), { ok: true, clear: true });
});

test('normalizeManualBalance：合法金额原样收下，币种统一大写', () => {
  assert.deepEqual(normalizeManualBalance({ amount: ' 3.02 ', currency: ' usd ' }), {
    ok: true, clear: false, amount: '3.02', currency: 'USD',
  });
  assert.deepEqual(normalizeManualBalance({ amount: '0', currency: 'CNY' }), {
    ok: true, clear: false, amount: '0', currency: 'CNY',
  });
});

test('normalizeManualBalance：非法金额 / 缺币种一律拒绝（不猜）', () => {
  for (const bad of [{ amount: 'abc' }, { amount: '-1' }, { amount: '1.234' }, { amount: '3.02' }]) {
    const r = normalizeManualBalance(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应被拒绝');
  }
});

// ---------- 凭证入参 ----------

test('parseCredential：manual 允许不带 secret（显式声明「无凭证、手工填」）', () => {
  assert.deepEqual(parseCredential({ kind: 'manual' }), { ok: true, value: { kind: 'manual', secret: '' } });
});

test('parseCredential：access-token 带 secret，附加头原样收下', () => {
  const r = parseCredential({ kind: 'access-token', secret: 'tok-123', extraHeaders: { 'New-Api-User': '42' } });
  assert.deepEqual(r, { ok: true, value: { kind: 'access-token', secret: 'tok-123', extraHeaders: { 'New-Api-User': '42' } } });
});

test('parseCredential：未知类型 / 空 secret / 坏附加头一律拒绝', () => {
  assert.equal(parseCredential({ kind: 'bogus', secret: 'x' }).ok, false);
  assert.equal(parseCredential({ kind: 'api-key', secret: '   ' }).ok, false);
  assert.equal(parseCredential({ kind: 'api-key' }).ok, false);
  assert.equal(parseCredential({}).ok, false);
  assert.equal(parseCredential({ kind: 'api-key', secret: 'sk-1', extraHeaders: [] }).ok, false);
  assert.equal(parseCredential({ kind: 'api-key', secret: 'sk-1', extraHeaders: { a: '' } }).ok, false);
  assert.equal(parseCredential({ kind: 'api-key', secret: 'sk-1', extraHeaders: { a: 5 } }).ok, false);
});

test('parseCredential：没有附加头时结果里不带 extraHeaders 键', () => {
  const r = parseCredential({ kind: 'api-key', secret: 'sk-abcdef' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal('extraHeaders' in r.value, false);
});

// ---------- 脱敏自检 ----------

test('collectSecrets：secret 与附加头的值都算敏感值', () => {
  const dir = tmp();
  try {
    const site = upsertSite(dir, { name: 'S', url: 'https://s.example.com', kind: 'new-api' });
    putCredential(dir, site.id, { kind: 'access-token', secret: 'sk-abcdef123456', extraHeaders: { 'New-Api-User': 'uid-98765' } });
    const secrets = collectSecrets({ [site.id]: { kind: 'access-token', secret: 'sk-abcdef123456', extraHeaders: { 'New-Api-User': 'uid-98765' } } });
    assert.ok(secrets.includes('sk-abcdef123456'));
    assert.ok(secrets.includes('uid-98765'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectSecrets：空目录 / 空 secret 不产生基线', () => {
  assert.deepEqual(collectSecrets({}), []);
  assert.deepEqual(collectSecrets(undefined), []);
  assert.deepEqual(collectSecrets({ a: { kind: 'manual', secret: '' } }), []);
});

test('assertNoSecret：掩码可以通过，明文一律抛错（安全底线）', () => {
  const secret = 'sk-abcdef123456';
  const masked = 'sk-a****3456';
  // 掩码 + 站点元数据：不含完整凭证 → 放行
  assert.doesNotThrow(() => assertNoSecret({ ok: true, sites: [{ id: 'x', credential: { masked } }] }, [secret]));
  // 不小心把凭证原值带进响应体 → 必须抛错，而不是返回
  assert.throws(() => assertNoSecret({ ok: true, site: { credential: { secret } } }, [secret]), /明文凭证/);
  // 字符串响应体同样受检
  assert.throws(() => assertNoSecret('token=' + secret, [secret]), /明文凭证/);
});

test('assertNoSecret：没有基线（无凭证）时直接放行；短于 6 位的值不算基线', () => {
  assert.doesNotThrow(() => assertNoSecret({ a: 1 }, []));
  // containsSecret 跳过长度 < 6 的值：避免把 "1234" 这类普通数字当成凭证误伤
  assert.doesNotThrow(() => assertNoSecret({ a: 'x1234y' }, ['1234']));
});

// ---------- detect / focus 入参（T03） ----------

test('parseDetectInput：只有 URL → 免凭证探测（/api/status 就够识别）', () => {
  assert.deepEqual(parseDetectInput({ url: 'https://a.com' }), { ok: true, value: { url: 'https://a.com' } });
  assert.deepEqual(parseDetectInput({ url: '  https://a.com  ' }), { ok: true, value: { url: 'https://a.com' } });
});

test('parseDetectInput：带凭证 → 收下用于本次探测（manual 视为无凭证）', () => {
  const r = parseDetectInput({ url: 'https://a.com', credential: { kind: 'api-key', secret: 'sk-abcdef' } });
  assert.deepEqual(r, { ok: true, value: { url: 'https://a.com', credential: { kind: 'api-key', secret: 'sk-abcdef' } } });
  assert.deepEqual(parseDetectInput({ url: 'https://a.com', credential: { kind: 'manual' } }), { ok: true, value: { url: 'https://a.com' } });
});

test('parseDetectInput：缺 URL / 坏凭证一律拒绝（不猜）', () => {
  assert.equal(parseDetectInput({}).ok, false);
  assert.equal(parseDetectInput({ url: '' }).ok, false);
  assert.equal(parseDetectInput({ url: 'https://a.com', credential: { kind: 'bogus', secret: 'x' } }).ok, false);
  assert.equal(parseDetectInput(null).ok, false);
});

test('parseFocusInput：siteId 原样收下；空 / 缺失 = 清除焦点', () => {
  assert.deepEqual(parseFocusInput({ siteId: 'abc' }), { ok: true, siteId: 'abc' });
  assert.deepEqual(parseFocusInput({ siteId: '' }), { ok: true, siteId: null });
  assert.deepEqual(parseFocusInput({}), { ok: true, siteId: null });
  assert.deepEqual(parseFocusInput(null), { ok: true, siteId: null });
});

// ---------- 模型矩阵聚合（T03：GET /relays/models 只读缓存） ----------

test('aggregateModelMatrix：有/无/未知三态分明，倍率价格随行带上', () => {
  const dir = tmp();
  try {
    const a = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const b = upsertSite(dir, { name: 'B站', url: 'https://b.example.com', kind: 'new-api' });
    const c = upsertSite(dir, { name: 'C站', url: 'https://c.example.com', kind: 'new-api' });
    const cache: RelayModelCache = {
      [a.id]: { models: [{ id: 'gpt-4o', ratio: 0.5 }, { id: 'claude-3' }], fetchedAt: '2026-10-17T00:00:00.000Z' },
      [b.id]: { models: [{ id: 'gpt-4o', ratio: 0.25, price: 12 }], fetchedAt: '2026-10-17T00:00:00.000Z' },
      // C 站从未抓过 → 未知
    };
    const { rows, unknownSiteCount } = aggregateModelMatrix(loadSites(dir), cache);
    assert.equal(unknownSiteCount, 1, 'C 站未抓取');

    const gpt = rows.find((r) => r.id === 'gpt-4o');
    assert.ok(gpt);
    assert.deepEqual(gpt.sites, [
      { siteId: a.id, name: 'A站', available: true, ratio: 0.5 },
      { siteId: b.id, name: 'B站', available: true, ratio: 0.25, price: 12 },
      { siteId: c.id, name: 'C站', available: null },
    ]);
    const claude = rows.find((r) => r.id === 'claude-3');
    assert.ok(claude);
    assert.deepEqual(claude.sites, [
      { siteId: a.id, name: 'A站', available: true },
      { siteId: b.id, name: 'B站', available: false }, // 抓过且没有 → 明确不可用（P0-15）
      { siteId: c.id, name: 'C站', available: null }, // 没抓过 → 未知，绝不猜成没有
    ]);
    // 行按 id 排序，结果稳定
    assert.deepEqual(rows.map((r) => r.id), ['claude-3', 'gpt-4o']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateModelMatrix：空缓存 → 0 行 + 全部站点未知（不演成「都没有」）', () => {
  const dir = tmp();
  try {
    upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const { rows, unknownSiteCount } = aggregateModelMatrix(loadSites(dir), {});
    assert.deepEqual(rows, []);
    assert.equal(unknownSiteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateModelMatrix：三站各有不同模型 → 行数 = 并集大小', () => {
  const dir = tmp();
  try {
    const a = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const b = upsertSite(dir, { name: 'B站', url: 'https://b.example.com', kind: 'new-api' });
    const c = upsertSite(dir, { name: 'C站', url: 'https://c.example.com', kind: 'new-api' });
    const at = '2026-10-17T00:00:00.000Z';
    const cache: RelayModelCache = {
      [a.id]: { models: [{ id: 'm1' }, { id: 'm2' }], fetchedAt: at },
      [b.id]: { models: [{ id: 'm2' }, { id: 'm3' }], fetchedAt: at },
      [c.id]: { models: [{ id: 'm3' }, { id: 'm4' }], fetchedAt: at },
    };
    const { rows, unknownSiteCount } = aggregateModelMatrix(loadSites(dir), cache);
    // 并集 {m1,m2,m3,m4} = 4；重复的 m2/m3 不许多出行
    assert.deepEqual(rows.map((r) => r.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(unknownSiteCount, 0, '三站都抓过 → 没有未知站');
    // 每一行都必须覆盖全部站点（不缺列）
    for (const row of rows) assert.equal(row.sites.length, 3, row.id + ' 应覆盖 3 个站点');
    // 回归（本次抓到的真 bug）：m3/m4 是 B/C 站才引入的行，旧实现**不给 A 站补格子**，
    // 那个格子会缺失，而客户端对缺失格子的兜底是「未知」——真实答案是「抓过、没有」。
    // 语义正好反，所以这里逐格钉死。
    const m3 = rows.find((r) => r.id === 'm3');
    assert.ok(m3);
    assert.deepEqual(m3.sites.map((c) => [c.name, c.available]), [
      ['A站', false],
      ['B站', true],
      ['C站', true],
    ]);
    const m4 = rows.find((r) => r.id === 'm4');
    assert.ok(m4);
    assert.deepEqual(m4.sites.map((c) => [c.name, c.available]), [
      ['A站', false],
      ['B站', false],
      ['C站', true],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateModelMatrix：顺序稳定 —— 同一输入两次结果逐字节一致', () => {
  const dir = tmp();
  try {
    const a = upsertSite(dir, { name: '乙站', url: 'https://b.example.com', kind: 'new-api' });
    const b = upsertSite(dir, { name: '甲站', url: 'https://a.example.com', kind: 'new-api' });
    const at = '2026-10-17T00:00:00.000Z';
    const cache: RelayModelCache = {
      [a.id]: { models: [{ id: 'z-model' }, { id: 'a-model' }], fetchedAt: at },
      [b.id]: { models: [{ id: 'm-model' }], fetchedAt: at },
    };
    const first = aggregateModelMatrix(loadSites(dir), cache);
    const second = aggregateModelMatrix(loadSites(dir), cache);
    assert.equal(JSON.stringify(first), JSON.stringify(second), '两次聚合必须完全一致');
    // 行按模型 id、格子按站点名：都升序且稳定
    assert.deepEqual(first.rows.map((r) => r.id), ['a-model', 'm-model', 'z-model']);
    assert.deepEqual(first.rows[0].sites.map((c) => c.name), ['甲站', '乙站']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateModelMatrix：unknownSiteCount 只数「从未抓过」的站，混合场景正确', () => {
  const dir = tmp();
  try {
    const a = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    upsertSite(dir, { name: 'B站', url: 'https://b.example.com', kind: 'new-api' });
    upsertSite(dir, { name: 'C站', url: 'https://c.example.com', kind: 'new-api' });
    upsertSite(dir, { name: 'D站', url: 'https://d.example.com', kind: 'new-api', enabled: false });
    const at = '2026-10-17T00:00:00.000Z';
    const cache: RelayModelCache = {
      [a.id]: { models: [{ id: 'm1' }], fetchedAt: at },
      // B/C 未抓过；D 停用但同样未抓过 —— 计数口径是「没抓过」，与启用无关
    };
    const { unknownSiteCount } = aggregateModelMatrix(loadSites(dir), cache);
    assert.equal(unknownSiteCount, 3, 'B/C/D 三站未抓过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
