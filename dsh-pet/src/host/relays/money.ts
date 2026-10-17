/**
 * 中转站金额换算 —— **唯一权威**。
 *
 * one-api / new-api 内部用 `quota` 整数计费，默认 **500000 quota = 1 USD**，站长可改
 * （`GET /api/status` 的 `quota_per_unit`）。因此：
 *
 * - 所有 quota ↔ 金额的换算**只准在这里做**。provider、store、路由、前端都不许自己除；
 * - 换算率允许按站点覆盖（站点自己那份 `quotaPerUnit`），默认值集中在这里；
 * - 非法输入一律 `throw`，绝不静默当 0 —— 与上游 `balance/internal.ts` 同口径；
 * - **不提供「无标记兜底」入口**（修订 #11）：站点没确认换算率时，由 store 建站显式写
 *   默认值并标记 `rateConfirmed:false`，余额结果带 `rateUnconfirmed` —— 探测不到就
 *   要求用户确认，绝不静默默认 500000。探测入口见 {@link detectQuotaPerUnit}。
 */

/** one-api / new-api 的默认换算率：500000 quota = 1 USD */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** 默认币种。中转站几乎都以美元计费；CNY 站由站点数据自带，这里只做兜底 */
export const DEFAULT_RELAY_CURRENCY = 'USD';

/** 宽松取对象（数组 / null / 非对象 → undefined） */
function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 校验换算率：必须是有限正数，否则 throw。
 * 站点配了 0 / 负数 / NaN 会让所有余额算成 Infinity 或 NaN —— 必须显式炸，不能静默。
 * **缺省（undefined/null/''）同样 throw**：调用方必须显式给值（store 建站时给默认值
 * 并标记未确认），本模块不替调用方猜（修订 #11）。
 */
export function quotaPerUnitOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('relays: quotaPerUnit 非法（必须是有限正数）：' + String(value));
  }
  return n;
}

/**
 * 从 `/api/status` 响应探测站点换算率（`data.quota_per_unit`）。
 *
 * 探测是本该走通的第一路径（修订 #19：官方文档明标该端点鉴权要求「公开」）；
 * 探测不到返回 undefined，由调用方标记 `rateUnconfirmed` 并要求用户确认 ——
 * **绝不静默默认**（修订 #11）。
 */
export function detectQuotaPerUnit(body: unknown): number | undefined {
  const root = asObj(body);
  const data = asObj(root?.data) ?? root;
  const v = data?.quota_per_unit;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * quota 整数 → 两位小数字符串。
 *
 * 走「先按换算率放大 100 倍再四舍五入」而不是 `(q/p).toFixed(2)`：后者在
 * `q = 1, p = 3` 这类除不尽时会先损失精度再舍入。这里按分取整，口径与金额显示一致。
 */
export function quotaToAmount(quota: unknown, quotaPerUnit: unknown = DEFAULT_QUOTA_PER_UNIT): string {
  const q = Number(quota);
  if (!Number.isFinite(q) || q < 0) {
    throw new Error('relays: quota 非法（必须是非负有限数）：' + String(quota));
  }
  const p = quotaPerUnitOf(quotaPerUnit);
  // 以「分」为最小单位取整，避免二进制浮点误差显形（同上游 sumMoney 的思路）
  const cents = Math.round((q * 100) / p);
  return (cents / 100).toFixed(2);
}

/** 两个 quota 相加（余额与已用额度求和，用于推「历史总额」= 档位基准） */
export function sumQuota(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || na < 0 || nb < 0) {
    throw new Error('relays: quota 相加失败（必须都是非负有限数）：' + String(a) + ', ' + String(b));
  }
  return na + nb;
}

/**
 * 已用百分比（0–100+）。`full <= 0` 时返回 undefined —— **不猜基准**，
 * 与上游 `MoneyBalance.fullBalance` 缺省即不播档位动画的口径一致。
 *
 * 上界不夹：超额时如实报 >100%（站点改了汇率或额度被回收时会看到）。
 */
export function usedPercent(remainingQuota: unknown, totalQuota: unknown): number | undefined {
  const r = Number(remainingQuota);
  const t = Number(totalQuota);
  if (!Number.isFinite(r) || !Number.isFinite(t) || t <= 0) return undefined;
  const used = t - r;
  return Math.max(0, (used / t) * 100);
}
