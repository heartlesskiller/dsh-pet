/**
 * 网关端到端（T07）：伪 ctx + **真实 apply** + 真实 `node:http` 服务。
 *
 * 与 integration.test.ts 同一套手法，单独一份文件避免把网关断言混进既有契约：
 *   1. `GET /capabilities` 在独立模式下如实自报（mode=standalone、四个能力槽、档位表）；
 *   2. `POST /agents/hello` + `GET /agents` 的 TTL 登记经真实 HTTP 可用；
 *   3. `POST /events` 的 status 段**真的写进了 sections.workStatus**（经 /state 读回，
 *      证明走的是状态仓而不是回显）；
 *   4. `GET /state/stream` 是真实 SSE（首帧 = 当前快照），且能正常断开。
 *
 * 限制（同 integration.test.ts）：源码形态下包内 assets 不可达，成品配置读不到 →
 * 不依赖 pets 的断言（这里只用 status 段，不需要桌宠在场）。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageRoot } from '../host/helper-process.ts';
import { apply } from '../host/index.ts';
import { createStandaloneContext, type RegisteredRoute, type StandaloneLogger } from './context.ts';
import { listenStandaloneServer, type StandaloneServer } from './server.ts';

const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let home = '';
let base = '';
let server: StandaloneServer | undefined;
let savedHome: string | undefined;
let savedElectron: string | undefined;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-gateway-'));
  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = home;
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  const routes: RegisteredRoute[] = [];
  const portRef = { value: 0 };
  const created = createStandaloneContext({ port: () => portRef.value, logger: silent, routes });
  const listening = await listenStandaloneServer({
    routes,
    logger: silent,
    port: 0,
    status: () => ({ name: 'dsh-pet-standalone', plugin: { root: packageRoot } }),
  });
  portRef.value = listening.port;
  apply(created.ctx);
  server = listening;
  base = `http://127.0.0.1:${listening.port}`;
});

after(async () => {
  await server?.close();
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  rmSync(home, { recursive: true, force: true });
});

describe('网关 E2E（真实 HTTP）', () => {
  test('GET /capabilities：独立模式如实自报（不虚报 llm，凭证来源是本机文件）', async () => {
    const res = await fetch(`${base}/dsh-pet-7340/capabilities`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      hostCapabilities: { llm: boolean; credentials: string; sessionEvents: string };
      tiers: Record<string, string[]>;
      relayKinds: string[];
      tokenRequired: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'standalone');
    assert.equal(body.hostCapabilities.llm, false, '伪 ctx 的替身不是能力，不许虚报');
    assert.equal(body.hostCapabilities.credentials, 'local-file');
    assert.equal(body.hostCapabilities.sessionEvents, 'http', '独立模式的事件来源是 HTTP 摄入');
    assert.ok(body.tiers.L0.includes('/capabilities'));
    assert.deepEqual(body.relayKinds, ['new-api', 'openai-compat']);
    assert.equal(body.tokenRequired, false);
  });

  test('POST /agents/hello → GET /agents：真实登记与在场列表', async () => {
    const hello = await fetch(`${base}/dsh-pet-7340/agents/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'e2e-agent', kind: 'test', wants: ['pet:drive'] }),
    });
    assert.equal(hello.status, 200);
    const helloBody = (await hello.json()) as { ok: boolean; leaseId: string; ttlSec: number };
    assert.equal(helloBody.ok, true);
    assert.ok(helloBody.leaseId.length > 0);
    assert.equal(helloBody.ttlSec, 60);

    const list = await fetch(`${base}/dsh-pet-7340/agents`);
    const listBody = (await list.json()) as { agents: Array<{ agentId: string }> };
    assert.deepEqual(listBody.agents.map((a) => a.agentId), ['e2e-agent']);
  });

  test('POST /events（status）→ GET /state 读回 sections.workStatus（证明写进状态仓）', async () => {
    const post = await fetch(`${base}/dsh-pet-7340/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'e2e-agent', status: 'working' }),
    });
    assert.equal(post.status, 200);
    const posted = (await post.json()) as { ok: boolean };
    assert.equal(posted.ok, true);

    const state = await fetch(`${base}/dsh-pet-7340/state`);
    const snapshot = (await state.json()) as {
      sections: { workStatus: { data: { state: string } | null } };
    };
    assert.equal(snapshot.sections.workStatus.data?.state, 'working', 'HTTP 摄入要真的驱动六档');

    // idle 回去（清会话）——同一入口，验证 null 分支
    const idle = await fetch(`${base}/dsh-pet-7340/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'e2e-agent', status: 'idle' }),
    });
    assert.equal(idle.status, 200);
    const after = (await fetch(`${base}/dsh-pet-7340/state`)).json() as Promise<{
      sections: { workStatus: { data: { state: string } | null } };
    }>;
    assert.equal((await after).sections.workStatus.data?.state ?? null, null, 'idle 清回空闲');
  });

  test('GET /state/stream：真实 SSE —— 首帧是当前快照，断开不残留', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/dsh-pet-7340/state/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body?.getReader();
    assert.ok(reader, 'SSE 必须有流式 body');
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /^id: \d+\nevent: snapshot\ndata: \{/);
    assert.match(text, /"sections"/, '首帧就是完整的 /state 快照');
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
