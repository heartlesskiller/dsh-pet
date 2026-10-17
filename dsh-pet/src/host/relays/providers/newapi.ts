/**
 * new-api / one-api 系中转站适配器。
 *
 * 端点与认证（**已对真实站点实测**：docs/10-real-site-verification.md，2026-10-17，
 * `https://st.cmjlevi.top`，curl 一手证据；本文所有 F 编号均指该报告的事实编号）：
 *
 * 取数链路（按凭证类型分流，**凭证类型之间不自动降级** —— 修订 #20）：
 * - `api-key`：① `GET /api/usage/token/`（F1：API-Key-only 场景的**第一优先**端点，
 *   直接给 unlimited_quota 布尔 + total_used/total_granted）→ ② billing 双端点
 *   （`/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`）→ ③ 失败上抛
 *   （由编排层降级到手工填写）
 * - `access-token` / `session-cookie`：① `GET /api/user/self`（账户级，仅 AccessToken
 *   有效；F5：API Key 打它必返 HTTP 200 + `{"success":false}`）→ ② `/api/usage/token/`
 *   → ③ billing 双端点
 *
 * 四个解析守卫（全部有真站对应证据）：
 * ① `unlimited_quota===true` 或 `hard_limit_usd>=1e8` → 无限额度（F2）：不显示为余额、
 *    不参与告警，`data.total` 放**已用金额**；
 * ② `total_available` 为负绝不能当余额（F3：实测站 −17291179）；
 * ③ `total_usage` 单位是**分**、`total_used`/`total_granted` 单位是 **quota**，不可混用（F4）；
 * ④ HTTP 200 + `{"success":false}` / `{"code":false}` 必须判失败（F5）。
 * 另：CF 挑战页按内容特征判 `blocked`（F7：无 `cf-mitigated` 头不等于被拦，
 * 见到 `server: cloudflare` 不判；修订 #23 判定表）。
 *
 * 纪律继承上游：本文件只负责**成功路径**，任何失败一律 `throw`（带分类 code），
 * 由查询入口统一落成结构化失败 —— **绝不伪造 0 余额**。
 */

import type { MoneyBalance } from '../../balance/types';
import { detectQuotaPerUnit, quotaPerUnitOf, quotaToAmount } from '../money';
import type { RelayFetchContext, RelayHealthResult, RelayModelEntry, RelayProvider } from '../types';

/** 货币：中转站几乎都以美元计费。CNY 站由站点数据自带时另说，这里只做兜底 */
const CURRENCY = 'USD';

/** provider id 前缀（展示层据此区分「这是中转站」而不是官方服务商） */
export const RELAY_PROVIDER_PREFIX = 'relay:';

/** billing 订阅接口的「无限额度」哨兵：hard_limit_usd >= 1e8（F2，真站实测 100000000） */
export const UNLIMITED_SENTINEL_USD = 100_000_000;

// ---------- 错误分类 ----------

/** fetch 层错误分类。编排层（../index.ts）按 code 归成 blocked / rate-limited / fetch-error */
export type RelayFetchErrorCode = 'blocked' | 'rate-limited' | 'http' | 'parse';

/** 带分类 code 与 HTTP 状态位的错误（不静默当 0，也不丢失排错信息） */
export function classifiedError(message: string, code: RelayFetchErrorCode, status?: number): Error {
  return Object.assign(new Error(message), { code, ...(status !== undefined ? { status } : {}) });
}

/** 被拦截 / 被限流：不重试别的端点（重试只会加重对方负担），直接上抛 */
export function isBlockedOrLimited(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return code === 'blocked' || code === 'rate-limited';
}

// ---------- 请求头与 URL ----------

/**
 * 请求头构造。
 *
 * 默认 `Authorization: Bearer <token>`（new-api 文档口径）。站点 `extraHeaders` 里**同名键优先**
 * —— 这是给 one-api 老版本（要裸 `Authorization: <token>`）留的逃生口，也方便带
 * `New-Api-User` 之类的附加头（修订 #21：该头已不参与鉴权，值就是用户数字 ID）。
 * extraHeaders 视为敏感值，绝不进日志。
 */
function authHeaders(ctx: RelayFetchContext): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'dsh-pet-relays' };
  const secret = ctx.kind === 'manual' ? '' : ctx.secret;
  if (secret) headers['Authorization'] = 'Bearer ' + secret;
  if (ctx.extraHeaders) {
    for (const [k, v] of Object.entries(ctx.extraHeaders)) headers[k] = v;
  }
  return headers;
}

