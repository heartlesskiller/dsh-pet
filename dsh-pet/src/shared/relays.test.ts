/**
 * 中转站舰队视图（sections.relays）客户端纯逻辑测试。
 * 全部无 GUI、无网络、无 React：喂构造的叶子数据，断言解析/折算/文案/去重键。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BURN_MIN_SPAN_DAYS,
  burnRows,
  computeBurnRate,
  dayKeyOf,
  daysBetween,
  fleetBurnRows,
  matrixCellState,
  projectedDays,
  readModelMatrix,
  readRelays,
  relaysAlertKey,
  relaysBalanceState,
  relaysBubbleRows,
  relaysBurnMap,
  resolveTarget,
  siteBurn,
  type RelaysView,
  type SnapshotStore,
} from './relays.ts';
import { flattenCounters, takeChanged, type PollState } from './state.ts';

// ----------  fixtures ----------

/** 一份「3 站 1 无限 1 低额 1 失败 + 1 外币」的构造叶子（对账 PLAN M1 验收口径） */
function fleetLeaf(): Record<string, unknown> {
  return {
    focusSiteId: null,
    summary: {
      currency: 'USD',
      total: '10.00',
      fullBalance: '20.00',
      siteCount: 2,
      unlimitedCount: 1,
      failedCount: 1,
      lowSites: [{ siteId: 'b', name: 'B鲸站', amount: '3.02', currency: 'USD', threshold: '5' }],
      otherCurrencies: ['CNY'],
    },
    sites: [
      { ok: true, siteId: 'a', provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '10.00', granted: '10.00', toppedUp: '0.00', fullBalance: '20.00' } },
      { ok: true, siteId: 'b', provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '3.02', granted: '3.02', toppedUp: '0.00' } },
      { ok: true, siteId: 'c', provider: 'relay:new-api', shape: 'money', source: 'auto', unlimited: true, spent: '34.58', data: { currency: 'USD', total: '34.58', granted: '34.58', toppedUp: '0.00' } },
      { ok: false, siteId: 'd', provider: 'relay:new-api', reason: 'blocked', message: 'HTTP 403 疑似 Cloudflare 拦截' },
    ],
    health: [
      { siteId: 'a', health: 'online', status: 200, checkedAt: '2026-10-17T00:00:00.000Z' },
      { siteId: 'b', health: 'auth-failed', status: 401, checkedAt: '2026-10-17T00:00:00.000Z' },
    ],
    refreshedAt: '2026-10-17T00:00:00.000Z',
  };
}

// ---------- readRelays：解析与轮询安全 ----------

test('readRelays：完整叶子 → 视图（汇总/各站/健康/焦点全解析）', () => {
  const v = readRelays(fleetLeaf());
  assert.ok(v);
  assert.equal(v.focusSiteId, null);
  assert.equal(v.summary.total, '10.00');
  assert.equal(v.summary.siteCount, 2);
  assert.equal(v.summary.unlimitedCount, 1);
  assert.equal(v.summary.failedCount, 1);
  assert.deepEqual(v.summary.lowSites.map((s) => s.name), ['B鲸站']);
  assert.deepEqual(v.summary.otherCurrencies, ['CNY']);
  assert.equal(v.sites.length, 4);
  assert.equal(v.sites[2].unlimited, true);
  assert.equal(v.sites[2].spent, '34.58');
  assert.equal(v.sites[3].ok, false);
  assert.equal(v.sites[3].reason, 'blocked');
  assert.equal(v.health.length, 2);
  assert.equal(v.health[1].health, 'auth-failed');
  assert.equal(v.refreshedAt, '2026-10-17T00:00:00.000Z');
});

