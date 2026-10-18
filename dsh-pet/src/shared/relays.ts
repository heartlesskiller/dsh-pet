// 中转站舰队状态（`sections.relays` 叶子）的客户端侧纯逻辑。
// 与 shared/balance.ts 同一套口径：只认形状与数据自带的业务事实，不碰网络/React/DOM；
// 形状非法 → null（轮询安全：1s 一拍，抛异常会打断整拍渲染，其余叶子跟着不渲染）。
//
// 展示形态复用上游 money（`MoneyBalance` 同构）：六档余额动画、气泡样式一行不用改——
// 舰队汇总（或焦点站点）折成 `BalanceState` 喂既有动画机，见 relaysBalanceState。
//
// 硬口径（与 host 侧一一对应）：
// - 无限额度站没有「剩余」概念：不折进动画、不当余额，气泡显示「无限额度 · 已用 $X」；
// - 手工值必须带「手工」标注，不得伪装成实时数据（P0-6）；
// - 失败站不进气泡文案（避免每周期刷屏），由管理页呈现；
// - 多币种不混算：非主币种一句话如实告知。

import type { BalanceBubbleRow, BalanceState } from './balance';

// ---------- 视图形状（host 的 relays 叶数据 → 客户端视图） ----------

/** 低余额站点（host 的 selectLowSites 产出；只含 auto 且有确认换算率的站） */
export interface RelaysLowSite {
  siteId: string;
  name: string;
  amount: string;
  currency: string;
  threshold: string;
}

/** 单站结果（host 的 RelayBalanceResult 成功/失败两种都收） */
export interface RelaysSiteResult {
  siteId: string;
  ok: boolean;
  source?: 'auto' | 'manual';
  /** 无限额度站：total 是已用金额（见 host A4） */
  unlimited?: boolean;
  spent?: string;
  /** 换算率未确认：数据不可靠，客户端提示核对 */
  rateUnconfirmed?: boolean;
  total?: string;
  currency?: string;
  fullBalance?: string;
  reason?: string;
}

export interface RelaysHealthEntry {
  siteId: string;
  health: string;
  message?: string;
}

export interface RelaysView {
  /** 焦点站点（只影响展示口径；null = 全舰队） */
  focusSiteId: string | null;
  summary: {
    currency: string;
    total: string;
    fullBalance?: string;
    siteCount: number;
    unlimitedCount: number;
    failedCount: number;
    lowSites: RelaysLowSite[];
    otherCurrencies: string[];
  };
  sites: RelaysSiteResult[];
  health: RelaysHealthEntry[];
  refreshedAt?: string;
  /**
   * 每日快照窗口（host 下发；本地时区日键）。消耗速率/预计天数由客户端用
   * {@link computeBurnRate} / {@link projectedDays} 现算 —— 算法只有一份。
   */
  snapshots?: SnapshotStore;
  /** 今天（本地时区 `YYYY-MM-DD`，host 下发）。客户端不自己取时钟，避免两端漂移 */
  today?: string;
}

// ---------- 防御式解析（形状非法 → null，不抛） ----------

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStrArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseSite(raw: unknown): RelaysSiteResult | undefined {
  const o = asObj(raw);
  if (!o) return undefined;
  const siteId = asStr(o.siteId);
  if (!siteId) return undefined;
  const data = asObj(o.data);
  return {
    siteId,
    ok: o.ok === true,
    ...(o.source === 'auto' || o.source === 'manual' ? { source: o.source } : {}),
    ...(o.unlimited === true ? { unlimited: true } : {}),
    ...(asStr(o.spent) !== undefined ? { spent: asStr(o.spent) } : {}),
    ...(o.rateUnconfirmed === true ? { rateUnconfirmed: true } : {}),
    ...(asStr(data?.total) !== undefined ? { total: asStr(data?.total) } : {}),
    ...(asStr(data?.currency) !== undefined ? { currency: asStr(data?.currency) } : {}),
    ...(asStr(data?.fullBalance) !== undefined ? { fullBalance: asStr(data?.fullBalance) } : {}),
    ...(asStr(o.reason) !== undefined ? { reason: asStr(o.reason) } : {}),
  };
}