/** 归一化 Base URL：去尾斜杠、去 `/v1` 后缀（用户常把 `https://x.com/v1` 整个粘进来） */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('relays: 站点 URL 缺失');
  let s = raw.trim();
  if (s.length === 0) throw new Error('relays: 站点 URL 为空');
  if (!/^https?:\/\//i.test(s)) throw new Error('relays: 站点 URL 必须是 http(s):// 开头');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '');
  return s;
}

// ---------- 基础解析工具 ----------

/** 宽松取对象（数组 / null / 非对象 → undefined） */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 必填数字：非法 → throw（不静默当 0） */
function num(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('relays: 响应缺少或非法字段 ' + what);
  return n;
}

/** `parseUserSelf` / `parseTokenUsage` / billing 的成功结果形状（与 `RelayBalanceSuccess` 同构） */
export interface NewApiBalanceSuccess {
  ok: true;
  provider: string;
  shape: 'money';
  source: 'auto';
  scope: 'account' | 'token';
  data: MoneyBalance;
  unlimited?: boolean;
  spent?: string;
}

/**
 *  money 形态成功结果构造。
 * 不变量（上游口径）：`sumMoney(granted, toppedUp) === total` —— 中转站不区分赠送/充值，
 * 硬拆会造出不存在的语义，故 `granted = total`、`toppedUp = '0.00'`。
 */
function moneySuccess(fields: {
  scope: 'account' | 'token';
  data: MoneyBalance;
  unlimited?: boolean;
  spent?: string;
}): NewApiBalanceSuccess {
  return {
    ok: true,
    provider: RELAY_PROVIDER_PREFIX + 'new-api',
    shape: 'money',
    source: 'auto',
    scope: fields.scope,
    data: fields.data,
    ...(fields.unlimited !== undefined ? { unlimited: fields.unlimited } : {}),
    ...(fields.spent !== undefined ? { spent: fields.spent } : {}),
  };
}

// ---------- 各端点响应解析（纯函数，测试直接喂真站响应原文） ----------

/**
 * `/api/user/self` 响应 → 账户级成功结果（**纯函数**）。
 *
 * 真站事实：该端点**仅 AccessToken 有效**，API Key 打它返 HTTP 200 +
 * `{"success":false,"message":"无权进行此操作，access token 无效"}`（F5）——
 * 所以 `success:false` 必须判失败（HTTP 200 不代表成功）。
 *
 * `quota`（剩余）与 `used_quota`（已用）都存在时，`fullBalance = (quota + used_quota) / rate`
 * 即「历史总额」—— 这是档位动画的基准，**由数据推出而不是猜一个数**。
 * 只有 `quota` 没有 `used_quota` 时不设 fullBalance（上游口径：没基准就不播档位动画）。
 *
 * 守卫：`quota` 为负 → throw（F3 泛化：账户级 quota 同样不能为负）。
 */
export function parseUserSelf(
  body: unknown,
  ctx: Pick<RelayFetchContext, 'quotaPerUnit'>,
): NewApiBalanceSuccess {
  const root = obj(body);
  if (!root) throw new Error('relays: /api/user/self 响应不是对象');
  // 兼容 `{success, data}` 与直接平铺两种返回
  const data = obj(root.data) ?? root;
  if (root.success === false) {
    throw new Error('relays: 站点返回失败：' + String(root.message ?? '未知原因'));
  }
  const quota = num(data.quota, 'quota');
  if (quota < 0) {
    throw new Error('relays: /api/user/self 的 quota 为负（' + quota + '），不当余额');
  }
  const usedRaw = data.used_quota;
  const rate = quotaPerUnitOf(ctx.quotaPerUnit);

  const remaining = quotaToAmount(quota, rate);
  let fullBalance: string | undefined;
  if (usedRaw !== undefined && usedRaw !== null && usedRaw !== '') {
    fullBalance = quotaToAmount(quota + num(usedRaw, 'used_quota'), rate);
  }

  return moneySuccess({
    scope: 'account',
    data: {
      currency: CURRENCY,
      total: remaining,
      granted: remaining,
      toppedUp: '0.00',
      ...(fullBalance !== undefined ? { fullBalance } : {}),
    },
  });
}