test('readRelays：host 失败形状 {ok:false} / 脏数据 → null（轮询安全，不抛）', () => {
  assert.equal(readRelays({ ok: false, reason: 'fetch-error', message: 'x' }), null);
  assert.equal(readRelays(null), null);
  assert.equal(readRelays('string'), null);
  assert.equal(readRelays([]), null);
  assert.equal(readRelays({ summary: { siteCount: 'x' } }), null);
  assert.equal(readRelays({ summary: {} }), null);
});

test('readRelays：焦点站点 id 透传；空串按无焦点', () => {
  assert.equal(readRelays({ ...fleetLeaf(), focusSiteId: 'a' })?.focusSiteId, 'a');
  assert.equal(readRelays({ ...fleetLeaf(), focusSiteId: '' })?.focusSiteId, null);
  assert.equal(readRelays({ ...fleetLeaf(), focusSiteId: 42 })?.focusSiteId, null);
});

test('readRelays：手工值站点带 source:manual（UI 必须标注「手工」）', () => {
  const leaf = fleetLeaf();
  (leaf.sites as Record<string, unknown>[])[0] = {
    ok: true, siteId: 'a', shape: 'money', source: 'manual',
    data: { currency: 'USD', total: '7.00', granted: '7.00', toppedUp: '0.00' },
  };
  const v = readRelays(leaf);
  assert.equal(v?.sites[0].source, 'manual');
  assert.equal(v?.sites[0].total, '7.00');
});

// ---------- relaysBalanceState：折成 money 形态喂六档动画 ----------

test('relaysBalanceState：舰队口径 → money 形态（汇总 total/fullBalance）', () => {
  const v = readRelays(fleetLeaf()) as RelaysView;
  const s = relaysBalanceState(v);
  assert.deepEqual(s, {
    provider: 'relay:fleet',
    shape: 'money',
    ok: true,
    currency: 'USD',
    total: '10.00',
    granted: '10.00',
    toppedUp: '0.00',
    fullBalance: '20.00',
  });
});

test('relaysBalanceState：无可计站 → null（不伪造 0，也不覆盖单服务商展示）', () => {
  const leaf = fleetLeaf();
  (leaf.summary as Record<string, unknown>).siteCount = 0;
  (leaf.summary as Record<string, unknown>).total = '0.00';
  const v = readRelays(leaf) as RelaysView;
  assert.equal(relaysBalanceState(v), null);
});

test('relaysBalanceState：焦点站优先用该站口径；无限额度焦点站 → null（不播档位）', () => {
  const withFocus = readRelays({ ...fleetLeaf(), focusSiteId: 'a' }) as RelaysView;
  const s = relaysBalanceState(withFocus);
  assert.ok(s !== null && s.ok, '焦点站口径必须折成 money 成功态');
  if (!s || !s.ok) return;
  assert.equal(s.provider, 'relay:a');
  assert.equal(s.total, '10.00');
  const focusUnlimited = readRelays({ ...fleetLeaf(), focusSiteId: 'c' }) as RelaysView;
  assert.equal(relaysBalanceState(focusUnlimited), null, '无限额度站没有「剩余」概念');
});

test('relaysBalanceState：焦点站查不到 → 回落到舰队口径（不猜）', () => {
  const focusFailed = readRelays({ ...fleetLeaf(), focusSiteId: 'd' }) as RelaysView;
  assert.equal(relaysBalanceState(focusFailed)?.provider, 'relay:fleet');
});

test('resolveTarget：焦点站存在且 ok → site；否则 fleet', () => {
  const v = readRelays({ ...fleetLeaf(), focusSiteId: 'b' }) as RelaysView;
  const t = resolveTarget(v);
  assert.equal(t.kind, 'site');
  if (t.kind !== 'site') return;
  assert.equal(t.site.siteId, 'b');
  assert.equal(t.manual, false);
});

// ---------- relaysBubbleRows：文案 ----------

