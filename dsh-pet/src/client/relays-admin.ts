/**
 * 设置页「中转站管理」（settings.section 插槽，id: relays-admin，order: 31）。
 *
 * 管的是 LLM API 中转站舰队：站点 CRUD、类型识别（detect）、余额/健康查看、手工余额
 * 降级、换算率核对、焦点站点切换。数据全部走宿主的 `/dsh-pet-7340/relays` 子域
 * （契约见仓库根 API.md 第五节 + openapi.yaml 的 /relays 路径；本站只消费、不重造）。
 *
 * 与 settings.ts 的 makePetConfigSection 同一套工厂模式：
 * - client 半侧是 __ModuleLoader__ 单文件形态，react 不能顶层 import，只能由 DSH 的
 *   require('react') 在运行时注入 → 组件依赖作为 rt 参数传进工厂；
 * - 自带字典命名空间（NS = 'relays.admin'）与 zh/en 两份字典（由 app.ts 注册进 locale）；
 * - 组件内 fetch 一律**相对路径**（'/dsh-pet-7340/relays…'），与设置页现有约定一致；
 * - 样式自带一份 CSS（dsh-pet-ra__ 前缀，data-plugin-css 去重注入）——不依赖 pet-config
 *   那块样式表先被注入（两个 section 谁先打开不确定）。
 *
 * 纯逻辑（URL 校验 / 表单归约 / detect 决策 / 错误态映射 / 余额格 / 健康点 / focus 决策 /
 * mapLimit）全部导出为纯函数：单测直接打（src/client/relays-admin.test.ts），组件只做装配。
 * DOM 级断言走 dev 验收脚本（scripts/dev/verify-relays-admin.ts，renderToStaticMarkup）。
 *
 * 三态兜底（硬要求：不许白屏、不许静默失败）：
 * - 空态：无站点 → 引导添加（空态文案 + 添加按钮，而非一张空列表）；
 * - 错误态：列表拉取失败 → 可读文案 + 重试按钮（role=alert）；
 * - 未确认态：rateConfirmed !== true 的站 → 横幅常驻 + 首次遇到强制弹核对对话框
 *   （用户确认后 PUT rateConfirmed:true；「稍后」只压制本次会话，不落库）。
 */
import type { ChangeEvent, Dispatch, FunctionComponent, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

import { fetchState } from '../shared/state';
import { readModelMatrix, type MatrixCellState, type RelaysModelMatrix } from '../shared/relays';

// ---------- 契约镜像（API.md §5 / openapi.yaml 的 /relays schema） ----------
// client 半侧不跨层 import 宿主代码（host 依赖 node:fs 等，浏览器产物里解析不到）；
// 这些形状按契约定型，改动以 API.md / openapi.yaml 为准（check:openapi 有守）。

/** 站点类型（= provider 的 id 词干） */
export type RelayKind = 'new-api' | 'sub2api' | 'openai-compat';

/** 全部站点类型（表单下拉用） */
export const RELAY_KINDS: readonly RelayKind[] = ['new-api', 'sub2api', 'openai-compat'];

/**
 * 凭证种类。**引导顺序即声明顺序：API Key 优先**（新版 new-api 经 /api/usage/token/
 * 可查令牌级用量与无限额度标记，覆盖面最广）→ AccessToken（账户级）→ Cookie（高级逃生口）
 * → manual（无凭证、余额手工填写的显式降级）。
 */
export type RelayCredentialKind = 'access-token' | 'api-key' | 'session-cookie' | 'manual';

export const CREDENTIAL_KINDS: readonly RelayCredentialKind[] = ['api-key', 'access-token', 'session-cookie', 'manual'];

/** one-api / new-api 默认换算率：500000 quota = 1 USD（建站显式写它并标记未确认，修订 #11） */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** 连通性分类（三者文案必须不同：用户要能分清「站点挂了」还是「只是查不到余额」） */
export type RelayHealthKind = 'online' | 'unreachable' | 'auth-failed' | 'blocked' | 'unknown';

/** 余额失败 reason（六种，一个出口） */
export type RelayFailReason =
  'unsupported' | 'credential-missing' | 'fetch-error' | 'manual' | 'blocked' | 'rate-limited';

/** 手工余额（降级路径；必须带「手工」标注与填写时间，不得伪装成实时数据） */
export interface RelayManualBalance {
  amount: string;
  currency: string;
  updatedAt: string;
}

/** 站点 + 脱敏后的凭证摘要（GET /relays 的唯一允许形状；credential.masked 绝不明文） */
export interface RelaySiteAdminView {
  id: string;
  name: string;
  url: string;
  kind: RelayKind;
  note?: string;
  quotaPerUnit: number;
  rateConfirmed?: boolean;
  lowThreshold?: string;
  enabled: boolean;
  manualBalance?: RelayManualBalance;
  createdAt: string;
  updatedAt: string;
  credential: {
    kind: RelayCredentialKind;
    /** 脱敏预览（形如 sk-ab****wxyz）；manual 时为空串 */
    masked: string;
    present: boolean;
    extraHeaders?: Record<string, string>;
    lastValidatedAt?: string;
  };
}

/** 单站余额结果（POST /relays/{id}/refresh 的响应；成功/失败两种都收） */
export interface RelayBalanceInfo {
  ok: boolean;
  source?: 'auto' | 'manual';
  /** 无限额度站：total 是已用金额（语义是「已用」不是「余额」） */
  unlimited?: boolean;
  spent?: string;
  rateUnconfirmed?: boolean;
  total?: string;
  currency?: string;
  scope?: 'account' | 'token';
  reason?: RelayFailReason;
  message?: string;
}

/** 连通性探测结果（POST /relays/{id}/health 的响应） */
export interface RelayHealthInfo {
  siteId: string;
  health: string;
  endpoint?: string;
  status?: number;
  message?: string;
  latencyMs?: number;
  checkedAt?: string;
}

/** 站点类型识别结果（POST /relays/detect 的 detect 段；失败也是 200 + unknown） */
export interface RelayDetectInfo {
  kind: RelayKind | 'unknown';
  confidence: 'certain' | 'likely' | 'unknown';
  /** 判定依据（人类可读，给 UI 展示「为什么判定成这个类型」） */
  evidence: string[];
  /** 从 /api/status 探测到的换算率（探不到 → 键不存在，调用方标 rateUnconfirmed） */
  suggestedQuotaPerUnit?: number;
  displayInCurrency?: boolean;
  /** 探测失败时的人类可读原因（kind = unknown 时） */
  message?: string;
}

/** 站点入参（POST /relays 与 PUT /relays/{id} 共用的 body 形状；凭证单独一段） */
export interface RelayCredentialBody {
  kind: RelayCredentialKind;
  secret?: string;
  extraHeaders?: Record<string, string>;
}

export interface RelaySiteBody {
  name: string;
  url: string;
  kind: RelayKind;
  note: string;
  quotaPerUnit: number;
  rateConfirmed: boolean;
  lowThreshold: string;
  enabled: boolean;
  /** 缺省 = 不动已有凭证；{kind:'manual'} = 显式清除/声明无凭证；带 secret = 写入 */
  credential?: RelayCredentialBody;
}

// ---------- 表单状态（新增/编辑共用；纯数据，归约逻辑可单测） ----------

export interface RelaySiteForm {
  name: string;
  url: string;
  kind: RelayKind;
  note: string;
  credentialKind: RelayCredentialKind;
  /** 新填的凭证值；留空 = 不动已有凭证（编辑态只显示掩码） */
  secret: string;
  headerKey: string;
  headerValue: string;
  lowThreshold: string;
  enabled: boolean;
  /** 数字输入用字符串（空输入框就是 ''，避免 Number('') = 0 的歧义） */
  quotaPerUnit: string;
  rateConfirmed: boolean;
  manualAmount: string;
  manualCurrency: string;
}

/** 新建表单的默认值：API Key 优先、默认换算率显式写出且**未确认**（修订 #11：绝不静默默认） */
export function emptySiteForm(): RelaySiteForm {
  return {
    name: '',
    url: '',
    kind: 'new-api',
    note: '',
    credentialKind: 'api-key',
    secret: '',
    headerKey: '',
    headerValue: '',
    lowThreshold: '',
    enabled: true,
    quotaPerUnit: String(DEFAULT_QUOTA_PER_UNIT),
    rateConfirmed: false,
    manualAmount: '',
    manualCurrency: 'USD',
  };
}

/** 站点视图 → 编辑表单。已有凭证只显示掩码（secret 留空 = 不动），绝不明文回显 */
export function formFromSite(site: RelaySiteAdminView): RelaySiteForm {
  return {
    name: site.name,
    url: site.url,
    kind: site.kind,
    note: site.note ?? '',
    credentialKind: site.credential.kind,
    secret: '',
    headerKey: '',
    headerValue: '',
    lowThreshold: site.lowThreshold ?? '',
    enabled: site.enabled,
    quotaPerUnit: String(site.quotaPerUnit),
    rateConfirmed: site.rateConfirmed === true,
    manualAmount: site.manualBalance?.amount ?? '',
    manualCurrency: site.manualBalance?.currency ?? 'USD',
  };
}

// ---------- 纯逻辑：URL 校验 ----------

/** URL 校验结果（镜像宿主 normalizeBaseUrl 的规则，但返回结构化结果不抛） */
export type RelayUrlCheck = { ok: true; url: string } | { ok: false; error: 'empty' | 'scheme' };

/**
 * 校验并归一化站点 URL：去首尾空白、去尾斜杠、去 `/v1` 后缀（用户常把
 * `https://x.com/v1` 整个粘进来）；非 http(s) / 空 → 结构化错误（调用方给红字）。
 */
export function checkRelayUrl(raw: string): RelayUrlCheck {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return { ok: false, error: 'empty' };
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: 'scheme' };
  return { ok: true, url: s.replace(/\/+$/, '').replace(/\/v1$/i, '') };
}

// ---------- 纯逻辑：金额 / 币种 ----------

/** 金额格式：非负、至多两位小数（与宿主 money.ts / normalizeManualBalance 同口径） */
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** 手工余额金额校验（空串由调用方按「清除」处理，这里只管非空格式） */
export function checkAmount(raw: string): { ok: true; amount: string } | { ok: false } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0 || !AMOUNT_RE.test(s)) return { ok: false };
  return { ok: true, amount: s };
}

/** 金额展示：USD → $、CNY → ¥、其余币种老老实实带代码（不假装是美元） */
export function moneyText(amount: string, currency: string): string {
  const c = (currency ?? '').toUpperCase();
  if (c === 'USD') return '$' + amount;
  if (c === 'CNY') return '¥' + amount;
  return amount + ' ' + c;
}

// ---------- 纯逻辑：表单校验与 body 构造 ----------

export type RelayFormError = 'name' | 'url' | 'quota' | 'threshold' | 'header' | 'manual';

/**
 * 表单就地校验（与宿主 validateSiteInput 同一套规则：非法宿主会回 400，这里先给红字）。
 * 凭证值**不**强制：允许先建站后补凭证（或走 manual 降级）。
 */
export function validateSiteForm(form: RelaySiteForm): { ok: true } | { ok: false; error: RelayFormError } {
  if (form.name.trim().length === 0) return { ok: false, error: 'name' };
  if (!checkRelayUrl(form.url).ok) return { ok: false, error: 'url' };
  const quota = Number(form.quotaPerUnit);
  if (!Number.isFinite(quota) || quota <= 0) return { ok: false, error: 'quota' };
  const threshold = form.lowThreshold.trim();
  if (threshold.length > 0 && !AMOUNT_RE.test(threshold)) return { ok: false, error: 'threshold' };
  if ((form.headerKey.trim() === '') !== (form.headerValue.trim() === '')) return { ok: false, error: 'header' };
  const amount = form.manualAmount.trim();
  const currency = form.manualCurrency.trim();
  // 与宿主 normalizeManualBalance 同口径：金额为空 = 不设置/清除（币种忽略）；
  // 金额非空时才要求币种齐备且格式合法（至多两位小数）
  if (amount.length > 0) {
    if (!AMOUNT_RE.test(amount) || currency.length === 0) return { ok: false, error: 'manual' };
  }
  return { ok: true };
}

/** 附加请求头（单键值对；不需要就留空 → undefined，不进 body） */
export function parseExtraHeaders(key: string, value: string): Record<string, string> | undefined {
  const k = key.trim();
  const v = value.trim();
  if (k === '' || v === '') return undefined;
  return { [k]: v };
}

