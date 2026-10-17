/**
 * `GET /capabilities`（S7 之一，L0 在场）：桌宠自报「我是谁、我能干什么、哪些端点在哪一档」。
 *
 * 这是宿主无关的关键一步：任何 agent 不用试错就能判断「碎碎念能不能用、凭证在不在、
 * 会话事件从哪来」——`hostCapabilities` 的三个枚举值就是为了回答这个问题（见
 * ../capabilities.ts 的 projectCapabilitySet）。
 *
 * 纯函数构造（依赖由 index.ts 注入），本文件不读盘、不起服务。
 */
import {
  CAPABILITY_TIERS,
  projectCapabilitySet,
  type CapabilitySet,
  type HostMode,
  type PetTier,
} from '../capabilities';

/** 构造 /capabilities 响应体所需的依赖（全部由宿主现成对象提供） */
export interface CapabilitiesDeps {
  hostMode: HostMode;
  caps: CapabilitySet;
  /** relays 注册表已登记的站点类型（当前 ['new-api','openai-compat']） */
  relayKinds: readonly string[];
  /** 本进程网关实例 id（与发现文件里的 instanceId 同源，07 §3 Q2 2a 的复核判据） */
  instanceId: string;
  /** 当前在场 agent 数（诊断用；不暴露具体 agent 信息） */
  agentCount: number;
  /** 是否有任何域要求 token（默认全关 → false） */
  tokenRequired: boolean;
  /** SSE 连接上限 */
  sseMaxConnections: number;
  /** 是否提供 HTTP 摄入轨（POST /events） */
  httpIngest: boolean;
}

/** /capabilities 响应体（公开契约，见仓库根 openapi.yaml 的 Capabilities 段） */
export interface CapabilitiesPayload {
  ok: true;
  schema: 1;
  instanceId: string;
  mode: HostMode;
  hostCapabilities: {
    llm: boolean;
    credentials: 'none' | 'dsh' | 'local-file';
    account: boolean;
    sessionEvents: 'none' | 'dsh' | 'http';
  };
  /** 端点档位表（路径相对 /dsh-pet-7340） */
  tiers: Record<PetTier, readonly string[]>;
  /** 已登记的中转站类型（空 = 没装适配器） */
  relayKinds: string[];
  /** 在场 agent 数 */
  agentCount: number;
  /** 是否有任何域要求 token（开启后 L3 域要 `Authorization: Bearer <token>`） */
  tokenRequired: boolean;
  /** SSE 连接上限（`GET /state/stream`） */
  sseMaxConnections: number;
  /** HTTP 摄入轨是否可用（`POST /events`） */
  httpIngest: boolean;
}

/**
 * 组装 /capabilities 响应体（**纯函数**）。
 *
 * `tiers` 直接投影 CAPABILITY_TIERS（与能力的真实实现一一对应）；`relayKinds` 拷贝一份数组，
 * 避免调用方误改共享的档位表。**不返回任何凭证/配置值**（能力只报在场与否）。
 */
export function capabilitiesPayload(deps: CapabilitiesDeps): CapabilitiesPayload {
  const tiers: Record<PetTier, readonly string[]> = {
    L0: [...CAPABILITY_TIERS.L0],
    L1: [...CAPABILITY_TIERS.L1],
    L2: [...CAPABILITY_TIERS.L2],
    L3: [...CAPABILITY_TIERS.L3],
  };
  return {
    ok: true,
    schema: 1,
    instanceId: deps.instanceId,
    mode: deps.hostMode,
    hostCapabilities: projectCapabilitySet(deps.caps, deps.hostMode, deps.httpIngest),
    tiers,
    relayKinds: [...deps.relayKinds],
    agentCount: deps.agentCount,
    tokenRequired: deps.tokenRequired,
    sseMaxConnections: deps.sseMaxConnections,
    httpIngest: deps.httpIngest,
  };
}
