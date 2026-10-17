/**
 * 宿主能力槽（S5）—— 把 `ctx` 上四个 DSH 专属服务收敛成可选接口 `CapabilitySet`，
 * 外加 L0–L3 能力分级表与「端点 → 档位」投影纯函数。
 *
 * ## 为什么要有这一层
 * 上游 dsh-pet 只作为 DSH 插件运行，四个 DSH 专属服务（llm / credentials / deepseekAccount /
 * `on('session/event')`）是**硬依赖**：独立模式把它们换成「明确降级」的替身后，消费方分不清
 * 「这个服务商不支持」与「宿主根本没这个能力」。本模块把两者拆开：
 *   - 能力缺失 = 显式 `capability-missing`（与 `unsupported` / `provider-missing` 并列的第三种理由）；
 *   - `GET /capabilities` 的 `hostCapabilities` 投影让 agent 一眼可判「碎碎念能不能用」，不必试错。
 *
 * ## 分级轴（07 文档 §3 Q3，写进注释以防后人改错）
 * **定级轴是「最坏后果是否不可逆」，不是「读还是写」。** 反例两个都钉在这里：
 *   - `POST /relays/refresh-all` 是写动作但无害（最坏多打几次站点，可重复）→ L2；
 *   - `DELETE /relays/{id}` 不可逆（数据丢失）→ L3。
 * 若按读写两档分，就会出现「为了防删除而把刷新也锁上」——个人自用立刻变难用。
 * 同理：`POST /relays/detect` 会让桌宠向调用方给定的 URL 主动发请求（驱使桌宠对外行动），
 * 但它最坏只是一次可重复的只读 GET（不改站点状态、不耗业务额度）→ 与 `/health` 的 POST 同级 L2；
 * `POST /relays/focus` 虽写持久化，但最坏后果是「气泡聚焦的站不是你想要的」（困惑而非损害，
 * 用户一键可改回），且上游先例 `POST /pet-display`（写用户配置 + 重启 Helper）同样是 L2 → L2。
 *
 * ## 四个可选接口（Q6）
 * DSH 从 `inject` 真填、独立模式从本地 provider 填（S6，本轮未做）、HTTP 摄入轨也可填
 * `sessionEvents`。`sessionEvents` 三个来源**互斥只用一个**（DSH 会话事件 > POST /events > 无），
 * 否则六档工作状态会被两个源同时改写而抖动。
 */

/** 宿主形态：DSH 插件模式 / 独立模式（standalone）。发现文件与 /capabilities 都带这个字段 */
export type HostMode = 'standalone' | 'dsh';

/** 当前宿主形态。判据是 standalone 伪 ctx 上的 `hostMode` 标记（`./standalone/context` 设）；
 *  DSH 的 cordis ctx 没有这个字段 → 'dsh'。 */
export function hostModeOf(ctx: Record<string, unknown>): HostMode {
  return ctx.hostMode === 'standalone' ? 'standalone' : 'dsh';
}

// ---------- 四个可选能力接口（Q5/Q6） ----------

/** LLM 网关（= 现在的 ctx.llm）：清单 + 流式生成 */
export interface PetLlmGateway {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  /** 契约必须是 AsyncIterable：同步返回 undefined / 返回 Promise 都会让 `for await` 直接炸
   *  （0.3.4 的事故根因，见 standalone/context.ts 的血泪注释） */
  stream(options: unknown): AsyncIterable<unknown>;
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>;
}

/** 凭证库（= 现在的 ctx.credentials）：只进不出的 resolve */
export interface PetCredentialVault {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>;
}

/** 账号服务（= ctx.get('deepseekAccount')，软取，不进 inject）：余额快照 */
export interface PetAccountService {
  getBalance(meta: unknown): Promise<unknown>;
}

/** 会话事件源（= 现在的 ctx.on('session/event')）：DSH 宿主独有 */
export interface PetSessionEvents {
  on(channel: string, handler: (session: unknown, event: unknown) => void): () => void;
}

/** 能力槽：四个接口全部可选。缺哪个，哪个的消费方就明确报 capability-missing */
export interface CapabilitySet {
  llm?: PetLlmGateway;
  credentials?: PetCredentialVault;
  account?: PetAccountService;
  sessionEvents?: PetSessionEvents;
}

/** 能力缺失的统一口径（绝不假装成功）——与 unsupported / provider-missing 区分开 */
export function capabilityMissing(what: string): { ok: false; reason: 'capability-missing'; message: string } {
  return { ok: false, reason: 'capability-missing', message: `宿主未提供能力：${what}` };
}