/**
 * `sections.relays` 叶子数据 → 客户端视图。
 *
 * host 刷新失败时写的是 `{ok:false, reason}`（没有 summary）→ 返回 null：
 * 消费端跳过这一拍（不渲染、不抛）——与 readBalance 的口径一致。
 */
export function readRelays(data: unknown): RelaysView | null {
  const root = asObj(data);
  if (!root) return null;
  const summary = asObj(root.summary);
  if (!summary) return null; // 失败形状（{ok:false}）或脏数据：跳过
  const siteCount = asNum(summary.siteCount);
  const unlimitedCount = asNum(summary.unlimitedCount);
  const failedCount = asNum(summary.failedCount);
  if (siteCount === undefined || unlimitedCount === undefined || failedCount === undefined) return null;
  const sites = Array.isArray(root.sites)
    ? root.sites.map(parseSite).filter((s): s is RelaysSiteResult => s !== undefined)
    : [];
  const health = Array.isArray(root.health)
    ? root.health
        .map((raw) => {
          const o = asObj(raw);
          const siteId = o ? asStr(o.siteId) : undefined;
          const h = o ? asStr(o.health) : undefined;
          if (!siteId || !h) return undefined;
          const message = o ? asStr(o.message) : undefined;
          return { siteId, health: h, ...(message !== undefined ? { message } : {}) };
        })
        .filter((e): e is RelaysHealthEntry => e !== undefined)
    : [];
  const focusSiteId = typeof root.focusSiteId === 'string' && root.focusSiteId.length > 0 ? root.focusSiteId : null;
  const snapshotsRaw = asObj(root.snapshots);
  const fullBalance = asStr(summary.fullBalance);
  return {
    focusSiteId,
    summary: {
      currency: asStr(summary.currency) ?? 'USD',
      total: asStr(summary.total) ?? '0.00',
      ...(fullBalance !== undefined ? { fullBalance } : {}),
      siteCount,
      unlimitedCount,
      failedCount,
      lowSites: Array.isArray(summary.lowSites)
        ? summary.lowSites
            .map((raw) => {
              const o = asObj(raw);
              if (!o) return undefined;
              const siteId = asStr(o.siteId);
              const name = asStr(o.name);
              const amount = asStr(o.amount);
              if (!siteId || !name || !amount) return undefined;
              return {
                siteId,
                name,
                amount,
                currency: asStr(o.currency) ?? 'USD',
                threshold: asStr(o.threshold) ?? '',
              };
            })
            .filter((s): s is RelaysLowSite => s !== undefined)
        : [],
      otherCurrencies: asStrArray(summary.otherCurrencies),
    },
    sites,
    health,
    ...(asStr(root.refreshedAt) !== undefined ? { refreshedAt: asStr(root.refreshedAt) } : {}),
    ...(asStr(root.today) !== undefined ? { today: asStr(root.today) } : {}),
    ...(snapshotsRaw !== undefined ? { snapshots: parseSnapshots(snapshotsRaw) } : {}),
  };
}

/** 快照表解析：坏条目跳过，整体形状不对 → 空表（派生数据，不抛） */
function parseSnapshots(raw: Record<string, unknown>): SnapshotStore {
  const out: SnapshotStore = {};
  for (const [day, value] of Object.entries(raw)) {
    const dayObj = asObj(value);
    if (dayObj === undefined) continue;
    const entries: DaySnapshots = {};
    for (const [siteId, entry] of Object.entries(dayObj)) {
      const e = asObj(entry);
      if (e === undefined) continue;
      entries[siteId] = {
        ...(asStr(e.spent) !== undefined ? { spent: asStr(e.spent) } : {}),
        ...(asStr(e.remaining) !== undefined ? { remaining: asStr(e.remaining) } : {}),
        ...(e.unlimited === true ? { unlimited: true } : {}),
      };
    }
    out[day] = entries;
  }
  return out;
}

