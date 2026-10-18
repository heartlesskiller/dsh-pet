/**
 * `launch-hints.mjs` 的类型声明。
 *
 * 为什么需要这个文件：那个模块是**纯 JS**（`scripts/` 不在 TS 构建里，node 直接跑），
 * 而它的单测在 `src/` 下用 TS 写。TS 默认给 `.mjs` 推断成 `any` 并报 TS7016，
 * 于是给一份声明 —— 这样"实现是 JS、测试是 TS"两边都成立，也不用把 launcher 拖进构建。
 */

/** 失败原因（与 launch-hints.mjs 的 HINTS 表一一对应） */
export type LaunchFailureReason =
  | 'not-built'
  | 'already-running'
  | 'port-busy'
  | 'electron-missing'
  | 'electron-downloading'
  | 'foreign-occupant'
  | 'timeout'
  | 'unknown';

export interface LaunchFailureInfo {
  reason: LaunchFailureReason;
  /** 发生了什么（一行人话） */
  title: string;
  /** 该怎么办 */
  hint: string;
  /** reason 为 unknown 时附上输出里最像错误的那一行 */
  detail: string;
}

/** 从输出里挑一行最像错误的（挑不到 → 空串） */
export function firstErrorLine(output: string): string;

/** 判断启动失败的原因 */
export function classifyLaunchFailure(input?: {
  output?: string;
  port?: number;
  /** 已知原因时直接指定（优先于从 output 推断） */
  reason?: LaunchFailureReason | string;
}): LaunchFailureInfo;

/** 排成给人看的几行 */
export function formatLaunchFailure(info: LaunchFailureInfo, logPath?: string): string;

/** 「端口是别人占的」提示语（launcher / admin 两处文案不同） */
export function foreignOccupantHint(where: 'launcher' | 'admin', port: number): string;
