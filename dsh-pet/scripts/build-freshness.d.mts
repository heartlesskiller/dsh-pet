/**
 * `build-freshness.mjs` 的类型声明。
 *
 * 与 `launch-hints.d.mts` 同一理由：实现是纯 JS（`scripts/` 不进 TS 构建、node 直接跑），
 * 而单测在 `src/` 下用 TS 写 —— 给一份声明，两边都成立。
 */

/** 需不需要重建（纯判断） */
export function needsRebuild(libMtimeMs: number, srcNewestMtimeMs: number): boolean;

/** 一组 mtime 里取最新；空集合 → NaN */
export function newestMtimeMs(entries: unknown): number;