// ---------- 折成 money 形态（喂既有六档动画机） ----------

/** 币种符号（与 balance.ts 同口径：CNY → ¥，USD → $） */
function symbolOf(currency: string): string {
  return currency === 'USD' ? '$' : '¥';
}

/** 展示目标：焦点站（存在且查得到）优先，否则全舰队汇总 */
export type RelaysTarget =
  | { kind: 'fleet' }
  | { kind: 'site'; site: RelaysSiteResult; unlimited: boolean; manual: boolean };

export function resolveTarget(view: RelaysView): RelaysTarget {
  if (view.focusSiteId) {
    const site = view.sites.find((s) => s.siteId === view.focusSiteId);
    // 焦点站查得到（含手工值）→ 按焦点站展示；查不到 → 回落到全舰队（不猜）
    if (site && site.ok && site.total !== undefined) {
      return { kind: 'site', site, unlimited: site.unlimited === true, manual: site.source === 'manual' };
    }
  }
  return { kind: 'fleet' };
}

/**
 * 舰队/焦点站余额 → `BalanceState`（money 形态），喂上游六档动画机。
 *
 * - 舰队：汇总的 total/fullBalance（fullBalance 齐全才播档位——host 聚合层已保证口径）；
 * - 焦点站：该站自己的 total/fullBalance；
 * - 焦点站是无限额度 → **null**（没有「剩余」概念，不播档位、不当余额）；
 * - 无可计站（siteCount=0）→ **null**（不伪造 0 余额，也不覆盖单服务商展示）。
 */
export function relaysBalanceState(view: RelaysView): BalanceState | null {
  const target = resolveTarget(view);
  if (target.kind === 'site') {
    if (target.unlimited) return null;
    const total = target.site.total;
    if (total === undefined) return null;
    const fullBalance = target.site.fullBalance;
    return {
      provider: 'relay:' + target.site.siteId,
      shape: 'money',
      ok: true,
      currency: target.site.currency ?? 'USD',
      total,
      granted: total,
      toppedUp: '0.00',
      ...(fullBalance !== undefined ? { fullBalance } : {}),
    };
  }
  if (view.summary.siteCount <= 0) return null;
  return {
    provider: 'relay:fleet',
    shape: 'money',
    ok: true,
    currency: view.summary.currency,
    total: view.summary.total,
    granted: view.summary.total,
    toppedUp: '0.00',
    ...(view.summary.fullBalance !== undefined ? { fullBalance: view.summary.fullBalance } : {}),
  };
}

// ---------- 气泡文案 ----------

/** 低余额站点一句话（最多列 3 个，超出折计数） */
function lowSitesText(lowSites: RelaysLowSite[]): string {
  if (lowSites.length === 0) return '';
  const shown = lowSites
    .slice(0, 3)
    .map((s) => s.name + ' ' + symbolOf(s.currency) + s.amount)
    .join('、');
  return lowSites.length > 3
    ? '⚡ ' + lowSites.length + ' 个站余额偏低：' + shown + ' 等'
    : '⚡ ' + lowSites.length + ' 个站余额偏低：' + shown;
}

/**
 * 中转站气泡行（纯函数；浏览器 overlay 与桌面端可共用同一份文案）。
 *
 * - 焦点站：该站余额（无限 → 「无限额度 · 已用 $X」；手工 → 带「手工」标注）；
 * - 舰队：总余额 + 低余额告警 + 无限额度站数 + 其他币种说明 + 未确认换算率站数；
 * - **失败站不进文案**（failedCount>0 不弹错误气泡，避免每周期刷屏；管理页呈现）。
 */