/**
 * 表单 → POST/PUT body（SiteInput + credential 段）。
 *
 * - lowThreshold / note 恒带（宿主 upsertSite 对空串是「清空」语义：`??` 只在 nullish 时
 *   保留旧值，'' 会落盘并被 selectLowSites 的 `!threshold` 判为不告警）；
 * - credential：manual = 显式声明无凭证；填了新 secret = 写入；留空 = **缺省不动**
 *   （宿主的 readCredential 对缺省键 = 不动、显式 null = 清除）；
 * - manualBalance **不进 body**：设置/清除走专用端点 POST /relays/{id}/manual-balance
 *   （那个端点负责写 updatedAt；upsertSite 的入参 manualBalance 不带时间戳）。
 */
export function buildSiteBody(form: RelaySiteForm): RelaySiteBody {
  const url = checkRelayUrl(form.url);
  const body: RelaySiteBody = {
    name: form.name.trim(),
    url: url.ok ? url.url : form.url.trim(),
    kind: form.kind,
    note: form.note.trim(),
    quotaPerUnit: Number(form.quotaPerUnit),
    rateConfirmed: form.rateConfirmed,
    lowThreshold: form.lowThreshold.trim(),
    enabled: form.enabled,
  };
  if (form.credentialKind === 'manual') {
    body.credential = { kind: 'manual' };
  } else if (form.secret.trim().length > 0) {
    const credential: RelayCredentialBody = { kind: form.credentialKind, secret: form.secret.trim() };
    const headers = parseExtraHeaders(form.headerKey, form.headerValue);
    if (headers !== undefined) credential.extraHeaders = headers;
    body.credential = credential;
  }
  return body;
}

// ---------- 纯逻辑：detect 结果渲染决策 ----------

export type DetectDecision =
  | {
      kind: 'apply';
      siteKind: RelayKind;
      confidence: 'certain' | 'likely';
      evidence: string[];
      suggestedQuota?: number;
    }
  | { kind: 'unknown'; message: string; evidence: string[] };

/**
 * detect 响应 → 界面决策：
 * - 识别出类型（certain/likely）→ 回填类型（likely 也回填，但文案提示核对）；
 * - unknown → **不静默失败**：回原因，引导用户手动选类型或先手工填余额。
 */
export function decideDetect(detect: RelayDetectInfo | null): DetectDecision | null {
  if (detect === null) return null;
  if (detect.kind === 'unknown') {
    return { kind: 'unknown', message: detect.message ?? '', evidence: detect.evidence };
  }
  return {
    kind: 'apply',
    siteKind: detect.kind,
    confidence: detect.confidence === 'certain' ? 'certain' : 'likely',
    evidence: detect.evidence,
    ...(detect.suggestedQuotaPerUnit !== undefined ? { suggestedQuota: detect.suggestedQuotaPerUnit } : {}),
  };
}

// ---------- 纯逻辑：错误态映射 ----------

export type RelayErrorPhase = 'load' | 'save' | 'act';

export interface RelayErrorView {
  /** 阶段标题键（errLoad / errSave / errAct） */
  titleKey: string;
  /** 细节键（errNetwork / errNotFound / errBadRequest / errServer / errUnknown） */
  detailKey: string;
  /** 是否值得重试（网络/5xx 值得；404/400 重试没意义） */
  retry: boolean;
}

/**
 * 请求错误 → 可读文案键。status 为数字走 HTTP 映射，否则按网络错（fetch 抛的）。
 * 组件侧拼 `t(titleKey) + '：' + t(detailKey)`——纯逻辑不碰字典，方便单测。
 */
export function mapRelayError(err: unknown, phase: RelayErrorPhase): RelayErrorView {
  const raw = err as { status?: unknown } | null | undefined;
  const status = typeof raw?.status === 'number' && Number.isFinite(raw.status) ? raw.status : null;
  const titleKey = phase === 'load' ? 'errLoad' : phase === 'save' ? 'errSave' : 'errAct';
  if (status === null) return { titleKey, detailKey: 'errNetwork', retry: true };
  if (status === 404) return { titleKey, detailKey: 'errNotFound', retry: false };
  if (status === 400) return { titleKey, detailKey: 'errBadRequest', retry: false };
  if (status >= 500) return { titleKey, detailKey: 'errServer', retry: true };
  return { titleKey, detailKey: 'errUnknown', retry: true };
}

// ---------- 纯逻辑：余额格 / 健康点 / 焦点 ----------

/** 一行的余额展示决策（auto 带口径 / manual 带「手工」/ unlimited 是「已用」/ failed 给原因） */
export type BalanceCell =
  | { kind: 'auto'; text: string; scope: 'account' | 'token' | null; unconfirmed: boolean }
  | { kind: 'manual'; text: string }
  | { kind: 'unlimited'; text: string; unconfirmed: boolean }
  | { kind: 'failed'; reason: RelayFailReason; message: string }
  | { kind: 'none' };

export function balanceCellOf(result: RelayBalanceInfo | undefined): BalanceCell {
  if (result === undefined) return { kind: 'none' };
  if (result.ok !== true) {
    const reason: RelayFailReason =
      result.reason === 'unsupported' ||
      result.reason === 'credential-missing' ||
      result.reason === 'fetch-error' ||
      result.reason === 'manual' ||
      result.reason === 'blocked' ||
      result.reason === 'rate-limited'
        ? result.reason
        : 'fetch-error';
    return { kind: 'failed', reason, message: result.message ?? '' };
  }
  const currency = result.currency ?? 'USD';
  if (result.source === 'manual') return { kind: 'manual', text: moneyText(result.total ?? '-', currency) };
  if (result.unlimited === true) {
    return {
      kind: 'unlimited',
      text: moneyText(result.spent ?? result.total ?? '-', currency),
      unconfirmed: result.rateUnconfirmed === true,
    };
  }
  return {
    kind: 'auto',
    text: moneyText(result.total ?? '-', currency),
    scope: result.scope ?? null,
    unconfirmed: result.rateUnconfirmed === true,
  };
}

/** 健康状态归键：白名单外（含脏数据）一律 'unknown'（不假装探到了） */
export function healthKeyOf(health: string | undefined): RelayHealthKind {
  return health === 'online' || health === 'unreachable' || health === 'auth-failed' || health === 'blocked'
    ? health
    : 'unknown';
}

/** 焦点切换目标：点当前焦点 = 清除（回全舰队汇总口径）；点别的 = 设过去 */
export function focusTarget(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

// ---------- 纯逻辑：并发受限的映射（批量刷新/探测用） ----------

/**
 * 并发受限 map：保序返回，同时最多 limit 个在飞。
 * 中转站多为小站，批量刷新/探测要限流（宿主舰队刷新同口径：并发 4）。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const lanes = Math.max(1, Math.min(limit, items.length));
  for (let lane = 0; lane < lanes; lane += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next;
          next += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

// ---------- API 层（相对路径 fetch；错误统一落 RelaysApiError） ----------

/** 请求失败：status = null 表示网络层错误（fetch 本身抛了），否则是 HTTP 状态码 */
export class RelaysApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'RelaysApiError';
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new RelaysApiError(e instanceof Error ? e.message : String(e), null);
  }
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok)
    throw new RelaysApiError('HTTP ' + res.status + (text.length > 0 ? '：' + text.slice(0, 200) : ''), res.status);
  return data as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  req<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

// ---- 防御式解析（脏数据 → 兜底，不抛；单站响应用严格解析，缺字段直接抛） ----

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseSiteView(raw: unknown): RelaySiteAdminView {
  const o = asObj(raw);
  const id = o ? asStr(o.id) : undefined;
  const name = o ? asStr(o.name) : undefined;
  const url = o ? asStr(o.url) : undefined;
  const kind = o?.kind;
  if (!id || !name || !url || (kind !== 'new-api' && kind !== 'sub2api' && kind !== 'openai-compat')) {
    throw new RelaysApiError('站点响应缺少必填字段（id/name/url/kind）', 200);
  }
  const cred = asObj(o?.credential);
  const credKind = cred?.kind;
  const manual = asObj(o?.manualBalance);
  return {
    id,
    name,
    url,
    kind,
    ...(asStr(o?.note) !== undefined ? { note: asStr(o?.note) } : {}),
    quotaPerUnit:
      typeof o?.quotaPerUnit === 'number' && Number.isFinite(o.quotaPerUnit) ? o.quotaPerUnit : DEFAULT_QUOTA_PER_UNIT,
    ...(asBool(o?.rateConfirmed) !== undefined ? { rateConfirmed: asBool(o?.rateConfirmed) } : {}),
    ...(asStr(o?.lowThreshold) !== undefined ? { lowThreshold: asStr(o?.lowThreshold) } : {}),
    enabled: asBool(o?.enabled) ?? true,
    ...(manual && asStr(manual.amount) !== undefined && asStr(manual.currency) !== undefined
      ? {
          manualBalance: {
            amount: asStr(manual.amount) ?? '',
            currency: asStr(manual.currency) ?? 'USD',
            updatedAt: asStr(manual.updatedAt) ?? '',
          },
        }
      : {}),
    createdAt: asStr(o?.createdAt) ?? '',
    updatedAt: asStr(o?.updatedAt) ?? '',
    credential: {
      kind:
        credKind === 'access-token' || credKind === 'api-key' || credKind === 'session-cookie' || credKind === 'manual'
          ? credKind
          : 'manual',
      masked: cred !== undefined && typeof cred.masked === 'string' ? cred.masked : '',
      present: cred?.present === true,
      ...(cred?.extraHeaders !== undefined && asObj(cred.extraHeaders) !== undefined
        ? { extraHeaders: cred.extraHeaders as Record<string, string> }
        : {}),
      ...(asStr(cred?.lastValidatedAt) !== undefined ? { lastValidatedAt: asStr(cred?.lastValidatedAt) } : {}),
    },
  };
}

function parseSiteViews(raw: unknown): RelaySiteAdminView[] {
  return Array.isArray(raw) ? raw.map(parseSiteView) : [];
}

function parseBalance(raw: unknown): RelayBalanceInfo {
  const o = asObj(raw);
  if (!o) return { ok: false, reason: 'fetch-error', message: '余额响应形状非法' };
  const data = asObj(o.data);
  const reason = o.reason;
  return {
    ok: o.ok === true,
    ...(o.source === 'auto' || o.source === 'manual' ? { source: o.source } : {}),
    ...(o.unlimited === true ? { unlimited: true } : {}),
    ...(asStr(o.spent) !== undefined ? { spent: asStr(o.spent) } : {}),
    ...(o.rateUnconfirmed === true ? { rateUnconfirmed: true } : {}),
    ...(asStr(data?.total) !== undefined ? { total: asStr(data?.total) } : {}),
    ...(asStr(data?.currency) !== undefined ? { currency: asStr(data?.currency) } : {}),
    ...(o.scope === 'account' || o.scope === 'token' ? { scope: o.scope } : {}),
    ...(reason === 'unsupported' ||
    reason === 'credential-missing' ||
    reason === 'fetch-error' ||
    reason === 'manual' ||
    reason === 'blocked' ||
    reason === 'rate-limited'
      ? { reason }
      : {}),
    ...(asStr(o.message) !== undefined ? { message: asStr(o.message) } : {}),
  };
}

function parseHealth(raw: unknown): RelayHealthInfo {
  const o = asObj(raw);
  return {
    siteId: o ? (asStr(o.siteId) ?? '') : '',
    health: o ? (asStr(o.health) ?? 'unknown') : 'unknown',
    ...(o && asStr(o.message) !== undefined ? { message: asStr(o.message) } : {}),
    ...(o && asStr(o.endpoint) !== undefined ? { endpoint: asStr(o.endpoint) } : {}),
    ...(o && typeof o.status === 'number' ? { status: o.status } : {}),
    ...(o && typeof o.latencyMs === 'number' ? { latencyMs: o.latencyMs } : {}),
    ...(o && asStr(o.checkedAt) !== undefined ? { checkedAt: asStr(o.checkedAt) } : {}),
  };
}

