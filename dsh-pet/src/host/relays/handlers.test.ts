/**
 * 中转站路由 **有副作用那一层**（`./handlers`）的直连测试（S1 抽离带出来的新缝）。
 *
 * 为什么单独一份：`handleRelayRequest` 现在接一个**显式依赖**（`RelayHandlerDeps`），
 * 而不是靠闭包摸宿主。这让「焦点切换后要不要立刻重刷状态叶」这段分支第一次变得可测 ——
 * 以前它在 `apply()` 闭包里，只能靠整条 HTTP 链路间接碰。
 *
 * 覆盖点（全部无网络、无 GUI、无真实端口）：
 *   - 依赖注入真的生效（数据目录指到临时目录 → 读到的是那个目录）；
 *   - `focus` 分支对 `hasEnabledRelaySites()` 门控的尊重（有启用站才重刷，没有就不空跑）；
 *   - 抽离前后没被覆盖的纯读分支（`models` 矩阵、`site-models` 无凭证、`detect` 参数错）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { handleRelayRequest, type RelayHandlerDeps } from './handlers.ts';
import { readFocus, readModelCache, setSiteModels, upsertSite, writeFocus } from './store.ts';
import type { RouteResult } from '../route-result.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'relay-handlers-'));
}

/** 造依赖；记录 refreshRelays 被调用次数，供门控断言 */
function makeDeps(relayDir: string, enabled: boolean): { deps: RelayHandlerDeps; refreshCalls: () => number } {
  let calls = 0;
  return {
    deps: {
      relayDir,
      hasEnabledRelaySites: () => enabled,
      refreshRelays: async () => {
        calls += 1;
      },
    },
    refreshCalls: () => calls,
  };
}

function json(r: RouteResult): { status: number; body: Record<string, unknown> } {
  assert.equal(r.kind, 'json', '中转站路由只回 JSON');
  if (r.kind !== 'json') throw new Error('unreachable');
  return { status: r.status, body: r.obj as Record<string, unknown> };
}

test('依赖注入生效：relayDir 指向临时目录 → 读到的是那个目录（不是宿主默认路径）', async () => {
  const dir = tmp();
  try {
    const { deps } = makeDeps(dir, false);
    const r = json(await handleRelayRequest(deps, 'relays', 'GET'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, sites: [] });
    // 往这个目录建一个站 → 同一 deps 立刻能读到（证明读写都走注入的目录）
    upsertSite(dir, { name: '注入站', url: 'https://inj.example.com', kind: 'new-api' });
    const again = json(await handleRelayRequest(deps, 'relays', 'GET'));
    assert.equal((again.body.sites as unknown[]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- focus 分支：抽离带出来的注入缝 ----------

test('focus：有启用站点时 → 写焦点并立刻重刷状态叶（调用 refreshRelays）', async () => {
  const dir = tmp();
  try {
    const site = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const { deps, refreshCalls } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, 'relays/focus', 'POST', JSON.stringify({ siteId: site.id })));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, focusSiteId: site.id });
    assert.equal(readFocus(dir), site.id, '焦点必须落盘');
    assert.equal(refreshCalls(), 1, '用户操作不能被刷新周期拖 30 分钟');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus：没有启用站点时 → 只写焦点，不空跑 refreshRelays', async () => {
  const dir = tmp();
  try {
    const site = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api', enabled: false });
    const { deps, refreshCalls } = makeDeps(dir, false);
    json(await handleRelayRequest(deps, 'relays/focus', 'POST', JSON.stringify({ siteId: site.id })));
    assert.equal(readFocus(dir), site.id);
    assert.equal(refreshCalls(), 0, '没有启用站点就没有可刷的叶，不该空跑');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus：未知站点 → 404 且不重刷；传空 siteId → 清除焦点', async () => {
  const dir = tmp();
  try {
    writeFocus(dir, 'stale-id');
    const { deps, refreshCalls } = makeDeps(dir, true);
    const bad = json(await handleRelayRequest(deps, 'relays/focus', 'POST', JSON.stringify({ siteId: 'nope' })));
    assert.equal(bad.status, 404);
    assert.equal(refreshCalls(), 0, '失败的焦点切换不该触发重刷');
    assert.equal(readFocus(dir), 'stale-id', '失败不得改动已有焦点');

    const cleared = json(await handleRelayRequest(deps, 'relays/focus', 'POST', JSON.stringify({ siteId: '' })));
    assert.deepEqual(cleared.body, { ok: true, focusSiteId: null });
    assert.equal(readFocus(dir), undefined, '空 siteId = 清除焦点');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus：非 POST → 405；坏 JSON → 400', async () => {
  const dir = tmp();
  try {
    const { deps } = makeDeps(dir, true);
    assert.equal(json(await handleRelayRequest(deps, 'relays/focus', 'GET')).status, 405);
    assert.equal(json(await handleRelayRequest(deps, 'relays/focus', 'POST', '{ not json')).status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 抽离前零覆盖的纯读分支 ----------

test('models：只读缓存聚合（未抓过 → 0 行 + 全部站点计为未知）', async () => {
  const dir = tmp();
  try {
    upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const { deps } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, 'relays/models', 'GET'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, rows: [], unknownSiteCount: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('models：抓过缓存后按三态出矩阵（true / null）', async () => {
  const dir = tmp();
  try {
    const a = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    upsertSite(dir, { name: 'B站', url: 'https://b.example.com', kind: 'new-api' });
    setSiteModels(dir, a.id, [{ id: 'gpt-4o' }]);
    const { deps } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, 'relays/models', 'GET'));
    const rows = r.body.rows as Array<{ id: string; sites: Array<{ name: string; available: boolean | null }> }>;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].sites.map((c) => [c.name, c.available]), [['A站', true], ['B站', null]]);
    assert.equal(r.body.unknownSiteCount, 1);
    assert.ok(readModelCache(dir)[a.id], '缓存确实落在注入的目录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('site-models：无凭证 → 200 + {ok:false, reason:credential-missing}（不发网络请求）', async () => {
  const dir = tmp();
  try {
    const site = upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
    const { deps } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, `relays/${site.id}/models`, 'POST'));
    assert.equal(r.status, 200, '动作类失败走 200 + ok:false，与既有分支同口径');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'credential-missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detect：缺少 url → 400（参数错走 4xx + {error}，不静默）', async () => {
  const dir = tmp();
  try {
    const { deps } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, 'relays/detect', 'POST', JSON.stringify({})));
    assert.equal(r.status, 400);
    assert.ok(typeof r.body.error === 'string' && (r.body.error as string).includes('URL'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知路径 → 404 + {error}（与 entry 层的兜底一致）', async () => {
  const dir = tmp();
  try {
    const { deps } = makeDeps(dir, true);
    const r = json(await handleRelayRequest(deps, 'relays/a/b/c', 'GET'));
    assert.equal(r.status, 404);
    assert.equal(typeof r.body.error, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
