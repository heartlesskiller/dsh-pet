/**
 * 宿主无关网关的路由分发（S7）：`/capabilities` · `/agents[/hello]` · `/events` · `/state/stream`。
 *
 * 与 relays 同一个分层手法：**纯逻辑/依赖注入在本模块**，`index.ts` 只做「读 body → 调这里 →
 * 落响应」的薄接线（`handleGatewayRoute` 约 20 行）。这样网关的业务逻辑无 GUI、无 HTTP 可测。
 *
 * ## 档位（../capabilities.ts 的 CAPABILITY_TIERS）
 *   - GET  /capabilities   L0（在场自述，零副作用）
 *   - POST /agents/hello   L0（握手，零副作用；TTL 60s）
 *   - GET  /agents         L1（只读在场列表）
 *   - POST /events         L2（驱动桌宠：气泡 + 六档状态）
 *   - GET  /state/stream   L1（只读；**只能走 HTTP 直连**——桌面 bridge 管道不支持流式，
 *                          走到这里说明是 bridge 路径，显式 501 而不是静默降级）
 *
 * 错误口径与既有分支一致：结构错 → 4xx + `{ error }`；动作失败 → 200 + `{ ok:false, reason }`。
 */
import type { AgentRegistry } from './agents';
import type { RouteResult } from '../route-result';
import type { CapabilitySet, HostMode } from '../capabilities';
import { capabilitiesPayload, type CapabilitiesPayload } from './capabilities';
import { ingestEvent, type IngestOptions } from './ingest';

/** 网关端点（rest 已去掉 ROUTE_PREFIX；均无子路径歧义） */
export type GatewayRoute = 'capabilities' | 'agents' | 'agents/hello' | 'events' | 'state/stream';

/**
 * 判断 rest 是否属于网关子域。**只认精确路径**：
 * `agents/hello` 只有 hello 一种子动作；多段（`agents/a/b`）→ undefined → 404，不猜。
 */
export function gatewayRouteOf(rest: string): GatewayRoute | undefined {
  switch (rest) {
    case 'capabilities':
    case 'agents':
    case 'agents/hello':
    case 'events':
    case 'state/stream':
      return rest;
    default:
      return undefined;
  }
}

/** 网关依赖（index.ts 注入：状态写入由 ingest 的 IngestOptions 转发，网关自己不碰状态仓） */
export interface GatewayDeps {
  hostMode: HostMode;
  caps: CapabilitySet;
  relayKinds: readonly string[];
  instanceId: string;
  /** 在场登记表（index.ts 建一份，进程内） */
  registry: AgentRegistry;
  /** 摄入写入口径（复用既有叶子） */
  ingest: IngestOptions;
  /** 是否有域要求 token（默认全关） */
  tokenRequired: boolean;
  sseMaxConnections: number;
  httpIngest?: boolean;
}

export interface Gateway {
  /** 处理一个已归类的网关路由（恒 async：调用方统一 await，避免联合类型窄化） */
  handle: (route: GatewayRoute, method: string, body?: string) => Promise<RouteResult>;
  /** 组装 /capabilities 响应（HTTP 与自检共用） */
  payload: () => CapabilitiesPayload;
}

const json = (status: number, obj: unknown): RouteResult => ({ kind: 'json', status, obj });
const methodNotAllowed = (): RouteResult => json(405, { error: 'method not allowed' });

/** 解析 JSON body（坏 JSON → undefined，调用方回 400） */
function parseBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? 'null');
  } catch {
    return undefined;
  }
}

export function createGateway(deps: GatewayDeps): Gateway {
  const payload = (): CapabilitiesPayload =>
    capabilitiesPayload({
      hostMode: deps.hostMode,
      caps: deps.caps,
      relayKinds: deps.relayKinds,
      instanceId: deps.instanceId,
      agentCount: deps.registry.size(),
      tokenRequired: deps.tokenRequired,
      sseMaxConnections: deps.sseMaxConnections,
      httpIngest: deps.httpIngest ?? true,
    });

  return {
    payload,
    async handle(route, method, body) {
      switch (route) {
        case 'capabilities': {
          if (method !== 'GET') return methodNotAllowed();
          return json(200, payload());
        }
        case 'agents': {
          if (method !== 'GET') return methodNotAllowed();
          return json(200, { ok: true, ...deps.registry.list() });
        }
        case 'agents/hello': {
          if (method !== 'POST') return methodNotAllowed();
          const raw = parseBody(body);
          if (raw === undefined) return json(400, { error: 'invalid JSON body' });
          const result = deps.registry.hello((raw && typeof raw === 'object' ? raw : {}) as Record<string, never>);
          if (result.ok) return json(200, result);
          return json(400, { error: result.message });
        }
        case 'events': {
          if (method !== 'POST') return methodNotAllowed();
          const raw = parseBody(body);
          if (raw === undefined) return json(400, { error: 'invalid JSON body' });
          return ingestEvent(raw, deps.ingest);
        }
        case 'state/stream': {
          // 只有 HTTP 直连才能流式；走到这里 = 桌面 bridge / 非 GET，显式拒绝而不是假装成功
          if (method !== 'GET') return methodNotAllowed();
          return json(501, {
            error: 'stream-requires-http',
            message: 'SSE 只能走 HTTP 直连（桌面 bridge 管道不支持流式）；请改用轮询 GET /state',
          });
        }
      }
    },
  };
}