test('relaysBubbleRows：舰队口径 —— 总余额 + 低额告警 + 无限站 + 外币 + 未确认', () => {
  const v = readRelays(fleetLeaf()) as RelaysView;
  const rows = relaysBubbleRows(v).map((r) => r.text);
  assert.ok(rows.includes('舰队总余额 $10.00'));
  assert.ok(rows.some((t) => t.includes('⚡ 1 个站余额偏低：B鲸站 $3.02')));
  assert.ok(rows.some((t) => t.includes('∞ 1 站无限额度（不计入合计）')));
  assert.ok(rows.some((t) => t.includes('另有 1 站为其他币种，未计入')));
  // 失败站不进文案（避免每周期刷屏）
  assert.ok(!rows.some((t) => t.includes('Cloudflare')));
});

test('relaysBubbleRows：焦点站无限额度 → 「无限额度 · 已用 $X」（绝不渲染成余额）', () => {
  const v = readRelays({ ...fleetLeaf(), focusSiteId: 'c' }) as RelaysView;
  const rows = relaysBubbleRows(v);
  assert.deepEqual(rows.map((r) => r.text), ['无限额度 · 已用 $34.58']);
});

test('relaysBubbleRows：焦点站手工值 → 带「手工」标注', () => {
  const leaf = fleetLeaf();
  (leaf.sites as Record<string, unknown>[])[0] = {
    ok: true, siteId: 'a', shape: 'money', source: 'manual',
    data: { currency: 'USD', total: '7.00', granted: '7.00', toppedUp: '0.00' },
  };
  const v = readRelays({ ...leaf, focusSiteId: 'a' }) as RelaysView;
  const rows = relaysBubbleRows(v).map((r) => r.text);
  assert.ok(rows.includes('余额 $7.00（手工）'));
});

test('relaysBubbleRows：低额焦点站带阈值说明；未确认换算率带核对提示', () => {
  const leaf = fleetLeaf();
  (leaf.sites as Record<string, unknown>[])[1] = {
    ok: true, siteId: 'b', shape: 'money', source: 'auto', rateUnconfirmed: true,
    data: { currency: 'USD', total: '3.02', granted: '3.02', toppedUp: '0.00' },
  };
  const v = readRelays({ ...leaf, focusSiteId: 'b' }) as RelaysView;
  const rows = relaysBubbleRows(v).map((r) => r.text);
  assert.ok(rows.includes('余额 $3.02'));
  assert.ok(rows.includes('⚠ 低于阈值 $5'));
  assert.ok(rows.includes('换算率未确认，请核对'));
});

test('relaysBubbleRows：全部无限 → 「全部站点均为无限额度」', () => {
  const leaf = fleetLeaf();
  (leaf.summary as Record<string, unknown>).siteCount = 0;
  const v = readRelays(leaf) as RelaysView;
  const rows = relaysBubbleRows(v).map((r) => r.text);
  assert.ok(rows.includes('全部站点均为无限额度'));
});

// ---------- relaysAlertKey：告警去重 ----------

test('relaysAlertKey：低余额集合的稳定指纹；集合不变 key 不变（不重复弹）', () => {
  const v = readRelays(fleetLeaf()) as RelaysView;
  const k1 = relaysAlertKey(v);
  assert.equal(k1, 'b');
  // 同一站余额继续跌：集合没变 → key 不变（OP-14：恢复前不重复弹）
  const leaf2 = fleetLeaf();
  ((leaf2.summary as Record<string, unknown>).lowSites as { amount: string }[])[0].amount = '1.00';
  assert.equal(relaysAlertKey(readRelays(leaf2) as RelaysView), k1);
  // 新站进集合 → key 变化（算新告警）
  const leaf3 = fleetLeaf();
  (leaf3.summary as Record<string, unknown>).lowSites = [
    { siteId: 'b', name: 'B', amount: '3.02', currency: 'USD', threshold: '5' },
    { siteId: 'e', name: 'E', amount: '1.00', currency: 'USD', threshold: '5' },
  ];
  assert.equal(relaysAlertKey(readRelays(leaf3) as RelaysView), 'b,e');
  // 无低余额 → 空 key（恢复）
  const leaf4 = fleetLeaf();
  (leaf4.summary as Record<string, unknown>).lowSites = [];
  assert.equal(relaysAlertKey(readRelays(leaf4) as RelaysView), '');
});

