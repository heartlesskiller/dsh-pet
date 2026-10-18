/**
 * S7 摄入测试：severity 映射、六态归一化、coalesce 去重（含优先级升级）、互斥规则。
 * 全部纯函数 + 注入记录器，无 HTTP、无状态仓。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNoticeCoalescer,
  decideCoalesce,
  ingestEvent,
  severityPriority,
  statusToWorkState,
  type IngestOptions,
} from './ingest.ts';

/** 记录器：把 pushSay / setWorkStatus 的调用记下来（不碰真实状态仓） */
function recorder(over: Partial<IngestOptions> = {}): {
  options: IngestOptions;
  says: Array<{ petId: string; text: string; severity: string; priority: number }>;
  statuses: Array<{ agentId: string; state: string | null; task: string | null }>;
} {
  const says: Array<{ petId: string; text: string; severity: string; priority: number }> = [];
  const statuses: Array<{ agentId: string; state: string | null; task: string | null }> = [];
  const options: IngestOptions = {
    pushSay: (petId, p) => says.push({ petId, text: p.text, severity: p.severity, priority: p.priority }),
    setWorkStatus: (agentId, state, task) => statuses.push({ agentId, state, task: task ?? null }),
    resolvePetId: (requested) => requested ?? 'main',
    coalescer: createNoticeCoalescer({}),
    ...over,
  };
  return { options, says, statuses };
}

test('severityPriority：info 0 / warning 10 / error 20；未知 → undefined（调用方按 400）', () => {
  assert.equal(severityPriority('info'), 0);
  assert.equal(severityPriority('warning'), 10);
  assert.equal(severityPriority('error'), 20);
  assert.equal(severityPriority('fatal'), undefined);
  assert.equal(severityPriority(undefined), undefined);
});

test('statusToWorkState：六态归一化；idle → null（回空闲）；未知 → undefined', () => {
  assert.equal(statusToWorkState('thinking'), 'thinking');
  assert.equal(statusToWorkState('working'), 'working');
  assert.equal(statusToWorkState('waiting-approval'), 'waiting');
  assert.equal(statusToWorkState('done'), 'success');
  assert.equal(statusToWorkState('error'), 'error');
  assert.equal(statusToWorkState('idle'), null);
  assert.equal(statusToWorkState('bogus'), undefined);
});

test('ingestEvent：notice → 写气泡（text + severity + priority），200 ok', () => {
  const { options, says } = recorder();
  const r = ingestEvent({ agentId: 'claude', notice: { severity: 'warning', text: '  构建失败  ' } }, options);
  assert.deepEqual(r, { kind: 'json', status: 200, obj: { ok: true } });
  assert.deepEqual(says, [{ petId: 'main', text: '构建失败', severity: 'warning', priority: 10 }]);
});

test('ingestEvent：status → 写六档；idle → 显式 null（清会话）', () => {
  const { options, statuses } = recorder();
  ingestEvent({ agentId: 'cursor', status: 'working' }, options);
  ingestEvent({ agentId: 'cursor', status: 'idle' }, options);
  assert.deepEqual(statuses, [
    { agentId: 'cursor', state: 'working', task: null },
    { agentId: 'cursor', state: null, task: null },
  ]);
});

test('ingestEvent：结构错一律 400 + { error }（缺 agentId / 空事件 / 坏 severity / 空文本）', () => {
  const { options } = recorder();
  const bad = (body: unknown): boolean => {
    const r = ingestEvent(body, options);
    return r.kind === 'json' && r.status === 400 && typeof (r.obj as { error?: unknown }).error === 'string';
  };
  assert.ok(bad({ notice: { severity: 'info', text: 'x' } }), '缺 agentId');
  assert.ok(bad({ agentId: 'a' }), 'notice 与 status 都没有');
  assert.ok(bad({ agentId: 'a', notice: { severity: 'fatal', text: 'x' } }), '坏 severity');
  assert.ok(bad({ agentId: 'a', notice: { severity: 'info', text: '   ' } }), '空文本');
  assert.ok(bad({ agentId: 'a', status: 'exploded' }), '未知 status');
  assert.ok(bad({ agentId: 'x'.repeat(129), status: 'working' }), 'agentId 过长');
});

