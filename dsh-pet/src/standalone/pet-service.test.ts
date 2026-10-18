/**
 * 端口占用者三态（`scripts/pet-service.mjs` 的 `classifyPortOccupant` / `ensurePetService`）。
 *
 * ## 这份测试在钉什么
 * DSH 宿主也监听 **3080** —— 和独立模式是同一个默认端口。旧代码只问了一句
 * "`/health` 的 `name` 是不是 `dsh-pet-standalone`"，答"不是"就当成**没在跑**，
 * 于是：
 *   1. spawn 一个独立服务 → 撞端口（DSH 占着）→ 子进程退出
 *   2. 启动器循环等 30 秒 → 报"30s 内没起来"
 *   3. 双击「中转站管理」的用户：干等 30 秒，浏览器永远不打开
 *
 * 修法是把布尔换成三态，并让 `foreign` **在 spawn 之前**就抛。
 * 所以这里最关键的一条断言是：**判定 foreign 时 spawn 调用次数必须是 0**。
 *
 * 全部无网络、无子进程、无端口占用（探测与 spawn 都注入）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyPortOccupant, ensurePetService, LaunchFailure } from '../../scripts/pet-service.mjs';
import type { PortProbe, SpawnedChildLike } from '../../scripts/pet-service.mjs';

// ---------- 三态判定：6 种输入 ----------

test('连不上（连接拒绝/超时）→ none（端口空着，可以去起服务）', () => {
  assert.equal(classifyPortOccupant({ reachable: false, body: undefined }), 'none');
  // 防御：传空也不许抛
  assert.equal(classifyPortOccupant(undefined), 'none');
});

test('返回我们的健康体 → our-standalone（直接用，不 spawn）', () => {
  const probe: PortProbe = { reachable: true, body: { name: 'dsh-pet-standalone', port: 3080 } };
  assert.equal(classifyPortOccupant(probe), 'our-standalone');
});

test('别人家的 JSON（DSH 宿主）→ foreign', () => {
  const probe: PortProbe = { reachable: true, body: { name: 'dsh-host', version: '2.0.3' } };
  assert.equal(classifyPortOccupant(probe), 'foreign');
});

test('返回 HTML（反代/错误页）→ foreign（body 解析不出 name）', () => {
  assert.equal(classifyPortOccupant({ reachable: true, body: undefined }), 'foreign');
  assert.equal(classifyPortOccupant({ reachable: true, body: '<html>404</html>' }), 'foreign');
});

test('返回 404 JSON（没有 name 字段）→ foreign', () => {
  assert.equal(classifyPortOccupant({ reachable: true, body: { error: 'not found' } }), 'foreign');
});

test('有 name 但值不对 / 不是字符串 → foreign（不靠模糊匹配）', () => {
  assert.equal(classifyPortOccupant({ reachable: true, body: { name: 'dsh-pet' } }), 'foreign');
  assert.equal(classifyPortOccupant({ reachable: true, body: { name: 'DSH-PET-STANDALONE' } }), 'foreign');
  assert.equal(classifyPortOccupant({ reachable: true, body: { name: 42 } }), 'foreign');
  assert.equal(classifyPortOccupant({ reachable: true, body: null }), 'foreign');
});

// ---------- ensurePetService：foreign 绝不 spawn ----------

/** 计数的假 spawn：被调用就记一笔，并返回最小子进程桩（本用例里不该被调用到） */
function countingSpawn(): { spawnFn: () => SpawnedChildLike; calls: () => number } {
  let calls = 0;
  return {
    spawnFn: () => {
      calls += 1;
      return { on: () => {}, unref: () => {}, pid: 1 };
    },
    calls: () => calls,
  };
}

test('🔴 判定 foreign → 立刻抛 LaunchFailure，spawn 调用次数 = 0（本 bug 的根因）', async () => {
  const { spawnFn, calls } = countingSpawn();
  const started = Date.now();
  await assert.rejects(
    () =>
      ensurePetService(3080, {
        probe: async () => ({ reachable: true, body: { name: 'dsh-host' } }),
        spawnFn,
      }),
    (e: unknown) => {
      assert.ok(e instanceof LaunchFailure, '必须是 LaunchFailure，调用方据此分类');
      assert.equal((e as InstanceType<typeof LaunchFailure>).reason, 'foreign-occupant');
      assert.match((e as Error).message, /别的程序占用/);
      return true;
    },
  );
  assert.equal(calls(), 0, '判定 foreign 后绝不许 spawn —— DSH 占着端口，spawn 只会撞上去再干等 30 秒');
  // 必须"立刻"返回，不许走那个 30 秒等待循环
  assert.ok(Date.now() - started < 2000, `耗时 ${Date.now() - started}ms，应为立刻返回`);
});

test('判定 none → 才允许 spawn（证明注入的假 spawn 真的接上了）', async () => {
  let calls = 0;
  // 让假 spawn 直接抛哨兵：证明代码确实走到了 spawn 这一步，且不必真起服务
  await assert.rejects(
    () =>
      ensurePetService(3099, {
        probe: async () => ({ reachable: false, body: undefined }),
        spawnFn: () => {
          calls += 1;
          throw new Error('SPAWN_REACHED');
        },
      }),
    /SPAWN_REACHED/,
  );
  assert.equal(calls, 1, '端口空着就应该去起服务');
});

test('判定 our-standalone → 直接用，spawn 调用次数 = 0', async () => {
  const { spawnFn, calls } = countingSpawn();
  const r = await ensurePetService(3080, {
    probe: async () => ({ reachable: true, body: { name: 'dsh-pet-standalone' } }),
    spawnFn,
  });
  assert.equal(r.alreadyRunning, true);
  assert.equal(calls(), 0);
});
