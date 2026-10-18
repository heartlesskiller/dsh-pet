/**
 * `dsh-pet-notify.mjs` 的类型声明（与 `shortcut-spec.d.mts` 同一理由：
 * 实现是纯 JS、由 node 直接跑；单测在 `src/` 下用 TS 写）。
 */

/** 解析后的 CLI 参数（字段全字符串化；'' = 没给） */
export interface NotifyArgs {
  kind: string;
  agentId: string;
  status: string;
  severity: string;
  text: string;
  coalesceKey: string;
  task: string;
  /** 直接指定网关（'' = 走发现） */
  base: string;
  listAgents: boolean;
  help: boolean;
}

export type NotifyParseResult = { ok: true; value: NotifyArgs } | { ok: false; message: string };

export const USAGE: string;
export const NOTIFY_STATUSES: string[];
export const NOTIFY_SEVERITIES: string[];

/** argv → 参数（纯函数；host 可注入，node:test 可测） */
export function notifyArgsFromArgv(argv: string[], host?: string): NotifyParseResult;

/** 执行层（薄）：发现 → hello → events。返回退出码（0 / 1 / 2）。
 *  io.stdout / io.stderr 输出注入；io.fetchImpl fetch 注入（测试不碰真网络）。 */
export function main(
  argv: string[],
  io?: {
    stdout?: { write(chunk: string): unknown };
    stderr?: { write(chunk: string): unknown };
    fetchImpl?: typeof fetch;
  },
): Promise<number>;
