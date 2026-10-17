/**
 * 状态摄入（S7 之二 / HTTP 摄入主轨）：`POST /events`。
 *
 * ## 这是什么（07 §3.8 / §4.2）
 * 一个 curl 就能接入任意 agent —— 这是「适用于所有 agent」最便宜的兜底。字段形状
 * **借自 ACP Session Notices RFD 的语义**（notice + severity + coalesce），但**不实现 ACP 协议**
 * （裁决见 07 §3.8：桌宠是第三方观察者，ACP 会话归 client 所有，接协议的动机不存在）。
 * 好处：任何按 ACP 语义发通知的 agent 无需改造就能对接。
 *
 * ## 写入口径（复用，不新造）
 *   - `notice`（气泡）→ `pets.<id>.say`：与 /broadcast /whisper /chat 回复**同一个叶子**
 *     （单槽、后到覆盖先到；客户端 1s 轮询 /state 后弹气泡，两端零改动）；
 *   - `status`（六档工作状态）→ `sections.workStatus`：经 WorkStatusStore 按会话聚合
 *     （合成会话 id `http:<agentId>`，终态 60s 自动清理复用上游 scheduleTerminalCleanup 的口径，
 *      由 index.ts 的 setWorkStatus 注入实现）。
 *   - **不新造状态通道**：两个目标叶子都是既有叶子，counter 地基不变。
 *
 * ## 互斥规则（07 §4.2）
 * `sessionEvents` 能力已被 DSH 填上时（DSH 会话事件在场），`status` 段**被忽略**（只处理 notice），
 * 避免六档档位被两个源同时改写而抖动。/capabilities 的 hostCapabilities.sessionEvents 会告诉
 * agent 当前是哪个源（dsh / http / none）。
 *
 * ## severity → priority（ACP 语义原样采用）
 *   info → 0（普通气泡）/ warning → 10（升级）/ error → 20（最高）。
 * 用途：同 coalesceKey 的去重窗口内，**更高优先级放行**（告警升级不该被合并窗口吞掉）。
 */
import type { HostWorkStatusState } from '../work-status';
import type { RouteResult } from '../route-result';

/** notice 严重度（借自 ACP notice.severity；三值，不扩展） */
export type NoticeSeverity = 'info' | 'warning' | 'error';

/** severity → priority（07 §3 Q2 2c 的表；桌宠表现由客户端按 severity 自行决定，host 只搬优先级） */
export const SEVERITY_PRIORITY: Record<NoticeSeverity, number> = { info: 0, warning: 10, error: 20 };

/** 未知 severity → undefined（调用方按 400 处理，不猜） */
export function severityPriority(severity: unknown): number | undefined {
  return typeof severity === 'string' && severity in SEVERITY_PRIORITY
    ? SEVERITY_PRIORITY[severity as NoticeSeverity]
    : undefined;
}

/** status 六态（07 §4.2 的枚举；done = 正常收尾） */
export type IngestStatus = 'idle' | 'thinking' | 'working' | 'waiting-approval' | 'done' | 'error';

/**
 * status → 六档工作状态。
 *   idle → null（**清会话回空闲**：回合结束不残留上一档，与 turn/end 的 aborted 同口径）；
 *   未知值 → undefined（调用方按 400 处理）。
 */
