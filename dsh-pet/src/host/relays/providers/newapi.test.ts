import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RELAY_PROVIDER_PREFIX,
  UNLIMITED_SENTINEL_USD,
  classifiedError,
  fetchSiteModels,
  isBlockedOrLimited,
  newApiProvider,
  normalizeBaseUrl,
  parseModels,
  parsePricing,
  parseStatus,
  parseSubscription,
  parseTokenUsage,
  parseUsage,
  parseUserSelf,
  probeModels,
  probeStatus,
} from './newapi.ts';

const RATE = 500_000;

// ---------- 真站响应原文（docs/10-real-site-verification.md 留档，不含任何密钥） ----------

/** /api/usage/token/ —— 实测站 unlimited 令牌原文（F1/F2/F3） */
const TOKEN_USAGE_UNLIMITED = {
  code: true,
  data: {
    expires_at: 0,
    model_limits: {},
    model_limits_enabled: false,
    name: 'code',
    object: 'token_usage',
    total_available: -17291179, // F3：unlimited 站的产物，负数
    total_granted: 0,
    total_used: 17291179,
    unlimited_quota: true,
  },
  message: 'ok',
};

/** /dashboard/billing/subscription —— 实测站原文（F2：1e8 哨兵） */
const SUBSCRIPTION_UNLIMITED = {
  object: 'billing_subscription',
  has_payment_method: true,
  soft_limit_usd: 100000000,
  hard_limit_usd: 100000000,
  system_hard_limit_usd: 100000000,
  access_until: 0,
};

/** /v1/dashboard/billing/usage —— 实测站原文（F4：单位是分） */
const USAGE_REAL = { object: 'list', total_usage: 3458.2358 };

/** /api/user/self 用 API Key 打的实测原文（F5：HTTP 200 + success:false） */
const USER_SELF_APIKEY_FAIL = { message: '无权进行此操作，access token 无效', success: false };

/** /api/status —— 实测站原文（F6/F8：system_name 被改成 st-api、version 空串、模块字段在） */
const STATUS_REAL = {
  success: true,
  data: {
    system_name: 'st-api',
    version: '',
    quota_per_unit: 500000,
    display_in_currency: true,
    usd_exchange_rate: 7.3,
    price: 7.3,
    HeaderNavModules: '["chat"]',
    SidebarModulesAdmin: '[{"id":"chat"}]',
  },
};

/** /v1/models —— 实测站形状（supported_endpoint_types 是 new-api 强特征） */
const MODELS_REAL = {
  data: [
    { id: 'gpt-4o', supported_endpoint_types: ['openai'] },
    { id: 'claude-sonnet-4.5', supported_endpoint_types: ['openai', 'anthropic'] },
  ],
};

// ---------- parseUserSelf（账户级，仅 AccessToken 有效） ----------

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
    scope: 'account',
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

test('parseUserSelf：F5 —— HTTP 200 + success:false 必须判失败（实测站 API Key 原文）', () => {
  // 真站实测：API Key 打 /api/user/self 返 HTTP 200 + 这个 body。
  // 只看 HTTP 状态会把它当成功 —— 必须读 body。
  assert.throws(() => parseUserSelf(USER_SELF_APIKEY_FAIL, { quotaPerUnit: RATE }), /access token 无效/);
});

