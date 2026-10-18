// 在场 agent 的客户端侧纯逻辑（`sections.agents` 叶子 → 桌宠可消费的视图）。
// 与 shared/relays.ts 同一套口径：只认形状与数据自带的业务事实，不碰网络/React/DOM；
// 形状非法 → null（轮询安全：1s 一拍，抛异常会打断整拍渲染，其余叶子跟着不渲染）。
//
// 分工（docs/19 §4.2 裁决）：sections.workStatus 答「桌宠该播哪档动画」（单值），
// 本模块答「谁在场、各自什么状态、谁在干活」（列表）。两者同源，无第二真相。
//
// 展示元数据（emoji/颜色/未知 kind 降级）唯一事实源是 shared/agents.ts 的注册表——
// host 侧不持有注册表（投影只带原始 kind 字符串），降级发生在渲染前的最后一跳。
import { agentMeta } from './agents';
import { WORK_STATUS_STATES, type WorkStatusState } from './work-status';

// ---------- 视图形状（host 投影器的输出 → 客户端视图） ----------

/** 单条在场 agent（字段与 host 的 AgentPresenceItem 同构；kind 是原始字符串） */
export interface AgentFaceItem {
  agentId: string;
  kind: string;
  /** 该 agent 合成会话的当前档位；无会话 → null（空闲） */
  state: WorkStatusState | null;
  task: string | null;
  lastSeenAt: number;
  expiresAt: number;
}

/** `sections.agents` 叶子的客户端视图 */
export interface AgentsFaceView {
  agents: AgentFaceItem[];
  activeCount: number;
}

// ---------- 防御式解析（形状非法 → null，不抛） ----------

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 档位收窄：不认识 → null（空闲）——与 shared/work-status.ts 的 toWorkStatus 同口径 */
function asState(value: unknown): WorkStatusState | null {
  return typeof value === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(value)
    ? (value as WorkStatusState)
    : null;
}

function parseItem(raw: unknown): AgentFaceItem | undefined {
  const o = asObj(raw);
  if (!o) return undefined;
  const agentId = asStr(o.agentId);
  if (!agentId) return undefined; // 没有 id 的条目无法定位，丢弃（不猜）
  return {
    agentId,
    kind: asStr(o.kind) ?? 'unknown',
    state: asState(o.state),
    task: asStr(o.task) ?? null,
    lastSeenAt: asNum(o.lastSeenAt),
    expiresAt: asNum(o.expiresAt),
  };
}

/**
 * `sections.agents` 叶子数据 → 客户端视图。
 *
 * 形状非法（非对象 / agents 非数组）→ null（消费端跳过这一拍）——与 readRelays 的口径一致。
 * 合法但空列表 → `{ agents: [], activeCount: 0 }`（**不是 null**：「查不到就是空数组」，
 * 空与坏是两件事，消费端要能区分）。
 */
export function readAgents(data: unknown): AgentsFaceView | null {
  const o = asObj(data);
  if (!o) return null;
  if (!Array.isArray(o.agents)) return null;
  const agents = o.agents.map(parseItem).filter((a): a is AgentFaceItem => a !== undefined);
  const activeCount = typeof o.activeCount === 'number' && Number.isFinite(o.activeCount) ? o.activeCount : countActive(agents);
  return { agents, activeCount };
}

// ---------- 摘要（tooltip 文案） ----------

/**
 * active 态的展示优先级（与 host/work-status.ts 的 WORK_STATUS_PRIORITY 同序）：
 *   waiting > error > working > thinking > result > success。
 * 为什么客户端也有一份：host 自 contain 不 import shared、shared 也不能反向 import host
 * （浏览器 bundle 不许拖 node 侧代码）——两端各持一份，由 agents-face.test.ts 的
 * 「与 host 表逐项一致」断言机械钉死，改一头就红。
 */
const AGENT_ACTIVE_PRIORITY: Record<WorkStatusState, number> = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** active 判定（与 host 投影器的 ACTIVE_STATES 同口径：success 终态不算） */
function isActive(state: WorkStatusState | null): state is WorkStatusState {
  return state !== null && state !== 'success';
}

function countActive(agents: readonly AgentFaceItem[]): number {
  return agents.filter((a) => isActive(a.state)).length;
}

/** 单条 agent 的一行摘要：`🧰 WorkBuddy · pnpm test`（无 task 时省略 · 之后的部分） */
export function agentRowText(item: AgentFaceItem): string {
  const meta = agentMeta(item.kind);
  const head = `${meta.emoji} ${meta.name}`;
  return item.task ? `${head} · ${item.task}` : head;
}

/**
 * tooltip 摘要：active 中优先级最高者的一行文案；无 active → null。
 *
 * 同优先级取列表前者（host 已按 agentId 排序，结果稳定）。
 * 返回 null = 没有 agent 在干活：调用方据此回落宠物显示名（tooltip 不许空）。
 */
export function agentsSummary(view: AgentsFaceView): string | null {
  let best: AgentFaceItem | undefined;
  for (const a of view.agents) {
    if (!isActive(a.state)) continue;
    if (!best || AGENT_ACTIVE_PRIORITY[a.state] > AGENT_ACTIVE_PRIORITY[best.state as WorkStatusState]) best = a;
  }
  return best ? agentRowText(best) : null;
}

// ---------- 组件（Phase 1 只被 dev 验收脚本 SSR；挂载点 Phase 2 右键菜单） ----------

import type { jsx } from 'react/jsx-runtime';
import type { ReactElement } from 'react';

/**
 * 制造在场列表组件（工厂，与 relay-face.ts 同构：react 由运行时注入）。
 *
 * Phase 1 的桌宠消费路径是 tooltip 摘要字符串（agentsSummary，pet.ts 挂载），不挂这个组件；
 * 它服务于 dev 验收脚本的 SSR 断言与 Phase 2 的右键菜单子菜单，先立住契约。
 * 样式自包含（AGENTS_FACE_CSS）：shared 不 import client 的 CSS。
 */
export function makeAgentsFace(
  rt: { h: typeof jsx },
): (props: { view: AgentsFaceView; on: boolean }) => ReactElement {
  const { h } = rt;
  return function AgentsFace({ view, on }: { view: AgentsFaceView; on: boolean }): ReactElement {
    if (view.agents.length === 0) {
      return h('div', { className: 'pet-agents-face' + (on ? ' is-on' : ''), children: '（没有 agent 在场）' });
    }
    return h('div', {
      className: 'pet-agents-face' + (on ? ' is-on' : ''),
      children: view.agents.map((a) =>
        h('div', { key: a.agentId, className: 'pet-agents-row', children: agentRowText(a) }),
      ),
    });
  };
}

/** 组件样式（与 TOOLTIP_CSS 同套路：两端要挂时注入同一份） */
export const AGENTS_FACE_CSS = [
  '.pet-agents-face{',
  'max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);',
  'padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);',
  'border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);',
  'background:rgba(255,255,255,.96);color:#1f1f1f;',
  'border:1px solid rgba(0,0,0,.12);',
  'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif;',
  'font-size:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026);line-height:1.4;',
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
  'box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);',
  'opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}',
  '.pet-agents-face.is-on{opacity:1}',
  '.pet-agents-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
].join('');