/**
 * `/api/usage/token/` 响应 → 令牌级成功结果（**纯函数**）。
 *
 * 真站事实（F1/F2/F3，docs/10 §2.4 原文）：
 * - `unlimited_quota: true` 是**显式布尔字段**，比 1e8 哨兵可靠，是「无限额度」的首选判据；
 * - `total_used` / `total_granted` 单位是 **quota**（F4：与 billing 的「分」不可混用）；
 * - `total_available` 可能为负（unlimited 站的产物，实测 −17291179）——**绝不能当余额**；
 * - 响应包在 `{code, data, message}` 里，`code:false` 即失败（new-api 口径，非 success）。
 *
 * 无限额度时：`data.total` 放**已用金额**（与 `spent` 同值），客户端渲染
 * 「无限额度 · 已用 $X」—— 用户真正关心的是「我用了多少钱」，而不是一个不存在的余额。
 */
export function parseTokenUsage(
  body: unknown,
  ctx: Pick<RelayFetchContext, 'quotaPerUnit'>,
): NewApiBalanceSuccess {
  const root = obj(body);
  if (!root) throw new Error('relays: /api/usage/token/ 响应不是对象');
  if (root.code === false || root.success === false) {
    throw new Error('relays: 站点返回失败：' + String(root.message ?? '未知原因'));
  }
  const data = obj(root.data) ?? root;
  const rate = quotaPerUnitOf(ctx.quotaPerUnit);
  const used = num(data.total_used, 'total_used');
  const grantedRaw = data.total_granted;
  const granted =
    grantedRaw === undefined || grantedRaw === null || grantedRaw === ''
      ? undefined
      : num(grantedRaw, 'total_granted');
  const availableRaw = data.total_available;
  const available =
    availableRaw === undefined || availableRaw === null || availableRaw === ''
      ? undefined
      : Number(availableRaw);

  if (data.unlimited_quota === true) {
    const spent = quotaToAmount(used, rate);
    return moneySuccess({
      scope: 'token',
      unlimited: true,
      spent,
      data: { currency: CURRENCY, total: spent, granted: spent, toppedUp: '0.00' },
    });
  }

  // 非无限：剩余优先取 total_available（非负），否则 granted − used；两者都推不出非负值 → 炸
  let remaining: number | undefined;
  if (available !== undefined && Number.isFinite(available) && available >= 0) remaining = available;
  else if (granted !== undefined && granted - used >= 0) remaining = granted - used;
  if (remaining === undefined) {
    throw new Error(
      'relays: /api/usage/token/ 推不出非负剩余额度（total_available=' +
        String(availableRaw) +
        '，total_granted=' +
        String(grantedRaw) +
        '，total_used=' +
        used +
        '），不当余额',
    );
  }
  const fullBalance = granted !== undefined && granted > 0 ? quotaToAmount(granted, rate) : undefined;
  const total = quotaToAmount(remaining, rate);
  return moneySuccess({
    scope: 'token',
    data: {
      currency: CURRENCY,
      total,
      granted: total,
      toppedUp: '0.00',
      ...(fullBalance !== undefined ? { fullBalance } : {}),
    },
  });
}

/** `/dashboard/billing/subscription` 响应 → 订阅硬上限 + 无限额度哨兵判定（F2） */
export interface NewApiSubscription {
  /** 订阅硬上限（USD 数值） */
  hardLimitUsd: number;
  /** `hard_limit_usd >= 1e8` → 无限额度哨兵（真站实测 100000000） */
  unlimited: boolean;
}

export function parseSubscription(body: unknown): NewApiSubscription {
  const root = obj(body);
  if (!root) throw new Error('relays: /dashboard/billing/subscription 响应不是对象');
  const hard = num(root.hard_limit_usd, 'hard_limit_usd');
  return { hardLimitUsd: hard, unlimited: hard >= UNLIMITED_SENTINEL_USD };
}

/**
 * `/v1/dashboard/billing/usage` 响应 → 已用金额（**纯函数**）。
 *
 * 真站事实（F4）：`total_usage` 单位是**分**（实测 3458.2358 分 = $34.582358，
 * 与 `/api/usage/token/` 的 total_used/quota_per_unit 交叉验算完全相等）——
 * 与 quota 单位不可混用，这里只除 100，不碰换算率。
 */
export interface NewApiUsage {
  usedUsd: string;
}

