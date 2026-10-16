/**
 * 中转站金额换算 —— **唯一权威**。
 *
 * one-api / new-api 内部用 `quota` 整数计费，默认 **500000 quota = 1 USD**，站长可改
 * （`GET /api/status` 的 `quota_per_unit`）。因此：
 *
 * - 所有 quota ↔ 金额的换算**只准在这里做**。provider、store、路由、前端都不许自己除；
 * - 换算率允许按站点覆盖（站点自己那份 `quotaPerUnit`），默认值集中在这里；
 * - 非法输入一律 `throw`，绝不静默当 0 —— 与上游 `balance/internal.ts` 同口径。
 */

/** one-api / new-api 的默认换算率：500000 quota = 1 USD */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** 默认币种。中转站几乎都以美元计费；CNY 站由站点数据自带，这里只做兜底 */
export const DEFAULT_RELAY_CURRENCY = 'USD';

/**
 * 校验换算率：必须是有限正数，否则 throw。
 * 站点配了 0 / 负数 / NaN 会让所有余额算成 Infinity 或 NaN —— 必须显式炸，不能静默。
 */
export function quotaPerUnitOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('relays: quotaPerUnit 非法（必须是有限正数）：' + String(value));
  }
  return n;
}

/** 站点级换算率：缺省 / 非法 → 默认值（站点没配就用默认，不是错误） */
export function siteQuotaPerUnit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_QUOTA_PER_UNIT;
  return quotaPerUnitOf(value);
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
