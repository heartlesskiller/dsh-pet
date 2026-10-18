// 已知 agent 注册表 —— **客户端唯一事实源**（host 不持有：host 自 contain 不 import src/shared）。
//
// 设计依据 docs/19-agent-adapter-design.md §4.1：方案 B「声明式注册表 + 通用协议」。
// 新接入一个 agent = 本表加一行 + 一段文档，core 零改动；注册表是**数据不是代码分支**。
//
// 两条硬口径：
//   1. `kind` 是稳定 id：只增不删、永不改名（host 侧 hello/events 的 kind 本来就是自由字符串，
//      改名只会让历史在场条目的展示元数据错配）；
//   2. **未知 kind 必须优雅降级**（agentMeta 永远返回可渲染对象，绝不拒映）——桌宠是第三方观察者，
//      排不到表里的 agent（自研脚本 / 新出的工具）照样能接入，只是展示元数据用降级值。

/** agent 传输方式（纯接入提示，不影响协议——三种 transport 都序列化成同一份 /events） */
export type AgentTransport = 'http' | 'cli' | 'mcp';

/** 注册表行（公开静态数据：emoji/色值均为近似值，不声称官方商标色） */
export interface KnownAgent {
  readonly kind: string; // hello/events 的 kind 值 = 稳定 id
  readonly name: string; // 显示名
  readonly emoji: string; // 单字符 emoji（桌宠气泡是纯文本槽，emoji 零素材成本）
  readonly color: string; // CSS 主色（近似值）
  readonly tag: string; // 1–4 字符短标签（窄气泡角落用）
  readonly transports: readonly AgentTransport[];
  readonly mcp: boolean; // 是否给 MCP 配置片段
  readonly hookHint?: string; // hook 安装提示（指向文档，不放脚本内容）
}

/**
 * 已知 agent 清单。
 *
 * 加一行的纪律（K6 防范围膨胀）：只加数据，不为任何 agent 在 core 里写 if/else。
 * 行序 = 展示优先序（/admin 与 tooltip 摘要取 active 中优先级最高者时同序）。
 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { kind: 'workbuddy', name: 'WorkBuddy', emoji: '🧰', color: '#6366f1', tag: 'WB', transports: ['mcp', 'cli', 'http'], mcp: true, hookHint: 'docs 接入指南 §MCP' },
  { kind: 'codex', name: 'Codex', emoji: '🤖', color: '#10a37f', tag: 'CX', transports: ['mcp', 'cli', 'http'], mcp: true, hookHint: 'docs 接入指南 §CLI' },
  { kind: 'claude-code', name: 'Claude Code', emoji: '🐈', color: '#d97757', tag: 'CC', transports: ['cli', 'http'], mcp: true, hookHint: 'hooks: Stop' },
  { kind: 'custom', name: '自定义脚本', emoji: '📜', color: '#6b7280', tag: 'DIY', transports: ['http', 'cli'], mcp: false },
];

/** 渲染层唯一入口的返回：已知 → 注册表元数据；未知 → 降级（known=false） */
export interface AgentMeta {
  kind: string;
  name: string;
  emoji: string;
  color: string;
  tag: string;
  known: boolean;
}

/** 未知 kind 的显示名截断上限（码点）：桌宠 tooltip/列表宽度有限，超长 kind 原样显示会撑爆布局 */
const UNKNOWN_NAME_MAX = 24;

/** 未知 kind 的降级元数据（写死，见模块头口径 2） */
const UNKNOWN_FALLBACK = { emoji: '👾', color: '#6b7280', tag: '…' } as const;

/**
 * kind → 展示元数据（渲染层唯一入口）。
 *
 * 已知 kind → 注册表行；未知 → 降级：name 取 kind 原样（截 24 码点 + 省略号）、
 * emoji `👾`、color 中性灰、tag `…`、`known=false`。**永远不返回 null、不抛**——
 * 「查不到就降级显示而非拒绝」是注册表方案的地基（K9：kind 自声明不可信，
 * 仅影响展示元数据，不参与任何权限判定）。
 */
export function agentMeta(kind: string): AgentMeta {
  const key = typeof kind === 'string' ? kind.trim() : '';
  const hit = KNOWN_AGENTS.find((a) => a.kind === key);
  if (hit) {
    return { kind: hit.kind, name: hit.name, emoji: hit.emoji, color: hit.color, tag: hit.tag, known: true };
  }
  // 按码点切（与 host/work-status.ts 的 TASK_TEXT_MAX 同口径：不把代理对截成半个字符）
  const points = Array.from(key);
  const name = points.length > UNKNOWN_NAME_MAX ? `${points.slice(0, UNKNOWN_NAME_MAX).join('')}…` : key;
  return { kind: key, name, emoji: UNKNOWN_FALLBACK.emoji, color: UNKNOWN_FALLBACK.color, tag: UNKNOWN_FALLBACK.tag, known: false };
}
