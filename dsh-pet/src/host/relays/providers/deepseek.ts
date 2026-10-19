/**
 * DeepSeek 官方余额适配器（`deepseek`，relays 家族）。
 *
 * ## 端点与真站事实（2026-10-19 用户提供真实 key 实测）
 * `GET <base>/user/balance`，**只要模型 API Key**（Bearer），实测响应：
 * ```json
 * {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"4.88",
 *   "granted_balance":"3.54","topped_up_balance":"1.34"}]}
 * ```
 *
 * ## 与上游 `balance/providers/deepseek-official.ts` 的关系（先读这段，别当成重复造轮子）
 * 上游已有一条 DeepSeek 官方路由，**同一端点、同一口径**，本文件与它的差别只有两点：
 * 1. **凭证来源**：上游走 DSH 凭证引用（`credential: {mode:'ref', ref:'DEEPSEEK_API_KEY'}`），
 *    独立模式下 `ctx.credentials.resolve()` 恒 undefined → 那条路在独立模式**必然不可用**；
 *    本适配器走 relays 的站点凭证（用户在 /admin 里填 key），舰队与独立模式都能用。
 * 2. **展示位置**：上游是 `sections.balance` 单服务商（一次一个 provider）；
 *    本适配器进 relays 舰队，与中转站同屏汇总（用户要的「一站式总仪表盘」）。
 * 因此 **¥20 档位基准与峰谷档位直接复用上游的 `deepseek-common.ts`**——不立第二套真相。
 *
 * ## 金额口径（对齐上游「官方数字比插件推算可信」）
 * `total/granted/toppedUp` **原样透传**，不按 `granted + toppedUp` 重算 total。
 * 仅当 granted/toppedUp 缺失时才回落（`granted = total, toppedUp = 0`），
 * 与 new-api 的 moneySuccess 同口径——硬拆会造出不存在的语义。
 *
 * ## 守卫（ relays 纪律：只负责成功路径，失败一律 throw）
 * 1. `is_available !== true` → 抛（账户被禁/未激活，不猜余额）；
 * 2. `balance_infos` 非数组或空 → 抛；
 * 3. **多币种 → 抛**（MoneyBalance 是单币种契约；上游取 `infos[0]` 是因为它只显示一个
 *    provider，舰队里默默挑一个币种会污染汇总——「不猜」红线，宁可明确失败）；
 * 4. `total_balance` 缺失/非数字 → 抛。
 */

import { DEEPSEEK_FULL_BALANCE, deepseekPricingTier } from '../../balance/deepseek-common';
import { classifiedError, normalizeBaseUrl, RELAY_PROVIDER_PREFIX } from './newapi';
import type { MoneyBalance } from '../../balance/types';
import type { RelayHealthResult, RelayProvider } from '../types';

/** `/user/balance` 的单条余额记录（宽松判定：只认用到的字段） */
interface DeepSeekBalanceInfo {
  currency?: unknown;
  total_balance?: unknown;
  granted_balance?: unknown;
  topped_up_balance?: unknown;
}

/** 金额字段 → 两位小数字符串；缺失/非法 → undefined（由调用方决定回落还是抛） */
function amount(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  return undefined;
}

/** 解析 `/user/balance` → MoneyBalance。任何不满足 → throw（调用方落 fetch-error） */
export function parseBalance(body: unknown): MoneyBalance {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (o.is_available !== true) {
    throw new Error('relays: DeepSeek 账户不可用（is_available != true）');
  }
  const infos = o.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    throw new Error('relays: DeepSeek /user/balance 无 balance_infos（账户无余额记录？）');
  }
  const entries = infos as DeepSeekBalanceInfo[];
  const currencies = [...new Set(entries.map((e) => (typeof e.currency === 'string' ? e.currency : 'CNY')))];
  if (currencies.length > 1) {
    throw new Error('relays: DeepSeek 返回多币种（' + currencies.join(' / ') + '），MoneyBalance 是单币种契约，需手工处理');
  }
  const e = entries[0];
  const total = amount(e.total_balance);
  if (total === undefined) throw new Error('relays: DeepSeek total_balance 缺失或非数字');
  const granted = amount(e.granted_balance);
  const toppedUp = amount(e.topped_up_balance);
  return {
    currency: currencies[0] ?? 'CNY',
    total,
    granted: granted ?? total,
    toppedUp: toppedUp ?? '0.00',
    // 档位基准与峰谷档位复用上游 deepseek-common（¥20 基准；取数时刻算峰谷）
    fullBalance: DEEPSEEK_FULL_BALANCE,
    tier: deepseekPricingTier(),
  };
}

export const deepseekProvider: RelayProvider = {
  kinds: ['deepseek'],
  credentialKinds: ['api-key'],
  // /user/balance 直接返回账户金额（CNY），没有 quota 换算 → 不打 rateUnconfirmed
  usesQuotaRate: false,
  async fetch(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    const res = await fetch(base + '/user/balance', {
      headers: { Authorization: 'Bearer ' + ctx.secret },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      throw classifiedError('relays: DeepSeek /user/balance 返回 429 限流', 'rate-limited', 429);
    }
    if (res.status === 401 || res.status === 403) {
      throw classifiedError('relays: DeepSeek /user/balance 返回 ' + res.status + '（key 无效或无权限）', 'http', res.status);
    }
    if (!res.ok) throw classifiedError('relays: DeepSeek /user/balance HTTP ' + res.status, 'http', res.status);
    const body: unknown = await res.json();
    const data = parseBalance(body);
    return {
      ok: true,
      provider: RELAY_PROVIDER_PREFIX + 'deepseek',
      shape: 'money',
      source: 'auto',
      scope: 'account',
      data,
    };
  },
  async health(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    const started = Date.now();
    // /models 是元数据端点（不耗额度），且**要鉴权** —— 401 能直接证明 key 无效
    const res = await fetch(base + '/models', {
      headers: { Authorization: 'Bearer ' + ctx.secret },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 429) {
      throw classifiedError('relays: DeepSeek /models 返回 429 限流', 'rate-limited', 429);
    }
    if (res.status === 401 || res.status === 403) {
      throw classifiedError('relays: DeepSeek /models 返回 ' + res.status + '（key 无效）', 'http', res.status);
    }
    if (!res.ok) throw classifiedError('relays: DeepSeek /models HTTP ' + res.status, 'http', res.status);
    const out: Omit<RelayHealthResult, 'siteId'> = {
      health: 'online',
      endpoint: base + '/models',
      status: res.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
    return out;
  },
};