// ---------- 通配证明：新 section 自动进轮询比对 ----------

test('通配证明：sections.relays 的 counter 变化被 takeChanged 捕获（无需改 state.ts）', () => {
  const s1: PollState = { sections: { relays: { counter: 1, data: fleetLeaf() } }, pets: {} };
  const baseline = flattenCounters(s1);
  assert.equal(baseline['sections.relays'], 1, '首拉基线自动纳入新 section');
  // 首拉不渲染
  assert.deepEqual(takeChanged(s1, baseline), []);
  // host 下一拍写入（counter 递增）→ 被捕获，路径就是不透明键 'sections.relays'
  const s2: PollState = { sections: { relays: { counter: 2, data: fleetLeaf() } }, pets: {} };
  const changed = takeChanged(s2, baseline);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].path, 'sections.relays');
  const view = readRelays(changed[0].leaf.data);
  assert.ok(view);
  assert.equal(view.summary.total, '10.00');
});

// ---------- 模型矩阵：三态语义（unknown ≠ no，最容易被写成 !v 而丢掉的地方） ----------

test('matrixCellState：true/false/null 三态各自归位', () => {
  assert.equal(matrixCellState(true), 'yes');
  assert.equal(matrixCellState(false), 'no');
  assert.equal(matrixCellState(null), 'unknown');
  // 兜底：缺字段 / 非布尔一律按「未知」，绝不猜成「没有」
  assert.equal(matrixCellState(undefined), 'unknown');
  assert.equal(matrixCellState('yes'), 'unknown');
  assert.equal(matrixCellState(0), 'unknown');
  assert.equal(matrixCellState(1), 'unknown');
});

test('matrixCellState：null 与 false 必须被区分（专项断言，不许揉成一个）', () => {
  // 这条是整个矩阵的语义地基：写成 !available 就会把「没抓过」渲染成「没有」
  assert.notEqual(matrixCellState(null), matrixCellState(false));
  assert.equal(matrixCellState(null), 'unknown');
  assert.equal(matrixCellState(false), 'no');
  // 反证：若有人把实现改成 `available ? yes : no`，null 会掉进 no —— 这里必须红
  assert.notEqual(matrixCellState(null), 'no');
});

/** 造一个 host 形状的 /relays/models 响应 */
function matrixPayload(rows: unknown[], unknownSiteCount: number): unknown {
  return { ok: true, rows, unknownSiteCount };
}

test('readModelMatrix：三态从 host 形状正确落到客户端视图', () => {
  const view = readModelMatrix(
    matrixPayload(
      [
        {
          id: 'gpt-4o',
          sites: [
            { siteId: 'a', name: '甲站', available: true },
            { siteId: 'b', name: '乙站', available: false },
            { siteId: 'c', name: '丙站', available: null },
          ],
        },
      ],
      1,
    ),
  );
  assert.ok(view);
  assert.equal(view.rows.length, 1);
  assert.equal(view.unknownSiteCount, 1);
  assert.deepEqual(
    view.rows[0].cells.map((c) => [c.name, c.state]),
    [
      ['甲站', 'yes'],
      ['乙站', 'no'],
      ['丙站', 'unknown'],
    ],
  );
});

test('readModelMatrix：ok 不为 true / rows 不是数组 → null（轮询安全，不抛）', () => {
  assert.equal(readModelMatrix({ ok: false, reason: 'fetch-error' }), null);
  assert.equal(readModelMatrix({ ok: true }), null);
  assert.equal(readModelMatrix({ ok: true, rows: 'nope' }), null);
  assert.equal(readModelMatrix(null), null);
  assert.equal(readModelMatrix('x'), null);
});

