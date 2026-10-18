/**
 * 中转站 HTTP 路由层 —— 只放**纯逻辑**：路径解析、入参校验、脱敏自检。
 *
 * 这里不碰 `node:http`、不读全局路径、不 import 宿主：数据目录由调用方
 * （`../index.ts` 的 handler）注入，于是本文件的每个函数都能无 GUI、无网络、
 * 无副作用地测（见 `./routes.test.ts`）。
 *
 * 三条硬纪律：
 * 1. **响应体不得带出明文凭证**：`assertNoSecret` 是返回前的最后一道闸 —— 一旦发现
 *    明文就**抛错**（该请求失败），而不是把凭证返回给调用方。宁可端点坏掉，不泄露；
 * 2. **错误口径与上游既有分支一致**：结构性参数错误 → HTTP 4xx + `{ error }`
 *    （同 `/config` `/pet-display`）；动作类失败 → HTTP 200 + `{ ok:false, reason }`
 *    （同 `/whisper` `/broadcast` `/anim`）。不新造第三种口径；
 * 3. **入参一律先校验再落盘**：非法就抛，不把脏数据写进 `relays.json`。
 */

import { containsSecret } from './redact';
import type { CredentialMap } from './store';
import type { RelayCredential, RelayCredentialKind, RelayModelCache, RelaySite } from './types';

// ---------- 错误口径 ----------

/** 动作端点失败（HTTP 200 + `{ ok:false, reason }`） */
export function relayFail(reason: string, message: string): { ok: false; reason: string; message: string } {
  return { ok: false, reason, message };
}

/** 结构性错误（HTTP 4xx + `{ error }`） */
export function relayError(message: string): { error: string } {
  return { error: message };
}

// ---------- 路径解析 ----------

/** `/relays` 之后的路径形状（id 段已由调用方 decodeURIComponent 过） */
export type RelayRoute =
  | { action: 'collection' }
  | { action: 'item'; id: string }
  | { action: 'refresh'; id: string }
  | { action: 'refresh-all' }
  | { action: 'health'; id: string }
  | { action: 'manual-balance'; id: string }
  | { action: 'detect' }
  | { action: 'models' }
  | { action: 'site-models'; id: string }
  | { action: 'focus' }
  | { action: 'unknown' };

/**
 * 解析 `/relays` 之后的剩余路径。
 *
 * 形如：`relays` / `relays/{id}` / `relays/{id}/refresh` / `relays/{id}/health`
 * / `relays/{id}/manual-balance` / `relays/{id}/models` / `relays/refresh-all`
 * / `relays/detect` / `relays/models` / `relays/focus`。
 *
 * 多段 / 空 id / 未知子动作 → `unknown`（调用方回 404，**不猜**意图）。
 * 注意 `refresh-all`/`detect`/`models`/`focus` 是保留字：一个 id 叫这些词的站点会被挡住——
 * 可接受，站点 id 由服务端 `randomUUID()` 生成，不会是这些词。
 */
export function parseRelayRoute(rest: string): RelayRoute {
  if (rest === 'relays') return { action: 'collection' };
  if (rest === 'relays/refresh-all') return { action: 'refresh-all' };
  if (rest === 'relays/detect') return { action: 'detect' };
  if (rest === 'relays/models') return { action: 'models' };
  if (rest === 'relays/focus') return { action: 'focus' };
  const m = /^relays\/([^/]+)(?:\/(refresh|health|manual-balance|models))?$/.exec(rest);
  if (!m) return { action: 'unknown' };
  const id = m[1];
  switch (m[2]) {
    case undefined:
      return { action: 'item', id };
    case 'refresh':
      return { action: 'refresh', id };
    case 'health':
      return { action: 'health', id };
    case 'models':
      return { action: 'site-models', id };
    default:
      return { action: 'manual-balance', id };
  }
}

// ---------- 脱敏自检 ----------

/** 收集数据目录下全部凭证明文（自检基线：附加头的值同样算敏感值） */
export function collectSecrets(creds: CredentialMap | undefined): string[] {
  const out: string[] = [];
  for (const cred of Object.values(creds ?? {})) {
    if (typeof cred?.secret === 'string' && cred.secret.length > 0) out.push(cred.secret);
    for (const value of Object.values(cred?.extraHeaders ?? {})) {
      if (typeof value === 'string' && value.length > 0) out.push(value);
    }
  }
  return out;
}