test('parseUserSelf：失败一律 throw，绝不伪造 0 余额', () => {
  assert.throws(() => parseUserSelf({ success: false, message: '令牌已过期' }, { quotaPerUnit: RATE }), /令牌已过期/);
  assert.throws(() => parseUserSelf({ success: true, data: {} }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf({ success: true, data: { quota: -1 } }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf({ success: true, data: { quota: 'x' } }, { quotaPerUnit: RATE }), /quota/);
  assert.throws(() => parseUserSelf(null, { quotaPerUnit: RATE }));
  assert.throws(() => parseUserSelf({ success: true, data: { quota: 1 } }, { quotaPerUnit: 0 }), /quotaPerUnit/);
});

// ---------- parseTokenUsage（令牌级，API-Key 场景第一优先） ----------

test('parseTokenUsage：F1/F2 —— 实测站 unlimited 原文 → 无限额度 + 已用金额（不是余额）', () => {
  const r = parseTokenUsage(TOKEN_USAGE_UNLIMITED, { quotaPerUnit: RATE });
  assert.equal(r.scope, 'token');
  assert.equal(r.unlimited, true);
  assert.equal(r.spent, '34.58'); // 17291179 / 500000 = $34.582358
  // data.total 放已用金额（与 spent 同值），客户端渲染「无限额度 · 已用 $34.58」
  assert.equal(r.data.total, '34.58');
  assert.equal(r.data.granted, '34.58');
  assert.equal(r.data.toppedUp, '0.00');
  assert.ok(!('fullBalance' in r.data), '无限站无基准 → 不播六档动画');
});

test('parseTokenUsage：F3 —— total_available 为负绝不能当余额', () => {
  // 原文里 total_available = -17291179：若拿它当余额会显示 −$34.58
  const r = parseTokenUsage(TOKEN_USAGE_UNLIMITED, { quotaPerUnit: RATE });
  assert.ok(Number(r.data.total) > 0, '已用金额必须为正');
  // 非 unlimited + available 负 + granted−used 也推不出非负 → 炸，不伪造
  assert.throws(
    () =>
      parseTokenUsage(
        { code: true, data: { total_available: -100, total_granted: 0, total_used: 100, unlimited_quota: false } },
        { quotaPerUnit: RATE },
      ),
    /推不出非负剩余额度/,
  );
});

test('parseTokenUsage：非无限令牌 —— 余额取 total_available，fullBalance 取 total_granted', () => {
  const r = parseTokenUsage(
    { code: true, data: { total_available: 5000000, total_granted: 10000000, total_used: 5000000, unlimited_quota: false } },
    { quotaPerUnit: RATE },
  );
  assert.equal(r.unlimited, undefined, '非无限站不带 unlimited 键');
  assert.equal(r.data.total, '10.00'); // 5000000 / 500000
  assert.equal(r.data.fullBalance, '20.00'); // 10000000 / 500000 —— 档位基准
});

test('parseTokenUsage：非无限 + available 缺省 → 用 granted − used 兜底推剩余', () => {
  const r = parseTokenUsage(
    { code: true, data: { total_granted: 10000000, total_used: 7500000, unlimited_quota: false } },
    { quotaPerUnit: RATE },
  );
  assert.equal(r.data.total, '5.00'); // (10000000 − 7500000) / 500000
  assert.equal(r.data.fullBalance, '20.00');
});

test('parseTokenUsage：granted=0 非无限 → 不设 fullBalance（没基准就不播档位动画）', () => {
  const r = parseTokenUsage(
    { code: true, data: { total_available: 1000000, total_granted: 0, total_used: 0, unlimited_quota: false } },
    { quotaPerUnit: RATE },
  );
  assert.equal(r.data.total, '2.00');
  assert.ok(!('fullBalance' in r.data));
});

test('parseTokenUsage：code:false / success:false / 缺 total_used → throw', () => {
  assert.throws(() => parseTokenUsage({ code: false, message: '令牌不存在' }, { quotaPerUnit: RATE }), /令牌不存在/);
  assert.throws(() => parseTokenUsage({ success: false }, { quotaPerUnit: RATE }), /未知原因/);
  assert.throws(() => parseTokenUsage({ code: true, data: { total_granted: 1 } }, { quotaPerUnit: RATE }), /total_used/);
  assert.throws(() => parseTokenUsage(null, { quotaPerUnit: RATE }), /不是对象/);
  assert.throws(() => parseTokenUsage(TOKEN_USAGE_UNLIMITED, { quotaPerUnit: 0 }), /quotaPerUnit/);
});

// ---------- parseSubscription / parseUsage（billing 双端点，F4） ----------

test('parseSubscription：F2 —— 实测站 1e8 哨兵 → 无限额度', () => {
  const s = parseSubscription(SUBSCRIPTION_UNLIMITED);
  assert.equal(s.hardLimitUsd, 100000000);
  assert.equal(s.unlimited, true);
  assert.equal(UNLIMITED_SENTINEL_USD, 100_000_000);
});

test('parseSubscription：正常订阅上限 → 非无限', () => {
  const s = parseSubscription({ object: 'billing_subscription', hard_limit_usd: 50 });
  assert.equal(s.unlimited, false);
  assert.equal(s.hardLimitUsd, 50);
});

test('parseSubscription：缺 hard_limit_usd / 非对象 → throw', () => {
  assert.throws(() => parseSubscription({ object: 'billing_subscription' }), /hard_limit_usd/);
  assert.throws(() => parseSubscription(null), /不是对象/);
});

test('parseUsage：F4 —— 实测站 total_usage 单位是分（3458.2358 分 = $34.58）', () => {
  // 与 /api/usage/token/ 的 total_used/quota_per_unit 交叉验算相等（docs/10 §2.5）
  const u = parseUsage(USAGE_REAL);
  assert.equal(u.usedUsd, '34.58');
});

test('parseUsage：负值 / 非数字 / 非对象 → throw', () => {
  assert.throws(() => parseUsage({ total_usage: -1 }), /为负/);
  assert.throws(() => parseUsage({ total_usage: 'x' }), /total_usage/);
  assert.throws(() => parseUsage({}), /total_usage/);
  assert.throws(() => parseUsage(null), /不是对象/);
});

// ---------- parseStatus（识别信号 + 换算率探测，F6/F8） ----------

test('parseStatus：F6/F8 —— 实测站原文 → 探到换算率 + new-api 特征 + 货币计价', () => {
  const s = parseStatus(STATUS_REAL);
  assert.equal(s.quotaPerUnit, 500_000);
  assert.equal(s.displayInCurrency, true);
  assert.equal(s.looksLikeNewApi, true);
  assert.equal(s.systemName, 'st-api'); // 被站长改过 —— 只记录，不参与判定
  assert.ok(s.evidence.length > 0 && /HeaderNavModules/.test(s.evidence[0]));
});

test('parseStatus：system_name / version 不可用于识别（F6：无模块字段即无证据）', () => {
  const s = parseStatus({ success: true, data: { system_name: 'New API', version: 'v0.9.0' } });
  assert.equal(s.looksLikeNewApi, false, '只有 system_name/version 不算 new-api 证据');
  assert.equal(s.evidence.length, 0);
});

test('parseStatus：quota_per_unit 探不到 → 键不存在（调用方标 rateUnconfirmed）', () => {
  const s = parseStatus({ success: true, data: { system_name: 'x' } });
  assert.ok(!('quotaPerUnit' in s));
});

test('parseStatus：兼容没有 data 包裹、平铺返回', () => {
  const s = parseStatus({ quota_per_unit: 250000, display_in_currency: false });
  assert.equal(s.quotaPerUnit, 250_000);
  assert.equal(s.displayInCurrency, false);
});

// ---------- parseModels ----------

test('parseModels：三种 OpenAI 兼容形状', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'gpt-4o' }, { id: 'claude-3' }] }), ['claude-3', 'gpt-4o']);
  assert.deepEqual(parseModels({ data: { models: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(parseModels(['x', 'y']), ['x', 'y']);
  // 实测站形状：元素带 supported_endpoint_types，id 照取
  assert.deepEqual(parseModels(MODELS_REAL), ['claude-sonnet-4.5', 'gpt-4o']);
});

test('parseModels：去重 + 排序，保证同站点多次拉取结果稳定', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
});

test('parseModels：空列表 / 找不到数组 → throw（不返回空列表冒充成功）', () => {
  assert.throws(() => parseModels({ data: [] }), /0 个模型/);
  assert.throws(() => parseModels({}), /找不到模型数组/);
  assert.throws(() => parseModels(null), /找不到模型数组/);
  assert.throws(() => parseModels({ data: [{ noId: 1 }] }), /0 个模型/);
});

// ---------- 错误分类 ----------

test('classifiedError / isBlockedOrLimited：分类 code 可被编排层读取', () => {
  const blocked = classifiedError('x', 'blocked', 403);
  assert.equal((blocked as { code?: string }).code, 'blocked');
  assert.equal((blocked as { status?: number }).status, 403);
  const limited = classifiedError('x', 'rate-limited', 429);
  const http = classifiedError('x', 'http', 500);
  const parse = classifiedError('x', 'parse');
  assert.ok(isBlockedOrLimited(blocked));
  assert.ok(isBlockedOrLimited(limited));
  assert.ok(!isBlockedOrLimited(http));
  assert.ok(!isBlockedOrLimited(parse));
  assert.ok(!isBlockedOrLimited(new Error('plain')));
});

// ---------- normalizeBaseUrl / authHeaders 逃生口 ----------

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

// ---------- provider.fetch 三级链路（mock fetch，按 URL 路由） ----------

/** 按 URL 路由的假 fetch；未注册的路径一律 404（测试里就是「失败」） */
function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, make] of Object.entries(routes)) {
      if (url.includes(pattern)) return make();
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** 在假 fetch 下跑一次 provider.fetch */
async function fetchWith(routes: Record<string, () => Response>, ctx: { kind: 'api-key' | 'access-token'; secret?: string }) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(routes);
  try {
    return await newApiProvider.fetch({
      siteId: 's1',
      baseUrl: 'https://st.example.com',
      secret: ctx.secret ?? 'sk-test',
      kind: ctx.kind,
      quotaPerUnit: RATE,
    });
  } finally {
    globalThis.fetch = original;
  }
}