test('readModelMatrix：坏行/坏格子被跳过，不拖垮整张矩阵', () => {
  const view = readModelMatrix(
    matrixPayload(
      [
        { id: 'ok-model', sites: [{ siteId: 'a', name: '甲站', available: true }] },
        { sites: [] }, // 缺 id
        { id: 'no-sites' }, // 缺 sites 数组 → 该行仍保留，只是没有格子
        { id: 'bad-cell', sites: [{ name: '无 siteId' }, 'x'] },
      ],
      0,
    ),
  );
  assert.ok(view);
  assert.deepEqual(view.rows.map((r) => r.id), ['ok-model', 'no-sites', 'bad-cell']);
  assert.equal(view.rows[0].cells.length, 1);
  assert.equal(view.rows[1].cells.length, 0);
  assert.equal(view.rows[2].cells.length, 0, '坏格子应被跳过');
  assert.equal(view.unknownSiteCount, 0);
});

test('readModelMatrix：保留 host 的排序（行按模型名、格子按站点名），不自行重排', () => {
  const view = readModelMatrix(
    matrixPayload(
      [
        { id: 'b-model', sites: [{ siteId: 's2', name: '乙站', available: true }] },
        { id: 'a-model', sites: [{ siteId: 's1', name: '甲站', available: true }] },
      ],
      0,
    ),
  );
  assert.ok(view);
  // 客户端只渲染：顺序由 host 定，客户端原样透传（改了就会出现两份真相）
  assert.deepEqual(view.rows.map((r) => r.id), ['b-model', 'a-model']);
});

test('readModelMatrix：unknownSiteCount 缺省按 0（不猜）', () => {
  const view = readModelMatrix({ ok: true, rows: [] });
  assert.ok(view);
  assert.equal(view.unknownSiteCount, 0);
  assert.deepEqual(view.rows, []);
});

// ---------- 消耗速率与预计可用天数（T11） ----------

const TODAY = '2026-10-18';

/** 造 n 天连续快照（累计已用线性增长），返回 { snapshots, days } */
function linearSnapshots(
  siteId: string,
  days: string[],
  startSpent: number,
  perDay: number,
): SnapshotStore {
  const out: SnapshotStore = {};
  days.forEach((day, i) => {
    out[day] = { [siteId]: { spent: (startSpent + perDay * i).toFixed(2), remaining: '50.00' } };
  });
  return out;
}