test('ingestEvent：notice.text 超长（码点计）→ 400，不静默截断', () => {
  const { options } = recorder({ maxTextLength: 5 });
  const r = ingestEvent({ agentId: 'a', notice: { severity: 'info', text: '一二三四五六' } }, options);
  assert.equal(r.kind === 'json' && r.status, 400);
});

test('ingestEvent：没有可显示桌宠 → 200 + { ok:false, reason:"no-active-pet" }（不写半个状态）', () => {
  const { options, says } = recorder({ resolvePetId: () => '' });
  const r = ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x' } }, options);
  assert.deepEqual(r, {
    kind: 'json',
    status: 200,
    obj: { ok: false, reason: 'no-active-pet', message: '没有可显示的桌宠' },
  });
  assert.equal(says.length, 0);
});

test('coalesce：窗口内同 key 同优先级 → 第二次静默合并（不重复弹）', () => {
  const { options, says } = recorder();
  ingestEvent({ agentId: 'a', notice: { severity: 'warning', text: '任务卡住', coalesceKey: 'stuck' } }, options);
  ingestEvent({ agentId: 'a', notice: { severity: 'warning', text: '任务卡住', coalesceKey: 'stuck' } }, options);
  assert.equal(says.length, 1, '同一个告警不该刷两次气泡');
});

test('coalesce：优先级升级 → 放行（error 不被 warning 的合并窗口吞掉）', () => {
  const { options, says, statuses } = recorder();
  ingestEvent({ agentId: 'a', notice: { severity: 'warning', text: '卡住', coalesceKey: 'k' } }, options);
  ingestEvent({ agentId: 'a', notice: { severity: 'error', text: '挂了', coalesceKey: 'k' } }, options);
  assert.equal(says.length, 2, '升级必须弹出来');
  assert.equal(statuses.length, 0);
});

test('coalesce：窗口过期后同 key 再来 → 放行', () => {
  let now = 10_000;
  const says: string[] = [];
  // coalescer 与 ingest 必须共用同一个假时钟（recorder 的默认 coalescer 用真实时钟，测不了窗口）
  const options: IngestOptions = {
    pushSay: (_petId, p) => says.push(p.text),
    setWorkStatus: () => {},
    resolvePetId: (requested) => requested ?? 'main',
    now: () => now,
    coalesceWindowMs: 5_000,
    coalescer: createNoticeCoalescer({ now: () => now, coalesceWindowMs: 5_000 }),
  };
  ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x', coalesceKey: 'k' } }, options);
  now += 4_999;
  ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x', coalesceKey: 'k' } }, options);
  assert.equal(says.length, 1, '窗口内合并');
  now += 2;
  ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x', coalesceKey: 'k' } }, options);
  assert.equal(says.length, 2, '窗口外重新放行');
});

test('decideCoalesce：记忆有界（超出上限按最早写入淘汰）', () => {
  const memory = { seen: new Map<string, { priority: number; at: number }>() };
  for (let i = 0; i < 5; i += 1) {
    decideCoalesce('k' + i, 10, { now: () => 1, maxCoalesceEntries: 3 }, memory);
  }
  assert.equal(memory.seen.size, 3);
  assert.ok(!memory.seen.has('k0'), '最老的被淘汰');
  assert.ok(memory.seen.has('k4'));
});

test('互斥规则：DSH 会话事件在场（sessionEventsOwned）→ status 段被忽略，notice 照常', () => {
  const { options, says, statuses } = recorder({ sessionEventsOwned: true });
  ingestEvent({ agentId: 'a', status: 'working', notice: { severity: 'info', text: '你好' } }, options);
  assert.equal(statuses.length, 0, 'DSH 事件源在场时 HTTP 的 status 不许抢六档');
  assert.equal(says.length, 1, '气泡与六档互不干扰');
});

