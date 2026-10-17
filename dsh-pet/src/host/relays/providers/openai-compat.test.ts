/**
 * openai-compat 兜底适配器测试：billing 双端点（真站实测 F4 的形状）。
 * mock fetch 按 URL 路由，不碰网络；解析守卫与 new-api 的 billing 链路同源。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openaiCompatProvider } from './openai-compat.ts';
import { classifiedError } from './newapi.ts';

const RATE = 500_000;

/** 实测站原文形状（docs/10 §2.2 / §2.5） */
const SUBSCRIPTION_LIMITED = { object: 'billing_subscription', has_payment_method: true, hard_limit_usd: 100, soft_limit_usd: 100, access_until: 0 };
const SUBSCRIPTION_UNLIMITED = { object: 'billing_subscription', hard_limit_usd: 100000000, system_hard_limit_usd: 100000000, access_until: 0 };
const USAGE = { object: 'list', total_usage: 3458.2358 };

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
  baseUrl: 'https://generic.example.com',
  secret: 'sk-test',
  kind: 'api-key' as const,
  quotaPerUnit: RATE,
};

test('openai-compat：provider 形状 —— 只认 api-key，不假装有 health 探测', () => {
  assert.deepEqual(openaiCompatProvider.kinds, ['openai-compat']);
  assert.deepEqual(openaiCompatProvider.credentialKinds, ['api-key']);
  assert.equal(openaiCompatProvider.health, undefined, '通用站不一定有 /api/status，不假装');
});

test('openai-compat：非无限订阅 —— 剩余 = hard_limit_usd − total_usage/100（F4 口径）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/dashboard/billing/subscription': () => jsonRes(SUBSCRIPTION_LIMITED),
    '/v1/dashboard/billing/usage': () => jsonRes(USAGE),
  });
  try {
    const r = await openaiCompatProvider.fetch(CTX);
    assert.equal(r.provider, 'relay:openai-compat');
    assert.equal(r.scope, 'token');
    assert.equal(r.unlimited, undefined);
    assert.equal(r.data.total, '65.42', '100 − 34.58');
    assert.equal(r.data.fullBalance, '100.00');
  } finally {
    globalThis.fetch = original;
  }
});

test('openai-compat：1e8 哨兵 → 无限额度，已用从 usage 拿（F2）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/dashboard/billing/subscription': () => jsonRes(SUBSCRIPTION_UNLIMITED),
    '/v1/dashboard/billing/usage': () => jsonRes(USAGE),
  });
  try {
    const r = await openaiCompatProvider.fetch(CTX);
    assert.equal(r.unlimited, true);
    assert.equal(r.spent, '34.58');
    assert.equal(r.data.total, '34.58', '无限站的 total 是已用金额，不是余额');
  } finally {
    globalThis.fetch = original;
  }
});

test('openai-compat：429 → rate-limited 分类（不重试）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/dashboard/billing/subscription': () => new Response('slow', { status: 429 }),
    '/v1/dashboard/billing/usage': () => jsonRes(USAGE),
  });
  try {
    await assert.rejects(
      () => openaiCompatProvider.fetch(CTX),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'rate-limited');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('openai-compat：usage 端点缺失 → 失败上抛（绝不伪造 0 余额）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/dashboard/billing/subscription': () => jsonRes(SUBSCRIPTION_LIMITED),
    '/v1/dashboard/billing/usage': () => new Response('nope', { status: 404 }),
  });
  try {
    await assert.rejects(() => openaiCompatProvider.fetch(CTX), /HTTP 404/);
  } finally {
    globalThis.fetch = original;
  }
});

test('openai-compat：剩余为负 → 抛错不当余额（守卫同 new-api）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/dashboard/billing/subscription': () => jsonRes({ object: 'billing_subscription', hard_limit_usd: 10 }),
    '/v1/dashboard/billing/usage': () => jsonRes({ object: 'list', total_usage: 5000 }),
  });
  try {
    await assert.rejects(() => openaiCompatProvider.fetch(CTX), /剩余为负/);
  } finally {
    globalThis.fetch = original;
  }
});

test('classifiedError 分类可读（与 new-api 同一出口）', () => {
  const e = classifiedError('x', 'blocked', 403);
  assert.equal((e as { code?: string }).code, 'blocked');
  assert.equal((e as { status?: number }).status, 403);
});
