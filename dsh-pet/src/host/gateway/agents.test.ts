/**
 * S7 在场登记测试：TTL 过期、心跳续期（租约不变）、入参校验、列表排序。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRegistry } from './agents.ts';

test('hello：首次登记 → 租约 + TTL；重复调用是续期（leaseId 不变）', () => {
  let now = 1_000;
  const reg = new AgentRegistry({ ttlMs: 60_000, now: () => now });
  const first = reg.hello({ agentId: 'claude', kind: 'cli', wants: ['pet:drive'] });
  assert.ok(first.ok);
  assert.equal(first.ttlSec, 60);
  assert.deepEqual(first.granted, ['pet:drive']);

  now = 30_000;
  const second = reg.hello({ agentId: 'claude' });
  assert.ok(second.ok);
  assert.equal(second.leaseId, first.leaseId, '心跳续的是同一份租约');
  assert.equal(reg.size(), 1);
});

test('TTL：60s 内续期 → 一直在场；超过 60s 未心跳 → 自动过期（读时清，不另起定时器）', () => {
  let now = 1_000;
  const reg = new AgentRegistry({ ttlMs: 60_000, now: () => now });
  reg.hello({ agentId: 'a' });
  now = 1_000 + 59_000;
  assert.equal(reg.size(), 1, '未到 TTL 仍在场');
  now = 1_000 + 60_001;
  assert.equal(reg.size(), 0, 'TTL 到点自动失效');
  assert.deepEqual(reg.list().agents, []);
});

test('hello：agentId 必填；过长（>128）拒绝；instanceId/capabilities 是别名', () => {
  const reg = new AgentRegistry();
  const missing = reg.hello({});
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.reason, 'bad-request');
  assert.match(missing.message, /agentId/);

  const tooLong = reg.hello({ agentId: 'x'.repeat(129) });
  assert.equal(tooLong.ok, false);

  // 发现文件里叫 instanceId；两种命名都收，不让调用方猜
  const alias = reg.hello({ instanceId: 'from-discovery', capabilities: ['presence'] });
  assert.ok(alias.ok);
  if (!alias.ok) return;
  assert.deepEqual(alias.granted, ['presence']);
});

test('list：按 agentId 排序，返回 lastSeenAt/expiresAt，不泄漏内部租约字段外的信息', () => {
  let now = 5_000;
  const reg = new AgentRegistry({ ttlMs: 60_000, now: () => now });
  reg.hello({ agentId: 'zeta', kind: 'cli' });
  now = 6_000;
  reg.hello({ agentId: 'alpha', kind: 'script' });
  const list = reg.list().agents;
  assert.deepEqual(list.map((a) => a.agentId), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['agentId', 'expiresAt', 'kind', 'lastSeenAt']);
  assert.equal(list[0].kind, 'script');
});

test('kind 缺省：首次 unknown，之后心跳可以补上（不覆盖成空）', () => {
  const reg = new AgentRegistry();
  reg.hello({ agentId: 'a' });
  assert.equal(reg.list().agents[0].kind, 'unknown');
  reg.hello({ agentId: 'a', kind: 'claude-code' });
  assert.equal(reg.list().agents[0].kind, 'claude-code');
  reg.hello({ agentId: 'a' }); // 不带 kind 的心跳不该把已知 kind 抹掉
  assert.equal(reg.list().agents[0].kind, 'claude-code');
});

test('onChange：hello 登记/续期与 prune 剔除都通知；取消订阅后不再收', () => {
  let now = 1_000;
  const reg = new AgentRegistry({ ttlMs: 60_000, now: () => now });
  let hits = 0;
  const off = reg.onChange(() => {
    hits += 1;
  });

  reg.hello({ agentId: 'a', kind: 'cli' });
  assert.equal(hits, 1, '登记必须通知（投影器据此重投影）');

  now = 30_000;
  reg.hello({ agentId: 'a' }); // 心跳续期也算变化（lastSeenAt/expiresAt 推进）
  assert.equal(hits, 2, '心跳续期必须通知');

  now = 1_000 + 60_001; // 距首次登记过了 60s，但心跳把租约推到了 90s——仍在场
  reg.list();
  assert.equal(hits, 2, '未过期不通知（心跳续期把 TTL 推后了）');

  now = 90_001;
  reg.list(); // 读时 prune → 剔除 → 通知
  assert.equal(hits, 3, '过期剔除必须通知');

  off();
  reg.hello({ agentId: 'b' });
  assert.equal(hits, 3, '取消订阅后不再收通知');
});

test('onChange：无变化的 prune 不通知（不打扰投影器空转）', () => {
  const now = 1_000;
  const reg = new AgentRegistry({ ttlMs: 60_000, now: () => now });
  reg.hello({ agentId: 'a' });
  let hits = 0;
  reg.onChange(() => {
    hits += 1;
  });
  reg.list(); // 没有过期条目 → 无剔除 → 不通知
  reg.size();
  assert.equal(hits, 0, '无变化不通知');
});

test('onChange：订阅方抛错不影响登记（投影故障不许拖垮在场表）', () => {
  const reg = new AgentRegistry();
  reg.onChange(() => {
    throw new Error('投影器炸了');
  });
  const r = reg.hello({ agentId: 'a', kind: 'cli' });
  assert.ok(r.ok, '订阅方异常被吞掉，登记照常成功');
  assert.equal(reg.size(), 1);
});