/**
 * 响应体脱敏自检：**发现明文凭证就抛错**。
 *
 * 站点视图（`toSiteView`）本来就只带掩码，这道闸防的是"以后有人新写一段直接回传站点实体"：
 * 那时 body 里会带上 `secret` 原值，这里会在返回前把它拦下并让请求失败。
 */
export function assertNoSecret(body: unknown, secrets: readonly string[]): void {
  if (secrets.length === 0) return;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (containsSecret(text, secrets)) {
    throw new Error('relays: 响应体检出明文凭证，已拦截（脱敏自检失败）');
  }
}

// ---------- 入参校验 ----------

/** 凭证种类白名单（与 `types.ts` 的 RelayCredentialKind 一致） */
const CREDENTIAL_KINDS: readonly RelayCredentialKind[] = ['access-token', 'api-key', 'session-cookie', 'manual'];

/** 手工余额入参：空 amount = 清除（降级路径的撤销），否则要求「金额 + 币种」齐备 */
export type ManualBalanceInput =
  | { ok: true; clear: true }
  | { ok: true; clear: false; amount: string; currency: string }
  | { ok: false; message: string };

/** 金额格式：非负、至多两位小数（与 `money.ts` 产出的 `'1.00'` 口径一致） */
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/**
 * 解析手工余额入参。
 * 币种统一大写（`usd` / `USD` 必须归到同一组，否则聚合会把同一币种当两种算）。
 */
export function normalizeManualBalance(raw: unknown): ManualBalanceInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const amount = typeof o.amount === 'string' ? o.amount.trim() : '';
  const currency = typeof o.currency === 'string' ? o.currency.trim().toUpperCase() : '';
  if (amount === '') return { ok: true, clear: true };
  if (!AMOUNT_RE.test(amount)) return { ok: false, message: 'amount 必须是非负金额（至多两位小数）' };
  if (currency.length === 0) return { ok: false, message: '缺少 currency' };
  return { ok: true, clear: false, amount, currency };
}

/** 凭证入参解析。`kind: 'manual'` 允许不带 secret（那是「无凭证、手工填余额」的显式声明） */
export function parseCredential(raw: unknown): { ok: true; value: RelayCredential } | { ok: false; message: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (!CREDENTIAL_KINDS.includes(kind as RelayCredentialKind)) {
    return { ok: false, message: '未知凭证类型：' + (kind || '(缺失)') + '（可用：' + CREDENTIAL_KINDS.join(' / ') + '）' };
  }
  if (kind === 'manual') return { ok: true, value: { kind: 'manual', secret: '' } };

  const secret = typeof o.secret === 'string' ? o.secret.trim() : '';
  if (secret.length === 0) return { ok: false, message: '凭证值不能为空' };

  const headers: Record<string, string> = {};
  const rawHeaders = o.extraHeaders;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      return { ok: false, message: 'extraHeaders 必须是 { 键: 值 } 对象' };
    }
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length === 0) return { ok: false, message: 'extraHeaders 的值必须是非空字符串：' + k };
      headers[k] = v;
    }
  }
  return {
    ok: true,
    value: { kind: kind as RelayCredentialKind, secret, ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}) },
  };
}

// ---------- detect 入参（T03：识别不落库，凭证只用于本次探测） ----------

export interface DetectInput {
  url: string;
  /** 探测用凭证（**不落库**）；缺省 = 只探免鉴权的 /api/status */
  credential?: RelayCredential;
}

/**
 * 解析 `POST /relays/detect` 入参。
 * `credential.kind === 'manual'` 视为无凭证探测（manual 的意义就是「不凭任何东西查」）。
 */
export function parseDetectInput(raw: unknown): { ok: true; value: DetectInput } | { ok: false; message: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  if (url.length === 0) return { ok: false, message: '缺少站点 URL' };
  if (!Object.prototype.hasOwnProperty.call(o, 'credential')) return { ok: true, value: { url } };
  const cred = parseCredential(o.credential);
  if (!cred.ok) return cred;
  if (cred.value.kind === 'manual') return { ok: true, value: { url } };
  return { ok: true, value: { url, credential: cred.value } };
}

// ---------- focus 入参（T03：焦点站点只影响展示） ----------