test('fetch：api-key 链路 —— /api/usage/token/ 第一优先（F1），成功就不碰 user/self', async () => {
  let userSelfHit = 0;
  const r = await fetchWith(
    {
      '/api/usage/token/': () => jsonRes(TOKEN_USAGE_UNLIMITED),
      '/api/user/self': () => {
        userSelfHit += 1;
        return jsonRes(USER_SELF_APIKEY_FAIL);
      },
    },
    { kind: 'api-key' },
  );
  assert.equal(r.unlimited, true);
  assert.equal(r.spent, '34.58');
  assert.equal(userSelfHit, 0, 'API Key 场景不该打 /api/user/self（F5：必失败）');
});

test('fetch：api-key 链路 —— usage/token 失败 → 降级 billing 双端点（F4）', async () => {
  const r = await fetchWith(
    {
      '/api/usage/token/': () => new Response('nope', { status: 500, statusText: 'Internal Server Error' }),
      '/dashboard/billing/subscription': () => jsonRes(SUBSCRIPTION_UNLIMITED),
      '/v1/dashboard/billing/usage': () => jsonRes(USAGE_REAL),
    },
    { kind: 'api-key' },
  );
  assert.equal(r.unlimited, true);
  assert.equal(r.spent, '34.58', '哨兵站的已用从 billing/usage 拿（docs/10 §3.2-1）');
});

