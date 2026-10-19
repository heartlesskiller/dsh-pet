/**
 * deepseek 适配器测试：`GET <base>/user/balance`。
 * 夹具 = 2026-10-19 用户提供真实 key 实测的响应形状（CNY 4.88 = granted 3.54 + topped_up 1.34）。
 * mock fetch 按 URL 路由，不碰网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deepseekProvider, parseBalance } from './deepseek.ts';

/** 真 key 实测原文（2026-10-19） */
const BALANCE_REAL = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '4.88', granted_balance: '3.54', topped_up_balance: '1.34' }],
};

function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, make] of Object.entries(routes)) {
      if (url.includes(pattern)) return make();
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CTX = {
  siteId: 's1',
  baseUrl: 'https://api.deepseek.com',
  secret: 'sk-test',
  kind: 'api-key' as const,
  quotaPerUnit: 500_000,
};

// ---------- parseBalance（纯函数） ----------

test('parseBalance：真 key 实测形状 → 三金额原样透传 + ¥20 基准 + 峰谷档位', () => {
  const out = parseBalance(BALANCE_REAL);
  assert.equal(out.currency, 'CNY');
  assert.equal(out.total, '4.88');
  assert.equal(out.granted, '3.54', '官方给的赠送额原样透传，不重算');
  assert.equal(out.toppedUp, '1.34');
  assert.equal(out.fullBalance, '20', '档位基准复用上游 deepseek-common 的 ¥20');
  assert.ok(out.tier === 'peak' || out.tier === 'idle', '峰谷档位随数据带出');
});

test('parseBalance：granted/toppedUp 缺失 → 回落 granted=total / toppedUp=0（不硬拆）', () => {
  const out = parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10' }] });
  assert.equal(out.total, '10.00');
  assert.equal(out.granted, '10.00');
  assert.equal(out.toppedUp, '0.00');
});

test('parseBalance：四道守卫全部触发（不猜、不伪造 0）', () => {
  // ① is_available 非 true
  assert.throws(() => parseBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), /账户不可用/);
  // ② balance_infos 缺失 / 空数组
  assert.throws(() => parseBalance({ is_available: true }), /无 balance_infos/);
  assert.throws(() => parseBalance({ is_available: true, balance_infos: [] }), /无 balance_infos/);
  // ③ 多币种 → 明确失败（MoneyBalance 单币种契约）
  assert.throws(
    () => parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }, { currency: 'USD', total_balance: '2' }] }),
    /多币种（CNY \/ USD）/,
  );
  // ④ total_balance 缺失 / 非数字
  assert.throws(() => parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY' }] }), /total_balance 缺失/);
  assert.throws(() => parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }), /total_balance 缺失/);
  // 非对象入参同样炸，不静默（null → is_available 缺失，先撞守卫①）
  assert.throws(() => parseBalance(null), /账户不可用/);
  assert.throws(() => parseBalance(undefined), /账户不可用/);
});

test('parseBalance：数字型金额与 0 元余额都是合法值', () => {
  const out = parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 0 }] });
  assert.equal(out.total, '0.00', '0 元是真实读数，不是缺失');
});

// ---------- provider.fetch ----------

test('fetch：200 + 实测形状 → money/account 成功结果', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/user/balance': () => jsonRes(BALANCE_REAL) });
  try {
    const r = await deepseekProvider.fetch(CTX);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.provider, 'relay:deepseek');
    assert.equal(r.shape, 'money');
    assert.equal(r.scope, 'account');
    assert.equal(r.data.total, '4.88');
    assert.equal(r.data.currency, 'CNY');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetch：401/403 → 带分类上抛（编排层归 auth 类）；429 → rate-limited', async () => {
  const original = globalThis.fetch;
  for (const status of [401, 403]) {
    globalThis.fetch = mockFetch({ '/user/balance': () => jsonRes({ error: 'nope' }, status) });
    try {
      await assert.rejects(() => deepseekProvider.fetch(CTX), (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'http');
        assert.equal((e as { status?: number }).status, status);
        return true;
      });
    } finally {
      globalThis.fetch = original;
    }
  }
  globalThis.fetch = mockFetch({ '/user/balance': () => jsonRes({ error: 'slow down' }, 429) });
  try {
    await assert.rejects(() => deepseekProvider.fetch(CTX), (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'rate-limited');
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('fetch：is_available=false / 坏 JSON → 普通错误上抛（绝不伪造 0 余额）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/user/balance': () => jsonRes({ is_available: false, balance_infos: [] }) });
  try {
    await assert.rejects(() => deepseekProvider.fetch(CTX), /账户不可用/);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = mockFetch({ '/user/balance': () => new Response('<html>nope', { status: 200 }) });
  try {
    await assert.rejects(() => deepseekProvider.fetch(CTX));
  } finally {
    globalThis.fetch = original;
  }
});

test('fetch：base URL 归一化（带 /v1 也能打对端点）', async () => {
  const original = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = mockFetch({
    '/user/balance': () => {
      hits.push('balance');
      return jsonRes(BALANCE_REAL);
    },
  });
  try {
    const r = await deepseekProvider.fetch({ ...CTX, baseUrl: 'https://api.deepseek.com/v1' });
    assert.equal(r.ok, true);
    assert.deepEqual(hits, ['balance']);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- provider.health ----------

test('health：/models 200 → online + 端点 + 延迟', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/models': () => jsonRes({ object: 'list', data: [] }) });
  try {
    const h = await deepseekProvider.health!(CTX);
    assert.equal(h.health, 'online');
    assert.equal(h.endpoint, 'https://api.deepseek.com/models');
    assert.equal(h.status, 200);
    assert.ok(h.latencyMs !== undefined && h.latencyMs >= 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('health：401 → auth 类上抛（key 无效能直接被证明）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/models': () => jsonRes({ error: 'bad key' }, 401) });
  try {
    await assert.rejects(() => deepseekProvider.health!(CTX), (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'http');
      assert.equal((e as { status?: number }).status, 401);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
