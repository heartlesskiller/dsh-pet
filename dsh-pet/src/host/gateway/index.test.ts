/**
 * 网关分发测试：路径归类、方法门控、hello/agents/events 接线、state/stream 的 501 语义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capabilitiesPayload } from './capabilities.ts';
import { createGateway, gatewayRouteOf } from './index.ts';
import { AgentRegistry } from './agents.ts';
import type { IngestOptions } from './ingest.ts';

const ingest: IngestOptions = {
  pushSay: () => {},
  setWorkStatus: () => {},
  resolvePetId: () => 'main',
};

function makeGateway() {
  return createGateway({
    hostMode: 'standalone',
    caps: {},
    relayKinds: ['new-api', 'openai-compat'],
    instanceId: 'inst-test',
    registry: new AgentRegistry(),
    ingest,
    tokenRequired: false,
    sseMaxConnections: 8,
  });
}

test('gatewayRouteOf：只认五个精确路径（多段/前缀歧义 → undefined，不猜）', async () => {
  assert.equal(gatewayRouteOf('capabilities'), 'capabilities');
  assert.equal(gatewayRouteOf('agents'), 'agents');
  assert.equal(gatewayRouteOf('agents/hello'), 'agents/hello');
  assert.equal(gatewayRouteOf('events'), 'events');
  assert.equal(gatewayRouteOf('state/stream'), 'state/stream');
  assert.equal(gatewayRouteOf('agents/hello/x'), undefined);
  assert.equal(gatewayRouteOf('events/extra'), undefined);
  assert.equal(gatewayRouteOf('relays'), undefined);
});

test('GET /capabilities：投影档位表 + relayKinds + 实例 id（L0 自述）', async () => {
  const gw = makeGateway();
  const r = await gw.handle('capabilities', 'GET');
  assert.ok(r && typeof r === 'object' && r.kind === 'json');
  if (r.kind !== 'json') return;
  assert.equal(r.status, 200);
  const body = r.obj as ReturnType<typeof capabilitiesPayload>;
  assert.equal(body.ok, true);
  assert.equal(body.instanceId, 'inst-test');
  assert.equal(body.mode, 'standalone');
  assert.deepEqual(body.relayKinds, ['new-api', 'openai-compat']);
  assert.equal(body.tokenRequired, false);
  assert.equal(body.sseMaxConnections, 8);
  assert.deepEqual(body.tiers.L0, ['/capabilities', '/agents/hello', '/health']);
  assert.equal(body.hostCapabilities.credentials, 'local-file');
});

test('capabilitiesPayload：档位表是拷贝，改返回值不影响共享常量', async () => {
  const make = () =>
    capabilitiesPayload({
      hostMode: 'dsh',
      caps: {},
      relayKinds: ['new-api'],
      instanceId: 'x',
      agentCount: 0,
      tokenRequired: false,
      sseMaxConnections: 8,
      httpIngest: true,
    });
  const p = make();
  (p.tiers.L0 as string[]).push('/hacked');
  assert.ok(!make().tiers.L0.includes('/hacked'), '第二次调用不许被上一次的改动污染');
});

test('POST /agents/hello：登记成功 → 200 + leaseId；坏 JSON → 400；GET → 405', async () => {
  const gw = makeGateway();
  const ok = await gw.handle('agents/hello', 'POST', JSON.stringify({ agentId: 'claude', kind: 'cli' }));
  assert.ok(ok && ok.kind === 'json');
  if (ok.kind !== 'json') return;
  assert.equal(ok.status, 200);
  const body = ok.obj as { ok: boolean; leaseId?: string; ttlSec?: number };
  assert.equal(body.ok, true);
  assert.ok(body.leaseId && body.leaseId.length > 0);
  assert.equal(body.ttlSec, 60);

  const badJson = await gw.handle('agents/hello', 'POST', '{ not json');
  assert.equal(badJson.kind === 'json' && badJson.status, 400);

  const wrongMethod = await gw.handle('agents/hello', 'GET');
  assert.equal(wrongMethod.kind === 'json' && wrongMethod.status, 405);
});

test('GET /agents：空表 → { ok:true, agents: [] }；登记后能看到', async () => {
  const gw = makeGateway();
  const empty = await gw.handle('agents', 'GET');
  assert.ok(empty && empty.kind === 'json');
  if (empty.kind !== 'json') return;
  assert.deepEqual(empty.obj, { ok: true, agents: [] });

  await gw.handle('agents/hello', 'POST', JSON.stringify({ agentId: 'cursor' }));
  const listed = await gw.handle('agents', 'GET');
  if (listed.kind !== 'json') return;
  const agents = (listed.obj as { agents: Array<{ agentId: string }> }).agents;
  assert.deepEqual(agents.map((a) => a.agentId), ['cursor']);
});

test('POST /events：走摄入（notice 写入由注入的 pushSay 承接）；方法不对 → 405', async () => {
  let said = '';
  const gw = createGateway({
    hostMode: 'standalone',
    caps: {},
    relayKinds: [],
    instanceId: 'x',
    registry: new AgentRegistry(),
    ingest: {
      ...ingest,
      pushSay: (_petId, p) => {
        said = p.text;
      },
    },
    tokenRequired: false,
    sseMaxConnections: 8,
  });
  const r = await gw.handle('events', 'POST', JSON.stringify({ agentId: 'a', notice: { severity: 'info', text: '你好' } }));
  assert.equal(r.kind === 'json' && r.status, 200);
  assert.equal(said, '你好');
  const wrong = await gw.handle('events', 'GET');
  assert.equal(wrong.kind === 'json' && wrong.status, 405);
});

test('GET /state/stream：走 RouteResult 管道时显式 501（SSE 只能 HTTP 直连）', async () => {
  const gw = makeGateway();
  const r = await gw.handle('state/stream', 'GET');
  assert.ok(r && r.kind === 'json');
  if (r.kind !== 'json') return;
  assert.equal(r.status, 501);
  const body = r.obj as { error: string; message: string };
  assert.equal(body.error, 'stream-requires-http');
  assert.match(body.message, /bridge/);
});