function parseDetect(raw: unknown): RelayDetectInfo {
  const o = asObj(raw);
  const kind = o?.kind;
  const confidence = o?.confidence;
  const evidence = Array.isArray(o?.evidence) ? o.evidence.filter((v): v is string => typeof v === 'string') : [];
  return {
    kind: kind === 'new-api' || kind === 'sub2api' || kind === 'openai-compat' ? kind : 'unknown',
    confidence: confidence === 'certain' || confidence === 'likely' ? confidence : 'unknown',
    evidence,
    ...(o !== undefined && typeof o.suggestedQuotaPerUnit === 'number' && Number.isFinite(o.suggestedQuotaPerUnit)
      ? { suggestedQuotaPerUnit: o.suggestedQuotaPerUnit }
      : {}),
    ...(o?.displayInCurrency === true ? { displayInCurrency: true } : {}),
    ...(asStr(o?.message) !== undefined ? { message: asStr(o?.message) } : {}),
  };
}

/** 中转站管理 API（base = '/dsh-pet-7340/relays'；dev 验收可传绝对 URL） */
export interface RelaysAdminApi {
  list(): Promise<RelaySiteAdminView[]>;
  create(body: RelaySiteBody): Promise<RelaySiteAdminView>;
  update(id: string, body: RelaySiteBody): Promise<RelaySiteAdminView>;
  remove(id: string): Promise<RelaySiteAdminView[]>;
  refresh(id: string): Promise<RelayBalanceInfo>;
  health(id: string): Promise<RelayHealthInfo>;
  detect(input: { url: string; credential?: RelayCredentialBody }): Promise<RelayDetectInfo>;
  focus(siteId: string | null): Promise<string | null>;
  manualBalance(id: string, amount: string, currency: string): Promise<RelaySiteAdminView>;
  fetchModels(id: string): Promise<{ count: number; source: string }>;
  /** 模型矩阵（GET /relays/models）。矩阵本身由 host 算好，这里只解析不重算 */
  fetchModelMatrix(): Promise<RelaysModelMatrix | null>;
}