/**
 * 解析 `POST /relays/focus` 入参。空 / 缺失 siteId = **清除焦点**（回到全舰队口径）。
 * 站点是否存在由调用方查注册表判定（这里只校验形状）。
 */
export function parseFocusInput(raw: unknown): { ok: true; siteId: string | null } | { ok: false; message: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const siteId = typeof o.siteId === 'string' ? o.siteId.trim() : '';
  return { ok: true, siteId: siteId.length > 0 ? siteId : null };
}

// ---------- 模型矩阵聚合（T03：GET /relays/models 只读缓存） ----------

/**
 * 矩阵格子。`available`：true = 该站有这模型；false = 抓过且没有（**明确不可用**，
 * P0-15 要求列出而不是省略）；null = **未抓过该站清单，未知**（绝不猜成没有）。
 */
export interface ModelMatrixCell {
  siteId: string;
  name: string;
  available: boolean | null;
  ratio?: number;
  price?: number;
}

export interface ModelMatrixRow {
  id: string;
  sites: ModelMatrixCell[];
}

/**
 * 缓存 + 站点 → 模型矩阵（**纯函数**）。
 *
 * 口径：行 = 全部已抓模型的并集（按 id 排序）；每行的格子覆盖**全部站点**——
 * 有=true、抓过没有=false、没抓过=null。`unknownSiteCount` = 从未抓过的站点数
 * （UI 提示「N 个站未抓取」，不把未知演成没有）。
 *
 * 实现要点（踩过的坑）：**必须最后统一补全格子，不能在遍历中增量补**。
 * 增量补只回看「当时已存在的行」，于是后出现的模型行拿不到先处理的站点的格子 ——
 * 那个格子会**缺失**，而客户端对缺失格子的兜底是「未知」，语义正好反了
 * （真实答案是「抓过、没有」却显示成「没抓过」）。所以这里先算并集，再逐格判定。
 */
export function aggregateModelMatrix(
  sites: RelaySite[],
  cache: RelayModelCache,
): { rows: ModelMatrixRow[]; unknownSiteCount: number } {
  const byName = sites.slice().sort((a, b) => a.name.localeCompare(b.name));
  // 每站「抓过哪些模型」的集合；没抓过的站不进这个表（格子最终是 null）
  const presentBySite = new Map<string, Set<string>>();
  // 倍率/价格是**按站**的（同一个模型在不同站可以有不同 ratio），必须按 (siteId, modelId) 存
  const metaBySite = new Map<string, Map<string, { ratio?: number; price?: number }>>();
  const modelIds = new Set<string>();
  for (const site of byName) {
    const entry = cache[site.id];
    if (!entry) continue; // 未抓过的站：最后统一补「未知」格子
    const present = new Set<string>();
    presentBySite.set(site.id, present);
    for (const model of entry.models) {
      present.add(model.id);
      modelIds.add(model.id);
      if (model.ratio !== undefined || model.price !== undefined) {
        let meta = metaBySite.get(site.id);
        if (!meta) {
          meta = new Map<string, { ratio?: number; price?: number }>();
          metaBySite.set(site.id, meta);
        }
        meta.set(model.id, {
          ...(model.ratio !== undefined ? { ratio: model.ratio } : {}),
          ...(model.price !== undefined ? { price: model.price } : {}),
        });
      }
    }
  }
  // 行 = 并集；每行**覆盖全部站点**，逐格判定，不存在"缺格子"
  const rows: ModelMatrixRow[] = [...modelIds].sort((a, b) => a.localeCompare(b)).map((id) => ({
    id,
    sites: byName.map((site) => {
      const present = presentBySite.get(site.id);
      const base = { siteId: site.id, name: site.name };
      // 没抓过 → null（未知）；抓过且不在列表里 → false（确认没有）；在列表里 → true
      if (present === undefined) return { ...base, available: null };
      if (!present.has(id)) return { ...base, available: false };
      const m = metaBySite.get(site.id)?.get(id);
      return {
        ...base,
        available: true,
        ...(m?.ratio !== undefined ? { ratio: m.ratio } : {}),
        ...(m?.price !== undefined ? { price: m.price } : {}),
      };
    }),
  }));
  const unknownSites = byName.filter((s) => !cache[s.id]);
  return {
    rows,
    unknownSiteCount: unknownSites.length,
  };
}
