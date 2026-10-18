/**
 * `pet-gateway-client.mjs` 的类型声明。
 *
 * 与 `tools/shortcut-spec.d.mts` 同一理由：实现是纯 JS（`tools/` 不进 TS 构建，
 * 由 node 直接跑），而单测在 `src/` 下用 TS 写——给一份声明，两边都成立。
 */

/** 一次 HTTP 调用的结果（网络失败 → ok:false + error，绝不静默） */
export interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
  error?: string;
}

/** 一条存活实例的发现记录（只取客户端用得到的字段） */
export interface LiveGateway {
  /** 实例 base（http://127.0.0.1:<port>，不含路由前缀） */
  url: string;
  routePrefix: string;
  pid: number;
  startedAt: string;
}

/** fetch 注入（测试不碰真网络） */
export type FetchImpl = typeof fetch;

export interface HttpOptions {
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

export const ROUTE_PREFIX: string;
export const SCAN_BASE_PORT: number;
export const SCAN_LIMIT: number;

export function dshHomeDir(): string;
export function gatewaysDir(home?: string): string;
export function isPidAlive(pid: number): boolean;
export function listLiveGateways(home?: string, isAlive?: (pid: number) => boolean): LiveGateway[];
export function discoverGatewayBase(options?: {
  home?: string;
  scanProbe?: (port: number) => Promise<boolean>;
}): Promise<string | null>;
export function postJson(url: string, body: unknown, options?: HttpOptions): Promise<HttpResult>;
export function getJson(url: string, options?: HttpOptions): Promise<HttpResult>;
export function helloAgent(
  base: string,
  input: { agentId: string; kind: string },
  options?: HttpOptions,
): Promise<HttpResult>;
export function postEvent(base: string, body: Record<string, unknown>, options?: HttpOptions): Promise<HttpResult>;
export function listAgents(base: string, options?: HttpOptions): Promise<HttpResult>;
export function localHostname(): string;