test('fetch：api-key 链路 —— billing 非无限公式（待验证 V2，但链路要通）', async () => {
  const r = await fetchWith(
    {
      '/api/usage/token/': () => new Response('nope', { status: 500 }),
      '/dashboard/billing/subscription': () => jsonRes({ object: 'billing_subscription', hard_limit_usd: 100 }),
      '/v1/dashboard/billing/usage': () => jsonRes({ object: 'list', total_usage: 3458.2358 }),
    },
    { kind: 'api-key' },
  );
  assert.equal(r.unlimited, undefined);
  assert.equal(r.data.total, '65.42', '剩余 = hard_limit_usd − total_usage/100 = 100 − 34.58');
  assert.equal(r.data.fullBalance, '100.00');
});

test('fetch：access-token 链路 —— /api/user/self 账户级优先', async () => {
  let usageHit = 0;
  const r = await fetchWith(
    {
      '/api/user/self': () => jsonRes({ success: true, data: { quota: 21090000, used_quota: 10000 } }),
      '/api/usage/token/': () => {
        usageHit += 1;
        return jsonRes(TOKEN_USAGE_UNLIMITED);
      },
    },
    { kind: 'access-token' },
  );
  assert.equal(r.scope, 'account');
  assert.equal(r.data.total, '42.18');
  assert.equal(usageHit, 0, '账户级成功就不降级');
});

test('fetch：access-token 链路 —— user/self 返回 success:false（F5）→ 降级 usage/token', async () => {
  const r = await fetchWith(
    {
      '/api/user/self': () => jsonRes(USER_SELF_APIKEY_FAIL),
      '/api/usage/token/': () => jsonRes(TOKEN_USAGE_UNLIMITED),
    },
    { kind: 'access-token' },
  );
  assert.equal(r.scope, 'token');
  assert.equal(r.spent, '34.58');
});

test('fetch：整链失败 → 上抛最后一个错误（编排层降级到手工，绝不伪造 0）', async () => {
  await assert.rejects(
    () =>
      fetchWith(
        {
          '/api/user/self': () => new Response('nope', { status: 500 }),
          '/api/usage/token/': () => new Response('nope', { status: 500 }),
          '/dashboard/billing/subscription': () => new Response('nope', { status: 500 }),
          '/v1/dashboard/billing/usage': () => new Response('nope', { status: 500 }),
        },
        { kind: 'access-token' },
      ),
    /HTTP 500/,
  );
});

