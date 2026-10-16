/**
 * 中转站查询编排 —— 把「站点注册表 + 适配器 + 凭证」接到一起，产出喂给 `/state` 的结果。
 *
 * 三条硬纪律（继承上游 balance 的口径）：
 * 1. **绝不伪造 0 余额**：查不到就是查不到，落 `fetch-error` / `credential-missing` / `manual`，
 *    绝不拿 0 充数；
 * 2. **降级链完整**：自动查询失败 → 有手工值就用手工值（标注「手工」）→ 没有才报错；
 * 3. **金额只准走 ../money.ts**：本文件不做任何 quota 除法。
 */

import { getCredential } from './store';
import { newApiProvider } from './providers/newapi';
import { sumMoney } from '../balance/internal';
import type {
  RelayBalanceResult,
  RelayHealthResult,
  RelayProvider,
  RelaySite,
} from './types';

/** 已登记的站点类型（登记口径：只收有接口的，其余 → `unsupported`） */
export const RELAY_PROVIDERS: RelayProvider[] = [newApiProvider];

/** 站点类型 → provider；未登记返回 undefined（= 不支持查询） */
export function matchRelayProvider(kind: string): RelayProvider | undefined {
  return RELAY_PROVIDERS.find((p) => p.kinds.includes(kind as never));
}

/** 全部已登记类型（供设置页/自检） */
export function supportedKinds(): string[] {
  return [...new Set(RELAY_PROVIDERS.flatMap((p) => p.kinds))];
}

/** 并发上限。中转站多为小站，并发打过去容易触发限流/CF，保守取 4 */
const CONCURRENCY = 4;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 手工填写结果（降级路径，不是失败；必须带「手工」来源与填写时间） */
function manualResult(site: RelaySite, note: string): RelayBalanceResult {
  if (!site.manualBalance) {
    return {
      ok: false,
      siteId: site.id,
      provider: 'relay:' + site.kind,
      reason: 'manual',
      message: note,
    };
  }
  return {
    ok: true,
    siteId: site.id,
    provider: 'relay:' + site.kind,
    shape: 'money',
    source: 'manual',
    data: {
      currency: site.manualBalance.currency,
      total: site.manualBalance.amount,
      granted: site.manualBalance.amount,
      toppedUp: '0.00',
    },
  };
}

/**
 * 查询单个站点的余额。
 *
 * 降级链：`manual` 凭证 → 直接用手工值，不发请求；无凭证 → 有手工值用手工值、否则
 * `credential-missing`；自动查询异常 → 有手工值用手工值（并在 message 里说明原因）、否则
 * `fetch-error`。**任何分支都不会返回 0 冒充成功。**
 */
export async function querySiteBalance(dir: string, site: RelaySite): Promise<RelayBalanceResult> {
  const provider = matchRelayProvider(site.kind);
  const pid = 'relay:' + site.kind;
  if (!provider) {
    return { ok: false, siteId: site.id, provider: pid, reason: 'unsupported', message: '未登记的站点类型 ' + site.kind };
  }
  const cred = getCredential(dir, site.id);

  if (cred?.kind === 'manual') return manualResult(site, '站点已设为手工填写');
  if (!cred) {
    if (site.manualBalance) return manualResult(site, '未配置凭证，回退到手工填写值');
    return { ok: false, siteId: site.id, provider: pid, reason: 'credential-missing', message: '未配置凭证' };
  }

  try {
    const r = await provider.fetch({
      siteId: site.id,
      baseUrl: site.url,
      secret: cred.secret,
      kind: cred.kind,
      extraHeaders: cred.extraHeaders,
      quotaPerUnit: site.quotaPerUnit,
    });
    return { ...r, siteId: site.id };
  } catch (e) {
    const msg = errMessage(e);
    if (site.manualBalance) return manualResult(site, '自动查询失败（' + msg + '），使用手工填写值');
    return { ok: false, siteId: site.id, provider: pid, reason: 'fetch-error', message: msg };
  }
}

/** 单个站点的连通性探测（同样走降级链：没凭证就报 credential-missing，不发请求） */
export async function checkSiteHealth(dir: string, site: RelaySite): Promise<RelayHealthResult> {
  const provider = matchRelayProvider(site.kind);
  const base = {
    siteId: site.id,
    checkedAt: new Date().toISOString(),
  };
  if (!provider?.health) {
    return { ...base, health: 'unknown', message: '该站点类型暂无探测实现' };
  }
  const cred = getCredential(dir, site.id);
  if (!cred || cred.kind === 'manual') {
    return { ...base, health: 'unknown', message: '未配置凭证，跳过探测' };
  }
  try {
    const r = await provider.health({
      siteId: site.id,
      baseUrl: site.url,
      secret: cred.secret,
      kind: cred.kind,
      extraHeaders: cred.extraHeaders,
      quotaPerUnit: site.quotaPerUnit,
    });
    return { ...r, siteId: site.id };
  } catch (e) {
    const msg = errMessage(e);
    // 401/403 归到鉴权失败，其余归不可达；拿不到状态码就归不可达（不猜）
    const status = (e as { status?: number }).status;
    const health: RelayHealthResult['health'] =
      status === 401 || status === 403 ? 'auth-failed' : 'unreachable';
    return { ...base, health, message: msg };
  }
}