test('dayKeyOf / daysBetween：本地时区日键与日历跨度', () => {
  // 本地时区：1 月 1 日 00:30 必须还是 1 月 1 日（UTC 会算成上一年）
  assert.equal(dayKeyOf(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(dayKeyOf(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(daysBetween('2026-10-01', '2026-10-18'), 17);
  assert.equal(daysBetween('2026-10-18', '2026-10-18'), 0);
  assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30, '跨月按日历天数');
  assert.equal(daysBetween('bad', '2026-10-18'), null, '非法键 → null，不猜');
});

// ---- 坑 1：只有 1 天快照 → null，绝不是 0 ----

test('computeBurnRate：只有 1 天快照 → null（绝不是 0）', () => {
  const snaps = linearSnapshots('s1', ['2026-10-18'], 10, 1);
  assert.equal(computeBurnRate(snaps, 's1', TODAY), null);
  // 反证：若实现返回 0，UI 会显示「0 美元/天」或「预计 ∞ 天」，都是假数据
  assert.notEqual(computeBurnRate(snaps, 's1', TODAY), 0);
});

test('computeBurnRate：一天都没有 / 站点不在快照里 → null', () => {
  assert.equal(computeBurnRate({}, 's1', TODAY), null);
  assert.equal(computeBurnRate({ '2026-10-18': { other: { spent: '1.00' } } }, 's1', TODAY), null);
});

// ---- 坑 2：中间断档不能当 0 消耗 ----

test('computeBurnRate：断档按日历跨度平均，不当 0 消耗', () => {
  // 10-01 用 10.00，10-18 用 28.00 → 跨度 17 天，日均 18/17 ≈ 1.0588
  const snaps = linearSnapshots('s1', ['2026-10-01', '2026-10-18'], 10, 0);
  snaps['2026-10-18'].s1.spent = '28.00';
  const rate = computeBurnRate(snaps, 's1', TODAY);
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate - 18 / 17) < 1e-9, '日均 = 总消耗 / 日历跨度');
  // 中间没观测的日子**不能**按"只有 2 个观测点"去除（那会算成 9/天，高估 8 倍）
  assert.ok(Math.abs(rate - 9) > 1, '不得把断档当成 0 消耗');
});

test('computeBurnRate：跨度不足 3 天 → null（数据不足，不猜）', () => {
  const snaps = linearSnapshots('s1', ['2026-10-17', '2026-10-18'], 10, 5);
  assert.equal(computeBurnRate(snaps, 's1', TODAY), null, `跨度 < ${BURN_MIN_SPAN_DAYS} 天必须判数据不足`);
  // 恰好 3 天跨度（10-15 → 10-18）→ 可以算
  const ok = linearSnapshots('s1', ['2026-10-15', '2026-10-18'], 10, 5);
  assert.ok(computeBurnRate(ok, 's1', TODAY) !== null);
});

test('computeBurnRate：晚于 today 的快照一律忽略（防时钟漂移写出未来日子）', () => {
  // 10-01 累计 10.00，10-18 累计 11.00 → 跨度 17 天，日均 1/17
  const snaps = linearSnapshots('s1', ['2026-10-01', '2026-10-18', '2099-01-01'], 10, 1);
  snaps['2099-01-01'].s1.spent = '999.00';
  const rate = computeBurnRate(snaps, 's1', TODAY);
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate - 1 / 17) < 1e-9, '未来那天的 999 不得参与计算');
});

// ---- 坑 3/4：缺 spent / 负速率 ----

test('computeBurnRate：端点缺 spent → null；期间充值（负速率）→ null', () => {
  const noSpent = { '2026-10-01': { s1: { remaining: '50.00' } }, '2026-10-18': { s1: { remaining: '40.00' } } };
  assert.equal(computeBurnRate(noSpent, 's1', TODAY), null, '没有累计用量就算不出速率');
  const toppedUp = linearSnapshots('s1', ['2026-10-01', '2026-10-18'], 30, 0);
  toppedUp['2026-10-18'].s1.spent = '10.00'; // 累计已用反而变小 = 充值/重置
  assert.equal(computeBurnRate(toppedUp, 's1', TODAY), null, '负速率对"还能用多久"没有意义');
});

// ---- projectedDays 边界 ----

test('projectedDays：速率未知 → null（不是 ∞、不是 0）', () => {
  assert.equal(projectedDays('50.00', null), null);
  assert.equal(projectedDays('50.00', 0), null);
  assert.equal(projectedDays('50.00', -1), null);
  assert.equal(projectedDays(null, 1), null);
  assert.equal(projectedDays(undefined, 1), null);
  assert.equal(projectedDays('abc', 1), null);
});

test('projectedDays：remaining=0 → 0（这个 0 有意义）；负数夹到 0', () => {
  assert.equal(projectedDays('0.00', 2), 0);
  assert.equal(projectedDays('-5.00', 2), 0, '超额时如实报 0 而不是负数');
});

test('projectedDays：正常相除；速率极小 → 天数巨大（但不返回 Infinity）', () => {
  assert.equal(projectedDays('10.00', 2), 5);
  const huge = projectedDays('10.00', 0.0001);
  assert.ok(huge !== null && Number.isFinite(huge) && huge === 100000);
});

// ---- 坑 3/4/5：siteBurn 的三个"不参与计算" ----