test('ingestEvent：写状态抛错 → 200 + { ok:false, reason:"ingest-error" }（不静默、不 500）', () => {
  const { options } = recorder({
    pushSay: () => {
      throw new Error('状态仓炸了');
    },
  });
  const r = ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x' } }, options);
  assert.equal(r.kind === 'json' && r.status, 200);
  if (r.kind !== 'json') return;
  assert.equal((r.obj as { reason?: string }).reason, 'ingest-error');
  assert.match(String((r.obj as { message?: string }).message), /状态仓炸了/);
});

// ---------- task 透传（docs/19 T02 / A12） ----------

test('ingestEvent：task 随 status 透传（trim 后落进同一合成会话条目）', () => {
  const { options, statuses } = recorder();
  const r = ingestEvent({ agentId: 'wb', status: 'working', task: '  pnpm test  ' }, options);
  assert.deepEqual(r, { kind: 'json', status: 200, obj: { ok: true } });
  assert.deepEqual(statuses, [{ agentId: 'wb', state: 'working', task: 'pnpm test' }]);
});

test('ingestEvent：task 超 40 码点 → 400（不静默截断，与 notice.text 同口径）', () => {
  const { options, statuses } = recorder();
  const r = ingestEvent({ agentId: 'wb', status: 'working', task: '啊'.repeat(41) }, options);
  assert.equal(r.kind === 'json' && r.status, 400);
  assert.equal(statuses.length, 0, '400 不许写半个状态');
  // 边界：正好 40 码点放行
  const ok = ingestEvent({ agentId: 'wb', status: 'working', task: '啊'.repeat(40) }, options);
  assert.equal(ok.kind === 'json' && ok.status, 200);
  assert.equal(statuses[0].task, '啊'.repeat(40));
});

test('ingestEvent：task 结构错 → 400（非字符串 / 空串 / 非有限类型）', () => {
  const { options, statuses } = recorder();
  const bad = (body: unknown): boolean => {
    const r = ingestEvent(body, options);
    return r.kind === 'json' && r.status === 400 && typeof (r.obj as { error?: unknown }).error === 'string';
  };
  assert.ok(bad({ agentId: 'a', status: 'working', task: 42 }), 'task 非字符串');
  assert.ok(bad({ agentId: 'a', status: 'working', task: '   ' }), 'task 空串');
  assert.ok(bad({ agentId: 'a', status: 'working', task: [] }), 'task 数组');
  assert.equal(statuses.length, 0);
});

test('ingestEvent：status:idle 带 task → 400（清会话时带文案自相矛盾，明说不静默）', () => {
  const { options, statuses } = recorder();
  const r = ingestEvent({ agentId: 'a', status: 'idle', task: '跑完了' }, options);
  assert.equal(r.kind === 'json' && r.status, 400);
  assert.equal(statuses.length, 0);
});

test('ingestEvent：只有 task 没有 status/notice → 400（task 必须挂在 status 段上）', () => {
  const { options, statuses } = recorder();
  const r = ingestEvent({ agentId: 'a', task: 'pnpm test' }, options);
  assert.equal(r.kind === 'json' && r.status, 400);
  assert.equal(statuses.length, 0);
});

test('ingestEvent：notice + task（没 status）→ 400（不静默丢 task）', () => {
  const { options, says, statuses } = recorder();
  const r = ingestEvent({ agentId: 'a', notice: { severity: 'info', text: 'x' }, task: 'pnpm test' }, options);
  assert.equal(r.kind === 'json' && r.status, 400);
  assert.equal(says.length, 0, '400 不许写半个状态');
  assert.equal(statuses.length, 0);
});

test('互斥规则扩展到 task：DSH 会话事件在场时 task 同段忽略（防「DSH 档位配 HTTP 文案」）', () => {
  const { options, says, statuses } = recorder({ sessionEventsOwned: true });
  ingestEvent(
    { agentId: 'a', status: 'working', task: 'HTTP 的任务', notice: { severity: 'info', text: '你好' } },
    options,
  );
  assert.equal(statuses.length, 0, 'DSH 事件源在场时 HTTP 的 status 与 task 都不许进场');
  assert.equal(says.length, 1, '气泡与六档互不干扰');
});
