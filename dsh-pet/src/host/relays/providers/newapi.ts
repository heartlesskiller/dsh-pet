/**
 * new-api / one-api 系中转站适配器。
 *
 * 端点与认证（来源：上游 `dsh-stats-panel` 的 `docs/CHANNELS.md`、one-api `docs/API.md`、
 * new-api 配套工具 `new-api-key-tool`；**尚未对真实站点跑通过，见文件末「待实测」**）：
 *
 * - 余额：`GET {base}/api/user/self`，需**系统访问令牌（AccessToken）**，
 *   头 `Authorization: Bearer <token>`；new-api 新版可能还要求 `New-Api-User: <uid>`
 *   （由站点的 `extraHeaders` 提供，本文件不写死）。
 *   响应 `data.quota` = 剩余 quota，`data.used_quota` = 已用 quota。
 * - 换算：默认 500000 quota = 1 USD（站点可覆盖）。**只准调 ../money.ts，别处不许自算。**
 * - 模型清单：`GET {base}/v1/models`，需同一个 Bearer 令牌。
 * - 健康探测：`GET {base}/api/status`，低开销、通常无需鉴权。
 *
 * 纪律继承上游：本文件只负责**成功路径**，任何失败一律 `throw`，
 * 由查询入口统一落成 `fetch-error` —— **绝不伪造 0 余额**。
 */

import type { MoneyBalance } from '../../balance/types';
import { quotaToAmount, sumQuota, siteQuotaPerUnit } from '../money';
import type { RelayFetchContext, RelayHealthResult, RelayProvider } from '../types';

/** 货币：中转站几乎都以美元计费。CNY 站由站点数据自带时另说，这里只做兜底 */
const CURRENCY = 'USD';

/** provider id 前缀（展示层据此区分「这是中转站」而不是官方服务商） */
export const RELAY_PROVIDER_PREFIX = 'relay:';

/**
 * 请求头构造。
 *
 * 默认 `Authorization: Bearer <token>`（new-api 文档口径）。站点 `extraHeaders` 里**同名键优先**
 * —— 这是给 one-api 老版本（要裸 `Authorization: <token>`）留的逃生口，也方便带
 * `New-Api-User` 之类的附加头。extraHeaders 视为敏感值，绝不进日志。
 */
function authHeaders(ctx: RelayFetchContext): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'dsh-pet-relays' };
  const secret = ctx.kind === 'manual' ? '' : ctx.secret;
  if (secret) headers['Authorization'] = 'Bearer ' + secret;
  if (ctx.extraHeaders) {
    for (const [k, v] of Object.entries(ctx.extraHeaders)) headers[k] = v;
  }
  return headers;
}

/** 归一化 Base URL：去尾斜杠、去 `/v1` 后缀（用户常把 `https://x.com/v1` 整个粘进来） */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('relays: 站点 URL 缺失');
  let s = raw.trim();
  if (s.length === 0) throw new Error('relays: 站点 URL 为空');
  if (!/^https?:\/\//i.test(s)) throw new Error('relays: 站点 URL 必须是 http(s):// 开头');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '');
  return s;
}

/** 宽松取对象（数组 / null / 非对象 → undefined） */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 必填数字：非法 → throw（不静默当 0） */
function num(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('relays: 响应缺少或非法字段 ' + what);
  return n;
}

/** `parseUserSelf` 的成功结果形状（与 `RelayBalanceSuccess` 的 data 部分同构） */
export interface NewApiBalanceSuccess {
  ok: true;
  provider: string;
  shape: 'money';
  source: 'auto';
  data: MoneyBalance;
}

/**
 * `/api/user/self` 响应 → 成功结果（**纯函数**，测试直接喂真实结构，不碰网络）。
 *
 * `quota`（剩余）与 `used_quota`（已用）都存在时，`fullBalance = (quota + used_quota) / rate`
 * 即「历史总额」—— 这是档位动画的基准，**由数据推出而不是猜一个数**。
 * 只有 `quota` 没有 `used_quota` 时不设 fullBalance（上游口径：没基准就不播档位动画）。
 *
 * 金额字段映射（复用上游 `MoneyBalance`，客户端零改动）：
 * - `total` = 剩余金额（气泡显示的就是它）
 * - `granted` = 剩余金额，`toppedUp` = '0.00' —— 中转站不区分赠送/充值，
 *   硬拆会造出不存在的语义。`sumMoney(granted, toppedUp) === total` 仍成立。
 */
