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
import type { RelayCredential, RelayCredentialKind } from './types';

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
  | { action: 'unknown' };

/**
 * 解析 `/relays` 之后的剩余路径。
 *
 * 形如：`relays` / `relays/{id}` / `relays/{id}/refresh` / `relays/{id}/health`
 * / `relays/{id}/manual-balance` / `relays/refresh-all`。
 *
 * 多段 / 空 id / 未知子动作 → `unknown`（调用方回 404，**不猜**意图）。
 * 注意 `refresh-all` 是保留字：一个 id 叫 `refresh-all` 的站点会被它挡住——
 * 可接受，站点 id 由服务端 `randomUUID()` 生成，不会是这个词。
 */
export function parseRelayRoute(rest: string): RelayRoute {
  if (rest === 'relays') return { action: 'collection' };
  if (rest === 'relays/refresh-all') return { action: 'refresh-all' };
  const m = /^relays\/([^/]+)(?:\/(refresh|health|manual-balance))?$/.exec(rest);
  if (!m) return { action: 'unknown' };
  const id = m[1];
  switch (m[2]) {
    case undefined:
      return { action: 'item', id };
    case 'refresh':
      return { action: 'refresh', id };
    case 'health':
      return { action: 'health', id };
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