export function relaysBubbleRows(view: RelaysView): BalanceBubbleRow[] {
  const target = resolveTarget(view);
  if (target.kind === 'site') {
    const sym = symbolOf(target.site.currency ?? 'USD');
    if (target.unlimited) {
      const spent = target.site.spent ?? target.site.total ?? '-';
      // 无限额度站**没有预计天数那一行**（没有 remaining 就没有"还能用多久"）
      return [{ role: 'label', text: '无限额度 · 已用 ' + sym + spent }];
    }
    const label = target.manual ? '余额 ' + sym + (target.site.total ?? '-') + '（手工）' : '余额 ' + sym + (target.site.total ?? '-');
    const rows: BalanceBubbleRow[] = [{ role: 'label', text: label }];
    rows.push(...burnRows(view, target.site.siteId, sym));
    const low = view.summary.lowSites.find((s) => s.siteId === target.site.siteId);
    if (low) rows.push({ role: 'sub', text: '⚠ 低于阈值 ' + sym + low.threshold });
    if (target.site.rateUnconfirmed === true) rows.push({ role: 'sub', text: '换算率未确认，请核对' });
    return rows;
  }

  // 舰队口径
  if (view.summary.siteCount <= 0 && view.summary.unlimitedCount <= 0) {
    return [{ role: 'label', text: '暂无可用余额数据' }];
  }
  const sym = symbolOf(view.summary.currency);
  const rows: BalanceBubbleRow[] = [];
  if (view.summary.siteCount > 0) {
    rows.push({ role: 'label', text: '舰队总余额 ' + sym + view.summary.total });
  } else {
    rows.push({ role: 'label', text: '全部站点均为无限额度' });
  }
  rows.push(...fleetBurnRows(view));
  const low = lowSitesText(view.summary.lowSites);
  if (low) rows.push({ role: 'sub', text: low });
  if (view.summary.unlimitedCount > 0) {
    rows.push({ role: 'sub', text: '∞ ' + view.summary.unlimitedCount + ' 站无限额度（不计入合计）' });
  }
  if (view.summary.otherCurrencies.length > 0) {
    rows.push({ role: 'sub', text: '另有 ' + view.summary.otherCurrencies.length + ' 站为其他币种，未计入' });
  }
  const unconfirmed = view.sites.filter((s) => s.rateUnconfirmed === true).length;
  if (unconfirmed > 0) {
    rows.push({ role: 'sub', text: unconfirmed + ' 站换算率未确认，请核对' });
  }
  return rows;
}

// ---------- 告警去重（OP-14：同一告警恢复前不重复弹） ----------

/**
 * 低余额告警键：当前低余额站点集合的稳定指纹。
 * 调用方保存上次的 key：key 变化（新站进/出低余额集合）才算一次「新告警」；
 * 余额在同一站内继续下跌 key 不变 → 不重复弹。
 */
export function relaysAlertKey(view: RelaysView): string {
  return view.summary.lowSites
    .map((s) => s.siteId)
    .sort()
    .join(',');
}

// ---------- 模型矩阵（GET /relays/models → 客户端视图） ----------

/**
 * 矩阵格子三态。**`unknown` 与 `no` 是两件事，绝不许揉成一个**：
 *   - `yes`     该站有這個模型
 *   - `no`      抓过，确认没有
 *   - `unknown` **没抓过 = 不知道**，不是「没有」
 *
 * 为什么单独一个类型：前端最容易写成 `!cell.available` 判「没有」——那样 `null`
 * （没抓过）会被渲染成「无」，用户据此判断「这站没我要的模型」而实际是从未抓过。
 * 矩阵本身（并集、三态、排序）由 host 的 `aggregateModelMatrix` 一次算清，
 * 两端 UI **只渲染、不重算**（重算就会出现两份真相漂移）。
 */
export type MatrixCellState = 'yes' | 'no' | 'unknown';

/**
 * 三态分类 —— **唯一**允许把 `boolean | null` 折成状态的地方，两端 UI 共用。
 * 纯函数、无依赖，`shared/relays.test.ts` 有 `null !== false` 的专项断言。
 */
export function matrixCellState(available: unknown): MatrixCellState {
  if (available === true) return 'yes';
  if (available === false) return 'no';
  return 'unknown';
}

/** 矩阵一个格子（站点列） */
export interface MatrixCell {
  siteId: string;
  name: string;
  state: MatrixCellState;
}

