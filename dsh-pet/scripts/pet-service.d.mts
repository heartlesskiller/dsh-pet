/**
 * `pet-service.mjs` 的类型声明。
 *
 * 与 `launch-hints.d.mts` 同一理由：实现是纯 JS（`scripts/` 不进 TS 构建、node 直接跑），
 * 而单测在 `src/` 下用 TS 写 —— 给一份声明，两边都成立。
 */

/** 端口占用者三态（本 bug 的根因就在"只有布尔"） */
export type PortOccupant = 'none' | 'our-standalone' | 'foreign';

/** 一次端口探测的结果 */
export interface PortProbe {
  /** 能不能连上（连接拒绝 / 超时 → false） */
  reachable: boolean;
  /** 连上时的响应体（非 JSON → undefined） */
  body: unknown;
}

/** 假的子进程句柄（单测注入 spawnFn 时用得到的最小形状） */
export interface SpawnedChildLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  unref(): void;
  pid?: number;
}

export interface EnsurePetServiceDeps {
  /** 端口探测（默认走真实 `/health`） */
  probe?: (port: number) => Promise<PortProbe>;
  /** spawn 实现（默认 node:child_process.spawn）；单测注入计数用 */
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => SpawnedChildLike;
}

/** 三态判定（纯函数） */
export function classifyPortOccupant(probe: PortProbe | undefined): PortOccupant;

/** 真实探一次端口 */
export function probePortOccupant(port: number): Promise<PortProbe>;

export class LaunchFailure extends Error {
  readonly output: string;
  readonly port?: number;
  /** 已知原因（如 'foreign-occupant'）；缺省时由 launch-hints 从输出推断 */
  readonly reason?: string;
}

export const PKG: string;
export function petHome(): string;
export function petDataDir(): string;
export function petLogPath(): string;
export function petBaseUrl(port: number): string;
export function log(message: string): void;
export function petHealth(port: number): Promise<unknown | null>;

export function ensurePetService(
  port: number,
  deps?: EnsurePetServiceDeps,
): Promise<{ alreadyRunning: boolean; entry: string; output: string }>;
