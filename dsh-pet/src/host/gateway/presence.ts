/**
 * 在场投影器（docs/19 §4.2）：AgentRegistry + WorkStatusStore → `sections.agents` 叶子。
 *
 * ## 与 sections.workStatus 的分工（设计裁决，两者并存）
 *   workStatus = 桌宠该播哪档动画（单值仲裁，pickDisplayed）；
 *   agents     = 谁在场、各自什么状态、谁在干活（列表投影）。
 * 两者同源（同一份 registry 与 WorkStatusStore），无第二真相。
 *
 * ## 写入口径（三条，缺一不可）
 *   1. registry.onChange（hello 登记/心跳、prune 剔除）→ refresh()；
 *   2. ingest 写 status/task 后 → refresh()（由 index.ts 在 setWorkStatus 里调）；
 *   3. start(5000) timer → refresh()（registry 读时 prune，兜住「心跳过期但没人再调
 *      hello」的空窗：agent 崩了没人发 idle，最多 60s TTL + 5s 投影 = ≤65s 收敛）。
 *
 * ## 「变化才写」是硬纪律（K2：防 5s timer 空转 counter）
 *   投影前算签名（agents 的 JSON 序列化 + activeCount），与上次相同 → 不调 write。
 *   前端每 5s 白渲染一次是可感知的浪费（气泡/动画链路会被无变化写入推着走）。
 *
 * 本模块 host 自包含（不 import src/shared —— DSH 单文件加载约束）：只输出原始 kind 字符串，
 * 展示元化（emoji/颜色/降级）在客户端 shared/agents.ts，两边不互相引用。
 */
import type { AgentRegistry } from './agents';
import type { HostWorkStatusState } from '../work-status';

/** 单条在场 agent 的投影（state/task 取自合成会话 `http:<agentId>`；无会话 → null） */
export interface AgentPresenceItem {
  agentId: string;
  kind: string;
  state: HostWorkStatusState | null;
  task: string | null;
  /** epoch ms（与 AgentView 同口径，原样搬运，不另算） */
  lastSeenAt: number;
  expiresAt: number;
}

/** `sections.agents` 叶子的 data */
export interface AgentsSectionData {
  /** 按 agentId 排序（与 GET /agents 一致） */
  agents: AgentPresenceItem[];
  /** state ∈ thinking/working/result/waiting/error 的个数（success 是终态、null 是空闲，都不算） */
  activeCount: number;
}

export interface PresenceDeps {
  registry: AgentRegistry;
  /** 取某 agent 合成会话的当前档位与任务（无会话 → undefined） */
  workStateOf: (agentId: string) => { state: HostWorkStatusState | null; task: string | null } | undefined;
  /** 写叶子（→ state.writeSection('agents', data)） */
  write: (data: AgentsSectionData) => void;
  /**
   * 时钟注入（假时钟测试用；默认 Date.now）。
   * 当前投影内容完全由 registry 的 TTL 驱动（读时 prune），此处仅作注入点保留——
   * 投影器自己不读时钟，避免与 registry 的时钟双源不一致。
   */
  now?: () => number;
}

/** 兜底刷新间隔（ms）：崩溃收敛 ≤ TTL 60s + 5s = ≤65s（设计 §4.7） */
const DEFAULT_INTERVAL_MS = 5000;

/** active 判定（与设计 §4.2 一字不差：五个进行态；success 终态与 null 空闲不算） */
const ACTIVE_STATES: ReadonlySet<HostWorkStatusState> = new Set<HostWorkStatusState>([
  'thinking',
  'working',
  'result',
  'waiting',
  'error',
]);

export interface PresenceProjector {
  /** 立刻重投影一次（签名不变不写） */
  refresh: () => void;
  /** 起兜底定时器（默认 5000ms、unref；返回停止函数） */
  start: (intervalMs?: number) => () => void;
}

/** 造一个投影器（纯逻辑 + 注入 registry/写入口，无 HTTP、无状态仓，可单测） */
export function createPresenceProjector(deps: PresenceDeps): PresenceProjector {
  // deps.now 是有意的预留注入点（见 PresenceDeps.now 的说明）：当前投影内容完全由
  // registry 的 TTL 驱动（读时 prune），投影器自己读时钟会形成双时钟源，故不消费。

  /** 上次写入的签名（'' = 从未写过）；相同 → 跳过 write */
  let lastSignature = '';

  const build = (): AgentsSectionData => {
    const agents: AgentPresenceItem[] = deps.registry.list().agents.map((a) => {
      const entry = deps.workStateOf(a.agentId);
      return {
        agentId: a.agentId,
        kind: a.kind,
        state: entry?.state ?? null,
        task: entry?.task ?? null,
        lastSeenAt: a.lastSeenAt,
        expiresAt: a.expiresAt,
      };
    });
    return { agents, activeCount: agents.filter((a) => a.state !== null && ACTIVE_STATES.has(a.state)).length };
  };

  const refresh = (): void => {
    const data = build();
    // 签名含 agents 全字段 + activeCount：任一变化才写（counter 不空转，K2）
    const signature = JSON.stringify(data) + '\u0000' + data.activeCount;
    if (signature === lastSignature) return;
    lastSignature = signature;
    deps.write(data);
  };

  const start = (intervalMs: number = DEFAULT_INTERVAL_MS): (() => void) => {
    const timer = setInterval(refresh, intervalMs);
    // unref：定时器不许拖着进程不退出（standalone 停机时靠它优雅收尾）
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  };

  return { refresh, start };
}
