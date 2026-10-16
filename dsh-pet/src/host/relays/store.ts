/**
 * 中转站注册表 —— 站点与凭证的本地持久化。
 *
 * 设计（继承上游 `list_skins_in` 的可注入风格：**数据目录由参数注入**，不读全局路径，
 * 于是纯逻辑可以无 GUI、无网络、无副作用地测）：
 *
 * - 站点与凭证**分两个文件存**：`relays.json` 只放站点元数据，`relay-credentials.json`
 *   只放凭证。站点文件里**没有任何密钥字段**，导出/备份站点不会顺带泄密；
 * - 写入走「临时文件 + rename」原子替换，避免进程被杀时写下半个 JSON；
 * - 读到的 JSON 损坏 → 原文件改名 `.corrupt-<时间戳>` 后按空启动，**不静默丢数据**
 *   （用户能在目录里看到坏文件并救回），也不静默运行残缺配置；
 * - 站点 id 用 `crypto.randomUUID()`；URL 归一化交给 provider 的 `normalizeBaseUrl`。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { siteQuotaPerUnit } from './money';
import { maskHeaders, maskSecret } from './redact';
import { normalizeBaseUrl } from './providers/newapi';
import { RELAY_KINDS, type RelayCredential, type RelayCredentialKind, type RelayKind, type RelaySite, type RelaySiteView } from './types';

/** 站点文件（无任何密钥） */
export const SITES_FILE = 'relays.json';
/** 凭证文件（只放密钥；不随站点文件导出） */
export const CREDENTIALS_FILE = 'relay-credentials.json';

/** 新建 / 更新站点的输入。凭证单独传，不进站点实体 */
export interface SiteInput {
  id?: string;
  name: string;
  url: string;
  kind: RelayKind;
  note?: string;
  quotaPerUnit?: number;
  lowThreshold?: string;
  enabled?: boolean;
  manualBalance?: { amount: string; currency: string };
}

/** 全部凭证：siteId → 凭证 */
export type CredentialMap = Record<string, RelayCredential>;

// ---------- 底层 IO ----------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 读 JSON；文件缺失 → fallback；损坏 → 改名留存后 fallback（不静默丢） */
function readJsonSafe<T>(path: string, fallback: T, what: string): T {
  if (!existsSync(path)) return fallback;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      renameSync(path, path + '.corrupt-' + stamp);
    } catch {
      // 改名也失败（权限/占用）就保留原样，至少不覆盖
    }
    throw new Error(
      'relays: ' + what + ' 损坏，已留存为 ' + path + '.corrupt-' + stamp + '（' + (e instanceof Error ? e.message : String(e)) + '）',
      { cause: e },
    );
  }
}

/** 原子写：先写同目录临时文件，再 rename 覆盖 */
function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(join(path, '..'));
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

// ---------- 站点 ----------

export function loadSites(dir: string): RelaySite[] {
  const raw = readJsonSafe<unknown>(join(dir, SITES_FILE), [], 'relays.json');
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is RelaySite => s !== null && typeof s === 'object');
}

export function saveSites(dir: string, sites: RelaySite[]): void {
  writeJsonAtomic(join(dir, SITES_FILE), sites);
}

/** 校验入参；非法一律 throw（不落脏数据） */
export function validateSiteInput(input: SiteInput): void {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('relays: 站点名称必填');
  }
  if (!RELAY_KINDS.includes(input.kind)) {
    throw new Error('relays: 未知站点类型 ' + String(input.kind));
  }
  // URL 归一化本身会校验协议与空值
  normalizeBaseUrl(input.url);
  if (input.quotaPerUnit !== undefined) siteQuotaPerUnit(input.quotaPerUnit);
}

/**
 * 新建或更新站点（按 `input.id` 命中则更新，否则新建）。
 * 更新时保留 `createdAt` 与原 `manualBalance`（除非本次显式带上）。
 *
 * 可选字段一律**条件展开**，不写 `note: undefined` 这类键 —— JSON 序列化会丢掉它们，
 * 于是「写进去的对象」与「读回来的对象」键集不同，严格比对会炸，也让配置文件里出现无意义空键。
 */