export function makeRelaysAdminApi(base: string): RelaysAdminApi {
  const at = (path: string): string => base + path;
  return {
    list: async () => {
      const d = await req<{ sites?: unknown }>(at(''));
      return parseSiteViews(d?.sites);
    },
    create: async (body) => {
      const d = await post<{ site?: unknown }>(at(''), body);
      return parseSiteView(d?.site);
    },
    update: async (id, body) => {
      const d = await req<{ site?: unknown }>(at('/' + encodeURIComponent(id)), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return parseSiteView(d?.site);
    },
    remove: async (id) => {
      const d = await req<{ sites?: unknown }>(at('/' + encodeURIComponent(id)), { method: 'DELETE' });
      return parseSiteViews(d?.sites);
    },
    refresh: async (id) => parseBalance(await post(at('/' + encodeURIComponent(id) + '/refresh'))),
    health: async (id) => parseHealth(await post(at('/' + encodeURIComponent(id) + '/health'))),
    detect: async (input) => {
      const d = await post<{ detect?: unknown }>(at('/detect'), input);
      return parseDetect(d?.detect);
    },
    focus: async (siteId) => {
      const d = await post<{ focusSiteId?: unknown }>(at('/focus'), { siteId: siteId ?? '' });
      const id = d?.focusSiteId;
      return typeof id === 'string' && id.length > 0 ? id : null;
    },
    manualBalance: async (id, amount, currency) => {
      const d = await post<{ site?: unknown }>(at('/' + encodeURIComponent(id) + '/manual-balance'), {
        amount,
        currency,
      });
      return parseSiteView(d?.site);
    },
    fetchModels: async (id) => {
      const d = await post<{ ok?: unknown; models?: unknown; source?: unknown; message?: unknown }>(
        at('/' + encodeURIComponent(id) + '/models'),
      );
      // 宿主抓取失败也是 200 + {ok:false, reason, message}（不静默失败）→ 翻成错误
      if (d?.ok !== true) {
        throw new RelaysApiError(asStr(d?.message) ?? '模型抓取失败', 200);
      }
      const models = Array.isArray(d?.models) ? d.models : [];
      return { count: models.length, source: asStr(d?.source) ?? '' };
    },
    fetchModelMatrix: async () => {
      const d = await req<unknown>(at('/models'));
      // 形状不符 → null（与 readRelays 同口径：不抛，交给 UI 显示"加载失败"）
      return readModelMatrix(d);
    },
  };
}

/**
 * 读当前焦点站点（/state 的 sections.relays 叶；host 在写 focus 后立即重刷该叶）。
 * 拉不到 / 形状不对 → null（无焦点 = 全舰队口径；派生数据，不抛）。
 */
export async function readFocusSiteId(stateBase = '/dsh-pet-7340/state'): Promise<string | null> {
  const s = await fetchState(stateBase);
  const data = s?.sections?.relays?.data;
  if (data === null || data === undefined || typeof data !== 'object') return null;
  const id = (data as { focusSiteId?: unknown }).focusSiteId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// ---------- 样式（dsh-pet-ra__ 前缀；只放行内样式表达不了的伪类/悬浮） ----------

const RELAYS_ADMIN_CSS = [
  '.dsh-pet-ra{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-pet-ra__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',
  '.dsh-pet-ra__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-ra__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-pet-ra__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-ra__cardActs{margin-left:auto;display:flex;align-items:center;gap:8px}',
  '.dsh-pet-ra__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '@container (max-width:400px){.dsh-pet-ra__grid2{grid-template-columns:minmax(0,1fr)}}',
  '.dsh-pet-ra__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-ra__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-ra__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-pet-ra__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-ra__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  // 开关（勾选框 + 标题 + 问号）
  '.dsh-pet-ra__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-ra__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-ra__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-pet-ra__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
  '.dsh-pet-ra__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  '.dsh-pet-ra__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-ra__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-ra__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-ra__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-ra__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-ra__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-ra__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',
  // 站点行：状态点 / 名称 / 标签 / 余额 / 操作
  '.dsh-pet-ra__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-pet-ra__row:last-child{border-bottom:none}',
  '.dsh-pet-ra__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-ra__dot.is-online{background:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-ra__dot.is-auth-failed{background:var(--dsw-alias-state-warning-primary,#faad14)}',
  '.dsh-pet-ra__dot.is-unreachable{background:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-ra__dot.is-blocked{background:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-ra__rowName{display:inline-flex;align-items:center;gap:4px;min-width:0;font-weight:500;overflow-wrap:anywhere}',
  '.dsh-pet-ra__rowActs{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.dsh-pet-ra__star{border:none;background:transparent;padding:0 2px;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.dsh-pet-ra__star.is-on{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-ra__tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dsh-pet-ra__tag.is-manual{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-ra__tag.is-warn{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);cursor:pointer}',
  '.dsh-pet-ra__bal{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
  '.dsh-pet-ra__bal.is-failed{color:var(--dsw-alias-state-error-primary)}',
  // 焦点按钮组 / 横幅 / 识别结果 / 空态 / 消息
  '.dsh-pet-ra__focus{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-ra__banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:10px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
  '.dsh-pet-ra__detect{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  // 模型矩阵：三态必须**视觉可区分**（未知 ≠ 无，用户会据格子判断"这站没我要的模型"）
  '.dsh-pet-ra__mxTable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;margin-top:8px}',
  '.dsh-pet-ra__mxTable th,.dsh-pet-ra__mxTable td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:middle}',
  '.dsh-pet-ra__mxTable th{font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dsh-pet-ra__mxModel{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}',
  '.dsh-pet-ra__mxCell{display:inline-block;min-width:22px;padding:1px 7px;border-radius:6px;text-align:center;font-weight:600}',
  '.dsh-pet-ra__mxCell.is-yes{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-secondary)}',
  '.dsh-pet-ra__mxCell.is-no{color:var(--dsw-alias-label-tertiary);background:transparent;font-weight:400}',
  // 未知：琥珀底 + 问号，与"无"（灰、无底）明确区分
  '.dsh-pet-ra__mxCell.is-unknown{color:var(--dsw-alias-state-warning-primary,#b45309);background:var(--dsw-alias-state-warning-secondary,#fef3c7)}',
  '.dsh-pet-ra__detect ul{margin:0;padding-left:18px}',
  '.dsh-pet-ra__detect.is-unknown{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-ra__empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-ra__msg{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-ra__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-ra__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  // 问号 + 悬浮说明（与设置页同一套 data-tip → ::after 手法）
  '.dsh-pet-ra__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
  '.dsh-pet-ra__q::after{display:none;content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
  '.dsh-pet-ra__q:hover::after{display:block;opacity:1;visibility:visible}',
  '.dsh-pet-ra__q.is-end::after{left:auto;right:-4px}',
].join('\n');

const relaysAdminCssTag = 'dsh-pet/relays-admin.css';

/** 注入设置页 CSS（只注入一次；与宠物页面同一套 data-plugin-css 去重） */
function injectRelaysAdminCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + relaysAdminCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = relaysAdminCssTag;
  tag.textContent = RELAYS_ADMIN_CSS;
  document.head.appendChild(tag);
}

// ---------- 字典（zh-CN / en；键集必须一致，单测有 parity 断言） ----------

/** 字典命名空间（app.ts 注册进 locale；与桌宠配置的 'pet.config' 分开） */
export const NS = 'relays.admin';

export const zh: Record<string, string> = {
  nav: '中转站管理',
  intro: '管理 LLM API 中转站：余额、连通性与焦点站点。数据由宿主实时查询，凭证只存本机、绝不明文外泄。',
  cardSites: '站点',
  cardSitesHint: '每个站点独立查询余额与连通性；带「手工」标签的余额是用户填写值、不是实时数据。',
  focusTitle: '焦点站点',
  focusHint: '桌宠气泡展示焦点站的余额；选「全舰队」则展示全部站点汇总。只影响展示，绝不做请求转发。',
  focusFleet: '全舰队（汇总）',
  focusCleared: '已切回全舰队汇总。',
  focusSetOk: '焦点站点已切换。',
  refreshAll: '刷新全部',
  add: '添加站点',
  edit: '编辑',
  remove: '删除',
  confirmTitle: '确认操作',
  confirmRemove: '确定删除站点「{name}」吗？站点与凭证会一起删除，不可恢复。',
  cancel: '取消',
  ok: '知道了',
  retry: '重试',
  loading: '正在加载站点…',
  empty: '还没有中转站。点「添加站点」，粘贴站点 URL 会自动识别类型。',
  save: '保存',
  saved: '已保存。',
  removed: '站点已删除。',
  errLoad: '加载失败',
  errSave: '保存失败',
  errAct: '操作失败',
  errNetwork: '网络不通（宿主无响应）',
  errNotFound: '站点不存在（可能已被删除）',
  errBadRequest: '参数被宿主拒绝',
  errServer: '宿主内部错误',
  errUnknown: '未知错误',
  // ---- 表单 ----
  urlLabel: '站点 URL',
  urlHint: 'Base URL（https:// 开头；末尾 /v1 会自动去掉）。粘贴或失焦后自动识别类型。',
  nameLabel: '名称',
  nameHint: '站点备注名（站点列表与桌宠气泡里显示）。',
  kindLabel: '类型',
  kindHint: '通常由识别自动填入；识别不出时按站点实际类型手动选。',
  'kind.new-api': 'new-api / one-api',
  'kind.sub2api': 'Sub2API',
  'kind.openai-compat': 'OpenAI 兼容',
  noteLabel: '备注',
  noteHint: '可选：站点用途、到期时间等，只在本页显示。',
  credLabel: '凭证',
  credHint:
    'API Key 覆盖面最广（推荐）；AccessToken 可查账户级余额；Cookie 是高级逃生口；手工 = 无凭证、余额手工填写。',
  'credKind.api-key': 'API Key',
  'credKind.access-token': 'AccessToken',
  'credKind.session-cookie': 'Cookie（高级）',
  'credKind.manual': '手工（无凭证）',
  secretLabel: '凭证值',
  secretPlaceholder: '留空 = 不变',
  secretHint: '只存本机凭证文件，绝不明文外泄；编辑时留空 = 保持原有凭证不变。',
  testCred: '测试',
  testCredBusy: '测试中…',
  testCredNone: '先填凭证值；对已建站点留空再测（测的是已存凭证）。',
  testCredOk: '凭证可用：{detail}',
  testCredFail: '凭证测试失败：{detail}',
  headerLabel: '附加请求头（高级）',
  headerKeyPh: '头名称（如 New-Api-User）',
  headerValuePh: '头的值',
  headerHint: '个别站点要额外头（如 New-Api-User: <uid>）；不需要就留空。',
  thresholdLabel: '低余额阈值',
  thresholdHint: '余额低于该金额时桌宠告警（与余额同币种）；留空 = 不告警。',
  enabledLabel: '参与刷新',
  enabledHint: '关掉后该站不参与周期刷新与告警（仍可手动刷新）。',
  quotaLabel: '换算率（quota/金额）',
  quotaHint: 'one-api / new-api 默认 500000 quota = 1 USD；站长可能改过，请按站点实际核对。',
  rateConfirmedLabel: '换算率已确认',
  rateConfirmedHint: '未确认的站余额带「未确认」标记且不参与告警——确认前请先核对上面的换算率。',
  manualAmountLabel: '手工余额金额',
  manualCurrencyLabel: '币种（USD / CNY）',
  manualAmountHint: '查不到余额时的手工填写值；会带「手工」标签与填写时间，绝不伪装成实时数据。',
  // ---- 识别（detect） ----
  detect: '识别',
  detecting: '识别中…',
  detectCertain: '已识别：{kind}（双信号命中）',
  detectLikely: '可能是：{kind}（单信号，请核对）',
  detectEvidence: '判定依据',
  detectQuota: '探测到换算率 {quota}（已填入，请核对后勾选确认）',
  detectNone: '识别结果：无法确定类型。可手动选择类型，或先手工填写余额。',
  detectUnknownMsg: '识别失败：{message}',
  // ---- 行内展示 ----
  balanceLabel: '余额',
  'scope.account': '账户级',
  'scope.token': '令牌级',
  manualTag: '手工',
  manualAt: '填写于 {time}',
  unconfirmedTag: '换算率未确认',
  unlimitedText: '无限额度 · 已用 {amount}',
  refresh: '刷新',
  modelsBtn: '抓模型',
  modelsOk: '已抓取 {count} 个模型。',
  modelsFail: '模型抓取失败',
  matrixTitle: '模型矩阵',
  matrixLoad: '加载矩阵',
  matrixLoading: '加载中…',
  matrixHint: '行 = 全部站点的模型并集。「有」= 该站有；「无」= 抓过、确认没有；「未知」= 没抓过（不是没有）。想补哪列就在该站点行上点「抓模型」。',
  matrixColModel: '模型',
  matrixSummary: '{models} 个模型 × {sites} 个站点',
  matrixUnknownSites: '{count} 个站未抓取（未知 ≠ 没有）',
  matrixEmpty: '还没有抓过任何模型：先在站点行上点「抓模型」。',
  matrixBad: '矩阵数据形状不符（host 返回异常）',
  matrixFail: '矩阵加载失败',
  'matrix.mark.yes': '有',
  'matrix.mark.no': '无',
  'matrix.mark.unknown': '未知',
  'matrix.state.yes': '该站有這個模型',
  'matrix.state.no': '抓过，确认没有',
  'matrix.state.unknown': '没抓过 = 未知（不是没有）',
  setFocus: '设为焦点',
  clearFocus: '取消焦点（回全舰队）',
  credNone: '无凭证',
  'health.online': '在线',
  'health.unreachable': '连不上',
  'health.auth-failed': '认证失败',
  'health.blocked': '被拦截',
  'health.unknown': '未知',
  'reason.unsupported': '类型未登记',
  'reason.credential-missing': '未配置凭证',
  'reason.fetch-error': '查询失败',
  'reason.manual': '待手工填写',
  'reason.blocked': '被拦截',
  'reason.rate-limited': '被限流',
  manualEntry: '手工填写',
  // ---- 对话框 ----
  manualDialogTitle: '手工填写余额 —— {name}',
  manualDialogBody: '自动查询不到时手工填写。该值带「手工」标签与填写时间，绝不伪装成实时数据；金额留空保存 = 清除。',
  manualAmountPh: '金额（如 12.34）',
  manualCurrencyPh: '币种（USD / CNY）',
  manualSaved: '手工余额已保存。',
  manualClear: '清除',
  rateDialogTitle: '核对换算率 —— {name}',
  rateDialogBody:
    '该站换算率尚未确认，当前按默认 {quota} quota = 1 {currency} 计算——站长可能改过这个值，余额可能算错。请核对后确认（或去编辑页改换算率）。',
  rateDialogConfirm: '已核对，确认',
  rateDialogLater: '稍后再说',
  rateConfirmedOk: '换算率已确认。',
  unconfirmedBanner: '{count} 个站换算率未确认，余额数据可能不准。',
  // ---- 表单校验红字 ----
  'errForm.name': '请填写站点名称。',
  'errForm.url': '请填写正确的站点 URL（https:// 开头）。',
  'errForm.quota': '换算率必须是正数。',
  'errForm.threshold': '低余额阈值必须是非负金额（至多两位小数）。',
  'errForm.header': '附加请求头的名称与值必须成对填写。',
  'errForm.manual': '手工余额的金额与币种必须成对填写，且金额为非负数字（至多两位小数）。',
};

export const en: Record<string, string> = {
  nav: 'Relay Sites',
  intro:
    'Manage your LLM API relay fleet: balances, connectivity and the focus site. Balances are queried live by the host; credentials stay on this machine and are never sent back in plain text.',
  cardSites: 'Sites',
  cardSitesHint:
    'Each site is queried for balance and connectivity on its own; a balance tagged "manual" was typed in by you — it is not live data.',
  focusTitle: 'Focus site',
  focusHint:
    'The pet bubble shows the focus site balance; "Whole fleet" shows the summary of all sites. Display only — requests are never forwarded.',
  focusFleet: 'Whole fleet (summary)',
  focusCleared: 'Switched back to the whole-fleet summary.',
  focusSetOk: 'Focus site updated.',
  refreshAll: 'Refresh all',
  add: 'Add site',
  edit: 'Edit',
  remove: 'Delete',
  confirmTitle: 'Confirm action',
  confirmRemove: 'Delete site "{name}"? The site and its credential are removed together — this cannot be undone.',
  cancel: 'Cancel',
  ok: 'Got it',
  retry: 'Retry',
  loading: 'Loading sites…',
  empty: 'No relay sites yet. Click "Add site" — pasting the site URL auto-detects its type.',
  save: 'Save',
  saved: 'Saved.',
  removed: 'Site deleted.',
  errLoad: 'Failed to load',
  errSave: 'Failed to save',
  errAct: 'Action failed',
  errNetwork: 'Network unreachable (no response from the host)',
  errNotFound: 'Site not found (it may have been deleted)',
  errBadRequest: 'Rejected by the host (bad input)',
  errServer: 'Host internal error',
  errUnknown: 'Unknown error',
  // ---- form ----
  urlLabel: 'Site URL',
  urlHint:
    'Base URL (https:// required; a trailing /v1 is stripped automatically). The type is detected on paste or blur.',
  nameLabel: 'Name',
  nameHint: 'Display name (shown in the site list and the pet bubble).',
  kindLabel: 'Type',
  kindHint: 'Usually filled in by detection; pick the real type manually when detection cannot tell.',
  'kind.new-api': 'new-api / one-api',
  'kind.sub2api': 'Sub2API',
  'kind.openai-compat': 'OpenAI-compatible',
  noteLabel: 'Note',
  noteHint: 'Optional: purpose, expiry date, etc. Shown on this page only.',
  credLabel: 'Credential',
  credHint:
    'API Key covers the most sites (recommended); AccessToken reads account-level balance; Cookie is an advanced escape hatch; manual = no credential, balance typed in by hand.',
  'credKind.api-key': 'API Key',
  'credKind.access-token': 'AccessToken',
  'credKind.session-cookie': 'Cookie (advanced)',
  'credKind.manual': 'Manual (no credential)',
  secretLabel: 'Secret',
  secretPlaceholder: 'empty = unchanged',
  secretHint:
    'Stored in the local credential file only, never echoed in plain text; leave empty while editing to keep the current credential.',
  testCred: 'Test',
  testCredBusy: 'Testing…',
  testCredNone: 'Type a secret to test it; for an existing site leave it empty (tests the stored credential).',
  testCredOk: 'Credential works: {detail}',
  testCredFail: 'Credential test failed: {detail}',
  headerLabel: 'Extra header (advanced)',
  headerKeyPh: 'Header name (e.g. New-Api-User)',
  headerValuePh: 'Header value',
  headerHint: 'Some sites need an extra header (e.g. New-Api-User: <uid>); leave empty if not needed.',
  thresholdLabel: 'Low-balance threshold',
  thresholdHint:
    'The pet warns when the balance drops below this amount (same currency as the balance); empty = no warning.',
  enabledLabel: 'Include in refresh',
  enabledHint: 'When off, this site is skipped by the periodic refresh and alerts (manual refresh still works).',
  quotaLabel: 'Quota rate (quota/currency)',
  quotaHint:
    'one-api / new-api default: 500000 quota = 1 USD; the owner may have changed it — verify against the site.',
  rateConfirmedLabel: 'Quota rate confirmed',
  rateConfirmedHint:
    'An unconfirmed site carries an "unconfirmed" tag on its balance and is excluded from alerts — verify the rate above before confirming.',
  manualAmountLabel: 'Manual balance amount',
  manualCurrencyLabel: 'Currency (USD / CNY)',
  manualAmountHint:
    'Hand-typed fallback when the live query fails; always tagged "manual" with its fill time — never disguised as live data.',
  // ---- detection ----
  detect: 'Detect',
  detecting: 'Detecting…',
  detectCertain: 'Detected: {kind} (both signals matched)',
  detectLikely: 'Probably: {kind} (single signal — please verify)',
  detectEvidence: 'Evidence',
  detectQuota: 'Detected quota rate {quota} (filled in — verify, then tick confirmed)',
  detectNone: 'Detection could not determine the type. Pick the type manually, or fill in a manual balance first.',
  detectUnknownMsg: 'Detection failed: {message}',
  // ---- row display ----
  balanceLabel: 'Balance',
  'scope.account': 'Account',
  'scope.token': 'Token',
  manualTag: 'manual',
  manualAt: 'filled at {time}',
  unconfirmedTag: 'rate unconfirmed',
  unlimitedText: 'Unlimited · used {amount}',
  refresh: 'Refresh',
  modelsBtn: 'Models',
  modelsOk: 'Fetched {count} models.',
  modelsFail: 'Model fetch failed',
  matrixTitle: 'Model matrix',
  matrixLoad: 'Load matrix',
  matrixLoading: 'Loading…',
  matrixHint:
    'Rows = the union of models across all sites. "Yes" = this site has it; "No" = fetched and confirmed absent; "Unknown" = never fetched (not the same as absent). Use "Models" on a site row to fill a column.',
  matrixColModel: 'Model',
  matrixSummary: '{models} models × {sites} sites',
  matrixUnknownSites: '{count} site(s) never fetched (unknown ≠ absent)',
  matrixEmpty: 'No models fetched yet — use "Models" on a site row first.',
  matrixBad: 'Matrix payload shape is invalid (host returned something unexpected)',
  matrixFail: 'Matrix load failed',
  'matrix.mark.yes': 'Yes',
  'matrix.mark.no': 'No',
  'matrix.mark.unknown': '?',
  'matrix.state.yes': 'This site has this model',
  'matrix.state.no': 'Fetched — confirmed absent',
  'matrix.state.unknown': 'Never fetched = unknown (not absent)',
  setFocus: 'Set as focus',
  clearFocus: 'Clear focus (back to fleet)',
  credNone: 'No credential',
  'health.online': 'Online',
  'health.unreachable': 'Unreachable',
  'health.auth-failed': 'Auth failed',
  'health.blocked': 'Blocked',
  'health.unknown': 'Unknown',
  'reason.unsupported': 'Unsupported type',
  'reason.credential-missing': 'No credential',
  'reason.fetch-error': 'Query failed',
  'reason.manual': 'Awaiting manual entry',
  'reason.blocked': 'Blocked',
  'reason.rate-limited': 'Rate limited',
  manualEntry: 'Fill manually',
  // ---- dialogs ----
  manualDialogTitle: 'Manual balance — {name}',
  manualDialogBody:
    'Type in the balance when the live query cannot reach it. The value carries a "manual" tag and its fill time — never disguised as live data; saving with an empty amount clears it.',
  manualAmountPh: 'Amount (e.g. 12.34)',
  manualCurrencyPh: 'Currency (USD / CNY)',
  manualSaved: 'Manual balance saved.',
  manualClear: 'Clear',
  rateDialogTitle: 'Verify quota rate — {name}',
  rateDialogBody:
    "This site's quota rate is unconfirmed; balances are currently computed with the default {quota} quota = 1 {currency} — the site owner may have changed it, so the balance may be wrong. Verify and confirm (or edit the rate on this page).",
  rateDialogConfirm: 'Verified, confirm',
  rateDialogLater: 'Later',
  rateConfirmedOk: 'Quota rate confirmed.',
  unconfirmedBanner: '{count} site(s) have an unconfirmed quota rate — balances may be off.',
  // ---- form validation messages ----
  'errForm.name': 'Please enter a site name.',
  'errForm.url': 'Please enter a valid site URL (https:// required).',
  'errForm.quota': 'The quota rate must be a positive number.',
  'errForm.threshold': 'The low-balance threshold must be a non-negative amount (at most two decimals).',
  'errForm.header': 'The extra header name and value must be filled in together.',
  'errForm.manual':
    'Manual balance amount and currency go together, and the amount must be a non-negative number (at most two decimals).',
};

// ---------- 组件工厂 ----------

/**
 * 制造「中转站管理」设置页组件（工厂函数）。
 *
 * 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
 * react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
 * 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
 * （与 settings.ts 的 makePetConfigSection 同一套模式。）
 *
 * @param rt   运行时注入的依赖集合（h / useState / useEffect / useRef / useCallback / t）
 * @param seed 沙箱验收种子（dev 用）：SSR 渲染不跑 effect，数据从这里进；
 *             生产环境不传 —— 组件挂载后自己拉 /relays 与 /state。
 */
export function makeRelaysAdminSection(
  rt: {
    h: typeof jsx;
    useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
    // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
    useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
    useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
    useCallback: typeof ReactNS.useCallback;
    t: (key: string) => string;
  },
  seed?: RelaysAdminSeed,
): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, useCallback, t } = rt;

  // 设置页样式（问号气泡 / 行布局 / 状态点这些行内样式表达不了的）
  injectRelaysAdminCss();

  const api = makeRelaysAdminApi('/dsh-pet-7340/relays');

  /** 等宽字体栈（掩码等值展示用；不引外部字体，走系统栈） */
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

  /** 问号 + 悬浮说明（本页所有解释小字的唯一去处；手法同设置页：data-tip → ::after） */
  const q = (tip: string, end = false, key = 'q'): ReturnType<typeof h> =>
    h('i', {
      key,
      className: 'dsh-pet-ra__q' + (end ? ' is-end' : ''),
      'data-tip': tip,
      'aria-label': tip,
      role: 'img',
      children: '?',
    });

  /** 卡片头：标题 + 问号说明（+ 可选右侧动作区，可以是多个按钮） */
  const cardHead = (
    title: string,
    tip?: string,
    acts?: ReturnType<typeof h> | ReturnType<typeof h>[],
    key = 'head',
  ): ReturnType<typeof h> =>
    h('div', {
      key,
      className: 'dsh-pet-ra__cardHead',
      children: [
        h('span', { key: 't', className: 'dsh-pet-ra__cardTitle', children: title }),
        tip ? q(tip, false, 'q') : null,
        acts !== undefined ? h('div', { key: 'a', className: 'dsh-pet-ra__cardActs', children: acts }) : null,
      ],
    });

  /** 一个字段：标签（+ 问号）在上、控件在下（key 供栅格同级元素用） */
  const field = (
    label: string,
    control: ReturnType<typeof h>,
    tip?: string,
    end = false,
    key = 'f',
  ): ReturnType<typeof h> =>
    h('div', {
      key,
      className: 'dsh-pet-ra__field',
      children: [
        h('span', {
          key: 'l',
          className: 'dsh-pet-ra__flabel',
          children: tip ? [label, q(tip, end, 'q')] : label,
        }),
        control,
      ],
    });

  /** 开关的一格：勾选框 + 标题 + 问号（说明进问号，不占一行小字） */
  const toggleCell = (
    label: string,
    value: boolean,
    onToggle: (v: boolean) => void,
    end = false,
    key = 't',
  ): ReturnType<typeof h> =>
    h('div', {
      key,
      className: 'dsh-pet-ra__toggle',
      children: [
        h('label', {
          key: 'l',
          children: [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: value,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
            }),
            h('span', { key: 't', children: t(label) }),
          ],
        }),
        q(t(label + 'Hint'), end, 'q'),
      ],
    });

  /** ISO 时间 → 'YYYY-MM-DD HH:mm'（手工余额填写时间用；解析不了原样返回） */
  const formatTs = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number): string => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      ' ' +
      p(d.getHours()) +
      ':' +
      p(d.getMinutes())
    );
  };

  return function RelaysAdminSection() {
    // ---- 列表 / 余额 / 健康 / 焦点 ----
    const [sites, setSites] = useState<RelaySiteAdminView[]>(seed?.sites ?? []);
    const [balances, setBalances] = useState<Record<string, RelayBalanceInfo>>(seed?.balances ?? {});
    const [healths, setHealths] = useState<Record<string, RelayHealthKind>>(seed?.healths ?? {});
    const [focusSiteId, setFocusSiteId] = useState<string | null>(seed?.focusSiteId ?? null);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
      seed?.loadState ?? (seed !== undefined ? 'ready' : 'loading'),
    );
    const [loadErr, setLoadErr] = useState<string>('');

    // ---- 表单 ----
    const [editing, setEditing] = useState<null | { mode: 'create' } | { mode: 'edit'; id: string }>(null);
    // 注入的 useState 没有惰性初值重载（与设置页同口径）：直接求值，开合表单时再整体替换
    const [form, setForm] = useState<RelaySiteForm>(emptySiteForm());
    const [kindTouched, setKindTouched] = useState(false);
    const [quotaTouched, setQuotaTouched] = useState(false);
    const [manualTouched, setManualTouched] = useState(false);
    const [detect, setDetect] = useState<RelayDetectInfo | null>(null);
    const [detectBusy, setDetectBusy] = useState(false);
    // 模型矩阵：三态（有 / 无 / 未知）。**未知 ≠ 无** —— 渲染必须可区分，绝不猜成"没有"
    const [matrix, setMatrix] = useState<RelaysModelMatrix | null>(null);
    const [matrixBusy, setMatrixBusy] = useState(false);
    const [matrixErr, setMatrixErr] = useState<string>('');
    const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    const [testBusy, setTestBusy] = useState(false);

    // ---- 反馈 / 忙碌 / 对话框 ----
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    const [busy, setBusy] = useState<string | null>(null);
    const [dialog, setDialog] = useState<null | { kind: 'remove' } | { kind: 'rate' } | { kind: 'manual' }>(null);
    const [dialogSite, setDialogSite] = useState<RelaySiteAdminView | null>(null);
    const [manualDraft, setManualDraft] = useState<{ amount: string; currency: string }>({
      amount: '',
      currency: 'USD',
    });
    // 换算率未确认站点队列（会话内已确认/已推迟的进 ackRef，不重复弹）
    const [rateQueue, setRateQueue] = useState<string[]>([]);
    const ackRef = useRef<Set<string>>(new Set<string>());
    // 已识别过的 URL（同一 URL 不重复探测）
    const detectedUrl = useRef<string>('');
    const urlInputRef = useRef<HTMLInputElement | null>(null);

    const errorTextOf = (e: unknown, phase: RelayErrorPhase): string => {
      const v = mapRelayError(e, phase);
      return t(v.titleKey) + '：' + t(v.detailKey);
    };

    // ---- 加载：列表 + 焦点 + 每站余额/健康（失败不阻塞列表，落成失败格） ----
    const hydrate = async (list: RelaySiteAdminView[]): Promise<void> => {
      await mapLimit(list, 4, async (site) => {
        const [b, hd] = await Promise.allSettled([api.refresh(site.id), api.health(site.id)]);
        setBalances((m) => ({
          ...m,
          [site.id]:
            b.status === 'fulfilled'
              ? b.value
              : {
                  ok: false,
                  reason: 'fetch-error',
                  message: b.reason instanceof Error ? b.reason.message : String(b.reason),
                },
        }));
        setHealths((m) => ({ ...m, [site.id]: hd.status === 'fulfilled' ? healthKeyOf(hd.value.health) : 'unknown' }));
      });
    };

    const loadAll = useCallback(
      async (opts?: { quiet?: boolean }) => {
        if (opts?.quiet !== true) setLoadState('loading');
        try {
          const list = await api.list();
          setSites(list);
          setLoadState('ready');
          setLoadErr('');
          // 焦点：/state 的 sections.relays 叶（host 写 focus 后立即重刷；拉不到按无焦点）
          void readFocusSiteId()
            .then(setFocusSiteId)
            .catch(() => setFocusSiteId(null));
          // 每站余额 + 连通性（enabled 只决定周期刷新要不要带它；管理页打开就是要看状态）
          void hydrate(list);
          // 换算率未确认 → 排队弹核对（会话内已确认/已推迟的跳过）
          const pending = list.filter((s) => s.rateConfirmed !== true && !ackRef.current.has(s.id)).map((s) => s.id);
          if (pending.length > 0) setRateQueue((q) => [...q, ...pending.filter((id) => !q.includes(id))]);
        } catch (e) {
          setLoadState('error');
          setLoadErr(errorTextOf(e, 'load'));
        }
      },
      // api / readFocusSiteId / hydrate 都是工厂作用域或纯 setState，依赖稳定
      [],
    );

    useEffect(() => {
      // seed 模式（沙箱 SSR 验收）：不发起真实请求
      if (seed !== undefined) return;
      void loadAll();
    }, [loadAll]);

    // 未确认队列非空且当前没有对话框 → 弹出队首的核对对话框（强制，不静默）
    useEffect(() => {
      if (dialog !== null || rateQueue.length === 0) return;
      const site = sites.find((s) => s.id === rateQueue[0]);
      if (site !== undefined) {
        setDialogSite(site);
        setDialog({ kind: 'rate' });
      }
    }, [rateQueue, dialog, sites]);

    // ---- 行操作 ----
    const refreshSite = async (id: string): Promise<void> => {
      setBusy(id);
      try {
        const [b, hd] = await Promise.all([api.refresh(id), api.health(id)]);
        setBalances((m) => ({ ...m, [id]: b }));
        setHealths((m) => ({ ...m, [id]: healthKeyOf(hd.health) }));
        setMsg({ kind: '', text: '' });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'act') });
      } finally {
        setBusy(null);
      }
    };

    const fetchModels = async (id: string): Promise<void> => {
      setBusy(id);
      try {
        const r = await api.fetchModels(id);
        setMsg({ kind: 'ok', text: t('modelsOk').replace('{count}', String(r.count)) });
      } catch (e) {
        // 宿主失败也带人类可读原因（未配置凭证等），直接透出
        setMsg({ kind: 'err', text: t('modelsFail') + '：' + (e instanceof Error ? e.message : String(e)) });
      } finally {
        setBusy(null);
      }
    };

    /** 加载模型矩阵。矩阵由 host 一次算好，这里只解析 + 渲染（不重算） */
    const loadMatrix = async (): Promise<void> => {
      setMatrixBusy(true);
      setMatrixErr('');
      try {
        const m = await api.fetchModelMatrix();
        if (m === null) {
          setMatrixErr(t('matrixBad'));
          setMatrix(null);
          return;
        }
        setMatrix(m);
      } catch (e) {
        setMatrixErr(t('matrixFail') + '：' + (e instanceof Error ? e.message : String(e)));
        setMatrix(null);
      } finally {
        setMatrixBusy(false);
      }
    };

    const doRemove = async (site: RelaySiteAdminView): Promise<void> => {
      setBusy(site.id);
      try {
        await api.remove(site.id);
        await loadAll({ quiet: true });
        setMsg({ kind: 'ok', text: t('removed') });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'act') });
      } finally {
        setBusy(null);
      }
    };

    const applyFocus = async (siteId: string | null): Promise<void> => {
      setBusy('focus');
      try {
        const next = await api.focus(siteId);
        setFocusSiteId(next);
        setMsg({ kind: 'ok', text: next === null ? t('focusCleared') : t('focusSetOk') });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'act') });
      } finally {
        setBusy(null);
      }
    };

    // ---- 表单开合 ----
    const openCreate = (): void => {
      setEditing({ mode: 'create' });
      setForm(emptySiteForm());
      setKindTouched(false);
      setQuotaTouched(false);
      setManualTouched(false);
      setDetect(null);
      detectedUrl.current = '';
      setTestMsg({ kind: '', text: '' });
      setMsg({ kind: '', text: '' });
    };

    const openEdit = (site: RelaySiteAdminView): void => {
      setEditing({ mode: 'edit', id: site.id });
      setForm(formFromSite(site));
      setKindTouched(false);
      setQuotaTouched(false);
      setManualTouched(false);
      setDetect(null);
      // 已建站的 URL 视为已识别过（失焦不重复探）；改了 URL 才会重新探
      const u = checkRelayUrl(site.url);
      detectedUrl.current = u.ok ? u.url : '';
      setTestMsg({ kind: '', text: '' });
      setMsg({ kind: '', text: '' });
    };

    // ---- detect（粘贴即触发 + 失焦 + 手动「识别」；同一 URL 不重复探） ----
    const runDetect = async (urlRaw: string): Promise<void> => {
      const u = checkRelayUrl(urlRaw);
      if (!u.ok) return;
      if (detectedUrl.current === u.url) return;
      detectedUrl.current = u.url;
      setDetectBusy(true);
      try {
        const secret = form.secret.trim();
        const headers = parseExtraHeaders(form.headerKey, form.headerValue);
        const credential =
          form.credentialKind !== 'manual' && secret.length > 0
            ? ({
                kind: form.credentialKind,
                secret,
                ...(headers !== undefined ? { extraHeaders: headers } : {}),
              } as RelayCredentialBody)
            : undefined;
        const d = await api.detect({ url: u.url, ...(credential !== undefined ? { credential } : {}) });
        setDetect(d);
        const decision = decideDetect(d);
        if (decision !== null && decision.kind === 'apply') {
          // 识别结果可被用户手动覆盖（kindTouched / quotaTouched 之后不再自动改）
          if (!kindTouched) setForm((f) => ({ ...f, kind: decision.siteKind }));
          if (decision.suggestedQuota !== undefined && !quotaTouched) {
            setForm((f) => ({ ...f, quotaPerUnit: String(decision.suggestedQuota) }));
          }
        }
      } catch (e) {
        // 探测失败不是 500：回 unknown + 原因，引导手选或手工填余额（不静默失败）
        setDetect({ kind: 'unknown', confidence: 'unknown', evidence: [], message: errorTextOf(e, 'act') });
      } finally {
        setDetectBusy(false);
      }
    };

    // ---- 凭证测试：填了新值 → detect 回显；编辑态留空 → 打已存凭证的 refresh ----
    const testCredential = async (): Promise<void> => {
      setTestBusy(true);
      setTestMsg({ kind: '', text: '' });
      try {
        const secret = form.secret.trim();
        if (secret.length > 0) {
          const u = checkRelayUrl(form.url);
          if (!u.ok) {
            setTestMsg({ kind: 'err', text: t('errForm.url') });
            return;
          }
          const headers = parseExtraHeaders(form.headerKey, form.headerValue);
          const d = await api.detect({
            url: u.url,
            credential: {
              kind: form.credentialKind,
              secret,
              ...(headers !== undefined ? { extraHeaders: headers } : {}),
            },
          });
          const decision = decideDetect(d);
          if (decision !== null && decision.kind === 'apply') {
            setTestMsg({ kind: 'ok', text: t('testCredOk').replace('{detail}', t('kind.' + decision.siteKind)) });
          } else {
            setTestMsg({
              kind: 'err',
              text: t('testCredFail').replace('{detail}', (decision !== null && decision.message) || t('detectNone')),
            });
          }
          return;
        }
        const editId = editing?.mode === 'edit' ? editing.id : null;
        if (editId !== null) {
          const b = await api.refresh(editId);
          if (b.ok) {
            setTestMsg({ kind: 'ok', text: t('testCredOk').replace('{detail}', balanceSummary(b)) });
          } else {
            setTestMsg({
              kind: 'err',
              text: t('testCredFail').replace(
                '{detail}',
                t('reason.' + (b.reason ?? 'fetch-error')) + (b.message ? '（' + b.message + '）' : ''),
              ),
            });
          }
          return;
        }
        setTestMsg({ kind: '', text: t('testCredNone') });
      } catch (e) {
        setTestMsg({ kind: 'err', text: t('testCredFail').replace('{detail}', errorTextOf(e, 'act')) });
      } finally {
        setTestBusy(false);
      }
    };

    /** 余额结果 → 一行摘要（凭证测试回显用） */
    const balanceSummary = (b: RelayBalanceInfo): string => {
      const cell = balanceCellOf(b);
      if (cell.kind === 'none') return '-';
      if (cell.kind === 'failed')
        return t('reason.' + cell.reason) + (cell.message.length > 0 ? '（' + cell.message + '）' : '');
      if (cell.kind === 'manual') return cell.text + '（' + t('manualTag') + '）';
      if (cell.kind === 'unlimited') return t('unlimitedText').replace('{amount}', cell.text);
      return cell.text;
    };

    // ---- 保存（新建 POST / 编辑 PUT；manual 站顺带写手工余额端点） ----
    const saveSite = async (): Promise<void> => {
      const v = validateSiteForm(form);
      if (!v.ok) {
        setMsg({ kind: 'err', text: t('errForm.' + v.error) });
        return;
      }
      const editId = editing?.mode === 'edit' ? editing.id : null;
      setBusy(editId ?? 'create');
      try {
        const body = buildSiteBody(form);
        const saved = editId === null ? await api.create(body) : await api.update(editId, body);
        // 手工余额（manual 凭证的站）：金额非空 → 写入；编辑时被清空 → 清除（撤销降级）
        if (form.credentialKind === 'manual' || form.manualAmount.trim().length > 0) {
          const amount = form.manualAmount.trim();
          if (amount.length > 0) {
            await api.manualBalance(saved.id, amount, form.manualCurrency.trim().toUpperCase() || 'USD');
          } else if (editId !== null && manualTouched && saved.manualBalance !== undefined) {
            await api.manualBalance(saved.id, '', '');
          }
        }
        setEditing(null);
        setDetect(null);
        detectedUrl.current = '';
        await loadAll({ quiet: true });
        setMsg({ kind: 'ok', text: t('saved') });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'save') });
      } finally {
        setBusy(null);
      }
    };

    // ---- 对话框动作 ----
    const openRemove = (site: RelaySiteAdminView): void => {
      setDialogSite(site);
      setDialog({ kind: 'remove' });
    };

    const openRate = (site: RelaySiteAdminView): void => {
      setDialogSite(site);
      setDialog({ kind: 'rate' });
    };

    const openManual = (site: RelaySiteAdminView): void => {
      setManualDraft({ amount: site.manualBalance?.amount ?? '', currency: site.manualBalance?.currency ?? 'USD' });
      setDialogSite(site);
      setDialog({ kind: 'manual' });
    };

    const laterRate = (): void => {
      const id = dialogSite?.id;
      if (id !== undefined) ackRef.current.add(id); // 只压制本次会话，不落库
      setDialog(null);
      setRateQueue((q) => (id === undefined ? q.slice(1) : q.filter((x) => x !== id)));
    };

    const confirmRate = async (site: RelaySiteAdminView | null): Promise<void> => {
      if (site === null) return;
      setBusy(site.id);
      try {
        // PUT 全量字段 + rateConfirmed:true（复用表单构造，保证不丢字段；凭证段缺省不动）
        const body = buildSiteBody(formFromSite(site));
        body.rateConfirmed = true;
        await api.update(site.id, body);
        ackRef.current.add(site.id);
        setDialog(null);
        setRateQueue((q) => q.filter((x) => x !== site.id));
        await loadAll({ quiet: true });
        setMsg({ kind: 'ok', text: t('rateConfirmedOk') });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'act') });
      } finally {
        setBusy(null);
      }
    };

    const saveManual = async (clear: boolean): Promise<void> => {
      const site = dialog?.kind === 'manual' ? dialogSite : null;
      if (site === null) return;
      const amount = clear ? '' : manualDraft.amount.trim();
      if (!clear && amount.length > 0 && !checkAmount(amount).ok) {
        setMsg({ kind: 'err', text: t('errForm.manual') });
        return;
      }
      setBusy(site.id);
      try {
        await api.manualBalance(site.id, amount, manualDraft.currency.trim().toUpperCase() || 'USD');
        setDialog(null);
        await loadAll({ quiet: true });
        setMsg({ kind: 'ok', text: t('manualSaved') });
      } catch (e) {
        setMsg({ kind: 'err', text: errorTextOf(e, 'act') });
      } finally {
        setBusy(null);
      }
    };

    // ---- 渲染零件 ----
    const balanceCellNode = (cell: BalanceCell, site: RelaySiteAdminView): ReturnType<typeof h> => {
      if (cell.kind === 'none') {
        return h('span', { key: 'b', className: 'dsh-pet-ra__bal', children: '—' });
      }
      if (cell.kind === 'failed') {
        return h('span', {
          key: 'b',
          className: 'dsh-pet-ra__bal is-failed',
          children: [
            h('span', {
              key: 'r',
              children: t('reason.' + cell.reason) + (cell.message.length > 0 ? '（' + cell.message + '）' : ''),
            }),
            // 查询失败的站 → 手工填写入口（降级路径，带「手工」标签与填写时间）
            h('button', {
              key: 'm',
              type: 'button',
              className: 'dsh-pet-ra__btn is-sm is-ghost',
              disabled: busy === site.id,
              onClick: () => openManual(site),
              children: t('manualEntry'),
            }),
          ],
        });
      }
      const unconfirmed = cell.kind === 'auto' || cell.kind === 'unlimited' ? cell.unconfirmed : false;
      return h('span', {
        key: 'b',
        className: 'dsh-pet-ra__bal',
        children: [
          h('span', {
            key: 'v',
            children: cell.kind === 'unlimited' ? t('unlimitedText').replace('{amount}', cell.text) : cell.text,
          }),
          cell.kind === 'manual'
            ? h('span', {
                key: 'm',
                className: 'dsh-pet-ra__tag is-manual',
                title:
                  site.manualBalance !== undefined
                    ? t('manualAt').replace('{time}', formatTs(site.manualBalance.updatedAt))
                    : undefined,
                children: t('manualTag'),
              })
            : null,
          cell.kind === 'auto' && cell.scope !== null
            ? h('span', { key: 's', className: 'dsh-pet-ra__tag', children: t('scope.' + cell.scope) })
            : null,
          unconfirmed
            ? h('button', {
                key: 'u',
                type: 'button',
                className: 'dsh-pet-ra__tag is-warn',
                onClick: () => openRate(site),
                children: t('unconfirmedTag'),
              })
            : null,
        ],
      });
    };

    const rowNode = (site: RelaySiteAdminView): ReturnType<typeof h> => {
      const cell = balanceCellOf(balances[site.id]);
      const hk = healthKeyOf(healths[site.id]);
      const isFocus = focusSiteId === site.id;
      const rowBusy = busy === site.id;
      return h('div', {
        key: site.id,
        className: 'dsh-pet-ra__row',
        children: [
          h('span', {
            key: 'dot',
            className: 'dsh-pet-ra__dot is-' + hk,
            title: t('health.' + hk),
            'aria-label': t('health.' + hk),
            role: 'img',
          }),
          h('span', {
            key: 'name',
            className: 'dsh-pet-ra__rowName',
            children: [
              h('span', { key: 'n', children: site.name }),
              isFocus
                ? h('span', {
                    key: 'f',
                    className: 'dsh-pet-ra__star is-on',
                    title: t('clearFocus'),
                    'aria-label': t('clearFocus'),
                    children: '★',
                  })
                : null,
            ],
          }),
          h('span', { key: 'kind', className: 'dsh-pet-ra__tag', children: t('kind.' + site.kind) }),
          balanceCellNode(cell, site),
          h('span', {
            key: 'cred',
            className: 'dsh-pet-ra__tag',
            style: { fontFamily: MONO },
            title: t('credKind.' + site.credential.kind),
            children: site.credential.present ? site.credential.masked : t('credNone'),
          }),
          h('div', {
            key: 'acts',
            className: 'dsh-pet-ra__rowActs',
            children: [
              h('button', {
                key: 'focus',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm' + (isFocus ? ' is-primary' : ''),
                disabled: rowBusy || busy === 'focus',
                title: isFocus ? t('clearFocus') : t('setFocus'),
                'aria-pressed': isFocus,
                onClick: () => void applyFocus(focusTarget(focusSiteId, site.id)),
                children: isFocus ? '★' : '☆',
              }),
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm',
                disabled: rowBusy,
                title: t('refresh'),
                onClick: () => void refreshSite(site.id),
                children: t('refresh'),
              }),
              h('button', {
                key: 'models',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm',
                disabled: rowBusy,
                title: t('modelsBtn'),
                onClick: () => void fetchModels(site.id),
                children: t('modelsBtn'),
              }),
              h('button', {
                key: 'edit',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm',
                disabled: rowBusy,
                onClick: () => openEdit(site),
                children: t('edit'),
              }),
              h('button', {
                key: 'rm',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm is-danger',
                disabled: rowBusy,
                onClick: () => openRemove(site),
                children: t('remove'),
              }),
            ],
          }),
        ],
      });
    };

    /**
     * 模型矩阵视图（T03 展示层）。
     *
     * 三态语义硬要求：`unknown`（没抓过）与 `no`（抓过确认没有）**必须视觉可区分** ——
     * 用户会据格子判断"这站没我要的模型"，把未知演成"没有"就是误导。
     * 状态分类统一走 shared/relays.ts 的 matrixCellState（两端共用、有专项单测），
     * 这里只做渲染，不重算矩阵。
     */
    const matrixNode = (): ReturnType<typeof h> => {
      const head = h('div', {
        key: 'head',
        className: 'dsh-pet-ra__cardHead',
        children: [
          h('span', { key: 't', className: 'dsh-pet-ra__cardTitle', children: t('matrixTitle') }),
          h('div', {
            key: 'acts',
            className: 'dsh-pet-ra__cardActs',
            children: [
              h('button', {
                key: 'load',
                type: 'button',
                className: 'dsh-pet-ra__btn is-sm',
                disabled: matrixBusy,
                onClick: () => void loadMatrix(),
                children: matrixBusy ? t('matrixLoading') : t('matrixLoad'),
              }),
            ],
          }),
        ],
      });

      if (matrix === null) {
        return h('div', { key: 'matrix', className: 'dsh-pet-ra__card', children: [
          head,
          h('p', { key: 'hint', className: 'dsh-pet-ra__note', children: t('matrixHint') }),
          matrixErr.length > 0
            ? h('p', { key: 'err', className: 'dsh-pet-ra__banner', role: 'alert', children: matrixErr })
            : null,
        ] });
      }

      // 站点列：从矩阵行里收集（host 已按站点名排序，这里只去重保序）
      const columns: Array<{ siteId: string; name: string }> = [];
      for (const row of matrix.rows) {
        for (const cell of row.cells) {
          if (!columns.some((c) => c.siteId === cell.siteId)) columns.push({ siteId: cell.siteId, name: cell.name });
        }
      }

      const cellNode = (state: MatrixCellState): ReturnType<typeof h> =>
        h('span', {
          className: 'dsh-pet-ra__mxCell is-' + state,
          title: t('matrix.state.' + state),
          'aria-label': t('matrix.state.' + state),
          children: t('matrix.mark.' + state),
        });

      const table = h('table', {
        key: 'tbl',
        className: 'dsh-pet-ra__mxTable',
        children: [
          h('thead', {
            key: 'th',
            children: h('tr', {
              children: [
                h('th', { key: 'm', children: t('matrix.colModel') }),
                ...columns.map((c) => h('th', { key: c.siteId, children: c.name })),
              ],
            }),
          }),
          h('tbody', {
            key: 'tb',
            children: matrix.rows.map((row) =>
              h('tr', {
                key: row.id,
                children: [
                  h('td', { key: 'm', className: 'dsh-pet-ra__mxModel', children: row.id }),
                  ...columns.map((c) => {
                    const cell = row.cells.find((x) => x.siteId === c.siteId);
                    return h('td', { key: c.siteId, children: cellNode(cell?.state ?? 'unknown') });
                  }),
                ],
              }),
            ),
          }),
        ],
      });

      const summary =
        t('matrixSummary')
          .replace('{models}', String(matrix.rows.length))
          .replace('{sites}', String(columns.length)) +
        (matrix.unknownSiteCount > 0 ? '　' + t('matrixUnknownSites').replace('{count}', String(matrix.unknownSiteCount)) : '');

      return h('div', { key: 'matrix', className: 'dsh-pet-ra__card', children: [
        head,
        h('div', { key: 'sum', className: 'dsh-pet-ra__note', children: summary }),
        matrix.rows.length === 0
          ? h('p', { key: 'empty', className: 'dsh-pet-ra__empty', children: t('matrixEmpty') })
          : table,
        h('p', { key: 'hint', className: 'dsh-pet-ra__note', children: t('matrixHint') }),
      ] });
    };

    const detectNode = (key = 'detect'): ReturnType<typeof h> | null => {
      if (detectBusy) return h('div', { key, className: 'dsh-pet-ra__detect', children: t('detecting') });
      const decision = decideDetect(detect);
      if (decision === null) return null;
      if (decision.kind === 'unknown') {
        return h('div', {
          key,
          className: 'dsh-pet-ra__detect is-unknown',
          role: 'status',
          children: [
            h('span', { key: 'n', children: t('detectNone') }),
            decision.message.length > 0
              ? h('span', { key: 'm', children: t('detectUnknownMsg').replace('{message}', decision.message) })
              : null,
            ...decision.evidence.map((ev, i) => h('span', { key: 'e' + i, children: '· ' + ev })),
          ],
        });
      }
      return h('div', {
        key,
        className: 'dsh-pet-ra__detect',
        role: 'status',
        children: [
          h('span', {
            key: 'k',
            children: t(decision.confidence === 'certain' ? 'detectCertain' : 'detectLikely').replace(
              '{kind}',
              t('kind.' + decision.siteKind),
            ),
          }),
          decision.evidence.length > 0
            ? h('ul', { key: 'e', children: decision.evidence.map((ev, i) => h('li', { key: i, children: ev })) })
            : null,
          decision.suggestedQuota !== undefined
            ? h('span', { key: 'q', children: t('detectQuota').replace('{quota}', String(decision.suggestedQuota)) })
            : null,
        ],
      });
    };

    const formNode = (): ReturnType<typeof h> => {
      const editId = editing?.mode === 'edit' ? editing.id : null;
      const site = editId !== null ? sites.find((s) => s.id === editId) : undefined;
      const formBusy = busy === (editId ?? 'create');
      return h('div', {
        key: 'form',
        className: 'dsh-pet-ra__card',
        children: [
          cardHead(editId === null ? t('add') : t('edit') + '：' + (site?.name ?? '')),
          // URL + 识别（粘贴即触发：onPaste 后读输入框最新值）
          field(
            t('urlLabel'),
            h('div', {
              key: 'u',
              className: 'dsh-pet-ra__focus',
              children: [
                h('input', {
                  key: 'i',
                  ref: urlInputRef,
                  type: 'text',
                  className: 'dsh-pet-ra__inp',
                  style: { flex: '1 1 240px' },
                  value: form.url,
                  disabled: formBusy,
                  placeholder: 'https://relay.example.com',
                  onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, url: e.target.value })),
                  onBlur: () => void runDetect(form.url),
                  onPaste: () => {
                    // 粘贴后 onChange 已把新值写进 state，但闭里的 form.url 还是旧的 →
                    // 下一帧从输入框节点读最新值（React 18 不再合并事件，节点值已更新）
                    setTimeout(() => {
                      const el = urlInputRef.current;
                      if (el !== null) void runDetect(el.value);
                    }, 0);
                  },
                }),
                h('button', {
                  key: 'd',
                  type: 'button',
                  className: 'dsh-pet-ra__btn',
                  disabled: formBusy || detectBusy,
                  onClick: () => void runDetect(form.url),
                  children: t('detect'),
                }),
              ],
            }),
            t('urlHint'),
            false,
            'url',
          ),
          detectNode(),
          h('div', {
            key: 'r1',
            className: 'dsh-pet-ra__grid2',
            children: [
              field(
                t('nameLabel'),
                h('input', {
                  key: 'n',
                  type: 'text',
                  className: 'dsh-pet-ra__inp',
                  value: form.name,
                  disabled: formBusy,
                  maxLength: 50,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, name: e.target.value })),
                }),
                t('nameHint'),
                false,
                'name',
              ),
              field(
                t('kindLabel'),
                h('select', {
                  key: 'k',
                  className: 'dsh-pet-ra__inp',
                  value: form.kind,
                  disabled: formBusy,
                  onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                    setKindTouched(true);
                    setForm((f) => ({ ...f, kind: e.target.value as RelayKind }));
                  },
                  children: RELAY_KINDS.map((k) => h('option', { key: k, value: k, children: t('kind.' + k) })),
                }),
                t('kindHint'),
                true,
                'kind',
              ),
            ],
          }),
          h('div', {
            key: 'r2',
            className: 'dsh-pet-ra__grid2',
            children: [
              field(
                t('noteLabel'),
                h('input', {
                  key: 'n',
                  type: 'text',
                  className: 'dsh-pet-ra__inp',
                  value: form.note,
                  disabled: formBusy,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, note: e.target.value })),
                }),
                t('noteHint'),
                false,
                'note',
              ),
              field(
                t('thresholdLabel'),
                h('input', {
                  key: 't',
                  type: 'text',
                  inputMode: 'decimal',
                  className: 'dsh-pet-ra__inp',
                  value: form.lowThreshold,
                  disabled: formBusy,
                  placeholder: '5.00',
                  onChange: (e: ChangeEvent<HTMLInputElement>) =>
                    setForm((f) => ({ ...f, lowThreshold: e.target.value })),
                }),
                t('thresholdHint'),
                true,
                'threshold',
              ),
            ],
          }),
          // 凭证：四选一（API Key 优先）+ 掩码输入 + 测试 + 高级附加头
          h('div', {
            key: 'cred',
            className: 'dsh-pet-ra__field',
            children: [
              h('span', { key: 'l', className: 'dsh-pet-ra__flabel', children: [t('credLabel'), q(t('credHint'))] }),
              h('div', {
                key: 'kinds',
                className: 'dsh-pet-ra__focus',
                children: [
                  ...CREDENTIAL_KINDS.map((k) =>
                    h('button', {
                      key: k,
                      type: 'button',
                      className: 'dsh-pet-ra__btn is-sm' + (form.credentialKind === k ? ' is-primary' : ''),
                      disabled: formBusy,
                      onClick: () => setForm((f) => ({ ...f, credentialKind: k })),
                      children: t('credKind.' + k),
                    }),
                  ),
                ],
              }),
              form.credentialKind === 'manual'
                ? null
                : h('input', {
                    key: 's',
                    type: 'password',
                    className: 'dsh-pet-ra__inp',
                    value: form.secret,
                    disabled: formBusy,
                    autoComplete: 'off',
                    placeholder:
                      site !== undefined && site.credential.present
                        ? site.credential.masked + '（' + t('secretPlaceholder') + '）'
                        : t('secretLabel'),
                    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, secret: e.target.value })),
                  }),
              form.credentialKind === 'manual'
                ? null
                : h('div', {
                    key: 'h',
                    className: 'dsh-pet-ra__grid2',
                    children: [
                      field(
                        t('headerLabel'),
                        h('input', {
                          key: 'hk',
                          type: 'text',
                          className: 'dsh-pet-ra__inp',
                          value: form.headerKey,
                          disabled: formBusy,
                          placeholder: t('headerKeyPh'),
                          onChange: (e: ChangeEvent<HTMLInputElement>) =>
                            setForm((f) => ({ ...f, headerKey: e.target.value })),
                        }),
                        t('headerHint'),
                        false,
                        'header',
                      ),
                      h('div', {
                        key: 'hv',
                        className: 'dsh-pet-ra__field',
                        children: [
                          h('span', { key: 'l', className: 'dsh-pet-ra__flabel', children: '\u00a0' }),
                          h('input', {
                            key: 'i',
                            type: 'text',
                            className: 'dsh-pet-ra__inp',
                            value: form.headerValue,
                            disabled: formBusy,
                            placeholder: t('headerValuePh'),
                            onChange: (e: ChangeEvent<HTMLInputElement>) =>
                              setForm((f) => ({ ...f, headerValue: e.target.value })),
                          }),
                        ],
                      }),
                    ],
                  }),
              h('div', {
                key: 't',
                className: 'dsh-pet-ra__focus',
                children: [
                  h('button', {
                    key: 'b',
                    type: 'button',
                    className: 'dsh-pet-ra__btn is-sm',
                    disabled: formBusy || testBusy,
                    onClick: () => void testCredential(),
                    children: testBusy ? t('testCredBusy') : t('testCred'),
                  }),
                  testMsg.text.length > 0
                    ? h('span', {
                        key: 'm',
                        className: 'dsh-pet-ra__msg' + (testMsg.kind === 'err' ? ' is-err' : ''),
                        children: testMsg.text,
                      })
                    : null,
                ],
              }),
            ],
          }),
          // 手工余额字段（仅 manual 凭证的站：查不到余额的显式降级路径）
          form.credentialKind === 'manual'
            ? h('div', {
                key: 'man',
                className: 'dsh-pet-ra__grid2',
                children: [
                  field(
                    t('manualAmountLabel'),
                    h('input', {
                      key: 'a',
                      type: 'text',
                      inputMode: 'decimal',
                      className: 'dsh-pet-ra__inp',
                      value: form.manualAmount,
                      disabled: formBusy,
                      placeholder: t('manualAmountPh'),
                      onChange: (e: ChangeEvent<HTMLInputElement>) => {
                        setManualTouched(true);
                        setForm((f) => ({ ...f, manualAmount: e.target.value }));
                      },
                    }),
                    t('manualAmountHint'),
                    false,
                    'amount',
                  ),
                  field(
                    t('manualCurrencyLabel'),
                    h('input', {
                      key: 'c',
                      type: 'text',
                      className: 'dsh-pet-ra__inp',
                      value: form.manualCurrency,
                      disabled: formBusy,
                      placeholder: t('manualCurrencyPh'),
                      onChange: (e: ChangeEvent<HTMLInputElement>) => {
                        setManualTouched(true);
                        setForm((f) => ({ ...f, manualCurrency: e.target.value }));
                      },
                    }),
                    undefined,
                    true,
                    'currency',
                  ),
                ],
              })
            : null,
          // 换算率 + 确认 + 刷新开关
          h('div', {
            key: 'r3',
            className: 'dsh-pet-ra__grid2',
            children: [
              field(
                t('quotaLabel'),
                h('input', {
                  key: 'q',
                  type: 'number',
                  className: 'dsh-pet-ra__inp',
                  value: form.quotaPerUnit,
                  disabled: formBusy,
                  min: '1',
                  step: '1',
                  onChange: (e: ChangeEvent<HTMLInputElement>) => {
                    setQuotaTouched(true);
                    setForm((f) => ({ ...f, quotaPerUnit: e.target.value }));
                  },
                }),
                t('quotaHint'),
                false,
                'quota',
              ),
              toggleCell(
                'rateConfirmedLabel',
                form.rateConfirmed,
                (v) => setForm((f) => ({ ...f, rateConfirmed: v })),
                true,
                'rate',
              ),
            ],
          }),
          toggleCell('enabledLabel', form.enabled, (v) => setForm((f) => ({ ...f, enabled: v })), false, 'enabled'),
          h('div', {
            key: 'acts',
            className: 'dsh-pet-ra__focus',
            children: [
              h('button', {
                key: 'save',
                type: 'button',
                className: 'dsh-pet-ra__btn is-primary',
                disabled: formBusy,
                onClick: () => void saveSite(),
                children: t('save'),
              }),
              h('button', {
                key: 'cancel',
                type: 'button',
                className: 'dsh-pet-ra__btn',
                disabled: formBusy,
                onClick: () => {
                  setEditing(null);
                  setDetect(null);
                  detectedUrl.current = '';
                },
                children: t('cancel'),
              }),
            ],
          }),
        ],
      });
    };

    // ---- 主树 ----
    const unconfirmedCount = sites.filter((s) => s.rateConfirmed !== true).length;

    return h('section', {
      className: 'dsh-pet-ra',
      style: { maxWidth: '720px' },
      children: [
        h('h2', {
          key: 'title',
          className: 'dsh-pet-ra__title',
          children: [h('span', { key: 'nav', children: t('nav') }), q(t('intro'), false, 'q')],
        }),
        msg.text.length > 0
          ? h('div', {
              key: 'msg',
              className: 'dsh-pet-ra__msg' + (msg.kind === 'err' ? ' is-err' : ''),
              role: 'status',
              children: msg.text,
            })
          : null,

        // 三态兜底：加载中 / 错误（可读文案 + 重试）/ 就绪
        loadState === 'loading'
          ? h('div', { key: 'ls', role: 'status', className: 'dsh-pet-ra__card', children: t('loading') })
          : loadState === 'error'
            ? h('div', {
                key: 'ls',
                role: 'alert',
                className: 'dsh-pet-ra__card',
                children: [
                  h('span', {
                    key: 'e',
                    className: 'dsh-pet-ra__msg is-err',
                    children: loadErr.length > 0 ? loadErr : t('errLoad'),
                  }),
                  h('button', {
                    key: 'r',
                    type: 'button',
                    className: 'dsh-pet-ra__btn',
                    onClick: () => void loadAll(),
                    children: t('retry'),
                  }),
                ],
              })
            : null,

        loadState === 'ready'
          ? h('div', {
              key: 'body',
              style: { display: 'flex', flexDirection: 'column', gap: '12px' },
              children: [
                // 未确认态：横幅常驻（对话框由 rateQueue 效应强制弹出）
                unconfirmedCount > 0
                  ? h('div', {
                      key: 'banner',
                      className: 'dsh-pet-ra__banner',
                      role: 'status',
                      children: [
                        h('span', {
                          key: 't',
                          children: t('unconfirmedBanner').replace('{count}', String(unconfirmedCount)),
                        }),
                        h('button', {
                          key: 'b',
                          type: 'button',
                          className: 'dsh-pet-ra__btn is-sm',
                          disabled: busy !== null,
                          onClick: () => {
                            const site = sites.find((s) => s.rateConfirmed !== true);
                            if (site !== undefined) openRate(site);
                          },
                          children: t('rateDialogConfirm'),
                        }),
                      ],
                    })
                  : null,

                // 焦点站点切换（按钮组：全舰队 + 每站一格；再点当前焦点 = 清除）
                h('div', {
                  key: 'focus',
                  className: 'dsh-pet-ra__card',
                  children: [
                    cardHead(t('focusTitle'), t('focusHint')),
                    h('div', {
                      key: 'g',
                      className: 'dsh-pet-ra__focus',
                      children: [
                        h('button', {
                          key: 'fleet',
                          type: 'button',
                          className: 'dsh-pet-ra__btn is-sm' + (focusSiteId === null ? ' is-primary' : ''),
                          disabled: busy === 'focus',
                          'aria-pressed': focusSiteId === null,
                          onClick: () => void applyFocus(null),
                          children: t('focusFleet'),
                        }),
                        ...sites.map((s) =>
                          h('button', {
                            key: s.id,
                            type: 'button',
                            className: 'dsh-pet-ra__btn is-sm' + (focusSiteId === s.id ? ' is-primary' : ''),
                            disabled: busy === 'focus',
                            'aria-pressed': focusSiteId === s.id,
                            onClick: () => void applyFocus(focusTarget(focusSiteId, s.id)),
                            children: s.name,
                          }),
                        ),
                      ],
                    }),
                  ],
                }),

                // 站点列表（空态引导添加，不给一张空表）
                h('div', {
                  key: 'sites',
                  className: 'dsh-pet-ra__card',
                  children: [
                    cardHead(t('cardSites'), t('cardSitesHint'), [
                      h('button', {
                        key: 'ra',
                        type: 'button',
                        className: 'dsh-pet-ra__btn is-sm',
                        disabled: busy !== null,
                        onClick: () => void loadAll({ quiet: true }),
                        children: t('refreshAll'),
                      }),
                      h('button', {
                        key: 'add',
                        type: 'button',
                        className: 'dsh-pet-ra__btn is-sm is-primary',
                        disabled: busy !== null,
                        onClick: openCreate,
                        children: '+ ' + t('add'),
                      }),
                    ]),
                    sites.length === 0
                      ? h('p', { key: 'empty', className: 'dsh-pet-ra__empty', children: t('empty') })
                      : sites.map((s) => rowNode(s)),
                  ],
                }),
              ],
            })
          : null,

        // 模型矩阵（T03 展示层）：行 = 全部站点模型并集，格子三态。
        // **未知 ≠ 无**：没抓过的站渲染成"未知"（琥珀底），绝不与"无"（灰）混同。
        matrixNode(),

        editing !== null ? formNode() : null,

        // 确认/提示弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 按钮）
        dialog !== null && dialogSite !== null
          ? h('div', {
              key: 'mask',
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setDialog(null),
              children: h('div', {
                style: {
                  width: '380px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    key: 't',
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children:
                      dialog.kind === 'remove'
                        ? t('confirmTitle')
                        : dialog.kind === 'rate'
                          ? t('rateDialogTitle').replace('{name}', dialogSite.name)
                          : t('manualDialogTitle').replace('{name}', dialogSite.name),
                  }),
                  dialog.kind === 'remove'
                    ? h('div', {
                        key: 'b',
                        style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                        children: t('confirmRemove').replace('{name}', dialogSite.name),
                      })
                    : dialog.kind === 'rate'
                      ? h('div', {
                          key: 'b',
                          style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                          children: t('rateDialogBody')
                            .replace('{quota}', String(dialogSite.quotaPerUnit))
                            .replace('{currency}', dialogSite.manualBalance?.currency ?? 'USD'),
                        })
                      : h('div', {
                          key: 'b',
                          style: { display: 'flex', flexDirection: 'column', gap: '10px' },
                          children: [
                            h('div', {
                              key: 'x',
                              style: {
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: 'var(--dsw-alias-label-secondary)',
                              },
                              children: t('manualDialogBody'),
                            }),
                            h('div', {
                              key: 'f',
                              className: 'dsh-pet-ra__grid2',
                              children: [
                                h('input', {
                                  key: 'a',
                                  type: 'text',
                                  inputMode: 'decimal',
                                  className: 'dsh-pet-ra__inp',
                                  value: manualDraft.amount,
                                  placeholder: t('manualAmountPh'),
                                  onChange: (e: ChangeEvent<HTMLInputElement>) =>
                                    setManualDraft((d) => ({ ...d, amount: e.target.value })),
                                }),
                                h('input', {
                                  key: 'c',
                                  type: 'text',
                                  className: 'dsh-pet-ra__inp',
                                  value: manualDraft.currency,
                                  placeholder: t('manualCurrencyPh'),
                                  onChange: (e: ChangeEvent<HTMLInputElement>) =>
                                    setManualDraft((d) => ({ ...d, currency: e.target.value })),
                                }),
                              ],
                            }),
                          ],
                        }),
                  h('div', {
                    key: 'acts',
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' },
                    children: [
                      dialog.kind === 'rate'
                        ? h('button', {
                            key: 'later',
                            type: 'button',
                            className: 'dsh-pet-ra__btn',
                            onClick: laterRate,
                            children: t('rateDialogLater'),
                          })
                        : h('button', {
                            key: 'cancel',
                            type: 'button',
                            className: 'dsh-pet-ra__btn',
                            onClick: () => setDialog(null),
                            children: t('cancel'),
                          }),
                      dialog.kind === 'manual' && dialogSite.manualBalance !== undefined
                        ? h('button', {
                            key: 'clear',
                            type: 'button',
                            className: 'dsh-pet-ra__btn is-danger',
                            disabled: busy === dialogSite.id,
                            onClick: () => void saveManual(true),
                            children: t('manualClear'),
                          })
                        : null,
                      h('button', {
                        key: 'confirm',
                        type: 'button',
                        className:
                          'dsh-pet-ra__btn ' +
                          (dialog.kind === 'rate'
                            ? 'is-primary'
                            : dialog.kind === 'remove'
                              ? 'is-danger'
                              : 'is-primary'),
                        disabled: busy === dialogSite.id,
                        onClick: () => {
                          if (dialog.kind === 'remove') void doRemove(dialogSite);
                          else if (dialog.kind === 'rate') void confirmRate(dialogSite);
                          else void saveManual(false);
                        },
                        children:
                          dialog.kind === 'remove'
                            ? t('remove')
                            : dialog.kind === 'rate'
                              ? t('rateDialogConfirm')
                              : t('save'),
                      }),
                    ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}

/** 沙箱验收种子（dev 专用）：SSR 渲染不跑 effect，组件初值从这里进 */
export interface RelaysAdminSeed {
  sites?: RelaySiteAdminView[];
  balances?: Record<string, RelayBalanceInfo>;
  healths?: Record<string, RelayHealthKind>;
  focusSiteId?: string | null;
  loadState?: 'loading' | 'ready' | 'error';
}