/**
 * 从 ctx 提取 CapabilitySet。
 *
 * **DSH 模式**（无 hostMode 标记）：四个槽位逐个软取——llm / credentials 常在 inject 里，
 * account 经 `ctx.get('deepseekAccount', false)` 软取（没装账号插件时不在场，不报错），
 * sessionEvents 取 `ctx.on`（cordis ctx 恒有，且是真事件系统）。
 *
 * **独立模式**（hostMode === 'standalone'）：伪 ctx 上的替身**不是能力**——
 * `listProviders()` 返 `[]`、`stream()` 一调就抛、`on()` 是 no-op。把它们采信成能力，
 * `/capabilities` 就会撒谎（llm:true 而生成必败）。所以此模式下只认**显式注入**的
 * `ctx.capabilities`（S6 的接线位，当前恒空 → 全部缺失 → 显式 capability-missing）。
 */
export function capabilitiesFrom(ctx: Record<string, unknown>): CapabilitySet {
  const caps: CapabilitySet = {};
  if (hostModeOf(ctx) === 'standalone') {
    // S6 起：独立模式经 ctx.capabilities 注入本地 provider（有注入用注入，无注入才落硬降级）。
    // 只收形状正确的槽位——注入方是个普通对象，逐个校验，不整体信任。
    const injected = ctx.capabilities as Partial<CapabilitySet> | undefined;
    if (injected && typeof injected === 'object') {
      if (injected.llm) caps.llm = injected.llm;
      if (injected.credentials) caps.credentials = injected.credentials;
      if (injected.account) caps.account = injected.account;
      if (injected.sessionEvents) caps.sessionEvents = injected.sessionEvents;
    }
    return caps;
  }
  const llm = ctx.llm as PetLlmGateway | undefined;
  if (llm && typeof llm.listProviders === 'function' && typeof llm.stream === 'function') caps.llm = llm;
  const credentials = ctx.credentials as PetCredentialVault | undefined;
  if (credentials && typeof credentials.resolve === 'function') caps.credentials = credentials;
  const get = ctx.get as ((name: string, fallback?: unknown) => unknown) | undefined;
  const account = typeof get === 'function' ? (get('deepseekAccount', false) as PetAccountService | undefined) : undefined;
  if (account && typeof account.getBalance === 'function') caps.account = account;
  const on = ctx.on as PetSessionEvents['on'] | undefined;
  if (typeof on === 'function') caps.sessionEvents = { on };
  return caps;
}

// ---------- L0–L3 能力分级（Q3） ----------

/** 能力档位 */
export type PetTier = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * 分级表（端点路径均相对 ROUTE_PREFIX，不带前缀；`/health` 在前缀外，是运维存活探测）。
 *
 * 表的内容 = 任务规格 T07 的档位表（07 §3 Q3 的 Condensed 版，与在飞实现的端点一一对应）：
 *   - L0 在场：探活与握手，零副作用；
 *   - L1 只读：全部是「读缓存/读内存」，零网络零凭证；
 *   - L2 驱动：驱使桌宠行动（说话/动画/刷新/摄入），最坏后果可逆；
 *   - L3 改配置与凭证：删站点、改配置结构、停机——最坏后果不可逆，**可选 token 主要为这一档设计**。
 *
 * 投影函数（{@link tierOfEndpoint}） additionally 把下列**同族已实现端点**归并进来
 * （07 §3 Q3 全表里有、任务 Condensed 表里被省略的只读/驱动同胞）：
 * GET /relays/{id}、GET /relays/{id}/balance、GET /config/meta、GET /models、GET /chat（L1），
 * POST /pet-display（L2，上游先例：持久化写 + 重启 Helper 仍归 L2）。
 */
export const CAPABILITY_TIERS: Record<PetTier, readonly string[]> = {
  L0: ['/capabilities', '/agents/hello', '/health'],
  L1: ['/state', '/state/stream', '/relays', '/relays/models', '/agents', '/config'],
  L2: ['/broadcast', '/anim', '/balance', '/events', '/relays/refresh-all', '/relays/detect', '/relays/focus'],
  L3: ['/config', '/reload', '/relays', '/relays/{id}', '/shutdown'],
};

/** relays 子域的动作段（POST 即 L2；`{id}` 段由正则匹配，站点 id 服务端生成不会是这些保留字） */
const RELAY_ACTION_RE = /^relays\/[^/]+\/(refresh|health|models|manual-balance)$/;