test('siteBurn：无限额度站 → 没有预计天数，只给已用', () => {
  const b = siteBurn({}, { siteId: 's1', ok: true, unlimited: true, spent: '34.58', total: '34.58' }, TODAY);
  assert.equal(b.excludedReason, 'unlimited');
  assert.equal(b.spent, '34.58');
  assert.equal(b.daily, null);
  assert.equal(b.projectedDays, null, '无限额度没有 remaining → 预计天数必须是 null');
});

test('siteBurn：手工值站 → 不算速率（不是实时数据）', () => {
  const b = siteBurn(linearSnapshots('s1', ['2026-10-01', '2026-10-18'], 10, 1), { siteId: 's1', ok: true, source: 'manual', total: '12.00' }, TODAY);
  assert.equal(b.excludedReason, 'manual');
  assert.equal(b.daily, null);
  assert.equal(b.projectedDays, null);
});

test('siteBurn：换算率未确认 → 标 unreliable 且不给数字（可能差 1000 倍）', () => {
  const snaps = linearSnapshots('s1', ['2026-10-01', '2026-10-18'], 10, 1);
  const b = siteBurn(snaps, { siteId: 's1', ok: true, rateUnconfirmed: true, total: '50.00' }, TODAY);
  assert.equal(b.unreliable, true);
  assert.equal(b.excludedReason, 'rate-unconfirmed');
  assert.equal(b.daily, null, '不可信的数字不许显示');
  assert.equal(b.projectedDays, null);
});

test('siteBurn：正常站 → 今日已用 + 速率 + 预计天数都算得出', () => {
  // 4 天连续观测：跨度 3 天（够算速率），末两天相邻（够算"今日已用"）
  const snaps = linearSnapshots('s1', ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'], 10, 2);
  const b = siteBurn(snaps, { siteId: 's1', ok: true, total: '50.00' }, TODAY);
  assert.equal(b.recentSpent, '2.00');
  assert.equal(b.recentSpanDays, 1, '跨度 1 天 = 就是"今日已用"');
  assert.equal(b.daily, 2);
  assert.equal(b.projectedDays, 25);
  assert.equal(b.unreliable, false);
});

test('siteBurn：跨度 > 1 天时 recentSpanDays 反映真实跨度（UI 据此改文案）', () => {
  const snaps = linearSnapshots('s1', ['2026-10-15', '2026-10-18'], 10, 0);
  snaps['2026-10-18'].s1.spent = '19.00';
  const b = siteBurn(snaps, { siteId: 's1', ok: true, total: '50.00' }, TODAY);
  assert.equal(b.recentSpent, '9.00');
  assert.equal(b.recentSpanDays, 3, '3 天没用"今日已用"表述，UI 会显示"近 3 天已用"');
});

// ---- 气泡行 ----

test('burnRows：拿不到就显示"数据不足"，绝不显示数字', () => {
  const view = {
    focusSiteId: null,
    summary: { currency: 'USD', total: '50.00', siteCount: 1, unlimitedCount: 0, failedCount: 0, lowSites: [], otherCurrencies: [] },
    sites: [{ siteId: 's1', ok: true, total: '50.00' }],
    health: [],
    today: TODAY,
    snapshots: {},
  };
  const rows = burnRows(view, 's1', '$');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].text.includes('数据不足'), rows[0].text);
  assert.equal(/[0-9]/.test(rows[0].text.replace(String(BURN_MIN_SPAN_DAYS), '')), false, '不得出现编造的数字');
});

test('burnRows：无限额度站只有"已用"那一行，没有预计天数', () => {
  const view = {
    focusSiteId: null,
    summary: { currency: 'USD', total: '0.00', siteCount: 0, unlimitedCount: 1, failedCount: 0, lowSites: [], otherCurrencies: [] },
    sites: [{ siteId: 's1', ok: true, unlimited: true, spent: '34.58', total: '34.58' }],
    health: [],
    today: TODAY,
    snapshots: {},
  };
  const rows = burnRows(view, 's1', '$');
  assert.equal(rows.length, 0, '无限额度站不追加消耗行（气泡主行已是"无限额度 · 已用 $X"）');
});