export function parseUsage(body: unknown): NewApiUsage {
  const root = obj(body);
  if (!root) throw new Error('relays: /v1/dashboard/billing/usage 响应不是对象');
  const cents = num(root.total_usage, 'total_usage');
  if (cents < 0) throw new Error('relays: total_usage 为负（' + cents + '），不当已用');
  return { usedUsd: (cents / 100).toFixed(2) };
}

/**
 * `/api/status` 响应 → 站点信号（**纯函数**；detect 与换算率探测都复用它）。
 *
 * 真站事实（F6/F8）：`system_name` 会被站长自定义（实测 "st-api"）、`version` 可能为空串
 * —— 都**不可用于类型识别**；可靠信号是 `HeaderNavModules` / `SidebarModulesAdmin` 存在。
 * `quota_per_unit` 可自动探测（F8，该端点免鉴权）。
 */
export interface NewApiStatusSignal {
  /** 探测到的换算率（探不到 → 键不存在） */
  quotaPerUnit?: number;
  /** 站点是否以货币计价（`display_in_currency`） */
  displayInCurrency?: boolean;
  /** 站长自定义站名（仅记进 evidence 作弱辅助，不参与判定） */
  systemName?: string;
  /** 是否含 new-api 特征字段（类型识别的可靠信号） */
  looksLikeNewApi: boolean;
  evidence: string[];
}

export function parseStatus(body: unknown): NewApiStatusSignal {
  const root = obj(body);
  const data = obj(root?.data) ?? root;
  const evidence: string[] = [];
  const looksLikeNewApi =
    data !== undefined && ('HeaderNavModules' in data || 'SidebarModulesAdmin' in data);
  if (looksLikeNewApi) {
    evidence.push('/api/status 含 HeaderNavModules / SidebarModulesAdmin（new-api 特征字段）');
  }
  const rate = detectQuotaPerUnit(body);
  return {
    ...(rate !== undefined ? { quotaPerUnit: rate } : {}),
    ...(data?.display_in_currency !== undefined ? { displayInCurrency: data.display_in_currency === true } : {}),
    ...(typeof data?.system_name === 'string' ? { systemName: data.system_name } : {}),
    looksLikeNewApi,
    evidence,
  };
}

/**
 * `/v1/models` 响应 → 模型 id 列表（**纯函数**）。
 *
 * OpenAI 兼容形状：`{ data: [{ id: 'gpt-4o' }, ...] }`。部分站点把模型放在
 * `data.models` 或直接平铺成数组 —— 三种都兼容，解析不出来就抛错（不返回空列表冒充成功）。
 */
export function parseModels(body: unknown): string[] {
  const root = obj(body);
  const list = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
      ? (root!.data as unknown[])
      : Array.isArray(obj(root?.data)?.models)
        ? (obj(root!.data)!.models as unknown[])
        : undefined;
  if (!list) throw new Error('relays: /v1/models 响应里找不到模型数组');
  const ids: string[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : obj(item)?.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  if (ids.length === 0) throw new Error('relays: /v1/models 返回 0 个模型');
  // 去重 + 排序，保证同站点多次拉取结果稳定（便于对比与快照）
  return [...new Set(ids)].sort();
}

// ---------- HTTP 层（带 CF / 限流分类） ----------

/** CF 挑战页 / Bot Detection 的内容特征（修订 #23 判定表；F7：无 cf-mitigated 不判） */
function looksLikeChallenge(res: Response, text: string): boolean {
  if (res.headers.get('cf-mitigated')) return true;
  if (res.headers.get('x-datadome')) return true;
  const head = text.slice(0, 2000);
  return /challenge-platform|Just a moment\.\.\.|cf-browser-verification|Checking your browser|Turnstile/i.test(head);
}

/** `server: cloudflare` + 403 → 判定表里的拦截形态（F7：仅 403 时判，200 不判） */
function isCloudflareForbidden(res: Response): boolean {
  return res.status === 403 && (res.headers.get('server') ?? '').toLowerCase().includes('cloudflare');
}

async function getJson(url: string, ctx: RelayFetchContext, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: authHeaders(ctx),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 429) {
    throw classifiedError('relays: HTTP 429 站点限流（' + url + '）', 'rate-limited', 429);
  }
  if (isCloudflareForbidden(res)) {
    throw classifiedError('relays: HTTP 403 疑似 Cloudflare / 反代拦截（' + url + '）', 'blocked', 403);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // HTTP 200 + 非 JSON：挑战页 / HTML 错误页都落这里。带上状态码便于上层分类。
    if (looksLikeChallenge(res, text)) {
      throw classifiedError('relays: HTTP ' + res.status + ' 返回挑战页而非 JSON（疑似被拦截）', 'blocked', res.status);
    }
    throw classifiedError('relays: 响应不是 JSON（HTTP ' + res.status + '，长度 ' + text.length + '）', 'http', res.status);
  }
  if (!res.ok) {
    throw classifiedError('relays: HTTP ' + res.status + ' ' + res.statusText, 'http', res.status);
  }
  return parsed;
}

