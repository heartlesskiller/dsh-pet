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
import { openaiCompatProvider } from './providers/openai-compat';
import { deepseekProvider } from './providers/deepseek';
import { sumMoney } from '../balance/internal';
import type {
  RelayBalanceResult,
  RelayHealthResult,
  RelayProvider,
  RelaySite,
} from './types';

/** 已登记的站点类型（登记口径：只收有接口的，其余 → `unsupported`） */
export const RELAY_PROVIDERS: RelayProvider[] = [newApiProvider, openaiCompatProvider, deepseekProvider];

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

// ---------- 站点级失败退避（T05/G1'：429 风险的现实对冲） ----------

/**
 * 连续失败的指数退避：1s → 2s → 4s → … 封顶 60s（**纯函数**，可无时钟测试）。
 * 参数是经验值（11-plan 假设 #5），待真机观察校准（V5）。
 */
export function failureBackoffDelay(consecutiveFailures: number): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, n - 1));
}

/** 失败记忆（进程内，重启清零可接受）：siteId → { 连续失败数, 下次允许尝试的时间戳 } */
const failureMemory = new Map<string, { count: number; nextAllowedAt: number }>();

/** 清空失败记忆（测试用；也让「用户手动重试」有地方可调） */
export function resetFailureMemory(): void {
  failureMemory.clear();
}

/** 记录一次失败（返回退避时长） */
function noteFailure(siteId: string, now: number): number {
  const count = (failureMemory.get(siteId)?.count ?? 0) + 1;
  const delay = failureBackoffDelay(count);
  failureMemory.set(siteId, { count, nextAllowedAt: now + delay });
  return delay;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * fetch 层错误 → 结构化 reason（A6： blocked / rate-limited 与 fetch-error 文案必须区分）。
 * 判定依据 provider 抛错时带的 `code`（见 providers/newapi.ts 的 classifiedError）。
 */
export function classifyBalanceError(e: unknown): 'blocked' | 'rate-limited' | 'fetch-error' {
  const code = (e as { code?: unknown }).code;
  if (code === 'blocked') return 'blocked';
  if (code === 'rate-limited') return 'rate-limited';
  return 'fetch-error';
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

  // 失败退避中：不发起请求（429 风险的对冲；N 站 × 周期轮询打一个正在失败的站没有意义）
  const memo = failureMemory.get(site.id);
  const now = Date.now();
  if (memo && memo.nextAllowedAt > now) {
    return {
      ok: false,
      siteId: site.id,
      provider: pid,
      reason: 'rate-limited',
      message:
        '失败退避中（连续第 ' + memo.count + ' 次失败），' +
        Math.ceil((memo.nextAllowedAt - now) / 1000) + 's 后自动重试',
    };
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
    failureMemory.delete(site.id); // 成功：清除失败记忆
    // 换算率未确认（建站默认 / 探测失败，修订 #11）→ 打标：客户端提示核对，
    // 且该站不参与低余额告警（OP-6：数据不可靠不评估）。
    // 只对**读数要经换算率折算**的类型打标（usesQuotaRate 缺省 true）：纯金额源
    // （billing USD / DeepSeek CNY）没有换算率可言，打标会让它永远无法告警。
    const needsRate = provider.usesQuotaRate !== false;
    if (needsRate && site.rateConfirmed !== true) return { ...r, siteId: site.id, rateUnconfirmed: true };
    return { ...r, siteId: site.id };
  } catch (e) {
    noteFailure(site.id, Date.now());
    const msg = errMessage(e);
    if (site.manualBalance) return manualResult(site, '自动查询失败（' + msg + '），使用手工填写值');
    return { ok: false, siteId: site.id, provider: pid, reason: classifyBalanceError(e), message: msg };
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

/**
 * 并发跑批（信号量限流；单个站点的异常已被 querySiteBalance 吃掉，这里再兜一层）。
 *
 * `deadlineMs`（默认 4000，OP-7）：到点后**不再新起**查询（在飞的自然完成），
 * 未开始的站点落一条显式「本次跳过」——下个周期照常重试。
 * 这样舰队刷新的总耗时被约束在 deadline + 单站超时内，N 站全挂也不会拖死刷新链。
 */
export async function queryAllBalances(
  dir: string,
  sites: RelaySite[],
  options: { deadlineMs?: number } = {},
): Promise<RelayBalanceResult[]> {
  const deadlineMs = options.deadlineMs ?? 4_000;
  const deadline = Date.now() + deadlineMs;
  const out: RelayBalanceResult[] = new Array(sites.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= sites.length) return;
      if (Date.now() > deadline) {
        out[i] = {
          ok: false,
          siteId: sites[i].id,
          provider: 'relay:' + sites[i].kind,
          reason: 'fetch-error',
          message: '本次舰队刷新已达 ' + deadlineMs + 'ms 上限，跳过（下周期重试）',
        };
        continue;
      }
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
 * - **无限额度站不判定**（F2/A4：它没有「剩余」概念，`total` 是已用金额，拿它比阈值会误报）；
 * - **换算率未确认的站不判定**（OP-6：数据不可靠不评估，先提示用户核对）；
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
    if (r.unlimited === true) continue;
    if (r.rateUnconfirmed === true) continue;
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
  /** 该币种下全部可查站点（**不含无限额度站**）的剩余合计 */
  total: string;
  /** 历史总额合计 —— 仅当参与站点**全部**提供 fullBalance 时才有（否则不猜基准） */
  fullBalance?: string;
  /** 可查站点数（不含无限额度站） */
  siteCount: number;
  /** 低于阈值的站点（按剩余升序） */
  lowSites: RelayLowSite[];
  /** 被排除的其他币种（如实告知，绝不把不同币种相加） */
  otherCurrencies: string[];
  /** 查不到 / 未配置凭证的站点数 */
  failedCount: number;
  /**
   * 无限额度站数量（F2：它们的 `total` 是已用金额，语义相反，
   * **不计入上面的剩余合计**；客户端据此显示「N 站无限额度」）。
   */
  unlimitedCount: number;
}

/**
 * 聚合全部站点余额 → 一份 `MoneyBalance` 口径的汇总（客户端六档动画可直接用）。
 *
 * 币种处理：**只合并同币种**。多币种时取「可查站点数最多」的币种作主口径，其余进
 * `otherCurrencies` 如实列出 —— 把 USD 和 CNY 相加是没有意义的数字，宁可不给。
 *
 * 无限额度站：不计入 total / fullBalance / siteCount（它们的「剩余」不可计），
 * 只进 `unlimitedCount` —— 把已用金额加进「剩余合计」是把语义搞反的数字。
 */
export function aggregateBalances(
  sites: RelaySite[],
  results: RelayBalanceResult[],
  defaultThreshold?: string,
): RelayFleetSummary {
  const ok = results.filter((r): r is Extract<RelayBalanceResult, { ok: true }> => r.ok);
  const failedCount = results.length - ok.length;
  const countable = ok.filter((r) => r.unlimited !== true);
  const unlimitedCount = ok.length - countable.length;

  // 按币种分组（只对可计入「剩余」的站）
  const groups = new Map<string, typeof countable>();
  for (const r of countable) {
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
    unlimitedCount,
  };
}