test('relaysBubbleRows：单站口径带"今日已用 / 预计还可使用 N 天"', () => {
  const snaps = linearSnapshots('s1', ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'], 10, 2);
  const view = {
    focusSiteId: 's1',
    summary: { currency: 'USD', total: '50.00', siteCount: 1, unlimitedCount: 0, failedCount: 0, lowSites: [], otherCurrencies: [] },
    sites: [{ siteId: 's1', ok: true, total: '50.00' }],
    health: [],
    today: TODAY,
    snapshots: snaps,
  };
  const rows = relaysBubbleRows(view);
  const text = rows.map((r) => r.text).join(' | ');
  assert.ok(text.includes('今日已用 $2.00'), text);
  assert.ok(text.includes('预计还可使用 25 天'), text);
});

test('fleetBurnRows：只汇总算得出速率的站，并如实说明多少站数据不足', () => {
  // 10-01 累计 10.00 → 10-18 累计 27.00：跨度 17 天，日均 1 → 剩余 8.00 预计 8 天
  const snaps = linearSnapshots('s1', ['2026-10-01', '2026-10-18'], 10, 0);
  snaps['2026-10-18'].s1.spent = '27.00';
  snaps['2026-10-18'].s1.remaining = '8.00';
  const view = {
    focusSiteId: null,
    summary: { currency: 'USD', total: '8.00', siteCount: 2, unlimitedCount: 0, failedCount: 0, lowSites: [], otherCurrencies: [] },
    sites: [
      { siteId: 's1', ok: true, total: '8.00' },
      { siteId: 's2', ok: true, total: '99.00' }, // 没有快照 → 数据不足
    ],
    health: [],
    today: TODAY,
    snapshots: snaps,
  };
  const rows = fleetBurnRows(view);
  const text = rows.map((r) => r.text).join(' | ');
  assert.ok(text.includes('预计最短还可使用 8 天'), text);
  assert.ok(text.includes('1 站消耗数据不足'), text);
});

test('relaysBurnMap：每个站点都有条目，键稳定', () => {
  const view = {
    focusSiteId: null,
    summary: { currency: 'USD', total: '0.00', siteCount: 2, unlimitedCount: 0, failedCount: 0, lowSites: [], otherCurrencies: [] },
    sites: [{ siteId: 'a', ok: true, total: '1.00' }, { siteId: 'b', ok: true, total: '2.00' }],
    health: [],
    today: TODAY,
    snapshots: {},
  };
  const map = relaysBurnMap(view);
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b']);
  assert.equal(map.a.daily, null);
});

// ---- 纯函数无时钟依赖（自证） ----

test('纯函数模块不读时钟：computeBurnRate / projectedDays 体内没有 new Date() / Date.now()', () => {
  const src = readFileSync(new URL('./relays.ts', import.meta.url), 'utf8');
  // 取出两个目标函数的函数体（从声明到下一个顶层声明）
  const bodyOf = (name: string): string => {
    const start = src.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}`);
    const next = src.indexOf('\nexport ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  for (const name of ['computeBurnRate', 'projectedDays']) {
    const body = bodyOf(name);
    assert.equal(/new Date\(/.test(body), false, `${name} 里出现了 new Date()`);
    assert.equal(/Date\.now\(/.test(body), false, `${name} 里出现了 Date.now()`);
    assert.equal(/dayKeyOf\(/.test(body), false, `${name} 不应自己取"今天"`);
  }
  // 时钟只能从参数进来：computeBurnRate 的第三个参数就是 today
  assert.ok(bodyOf('computeBurnRate').includes('today: string'));
});