/** 矩阵一行（一个模型） */
export interface MatrixRow {
  id: string;
  cells: MatrixCell[];
}

export interface RelaysModelMatrix {
  rows: MatrixRow[];
  /** 从未抓过模型的站点数（UI 提示「N 个站未抓取」，不把未知演成没有） */
  unknownSiteCount: number;
}

/** 解析 `GET /relays/models` 的响应体；形状非法 → null（与 readRelays 同口径：不抛） */
export function readModelMatrix(payload: unknown): RelaysModelMatrix | null {
  const obj = asObj(payload);
  if (!obj || obj.ok !== true) return null;
  const rawRows = Array.isArray(obj.rows) ? obj.rows : null;
  if (rawRows === null) return null;
  const rows: MatrixRow[] = [];
  for (const raw of rawRows) {
    const row = asObj(raw);
    const id = asStr(row?.id);
    if (row === undefined || id === undefined) continue;
    const cells: MatrixCell[] = [];
    const rawCells = Array.isArray(row.sites) ? row.sites : [];
    for (const rawCell of rawCells) {
      const cell = asObj(rawCell);
      const siteId = asStr(cell?.siteId);
      if (cell === undefined || siteId === undefined) continue;
      cells.push({
        siteId,
        name: asStr(cell.name) ?? siteId,
        state: matrixCellState(cell.available),
      });
    }
    rows.push({ id, cells });
  }
  return { rows, unknownSiteCount: asNum(obj.unknownSiteCount) ?? 0 };
}

// ---------- 消耗速率与预计可用天数（T11） ----------

/**
 * 一天的快照（host 的 `snapshots.json` 里的一片）。
 * `spent` 是**累计已用**（不是当日增量）—— 速率靠累计值的差分算，充值不会污染它。
 */
export interface DaySnapshotEntry {
  spent?: string;
  remaining?: string;
  unlimited?: boolean;
}

/** 一天的快照：siteId → 该站当天的累计数据 */
export type DaySnapshots = Record<string, DaySnapshotEntry>;

/** 全部快照：`YYYY-MM-DD`（**本地时区**，不是 UTC）→ 当天的各站数据 */
export type SnapshotStore = Record<string, DaySnapshots>;

