/**
 * pet-gateway-client 测试：发现口径（目录 + pid 活性 + 端口扫描兜底）与 HTTP 薄客户端。
 *
 * 钉的是与 src/standalone/discovery.ts 的**同序镜像**（tools/ 是 JS、不能 import TS）：
 * 谁改了发现语义忘了同步 JS 侧，这里红。假目录 + 注入 isAlive / scanProbe / fetch，
 * 不碰真文件系统、不碰真网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTE_PREFIX,
  discoverGatewayBase,
  gatewaysDir,
  helloAgent,
  isPidAlive,
  listLiveGateways,
  listAgents,
  postEvent,
} from '../../tools/pet-gateway-client.mjs';

/** 假造一个 gateways 目录（返回 home 路径；调用方负责 rmSync） */
function fakeHome(files: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-gw-'));
  const dir = gatewaysDir(home);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return home;
}

const RECORD = (pid: number, startedAt: string, url = 'http://127.0.0.1:3080') => ({
  schema: 1,
  instanceId: 'i-' + pid,
  mode: 'standalone',
  url,
  routePrefix: '/dsh-pet-7340',
  port: 3080,
  pid,
  startedAt,
  capabilities: ['presence'],
  tokenRequired: false,
});

test('gatewaysDir：<home>/dsh-pet/gateways', () => {
  assert.equal(gatewaysDir('D:/fake-home'), join('D:/fake-home', 'dsh-pet', 'gateways'));
});

test('isPidAlive：当前进程活着；不存在的 pid 死了', () => {
  assert.equal(isPidAlive(process.pid), true);
  // pid 2^31-1 几乎不可能存在（且 > 系统上限时 kill 抛 ESRCH）
  assert.equal(isPidAlive(2147483647), false);
});

test('listLiveGateways：只返活 pid；坏文件/坏形状跳过；按 startedAt 排序', () => {
  const home = fakeHome({
    '1.json': RECORD(1, '2026-10-18T00:00:01.000Z'),
    '2.json': RECORD(2, '2026-10-18T00:00:00.000Z'), // 启动更早 → 排前面
    '3.json': RECORD(3, '2026-10-18T00:00:02.000Z'), // pid 死 → 剔除
    'bad.json': '{not json',
    'shape.json': { schema: 2 }, // schema 不符 → 跳过（与 parseGatewayRecord 同口径）
    'noid.json': { url: 'http://x', pid: 1 }, // 缺 schema 等必达字段 → 跳过
    'readme.txt': 'ignore me', // 非 .json 不读
  });
  try {
    const alive = (pid: number) => pid !== 3;
    const list = listLiveGateways(home, alive);
    assert.deepEqual(
      list.map((g) => g.pid),
      [2, 1],
      '死 pid 剔除 + 坏形状跳过 + 按 startedAt 升序',
    );
    assert.equal(list[0].routePrefix, ROUTE_PREFIX, 'routePrefix 缺省补 ROUTE_PREFIX');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('listLiveGateways：目录不存在 → 空数组（不抛）', () => {
  assert.deepEqual(
    listLiveGateways('D:/no/such/dir', () => true),
    [],
  );
});

test('discoverGatewayBase：目录命中 → url + routePrefix（不扫端口）', async () => {
  // 用真活 pid（当前进程）：默认 isAlive 走 process.kill(pid,0)
  const home = fakeHome({ '1.json': RECORD(process.pid, '2026-10-18T00:00:00.000Z', 'http://127.0.0.1:3080') });
  try {
    const base = await discoverGatewayBase({ home, scanProbe: async () => assert.fail('不该扫端口') });
    assert.equal(base, 'http://127.0.0.1:3080/dsh-pet-7340');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverGatewayBase：目录空/全 stale → 端口扫描兜底（3080..3104）', async () => {
  const home = fakeHome({ '1.json': RECORD(1, '2026-10-18T00:00:00.000Z') }); // pid 1 判死
  try {
    const probed: number[] = [];
    const base = await discoverGatewayBase({
      home,
      scanProbe: async (port: number) => {
        probed.push(port);
        return port === 3085; // 第 6 个端口才活
      },
    });
    assert.equal(base, 'http://127.0.0.1:3085/dsh-pet-7340');
    assert.deepEqual(probed, [3080, 3081, 3082, 3083, 3084, 3085], '从 3080 起逐个探');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverGatewayBase：全都找不到 → null（调用方明确失败，不猜）', async () => {
  const home = fakeHome({});
  try {
    const base = await discoverGatewayBase({ home, scanProbe: async () => false });
    assert.equal(base, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- HTTP 薄客户端 ----------

/** 记录型假 fetch（按 URL 片段分流；非匹配 → 404） */
function fakeFetch(handlers: Record<string, { status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    let parsed;
    try {
      parsed = init.body ? JSON.parse(String(init.body)) : null;
    } catch {
      parsed = null;
    }
    calls.push({ url: String(url), method: init.method ?? 'GET', body: parsed });
    for (const [frag, preset] of Object.entries(handlers)) {
      if (String(url).includes(frag)) {
        const status = preset.status ?? 200;
        const text = preset.text ?? JSON.stringify(preset.body ?? {});
        return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":"not found"}' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('helloAgent：POST /agents/hello，body = {agentId, kind}', async () => {
  const { impl, calls } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
  });
  const r = await helloAgent('http://127.0.0.1:8231', { agentId: 'a@PC', kind: 'codex' }, { fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].body, { agentId: 'a@PC', kind: 'codex' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:8231/dsh-pet-7340/agents/hello');
});

test('postEvent：POST /events，body 原样透传', async () => {
  const { impl, calls } = fakeFetch({ '/events': { body: { ok: true } } });
  const r = await postEvent(
    'http://127.0.0.1:8231',
    { agentId: 'a@PC', status: 'working', task: 'x' },
    { fetchImpl: impl },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].body, { agentId: 'a@PC', status: 'working', task: 'x' });
});

test('listAgents：GET /agents', async () => {
  const { impl, calls } = fakeFetch({ '/agents': { body: { ok: true, agents: [] } } });
  const r = await listAgents('http://127.0.0.1:8231', { fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(calls[0].method, 'GET');
});

test('网络失败 → {ok:false, error}（绝不静默）；非 JSON 响应 body 落 null、text 带回', async () => {
  const boom = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r = await postEvent('http://127.0.0.1:8231', { agentId: 'a' }, { fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /ECONNREFUSED/);

  const html = (async () => ({ ok: true, status: 200, text: async () => '<html>nope' })) as unknown as typeof fetch;
  const r2 = await listAgents('http://127.0.0.1:8231', { fetchImpl: html });
  assert.equal(r2.body, null);
  assert.equal(r2.text, '<html>nope');
});
