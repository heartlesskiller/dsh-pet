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
  assertNoSecret,
  collectSecrets,
  normalizeManualBalance,
  parseCredential,
  parseRelayRoute,
  relayError,
  relayFail,
} from './routes.ts';
import { putCredential, upsertSite } from './store.ts';

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