export function upsertSite(dir: string, input: SiteInput): RelaySite {
  validateSiteInput(input);
  const sites = loadSites(dir);
  const now = new Date().toISOString();
  const url = normalizeBaseUrl(input.url);
  const idx = input.id ? sites.findIndex((s) => s.id === input.id) : -1;

  if (idx >= 0) {
    const prev = sites[idx];
    const next: RelaySite = {
      ...prev,
      name: input.name.trim(),
      url,
      kind: input.kind,
      quotaPerUnit: input.quotaPerUnit ?? prev.quotaPerUnit,
      lowThreshold: input.lowThreshold ?? prev.lowThreshold,
      enabled: input.enabled ?? prev.enabled,
      updatedAt: now,
      // 传了才覆盖（传空串 = 清空）；没传则保留原值
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.manualBalance ? { manualBalance: { ...input.manualBalance, updatedAt: now } } : {}),
    };
    sites[idx] = next;
    saveSites(dir, sites);
    return next;
  }

  const site: RelaySite = {
    id: randomUUID(),
    name: input.name.trim(),
    url,
    kind: input.kind,
    quotaPerUnit: input.quotaPerUnit ?? siteQuotaPerUnit(undefined),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.lowThreshold !== undefined ? { lowThreshold: input.lowThreshold } : {}),
    ...(input.manualBalance ? { manualBalance: { ...input.manualBalance, updatedAt: now } } : {}),
  };
  sites.push(site);
  saveSites(dir, sites);
  return site;
}

/** 删除站点，**同时删掉它的凭证**（不留孤儿密钥文件） */
export function removeSite(dir: string, id: string): RelaySite[] {
  const sites = loadSites(dir);
  const next = sites.filter((s) => s.id !== id);
  if (next.length === sites.length) return sites;
  saveSites(dir, next);
  const creds = loadCredentials(dir);
  if (id in creds) {
    delete creds[id];
    saveCredentials(dir, creds);
  }
  return next;
}

// ---------- 凭证 ----------

export function loadCredentials(dir: string): CredentialMap {
  const raw = readJsonSafe<unknown>(join(dir, CREDENTIALS_FILE), {}, CREDENTIALS_FILE);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as CredentialMap;
}

export function saveCredentials(dir: string, creds: CredentialMap): void {
  writeJsonAtomic(join(dir, CREDENTIALS_FILE), creds);
}

/** 写入 / 覆盖某站点的凭证 */
export function putCredential(dir: string, siteId: string, credential: RelayCredential): void {
  const creds = loadCredentials(dir);
  creds[siteId] = credential;
  saveCredentials(dir, creds);
}

/** 清除某站点的凭证 */
export function clearCredential(dir: string, siteId: string): void {
  const creds = loadCredentials(dir);
  if (!(siteId in creds)) return;
  delete creds[siteId];
  saveCredentials(dir, creds);
}

/** 该站点的凭证（取不到 → undefined） */
export function getCredential(dir: string, siteId: string): RelayCredential | undefined {
  return loadCredentials(dir)[siteId];
}

// ---------- 视图（唯一允许对外的形状） ----------

/** 站点 → 脱敏视图。凭证值只以掩码出现 */
export function toSiteView(site: RelaySite, credential: RelayCredential | undefined): RelaySiteView {
  const kind: RelayCredentialKind = credential?.kind ?? 'manual';
  return {
    ...site,
    credential: {
      kind,
      masked: maskSecret(credential?.secret),
      present: credential !== undefined && credential.kind !== 'manual',
      ...(credential?.extraHeaders ? { extraHeaders: maskHeaders(credential.extraHeaders) } : {}),
    },
  };
}

/** 全部站点的脱敏视图（按名称排序，稳定） */
export function siteViews(dir: string): RelaySiteView[] {
  const creds = loadCredentials(dir);
  return loadSites(dir)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => toSiteView(s, creds[s.id]));
}

/** 列出数据目录下全部文件（诊断用：让用户/排错时能看到 .corrupt-* 留存） */
export function listDataFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}