export function statusToWorkState(status: unknown): HostWorkStatusState | null | undefined {
  switch (status) {
    case 'idle':
      return null;
    case 'thinking':
      return 'thinking';
    case 'working':
      return 'working';
    case 'waiting-approval':
      return 'waiting';
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

/** notice 段（text 上限 500 码点：桌宠气泡最大宽度只有 0.5×宠物宽，长文本会撑成几行盖住宠物） */
export interface NoticeInput {
  severity?: unknown;
  text?: unknown;
  coalesceKey?: unknown;
  /** 气泡存留毫秒（doc 默认 3000）。R0 只校验不使用——say 叶子没有过期通道，留给后续 */
  ttlMs?: unknown;
}

/** /events 请求体（07 §4.2；agentId 必填，notice 与 status 二选一或都给） */
export interface EventsInput {
  agentId?: unknown;
  sessionId?: unknown;
  notice?: NoticeInput;
  status?: unknown;
  /** 气泡目标宠物（扩展字段：缺省 = 当前桌宠）。发现文件/握手不管气泡去向，这里管 */
  petId?: unknown;
}

/** 摄入依赖（由 index.ts 注入：全部是既有写入口径的转发，ingest 自己不碰状态仓） */
export interface IngestOptions {
  /** 写气泡（pets.<id>.say）；payload 带 severity/priority 供客户端择优渲染（不认识就忽略） */
  pushSay: (petId: string, payload: { text: string; severity: NoticeSeverity; priority: number }) => void;
  /** 写六档工作状态（null = 清该 agent 的合成会话回空闲） */
  setWorkStatus: (agentId: string, state: HostWorkStatusState | null) => void;
  /** 解析气泡目标宠物（requested 缺省 = 当前桌宠）；'' = 没有可显示的桌宠 */
  resolvePetId: (requested: string | undefined) => string;
  /** DSH 会话事件在场 → status 段忽略（互斥规则） */
  sessionEventsOwned?: boolean;
  /** 时钟注入（测试假时钟） */
  now?: () => number;
  /** coalesce 窗口，默认 5000ms */
  coalesceWindowMs?: number;
  /** coalesce 记忆上限（有界，按最早写入淘汰），默认 256 */
  maxCoalesceEntries?: number;
  /** notice.text 长度上限（码点），默认 500 */
  maxTextLength?: number;
  /** coalesce 记忆（跨请求共享；缺省 = 不去重） */
  coalescer?: NoticeCoalescer;
}

/** coalesce 判定接口（跨请求共享的记忆由实现方持有；默认实现见 {@link createNoticeCoalescer}） */
export interface NoticeCoalescer {
  /** true = 本次应放行（写气泡）；false = 窗口内同 key 且优先级未升级，静默合并 */
  shouldEmit(key: string, priority: number): boolean;
}

const MAX_AGENT_ID = 128;
const MAX_COALESCE_KEY = 128;
const DEFAULT_COALESCE_WINDOW_MS = 5000;
const DEFAULT_MAX_TEXT = 500;
const DEFAULT_MAX_COALESCE = 256;
const MAX_TTL_MS = 60_000;

/** 路由层用的 400（结构错 → 4xx + { error }，与 /config /pet-display 同口径） */
const badRequest = (message: string): RouteResult => ({ kind: 'json', status: 400, obj: { error: message } });

/**
 * 处理一次 POST /events。
 *
 * 顺序：校验 → （有 notice 时）先确认桌宠在场 → coalesce 判定 → 写气泡 → 写档位。
 * 动作类失败（桌宠不在场）→ 200 + { ok:false, reason }（与 /whisper /broadcast 一致）；
 * 结构类失败（坏字段）→ 400 + { error }。异常 → 200 + { ok:false, reason:'ingest-error' }，不静默。
 */
export function ingestEvent(raw: unknown, options: IngestOptions): RouteResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as EventsInput;
  const agentId = typeof o.agentId === 'string' ? o.agentId.trim() : '';
  if (!agentId) return badRequest('缺少 agentId');
  if (agentId.length > MAX_AGENT_ID) return badRequest(`agentId 过长（限 ${MAX_AGENT_ID} 字符）`);

  const hasNotice = o.notice !== undefined && o.notice !== null;
  const hasStatus = o.status !== undefined && o.status !== null;
  if (!hasNotice && !hasStatus) return badRequest('notice 或 status 至少给一个');

  // ---- notice 段校验（结构错 → 400）----
  let notice: { text: string; severity: NoticeSeverity; priority: number; coalesceKey?: string } | undefined;
  if (hasNotice) {
    const n = (o.notice ?? {}) as NoticeInput;
    const priority = severityPriority(n.severity);
    if (priority === undefined) return badRequest('notice.severity 必须是 info / warning / error');
    const text = typeof n.text === 'string' ? n.text.trim() : '';
    if (!text) return badRequest('notice.text 不能为空');
    const maxText = options.maxTextLength ?? DEFAULT_MAX_TEXT;
    // 按码点切（与 work-status.ts 的 TASK_TEXT_MAX 同口径：不把代理对截成半个字符）
    const points = Array.from(text);
    if (points.length > maxText) return badRequest(`notice.text 过长（限 ${maxText} 字）`);
    let coalesceKey: string | undefined;
    if (n.coalesceKey !== undefined && n.coalesceKey !== null) {
      if (typeof n.coalesceKey !== 'string') return badRequest('notice.coalesceKey 必须是字符串');
      const key = n.coalesceKey.trim();
      if (key.length > MAX_COALESCE_KEY) return badRequest(`notice.coalesceKey 过长（限 ${MAX_COALESCE_KEY} 字符）`);
      if (key) coalesceKey = key;
    }
    if (n.ttlMs !== undefined && n.ttlMs !== null) {
      const ttl = Number(n.ttlMs);
      if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
        return badRequest(`notice.ttlMs 必须是 1..${MAX_TTL_MS} 的整数（R0 仅校验，不驱动过期）`);
      }
    }
    notice = { text, severity: n.severity as NoticeSeverity, priority, ...(coalesceKey ? { coalesceKey } : {}) };
  }

  // ---- status 段校验（DSH 在场时整段忽略，见模块头的互斥规则）----
  let workState: HostWorkStatusState | null | undefined;
  if (hasStatus && options.sessionEventsOwned !== true) {
    workState = statusToWorkState(o.status);
    if (workState === undefined) return badRequest('status 必须是 idle/thinking/working/waiting-approval/done/error');
  }

  try {
    // 有 notice 就先确认桌宠在场：没有桌宠时这条 notice 无处可去（fail-fast，别写半个状态）
    let petId = '';
    if (notice) {
      const requested = typeof o.petId === 'string' && o.petId.trim() ? o.petId.trim() : undefined;
      petId = options.resolvePetId(requested);
      if (!petId) return { kind: 'json', status: 200, obj: { ok: false, reason: 'no-active-pet', message: '没有可显示的桌宠' } };
    }

    // coalesce 去重：同 key 在窗口内已发过，且优先级没有升级 → 静默合并（不重复弹）
    if (notice && notice.coalesceKey && options.coalescer) {
      if (!options.coalescer.shouldEmit(notice.coalesceKey, notice.priority)) {
        return { kind: 'json', status: 200, obj: { ok: true } };
      }
    }

    if (notice && petId) {
      options.pushSay(petId, { text: notice.text, severity: notice.severity, priority: notice.priority });
    }
    if (workState !== undefined) options.setWorkStatus(agentId, workState);
    return { kind: 'json', status: 200, obj: { ok: true } };
  } catch (e) {
    return {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'ingest-error', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/** coalesce 记忆：key → { priority, at }（进程内、有界） */
interface CoalesceMemory {
  seen: Map<string, { priority: number; at: number }>;
}

/**
 * 同 coalesceKey 去重判定（纯函数 + 注入记忆）。
 * 放行条件：没见过 / 超出窗口 / **优先级升级**（error 不被 warning 的合并窗口吞掉）。
 * 记忆超出 maxCoalesceEntries 时按最早写入淘汰（Map 保序，取头几个删）。
 */
export function decideCoalesce(
  key: string,
  priority: number,
  options: Pick<IngestOptions, 'now' | 'coalesceWindowMs' | 'maxCoalesceEntries'>,
  memory: CoalesceMemory,
): { emit: boolean } {
  const now = (options.now ?? Date.now)();
  const windowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const max = options.maxCoalesceEntries ?? DEFAULT_MAX_COALESCE;
  const prev = memory.seen.get(key);
  if (prev && now - prev.at < windowMs && priority <= prev.priority) return { emit: false };
  memory.seen.set(key, { priority, at: now });
  while (memory.seen.size > max) {
    const oldest = memory.seen.keys().next();
    if (oldest.done) break;
    memory.seen.delete(oldest.value);
  }
  return { emit: true };
}

/**
 * 默认 coalescer（跨请求共享一份记忆）。
 * 纯逻辑仍可单独测：{@link decideCoalesce} 是纯函数，本工厂只负责持有记忆。
 */
export function createNoticeCoalescer(
  options: Pick<IngestOptions, 'now' | 'coalesceWindowMs' | 'maxCoalesceEntries'> = {},
): NoticeCoalescer {
  const memory: CoalesceMemory = { seen: new Map() };
  return {
    shouldEmit: (key, priority) => decideCoalesce(key, priority, options, memory).emit,
  };
}