/** 本地时区的 `YYYY-MM-DD`。纯函数：日期由调用方给，本模块不读时钟 */
export function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 两个 `YYYY-MM-DD` 之间的日历天数；键非法 → null（不猜） */
export function daysBetween(fromDay: string, toDay: string): number | null {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** 速率判定所需的最少观测跨度（天）。少于它 → 数据不足，**不猜** */
export const BURN_MIN_SPAN_DAYS = 3;

/**
 * 单站消耗速率（美元/天）。**数据不足 → null，绝不返回 0。**
 *
 * 五个坑都在这里防（每条都有对应用例）：
 * 1. **只有 1 天快照 → null**。返回 0 会让 UI 显示「0 美元/天」或「预计 ∞ 天」，都是假数据；
 * 2. **中间断档不当 0 消耗**：速率按「首末两次观测的**日历跨度**」平均 —— 用户 3 天没开机，
 *    第 4 天又开，那 3 天确实没花钱，摊到跨度里才是真实均值；跨度 < {@link BURN_MIN_SPAN_DAYS}
 *    天 → null（样本太短，噪声比信号大）；
 * 3. 端点缺 `spent`（没有累计用量就算不出速率）→ null；
 * 4. 速率为负（期间充值过）→ null：负速率对「还能用多久」没有意义，不猜；
 * 5. **本函数不读时钟**：`today` 由调用方传入（host 下发，避免客户端各自取时钟漂移）。
 *
 * @param snapshots 快照表（本地时区日键）
 * @param siteId    站点 id
 * @param today     今天（`YYYY-MM-DD`，本地时区）；晚于它的快照一律忽略（防时钟漂移写出未来日子）
 */
export function computeBurnRate(snapshots: SnapshotStore, siteId: string, today: string): number | null {
  const days = Object.keys(snapshots ?? {})
    .filter((day) => day <= today)
    .filter((day) => {
      const entry = snapshots[day]?.[siteId];
      return entry !== undefined && typeof entry.spent === 'string' && entry.spent.length > 0;
    })
    .sort();
  if (days.length < 2) return null; // 坑 1
  const first = days[0];
  const last = days[days.length - 1];
  const span = daysBetween(first, last);
  if (span === null || span < BURN_MIN_SPAN_DAYS) return null; // 坑 2
  const from = Number(snapshots[first][siteId].spent);
  const to = Number(snapshots[last][siteId].spent);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null; // 坑 3
  const burn = (to - from) / span;
  if (!(burn > 0)) return null; // 坑 4（负值/NaN 一律不算）
  return burn;
}

/**
 * 预计剩余可用天数。
 *
 * - 速率未知 / 速率 ≤ 0 / remaining 缺失 → **null**（不是 ∞、不是 0 —— 那两个都是假数据）；
 * - remaining ≤ 0 → **0**（已经用完了，这个 0 是有意义的）；
 * - 其余 → `remaining / dailyBurn`，不取整（展示层自己定格式）。
 */
export function projectedDays(
  remaining: string | null | undefined,
  dailyBurn: number | null | undefined,
): number | null {
  if (dailyBurn === null || dailyBurn === undefined || !(dailyBurn > 0)) return null;
  if (remaining === null || remaining === undefined || remaining.length === 0) return null;
  const left = Number(remaining);
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 0;
  return left / dailyBurn;
}

/** 单站的消耗视图（把三个「不参与计算」的坑收在一处） */
export interface SiteBurn {
  siteId: string;
  /** 累计已用（无限额度站也有） */
  spent?: string;
  /** 距上一次观测的已用金额；没有上一次观测 → undefined */
  recentSpent?: string;
  /** `recentSpent` 覆盖的日历天数（1 = 就是「今日已用」） */
  recentSpanDays: number;
  /** 美元/天；null = 数据不足（**绝不是 0**） */
  daily: number | null;
  /** 预计剩余天数；null = 算不出 */
  projectedDays: number | null;
  /** 换算率未确认 → 数字可能差 1000 倍，一律不可信 */
  unreliable: boolean;
  /** 不参与速率计算的原因（UI 据此显示「数据不足」而不是数字） */
  excludedReason?: 'manual' | 'unlimited' | 'rate-unconfirmed';
}

/**
 * 单站消耗视图。三个「不参与计算」的坑在这里收口：
 * - **手工值**不是实时数据 → 不算速率；
 * - **无限额度**没有 remaining → 没有「还能用多久」，只显示已用；
 * - **换算率未确认** → 数字可能差 1000 倍 → 标 `unreliable` 且**不给数字**。
 */
export function siteBurn(
  snapshots: SnapshotStore,
  site: RelaysSiteResult,
  today: string,
): SiteBurn {
  const base: SiteBurn = { siteId: site.siteId, recentSpanDays: 0, daily: null, projectedDays: null, unreliable: false };
  if (site.source === 'manual') return { ...base, excludedReason: 'manual' };
  if (site.unlimited === true) {
    return { ...base, spent: site.spent ?? site.total, excludedReason: 'unlimited' };
  }
  if (site.rateUnconfirmed === true) {
    return { ...base, spent: site.spent, unreliable: true, excludedReason: 'rate-unconfirmed' };
  }

  const days = Object.keys(snapshots ?? {})
    .filter((day) => day <= today)
    .filter((day) => snapshots[day]?.[site.siteId] !== undefined)
    .sort();
  const lastDay: string | undefined = days.length > 0 ? days[days.length - 1] : undefined;
  const prevDay: string | undefined = days.length > 1 ? days[days.length - 2] : undefined;
  const lastEntry = lastDay === undefined ? undefined : snapshots[lastDay]?.[site.siteId];

  let recentSpent: string | undefined;
  let recentSpanDays = 0;
  if (lastEntry?.spent !== undefined && prevDay !== undefined && lastDay !== undefined) {
    const prevSpent = snapshots[prevDay]?.[site.siteId]?.spent;
    if (prevSpent !== undefined) {
      const delta = Number(lastEntry.spent) - Number(prevSpent);
      const span = daysBetween(prevDay, lastDay);
      if (Number.isFinite(delta) && span !== null && span > 0 && delta >= 0) {
        recentSpent = delta.toFixed(2);
        recentSpanDays = span;
      }
    }
  }

  const daily = computeBurnRate(snapshots, site.siteId, today);
  return {
    ...base,
    spent: site.spent ?? lastEntry?.spent,
    ...(recentSpent !== undefined ? { recentSpent } : {}),
    recentSpanDays,
    daily,
    projectedDays: projectedDays(site.total, daily),
  };
}

/** 全部站点的消耗视图（siteId → SiteBurn） */
export function relaysBurnMap(view: RelaysView): Record<string, SiteBurn> {
  const today = view.today ?? '';
  const out: Record<string, SiteBurn> = {};
  for (const site of view.sites) out[site.siteId] = siteBurn(view.snapshots ?? {}, site, today);
  return out;
}

// ---------- 气泡里的消耗行（T11 展示层） ----------

/**
 * 单站的「今日已用 / 预计天数」两行。
 *
 * 口径：拿不到就显示「数据不足」，**绝不显示数字**（0 / ∞ 都是假数据）。
 * 跨度 > 1 天时文案改成「近 N 天已用」—— 把 3 天前的用量说成"今日已用"是误导。
 */
export function burnRows(view: RelaysView, siteId: string, sym: string): BalanceBubbleRow[] {
  const burn = relaysBurnMap(view)[siteId];
  if (!burn) return [];
  const rows: BalanceBubbleRow[] = [];
  if (burn.recentSpent !== undefined) {
    const label = burn.recentSpanDays <= 1 ? '今日已用 ' : `近 ${burn.recentSpanDays} 天已用 `;
    rows.push({ role: 'sub', text: label + sym + burn.recentSpent });
  }
  if (burn.excludedReason === 'unlimited') return rows; // 无限额度：没有预计天数
  if (burn.projectedDays !== null) {
    rows.push({ role: 'sub', text: '预计还可使用 ' + Math.floor(burn.projectedDays) + ' 天' });
  } else if (burn.excludedReason !== undefined) {
    rows.push({ role: 'sub', text: burn.excludedReason === 'manual' ? '手工填写，无消耗统计' : '消耗数据不足' });
  } else {
    rows.push({ role: 'sub', text: '消耗数据不足（需连续观测 ' + BURN_MIN_SPAN_DAYS + ' 天以上）' });
  }
  return rows;
}

/** 舰队口径的消耗行：只汇总「算得出速率」的站，并如实说明有多少站算不出 */
export function fleetBurnRows(view: RelaysView): BalanceBubbleRow[] {
  const burns = relaysBurnMap(view);
  const countable = view.sites.filter((s) => {
    const b = burns[s.siteId];
    return b !== undefined && b.daily !== null && b.projectedDays !== null;
  });
  if (countable.length === 0) return [];
  // 预计天数取**最短**的那天：用户关心的是"最早哪个站会断"
  let worst: { siteId: string; days: number } | null = null;
  for (const site of countable) {
    const days = burns[site.siteId].projectedDays;
    if (days === null || days === undefined) continue;
    if (worst === null || days < worst.days) worst = { siteId: site.siteId, days };
  }
  const rows: BalanceBubbleRow[] = [];
  if (worst !== null) {
    const name = view.sites.find((s) => s.siteId === worst.siteId)?.siteId ?? worst.siteId;
    rows.push({ role: 'sub', text: `预计最短还可使用 ${Math.floor(worst.days)} 天（${name}）` });
  }
  const insufficient = view.sites.length - countable.length;
  if (insufficient > 0) {
    rows.push({ role: 'sub', text: insufficient + ' 站消耗数据不足' });
  }
  return rows;
}