/**
 * billing 双端点取数（api-key 链路的第 ② 级）。
 *
 * 真站事实（F4）：`/dashboard/billing/subscription` 与 `/v1/dashboard/billing/usage`
 * 两条路径都注册（`/v1` 前缀不是版本分界）；只要 API Key（中间件 `TokenAuth()`）。
 * 无限额度哨兵站：先判 unlimited，已用从 usage 拿（docs/10 §3.2-1）。
 *
 * ⚠️ 剩余公式 `hard_limit_usd − total_usage/100` 在**非无限 Key** 上**【待验证】**
 * （docs/10 V2：实测站令牌是 unlimited，公式无法实测；需要一个有额度的 Key）。
 */
async function fetchViaBilling(
  base: string,
  ctx: RelayFetchContext,
): Promise<NewApiBalanceSuccess> {
  const [subBody, usageBody] = await Promise.all([
    getJson(base + '/dashboard/billing/subscription', ctx),
    getJson(base + '/v1/dashboard/billing/usage', ctx),
  ]);
  const sub = parseSubscription(subBody);
  const usage = parseUsage(usageBody);
  if (sub.unlimited) {
    return moneySuccess({
      scope: 'token',
      unlimited: true,
      spent: usage.usedUsd,
      data: { currency: CURRENCY, total: usage.usedUsd, granted: usage.usedUsd, toppedUp: '0.00' },
    });
  }
  const remaining = sub.hardLimitUsd - Number(usage.usedUsd);
  if (!(remaining >= 0)) {
    throw new Error(
      'relays: billing 剩余为负（hard_limit_usd=' + sub.hardLimitUsd + ' − 已用 ' + usage.usedUsd + '），不当余额',
    );
  }
  const total = remaining.toFixed(2);
  return moneySuccess({
    scope: 'token',
    data: {
      currency: CURRENCY,
      total,
      granted: total,
      toppedUp: '0.00',
      fullBalance: sub.hardLimitUsd.toFixed(2),
    },
  });
}

// ---------- 探测与模型抓取（T03 端点用；失败口径与 fetch 一致） ----------

/**
 * 探测 `/api/status` 原文（detect 与换算率探测用；该端点免鉴权 —— F8）。
 * 失败按 getJson 的口径抛带 code 的错误，由调用方决定怎么呈现。
 */
export async function probeStatus(baseUrl: string, ctx: RelayFetchContext): Promise<unknown> {
  return getJson(normalizeBaseUrl(baseUrl) + '/api/status', ctx, 10_000);
}

/** 探测 `/v1/models` 原文（detect 的强信号；需要凭证） */
export async function probeModels(baseUrl: string, ctx: RelayFetchContext): Promise<unknown> {
  return getJson(normalizeBaseUrl(baseUrl) + '/v1/models', ctx, 10_000);
}

/**
 * `/api/pricing` 响应 → 模型条目（**纯函数**；带倍率/价格 —— F9）。
 *
 * 真站事实：该端点**免鉴权**可读，且带 `model_ratio` / `model_price`（比价原料）；
 * `model_ratio: 0` 是合法值（按次计费模型），`null`/缺失才不给键。
 */
