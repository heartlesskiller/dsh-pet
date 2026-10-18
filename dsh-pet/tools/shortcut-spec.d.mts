/**
 * `shortcut-spec.mjs` 的类型声明。
 *
 * 与 `scripts/launch-hints.d.mts` 同一理由：实现是纯 JS（`tools/` 不进 TS 构建，
 * electron 直接跑），而单测在 `src/` 下用 TS 写 —— 给一份声明，两边都成立。
 */

export interface ShortcutSpec {
  /** 要生成的 .lnk 路径 */
  out: string;
  /** 快捷方式指向的目标 */
  target: string;
  /** 命令行参数（可为空串） */
  args: string;
  cwd?: string;
  icon?: string;
  /** 备注 / 悬浮提示。**中文只从这里进**（argv 会被转成 mojibake） */
  description?: string;
}

export type SpecSource =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'json'; path: string }
  | { kind: 'argv'; argv: string[] };

export type SpecResult = { ok: true; value: ShortcutSpec } | { ok: false; message: string };

export const USAGE: string;

export function pickSpecSource(argv: string[]): SpecSource;
export function normalizeSpec(raw: unknown): SpecResult;
export function specFromArgv(argv: string[]): SpecResult;
export function specFromObject(obj: unknown): SpecResult;
