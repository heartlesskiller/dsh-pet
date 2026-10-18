/**
 * 在场投影器测试（docs/19 §8 A3）：hello→投影；TTL 过期→剔出；**签名不变不 write**；activeCount 正确。
 *
 * 假时钟驱动 registry 的 TTL（registry 读时 prune，投影器自己无时钟——双时钟会不一致，
 * 见 presence.ts 对 PresenceDeps.now 的说明）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRegistry } from './agents.ts';
import {
  createPresenceProjector,
  type AgentsSectionData,
  type PresenceDeps,
} from './presence.ts';
import type { HostWorkStatusState } from '../work-status';

/** 造一套：假时钟 + registry + 合成会话表 + 写入记录器 */
function harness(ttlMs = 60_000): {
  deps: PresenceDeps;
  writes: AgentsSectionData[];
  sessions: Map<string, { state: HostWorkStatusState | null; task: string | null }>;
  advance: (ms: number) => void;
} {
  let now = 1_000;
  const registry = new AgentRegistry({ ttlMs, now: () => now });
  // 合成会话表（index.ts 里就是 WorkStatusStore 的 http:<agentId> 条目）
  const sessions = new Map<string, { state: HostWorkStatusState | null; task: string | null }>();
  const writes: AgentsSectionData[] = [];
  const deps: PresenceDeps = {
    registry,
    workStateOf: (agentId) => sessions.get('http:' + agentId),
    write: (data) => writes.push(data),
    now: () => now,
  };
  return { deps, writes, sessions, advance: (ms: number) => (now += ms) };
}

test('hello → 投影：在场条目带 kind/租期；合成会话的 state/task 一并落位', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'workbuddy@PC', kind: 'workbuddy' });
  h.sessions.set('http:workbuddy@PC', { state: 'working', task: 'pnpm test' });
  projector.refresh();

  assert.equal(h.writes.length, 1);
  const data = h.writes[0];
  assert.equal(data.agents.length, 1);
  assert.deepEqual(data.agents[0], {
    agentId: 'workbuddy@PC',
    kind: 'workbuddy',
    state: 'working',
    task: 'pnpm test',
    lastSeenAt: 1_000,
    expiresAt: 61_000,
  });
  assert.equal(data.activeCount, 1);
});

test('无合成会话的 agent → state/task 落 null（不猜、不残留）', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'ghost@PC', kind: 'custom' });
  projector.refresh();
  assert.equal(h.writes[0].agents[0].state, null);
  assert.equal(h.writes[0].agents[0].task, null);
  assert.equal(h.writes[0].activeCount, 0);
});

test('TTL 过期 → 剔出（读时 prune + refresh 后列表为空，写一次空投影）', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a@PC', kind: 'codex' });
  projector.refresh();
  assert.equal(h.writes.length, 1);

  h.advance(60_001); // 超过 TTL 未心跳
  projector.refresh(); // 兜底 timer 打的就是这个：registry.list() 读时 prune
  assert.equal(h.writes.length, 2, '列表变了（有条 → 空）必须写');
  assert.deepEqual(h.writes[1], { agents: [], activeCount: 0 });
});

test('签名不变不 write：连续 refresh 无变化 → 第二次不调 write（counter 不空转，K2）', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a@PC', kind: 'codex' });
  projector.refresh();
  projector.refresh();
  projector.refresh();
  assert.equal(h.writes.length, 1, '同样的投影不许重复写（前端 5s 一拍会被推着白渲染）');
});

test('心跳续期 → lastSeenAt/expiresAt 随之更新（要写：签名是投影全量 JSON，客户端可展示「最近心跳」）', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a@PC', kind: 'codex' });
  projector.refresh();
  h.advance(30_000);
  h.deps.registry.hello({ agentId: 'a@PC' }); // 心跳：lastSeenAt/expiresAt 推进
  projector.refresh();
  assert.equal(h.writes.length, 2, '租期变了投影就变，要写');
  assert.equal(h.writes[1].agents[0].lastSeenAt, 31_000);
  assert.equal(h.writes[1].agents[0].expiresAt, 91_000);
});

test('activeCount：五进行态算、success 终态与 null 空闲不算', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a', kind: 'codex' });
  h.deps.registry.hello({ agentId: 'b', kind: 'workbuddy' });
  h.deps.registry.hello({ agentId: 'c', kind: 'claude-code' });
  h.deps.registry.hello({ agentId: 'd', kind: 'custom' });
  h.sessions.set('http:a', { state: 'thinking', task: null }); // 算
  h.sessions.set('http:b', { state: 'working', task: 'x' }); // 算
  h.sessions.set('http:c', { state: 'success', task: null }); // 终态不算
  // d 无会话 → null 不算
  projector.refresh();
  assert.equal(h.writes[0].activeCount, 2);

  h.sessions.set('http:d', { state: 'error', task: null }); // error 算
  projector.refresh();
  assert.equal(h.writes[1].activeCount, 3);
  // 按 agentId 排序（与 GET /agents 一致）
  assert.deepEqual(
    h.writes[1].agents.map((a) => a.agentId),
    ['a', 'b', 'c', 'd'],
  );
});

test('state 变化 → 写（投影内容真的变了）', () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a', kind: 'codex' });
  projector.refresh();
  h.sessions.set('http:a', { state: 'thinking', task: '读代码' });
  projector.refresh();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].agents[0].state, 'thinking');
  assert.equal(h.writes[1].agents[0].task, '读代码');
});

test('start：定时器到点自动 refresh；停止函数生效', async () => {
  const h = harness();
  const projector = createPresenceProjector(h.deps);
  h.deps.registry.hello({ agentId: 'a', kind: 'codex' });
  const stop = projector.start(30); // 30ms 一拍（测试加速）
  await new Promise<void>((r) => setTimeout(r, 80)); // 不 unref：让事件循环活着等这一拍
  stop();
  assert.ok(h.writes.length >= 1, '定时器应至少触发一次 refresh');
  const before = h.writes.length;
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(h.writes.length, before, '停止后不再 refresh');
});

test('写入口抛错 → refresh 不吞（投影故障要响亮，静默丢列表更难查）', () => {
  const now = 1_000;
  const registry = new AgentRegistry({ now: () => now });
  let calls = 0;
  const projector = createPresenceProjector({
    registry,
    workStateOf: () => undefined,
    write: () => {
      calls += 1;
      throw new Error('状态仓炸了');
    },
  });
  registry.hello({ agentId: 'a', kind: 'codex' });
  assert.throws(() => projector.refresh(), /状态仓炸了/);
  assert.equal(calls, 1);
});
