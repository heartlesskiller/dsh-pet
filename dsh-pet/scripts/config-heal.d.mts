/**
 * `config-heal.mjs` 的类型声明。
 *
 * 与 `launch-hints.d.mts` 同一理由：实现是纯 JS（`scripts/` 不进 TS 构建、node 直接跑），
 * 而单测在 `src/` 下用 TS 写 —— 给一份声明，两边都成立。
 */

export interface DisplayHealPlan {
  /** 要不要改（false 时调用方不该写盘） */
  changed: boolean;
  /** 给人看的一句话 */
  reason: string;
  /** 改完的配置（changed 为 false 时原样返回） */
  value: unknown;
}

/** 备份名后缀：`YYYYMMDD-HHmmss` */
export function backupSuffix(now?: Date | number): string;

/** 去掉 JSONC 注释（字符串内的 `//` 不受影响） */
export function stripJsonComments(text: string): string;

/** 解析 JSONC 配置文本 */
export function parseConfigText(text: string): { ok: true; value: unknown } | { ok: false; message: string };

/** 判断要不要把 `display:"none"` 自愈成 `"desktop"`（只治这一种） */
export function planDisplayHeal(config: unknown): DisplayHealPlan;