/** 并发跑批（信号量限流；单个站点的异常已被 querySiteBalance 吃掉，这里再兜一层） */
export async function queryAllBalances(dir: string, sites: RelaySite[]): Promise<RelayBalanceResult[]> {
  const out: RelayBalanceResult[] = new Array(sites.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= sites.length) return;
      try {
        out[i] = await querySiteBalance(dir, sites[i]);
      } catch (e) {
        out[i] = {
          ok: false,
          siteId: sites[i].id,
          provider: 'relay:' + sites[i].kind,
          reason: 'fetch-error',
          message: errMessage(e),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
  return out;
}

// ---------- 聚合（纯函数，可无网络测试） ----------

/** 一个站点的低余额判定结果 */
export interface RelayLowSite {
  siteId: string;
  name: string;
  amount: string;
  currency: string;
  threshold: string;
  /** 手工值不参与告警（它不是实时数据，拿它告警会误报） */
  manual: boolean;
}

/**
 * 选出低于阈值的站点。
 *
 * - 阈值取站点自己的 `lowThreshold`，缺省用 `defaultThreshold`；**两个都没有就不判**——
 *   不替用户猜一个阈值；
 * - 只对 `source: 'auto'` 的成功结果判定。手工值是用户上次手填的快照，拿它触发告警会误报；
 * - 无法解析的金额 → 跳过该站点（不猜）。
 */
export function selectLowSites(
  sites: RelaySite[],
  results: RelayBalanceResult[],
  defaultThreshold?: string,
): RelayLowSite[] {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const low: RelayLowSite[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    const site = byId.get(r.siteId);
    if (!site) continue;
    if (r.source === 'manual') continue;
    const threshold = site.lowThreshold ?? defaultThreshold;
    if (!threshold) continue;
    const amount = Number(r.data.total);
    const limit = Number(threshold);
    if (!Number.isFinite(amount) || !Number.isFinite(limit)) continue;
    if (amount < limit) {
      low.push({
        siteId: site.id,
        name: site.name,
        amount: r.data.total,
        currency: r.data.currency,
        threshold,
        manual: false,
      });
    }
  }
  return low.sort((a, b) => Number(a.amount) - Number(b.amount));
}

/** 全舰队汇总（纯函数） */
export interface RelayFleetSummary {
  currency: string;
  /** 该币种下全部可查站点的剩余合计 */
  total: string;
  /** 历史总额合计 —— 仅当参与站点**全部**提供 fullBalance 时才有（否则不猜基准） */
  fullBalance?: string;
  /** 可查站点数 */
  siteCount: number;
  /** 低于阈值的站点（按剩余升序） */
  lowSites: RelayLowSite[];
  /** 被排除的其他币种（如实告知，绝不把不同币种相加） */
  otherCurrencies: string[];
  /** 查不到 / 未配置凭证的站点数 */
  failedCount: number;
}

/**
 * 聚合全部站点余额 → 一份 `MoneyBalance` 口径的汇总（客户端六档动画可直接用）。
 *
 * 币种处理：**只合并同币种**。多币种时取「可查站点数最多」的币种作主口径，其余进
 * `otherCurrencies` 如实列出 —— 把 USD 和 CNY 相加是没有意义的数字，宁可不给。
 */
export function aggregateBalances(
  sites: RelaySite[],
  results: RelayBalanceResult[],
  defaultThreshold?: string,
): RelayFleetSummary {
  const ok = results.filter((r): r is Extract<RelayBalanceResult, { ok: true }> => r.ok);
  const failedCount = results.length - ok.length;

  // 按币种分组
  const groups = new Map<string, typeof ok>();
  for (const r of ok) {
    const c = r.data.currency || 'USD';
    const list = groups.get(c);
    if (list) list.push(r);
    else groups.set(c, [r]);
  }
  const currencies = [...groups.keys()].sort((a, b) => (groups.get(b)!.length - groups.get(a)!.length) || a.localeCompare(b));
  const primary = currencies[0];
  const primaryGroup = primary ? groups.get(primary)! : [];

  let total = '0.00';
  let allHaveFull = primaryGroup.length > 0;
  let full = '0.00';
  for (const r of primaryGroup) {
    total = sumMoney(total, r.data.total);
    if (r.data.fullBalance === undefined) allHaveFull = false;
    else full = sumMoney(full, r.data.fullBalance);
  }

  return {
    currency: primary ?? 'USD',
    total,
    ...(allHaveFull ? { fullBalance: full } : {}),
    siteCount: primaryGroup.length,
    lowSites: selectLowSites(sites, results, defaultThreshold),
    otherCurrencies: currencies.slice(1),
    failedCount,
  };
}