test('fetch：429 → rate-limited 分类，且不重试别的端点', async () => {
  let billingHit = 0;
  await assert.rejects(
    () =>
      fetchWith(
        {
          '/api/usage/token/': () => new Response('slow down', { status: 429, statusText: 'Too Many Requests' }),
          '/dashboard/billing/subscription': () => {
            billingHit += 1;
            return jsonRes(SUBSCRIPTION_UNLIMITED);
          },
        },
        { kind: 'api-key' },
      ),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'rate-limited');
      assert.match((e as Error).message, /429/);
      return true;
    },
  );
  assert.equal(billingHit, 0, '被限流还去打别的端点 = 加重对方负担');
});

test('fetch：403 + server:cloudflare → blocked 分类（F7/修订 #23 判定表）', async () => {
  await assert.rejects(
    () =>
      fetchWith(
        {
          '/api/usage/token/': () => new Response('forbidden', { status: 403, headers: { server: 'cloudflare' } }),
        },
        { kind: 'api-key' },
      ),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'blocked');
      return true;
    },
  );
});

test('fetch：F7 —— 200 + server:cloudflare 但不判拦截（无 cf-mitigated 正常出数）', async () => {
  const r = await fetchWith(
    {
      '/api/usage/token/': () => jsonRes(TOKEN_USAGE_UNLIMITED, 200, { server: 'cloudflare' }),
    },
    { kind: 'api-key' },
  );
  assert.equal(r.spent, '34.58', '见到 server: cloudflare 不能神经过敏判 blocked');
});

test('fetch：200 + CF 挑战页 HTML → blocked 分类（按内容特征判）', async () => {
  await assert.rejects(
    () =>
      fetchWith(
        {
          '/api/usage/token/': () =>
            new Response('<html><title>Just a moment...</title><challenge-platform>cf</challenge-platform></html>', {
              status: 200,
            }),
        },
        { kind: 'api-key' },
      ),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'blocked');
      assert.match((e as Error).message, /挑战页/);
      return true;
    },
  );
});

test('fetch：200 + 普通 HTML（无挑战特征）→ http 分类，不神经过敏', async () => {
  await assert.rejects(
    () =>
      fetchWith(
        { '/api/usage/token/': () => new Response('<html>oops</html>', { status: 200 }) },
        { kind: 'api-key' },
      ),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'http');
      return true;
    },
  );
});