export function parsePricing(body: unknown): RelayModelEntry[] {
  const root = obj(body);
  const list = Array.isArray(root?.data)
    ? (root!.data as unknown[])
    : Array.isArray(body)
      ? (body as unknown[])
      : undefined;
  if (!list) throw new Error('relays: /api/pricing 响应里找不到模型数组');
  const out: RelayModelEntry[] = [];
  for (const item of list) {
    const o = obj(item);
    const name = typeof o?.model_name === 'string' ? o.model_name : typeof o?.id === 'string' ? o.id : '';
    if (name.length === 0) continue;
    const ratioRaw = o?.model_ratio;
    const priceRaw = o?.model_price;
    out.push({
      id: name,
      ...(ratioRaw !== undefined && ratioRaw !== null && Number.isFinite(Number(ratioRaw)) ? { ratio: Number(ratioRaw) } : {}),
      ...(priceRaw !== undefined && priceRaw !== null && Number.isFinite(Number(priceRaw)) ? { price: Number(priceRaw) } : {}),
    });
  }
  if (out.length === 0) throw new Error('relays: /api/pricing 返回 0 个模型');
  // 去重 + 排序，保证同站点多次拉取结果稳定（便于对比与快照）
  const seen = new Map<string, RelayModelEntry>();
  for (const m of out) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 抓取站点模型清单：**优先 `/api/pricing`**（带倍率，修订 #14），失败回落 `/v1/models`。
 * 被拦截 / 被限流不回落（重试只会加重对方负担），直接上抛。
 */
export async function fetchSiteModels(
  baseUrl: string,
  ctx: RelayFetchContext,
): Promise<{ source: 'pricing' | 'models'; models: RelayModelEntry[] }> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    return { source: 'pricing', models: parsePricing(await getJson(base + '/api/pricing', ctx, 15_000)) };
  } catch (e) {
    if (isBlockedOrLimited(e)) throw e;
    // pricing 拿不到（404 / 需鉴权 / 形状不同）→ 回落 /v1/models（只有 id，没有倍率）
  }
  const models = parseModels(await getJson(base + '/v1/models', ctx, 15_000));
  return { source: 'models', models: models.map((id) => ({ id })) };
}

// ---------- provider ----------

export const newApiProvider: RelayProvider = {
  kinds: ['new-api'],
  credentialKinds: ['access-token', 'api-key', 'session-cookie'],
  async fetch(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    // 三级取数链路按凭证类型分流（修订 #20：凭证类型之间不自动降级，只做端内降级）
    const chain: Array<() => Promise<NewApiBalanceSuccess>> =
      ctx.kind === 'api-key'
        ? [
            // F1：API-Key-only 场景的第一优先端点
            async () => parseTokenUsage(await getJson(base + '/api/usage/token/', ctx), ctx),
            async () => fetchViaBilling(base, ctx),
          ]
        : [
            // access-token / session-cookie：账户级优先（F5：API Key 打它必失败）
            async () => parseUserSelf(await getJson(base + '/api/user/self', ctx), ctx),
            async () => parseTokenUsage(await getJson(base + '/api/usage/token/', ctx), ctx),
            async () => fetchViaBilling(base, ctx),
          ];
    let lastError: unknown;
    for (const step of chain) {
      try {
        return await step();
      } catch (e) {
        // 被拦截 / 被限流不重试别的端点（重试只会加重对方负担），直接上抛
        if (isBlockedOrLimited(e)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  },
  async health(ctx) {
    const base = normalizeBaseUrl(ctx.baseUrl);
    const started = Date.now();
    const res = await fetch(base + '/api/status', {
      headers: authHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 429) {
      throw classifiedError('relays: /api/status 返回 429 限流', 'rate-limited', 429);
    }
    if (res.status === 401 || res.status === 403) {
      // status 端点要鉴权 ≠ 凭证一定错，但这是唯一能拿到的信号
      throw classifiedError('relays: /api/status 返回 ' + res.status, 'http', res.status);
    }
    if (!res.ok) throw classifiedError('relays: /api/status HTTP ' + res.status, 'http', res.status);
    const out: Omit<RelayHealthResult, 'siteId'> = {
      health: 'online',
      endpoint: base + '/api/status',
      status: res.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
    return out;
  },
};

// ---------- 待实测（不静默跳过，明确记账；docs/10 §四） ----------
// 1. `/api/user/self` 的账户级余额真实形状（quota 是剩余还是总额、used_quota 语义）——
//    需要 AccessToken 才能实测；当前解析按 one-api 源码口径写 + 负值守卫。
// 2. 有额度（非无限）Key 的 `hard_limit_usd − total_usage/100` 剩余公式 —— 需要非无限 Key。
// 3. Cloudflare 真拦截时的响应形态 —— 需要被挑战过的站点（判定表已按修订 #23 实现）。
// 4. `display_in_currency = false` 的站点行为、done-hub / Veloera / VoAPI 等分支。
// 以上都要等用户提供对应素材才能闭环；本文件不再有「未对真实站点跑通过」的整体性未知。