/**
 * 端点 → 档位投影（纯函数）。
 *
 * @param method HTTP 方法（大写小写都认）；同一路径不同方法不同档是本函数存在的理由——
 *   `GET /config` 是只读（L1）而 `PUT /config` 改配置结构（L3），`GET /relays` 只读（L1）
 *   而 `POST /relays` 建站（L3）。
 * @param path 相对 ROUTE_PREFIX 的路径（可带或不带前导 `/`；`/health` 亦可）
 * @returns 档位；表外路径（未实现 / 不该经 HTTP 到达）→ undefined，调用方不得当成 L0 放行
 */
export function tierOfEndpoint(method: string, path: string): PetTier | undefined {
  const m = method.toUpperCase();
  // 归一：去前导斜杠、去尾斜杠、去查询（调用方传的应是 pathname，这里双保险）
  const p = path.split('?')[0]?.replace(/^\/+/, '').replace(/\/+$/, '') ?? '';

  // ---- L0：在场（探活 + 握手），任何方法都不改档（hello 只有 POST 一种用法）----
  if (p === 'capabilities' || p === 'agents/hello' || p === 'health') return 'L0';

  // ---- L1：只读 ----
  if (m === 'GET') {
    if (p === 'state' || p === 'state/stream') return 'L1';
    if (p === 'agents' || p === 'config' || p === 'config/meta' || p === 'models' || p === 'chat') return 'L1';
    if (p === 'relays' || p === 'relays/models') return 'L1';
    if (/^relays\/[^/]+$/.test(p) || /^relays\/[^/]+\/balance$/.test(p)) return 'L1'; // 单站详情 / 单站余额（读缓存）
  }

  // ---- L2：驱动（驱使桌宠行动，最坏后果可逆）----
  if (m === 'POST') {
    if (p === 'broadcast' || p === 'anim' || p === 'balance' || p === 'events' || p === 'pet-display') return 'L2';
    if (p === 'relays/refresh-all' || p === 'relays/detect' || p === 'relays/focus') return 'L2';
    if (RELAY_ACTION_RE.test(p)) return 'L2'; // {id}/refresh · {id}/health · {id}/models · {id}/manual-balance
  }

  // ---- L3：改配置与凭证（最坏后果不可逆）----
  if (p === 'reload' && m === 'POST') return 'L3';
  if (p === 'shutdown' && m === 'POST') return 'L3';
  if (p === 'config' && (m === 'PUT' || m === 'POST')) return 'L3';
  if (p === 'relays' && m === 'POST') return 'L3';
  if (/^relays\/[^/]+$/.test(p) && (m === 'PUT' || m === 'DELETE')) return 'L3';

  return undefined;
}

// ---------- /capabilities 的 hostCapabilities 投影 ----------

/** hostCapabilities 投影值（Q6 四个槽位的对外形态） */
export interface HostCapabilitiesProjection {
  llm: boolean;
  /** none = 没有凭证来源；dsh = DSH 凭证库（ctx.credentials）；local-file = 本机 0600 文件（relays 目录） */
  credentials: 'none' | 'dsh' | 'local-file';
  account: boolean;
  /** none = 没有会话事件源；dsh = DSH 会话事件（在场时 HTTP 摄入的 status 段被忽略，互斥规则）；
   *  http = POST /events 摄入轨（独立模式下的唯一来源） */
  sessionEvents: 'none' | 'dsh' | 'http';
}

/**
 * CapabilitySet → hostCapabilities 投影（纯函数）。
 *
 * credentials 的来源标注由**宿主形态**决定而不是能力在不在场：独立模式下凭证落在
 * `relay-credentials.json`（local-file），这是 relays 子域自带的存储，与 ctx.credentials 无关。
 */
export function projectCapabilitySet(caps: CapabilitySet, mode: HostMode, httpIngest = true): HostCapabilitiesProjection {
  // credentials：独立模式的凭证恒在本机文件（relays 目录），与 ctx.credentials 在不在场无关；
  // DSH 模式看凭证库槽位（没装/没注入 → none）。
  const credentials: HostCapabilitiesProjection['credentials'] =
    mode === 'standalone' ? 'local-file' : caps.credentials ? 'dsh' : 'none';
  return {
    llm: Boolean(caps.llm),
    credentials,
    account: Boolean(caps.account),
    sessionEvents: caps.sessionEvents ? 'dsh' : httpIngest ? 'http' : 'none',
  };
}