test('health：/api/status 在线 → online + 端点 + 延迟', async () => {  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/api/status': () => jsonRes(STATUS_REAL) });
  try {
    const r = await newApiProvider.health!({
      siteId: 's1',
      baseUrl: 'https://st.example.com',
      secret: 'sk-test',
      kind: 'api-key',
      quotaPerUnit: RATE,
    });
    assert.equal(r.health, 'online');
    assert.equal(r.endpoint, 'https://st.example.com/api/status');
    assert.equal(r.status, 200);
    assert.ok(r.latencyMs !== undefined && r.latencyMs >= 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('health：401/403 → 带 status 抛错（编排层归 auth-failed）；429 → rate-limited', async () => {
  for (const status of [401, 403]) {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch({ '/api/status': () => new Response('x', { status }) });
    try {
      await assert.rejects(
        () =>
          newApiProvider.health!({
            siteId: 's1',
            baseUrl: 'https://st.example.com',
            secret: 'sk-test',
            kind: 'api-key',
            quotaPerUnit: RATE,
          }),
        (e: unknown) => {
          assert.equal((e as { status?: number }).status, status);
          return true;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  }
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ '/api/status': () => new Response('slow', { status: 429 }) });
  try {
    await assert.rejects(
      () =>
        newApiProvider.health!({
          siteId: 's1',
          baseUrl: 'https://st.example.com',
          secret: 'sk-test',
          kind: 'api-key',
          quotaPerUnit: RATE,
        }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'rate-limited');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- parsePricing（T03：F9 免鉴权带倍率） ----------

/** /api/pricing —— 实测站原文形状（model_ratio / model_price 是比价原料） */
const PRICING_REAL = {
  auto_groups: ['default'],
  data: [
    { model_name: 'gpt-image-2.5-flare', vendor_id: 4, quota_type: 1, model_ratio: 0, model_price: 12, enable_groups: ['svip', 'vip', 'default'], supported_endpoint_types: ['openai'] },
    { model_name: 'gpt-4o', vendor_id: 1, quota_type: 0, model_ratio: 0.5, model_price: 0, enable_groups: ['default'] },
  ],
};

test('parsePricing：F9 —— 实测站形状 → 倍率/价格随行带上（ratio 0 是合法值）', () => {
  const out = parsePricing(PRICING_REAL);
  assert.deepEqual(out, [
    { id: 'gpt-4o', ratio: 0.5, price: 0 },
    { id: 'gpt-image-2.5-flare', ratio: 0, price: 12 },
  ]);
});

test('parsePricing：缺倍率/价格不给键（null 与缺失都不演成 0）', () => {
  const out = parsePricing({ data: [{ model_name: 'm1' }, { model_name: 'm2', model_ratio: null, model_price: 2 }] });
  assert.deepEqual(out, [{ id: 'm1' }, { id: 'm2', price: 2 }]);
});

test('parsePricing：去重排序；空列表 / 找不到数组 / 非对象 → throw', () => {
  assert.deepEqual(parsePricing({ data: [{ model_name: 'b' }, { model_name: 'a' }, { model_name: 'b' }] }), [
    { id: 'a' },
    { id: 'b' },
  ]);
  assert.throws(() => parsePricing({ data: [] }), /0 个模型/);
  assert.throws(() => parsePricing({}), /找不到模型数组/);
  assert.throws(() => parsePricing(null), /找不到模型数组/);
  assert.throws(() => parsePricing({ data: [{ noName: 1 }] }), /0 个模型/);
});

test('fetchSiteModels：优先 /api/pricing（修订 #14），失败回落 /v1/models', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({
    '/api/pricing': () => jsonRes(PRICING_REAL),
    '/v1/models': () => jsonRes({ data: [{ id: 'fallback-only' }] }),
  });
  try {
    const out = await fetchSiteModels('https://st.example.com', {
      siteId: 's1', baseUrl: 'https://st.example.com', secret: 'sk-test', kind: 'api-key', quotaPerUnit: RATE,
    });
    assert.equal(out.source, 'pricing');
    assert.deepEqual(out.models.map((m) => m.id), ['gpt-4o', 'gpt-image-2.5-flare']);
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = mockFetch({
    '/api/pricing': () => new Response('nope', { status: 404 }),
    '/v1/models': () => jsonRes({ data: [{ id: 'from-models' }] }),
  });
  try {
    const out = await fetchSiteModels('https://st.example.com', {
      siteId: 's1', baseUrl: 'https://st.example.com', secret: 'sk-test', kind: 'api-key', quotaPerUnit: RATE,
    });
    assert.equal(out.source, 'models', 'pricing 拿不到 → 回落 v1/models');
    assert.deepEqual(out.models, [{ id: 'from-models' }], '回落只有 id，没有倍率');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchSiteModels：pricing 被拦/限流 → 不回落，直接按分类上抛', async () => {
  const original = globalThis.fetch;
  let modelsHit = 0;
  globalThis.fetch = mockFetch({
    '/api/pricing': () => new Response('slow', { status: 429 }),
    '/v1/models': () => {
      modelsHit += 1;
      return jsonRes({ data: [{ id: 'x' }] });
    },
  });
  try {
    await assert.rejects(
      () =>
        fetchSiteModels('https://st.example.com', {
          siteId: 's1', baseUrl: 'https://st.example.com', secret: 'sk-test', kind: 'api-key', quotaPerUnit: RATE,
        }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'rate-limited');
        return true;
      },
    );
    assert.equal(modelsHit, 0, '被限流还去打 v1/models = 加重对方负担');
  } finally {
    globalThis.fetch = original;
  }
});

test('probeStatus / probeModels：打对应端点并回传原文', async () => {
  const original = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = mockFetch({
    '/api/status': () => {
      hits.push('status');
      return jsonRes(STATUS_REAL);
    },
    '/v1/models': () => {
      hits.push('models');
      return jsonRes(MODELS_REAL);
    },
  });
  try {
    const ctx = { siteId: '', baseUrl: 'https://st.example.com', secret: '', kind: 'api-key' as const, quotaPerUnit: RATE };
    const status = await probeStatus('https://st.example.com', ctx);
    assert.equal((status as { data: { system_name: string } }).data.system_name, 'st-api');
    const models = await probeModels('https://st.example.com', ctx);
    assert.ok(Array.isArray((models as { data: unknown[] }).data));
    assert.deepEqual(hits, ['status', 'models']);
  } finally {
    globalThis.fetch = original;
  }
});