export function parseUserSelf(
  body: unknown,
  ctx: Pick<RelayFetchContext, 'quotaPerUnit'>,
): NewApiBalanceSuccess {
  const root = obj(body);
  if (!root) throw new Error('relays: /api/user/self 响应不是对象');
  // 兼容 `{success, data}` 与直接平铺两种返回
  const data = obj(root.data) ?? root;
  if (root.success === false) {
    throw new Error('relays: 站点返回失败：' + String(root.message ?? '未知原因'));
  }
  const quota = num(data.quota, 'quota');
  const usedRaw = data.used_quota;
  const rate = siteQuotaPerUnit(ctx.quotaPerUnit);

  const remaining = quotaToAmount(quota, rate);
  let fullBalance: string | undefined;
  if (usedRaw !== undefined && usedRaw !== null && usedRaw !== '') {
    fullBalance = quotaToAmount(sumQuota(quota, num(usedRaw, 'used_quota')), rate);
  }

  return {
    ok: true,
    provider: RELAY_PROVIDER_PREFIX + 'new-api',
    shape: 'money',
    source: 'auto',
    data: {
      currency: CURRENCY,
      total: remaining,
      granted: remaining,
      toppedUp: '0.00',
      ...(fullBalance !== undefined ? { fullBalance } : {}),
    },
  };
}

/**
 * `/v1/models` 响应 → 模型 id 列表（**纯函数**）。
 *
 * OpenAI 兼容形状：`{ data: [{ id: 'gpt-4o' }, ...] }`。部分站点把模型放在
 * `data.models` 或直接平铺成数组 —— 三种都兼容，解析不出来就抛错（不返回空列表冒充成功）。
 */
export function parseModels(body: unknown): string[] {
  const root = obj(body);
  const list = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
      ? (root!.data as unknown[])
      : Array.isArray(obj(root?.data)?.models)
        ? (obj(root!.data)!.models as unknown[])
        : undefined;
  if (!list) throw new Error('relays: /v1/models 响应里找不到模型数组');
  const ids: string[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : obj(item)?.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  if (ids.length === 0) throw new Error('relays: /v1/models 返回 0 个模型');
  // 去重 + 排序，保证同站点多次拉取结果稳定（便于对比与快照）
  return [...new Set(ids)].sort();
}

/** `/api/status` 响应 → 是否含 `quota_per_unit`（用于校验换算率） */
export function parseQuotaPerUnit(body: unknown): number | undefined {
  const root = obj(body);
  const data = obj(root?.data) ?? root;
  const v = data?.quota_per_unit;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function getJson(url: string, ctx: RelayFetchContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: authHeaders(ctx),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON：Cloudflare 挑战页 / HTML 错误页都落这里。带上状态码便于上层分类。
    throw new Error('relays: 响应不是 JSON（HTTP ' + res.status + '，长度 ' + text.length + '）');
  }
  if (!res.ok) {
    throw new Error('relays: HTTP ' + res.status + ' ' + res.statusText);
  }
  return parsed;
}

export const newApiProvider: RelayProvider = {
  kinds: ['new-api'],
  credentialKinds: ['access-token', 'api-key', 'session-cookie'],
  async fetch(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    return parseUserSelf(await getJson(base + '/api/user/self', ctx), ctx);
  },
  async health(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    const started = Date.now();
    const res = await fetch(base + '/api/status', {
      headers: authHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      // status 端点要鉴权 ≠ 凭证一定错，但这是唯一能拿到的信号
      throw Object.assign(new Error('relays: /api/status 返回 ' + res.status), { status: res.status });
    }
    if (!res.ok) throw new Error('relays: /api/status HTTP ' + res.status);
    const out: Omit<RelayHealthResult, 'siteId'> = {
      health: 'online',
      endpoint: base + '/api/status',
      status: res.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
    return out;
  },
};

// ---------- 待实测（不静默跳过，明确记账） ----------
// 1. `Authorization: Bearer <token>` 对 one-api 老版本是否兼容（有资料称老版本要裸 token）。
//    已留 extraHeaders 逃生口，但**未对真实站点验证**。
// 2. `/api/status` 是否真的免鉴权、`quota_per_unit` 字段名是否正确 —— 未验证。
// 3. `data.quota` 语义是「剩余」还是「总额」—— one-api 源码里是剩余，new-api 分支需实测。
// 4. 被 Cloudflare 拦时返回的是挑战页 HTML，本文件会落「响应不是 JSON」，
//    上层需据此归类为 `blocked`（当前还没有这一层归类，见 PLAN Q3）。
// 以上都要等用户提供 ≥1 个真实站点才能闭环。
