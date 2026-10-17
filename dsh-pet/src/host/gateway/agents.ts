/**
 * Agent 在场登记（S7 之一）：`POST /agents/hello` + `GET /agents`。
 *
 * ## 语义（07 §3 Q2 2b）
 * - **TTL 60s，心跳 = 重复调同一端点**。服务端只维护内存 Map：**不落盘、不鉴权（L0）**。
 * - 多 agent 仲裁是「优先级 + TTL」，**不搞租约锁**：锁要处理死锁/续租/崩溃恢复，
 *   而气泡本来就只有一条槽，业务上合理的解是「谁优先级高谁说话」（见 ingest.ts 的 severity 映射）。
 * - 过期自动滤除：读的时候清，不另起定时器（进程内内存态，重启即空——在场信息本就是易失的）。
 *
 * ## 为什么内存 Map 够用
 * 在场列表的消费方是「让多个 agent 互相看见」，不是审计。进程重启丢一次在场状态，
 * 各 agent 下一个心跳周期（≤60s）自然恢复，没有任何持久化收益能匹配它的成本。
 */
import { randomUUID } from 'node:crypto';

/** hello 入参。`instanceId` / `capabilities` 是 `agentId` / `wants` 的别名（任务规格的字段名，两种都收） */
export interface AgentHelloInput {
  agentId?: string;
  /** agentId 的别名（发现文件里叫 instanceId；两种命名都接受，不让调用方猜） */
  instanceId?: string;
  kind?: string;
  wants?: string[];
  /** wants 的别名 */
  capabilities?: string[];
}

/** 在场条目（内存态；lastSeenAt / expiresAt 是 epoch ms） */
export interface AgentEntry {
  agentId: string;
  kind: string;
  /** 租约标识：首次登记生成，心跳续期不换（续的是同一份租约） */
  leaseId: string;
  wants: string[];
  lastSeenAt: number;
  expiresAt: number;
}

/** hello 成功响应 */
export interface AgentHelloOk {
  ok: true;
  leaseId: string;
  ttlSec: number;
  granted: string[];
}

/** hello 入参错误（HTTP 400 + { error }，与 /config /pet-display 的结构错误口径一致） */
export interface AgentHelloError {
  ok: false;
  reason: 'bad-request';
  message: string;
}

/** GET /agents 响应里的单项（不返回 token、不返回 agent 环境信息） */
export interface AgentView {
  agentId: string;
  kind: string;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AgentRegistryOptions {
  /** 心跳 TTL，默认 60000（60s） */
  ttlMs?: number;
  /** 时钟注入（测试假时钟覆盖过期）；默认 Date.now */
  now?: () => number;
}

/** agentId 长度上限（与 /events 的 agentId 同口径，防无界字符串进内存 Map 的键） */
const MAX_AGENT_ID = 128;

export class AgentRegistry {
  // 类字段一律 declare + 构造器赋值（仓库约定：带初始化器的类字段在 target es2020 下会被
  // rolldown 降级出 @oxc-project/runtime 外部 helper，被 prepack 门禁拦下）。
  declare private readonly entries: Map<string, AgentEntry>;
  declare private readonly ttlMs: number;
  declare private readonly now: () => number;

  constructor(options: AgentRegistryOptions = {}) {
    this.entries = new Map();
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * 在场登记 / 心跳。同一个 agentId 重复调用 = 续期（leaseId 不变，expiresAt 推后）。
   * 过期条目先统一清掉再登记——心跳把一个已过期的 agent 拉回在场，语义上就是重新出现。
   */
  hello(input: AgentHelloInput): AgentHelloOk | AgentHelloError {
    const agentId = readString(input.agentId) || readString(input.instanceId);
    if (!agentId) return { ok: false, reason: 'bad-request', message: '缺少 agentId' };
    if (agentId.length > MAX_AGENT_ID) {
      return { ok: false, reason: 'bad-request', message: `agentId 过长（限 ${MAX_AGENT_ID} 字符）` };
    }
    const wants = readStringArray(input.wants) ?? readStringArray(input.capabilities) ?? [];
    this.prune();
    const now = this.now();
    const prev = this.entries.get(agentId);
    const entry: AgentEntry = {
      agentId,
      kind: readString(input.kind) || prev?.kind || 'unknown',
      leaseId: prev?.leaseId ?? randomLeaseId(),
      wants,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(agentId, entry);
    return { ok: true, leaseId: entry.leaseId, ttlSec: Math.round(this.ttlMs / 1000), granted: entry.wants };
  }

  /** 在场列表（过期自动滤除；不过期的一律不返回） */
  list(): { agents: AgentView[] } {
    this.prune();
    return {
      agents: [...this.entries.values()]
        .map((e) => ({ agentId: e.agentId, kind: e.kind, lastSeenAt: e.lastSeenAt, expiresAt: e.expiresAt }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    };
  }

  /** 当前在场数（测试与 /capabilities 的诊断用） */
  size(): number {
    this.prune();
    return this.entries.size;
  }

  /** 清掉全部已过期条目（读路径与写路径都走它，不另起定时器） */
  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

/** 取非空字符串（非字符串 / 空串 → ''） */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取字符串数组（过滤非字符串项；非数组 → undefined = 调用方没给） */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** 租约标识（与 gateway/identity 同口径：node:crypto 的 randomUUID，进程内零依赖） */
function randomLeaseId(): string {
  return randomUUID();
}
