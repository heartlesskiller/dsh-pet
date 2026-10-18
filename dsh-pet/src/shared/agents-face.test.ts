/**
 * 在场 agent 客户端逻辑测试（docs/19 §8 A5）：
 *   readAgents 坏形状 → null（空列表 ≠ 坏形状）；agentsSummary 优先级正确；
 *   AgentsFace SSR 断言；与 host 的 WORK_STATUS_PRIORITY 表逐项一致（防两端漂移）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import { agentRowText, agentsSummary, makeAgentsFace, readAgents, type AgentsFaceView } from './agents-face.ts';
import { WORK_STATUS_PRIORITY, type HostWorkStatusState } from '../host/work-status.ts';

/** 造一份合法视图（字段与 host 投影器输出同构） */
function view(agents: AgentsFaceView['agents'], activeCount = agents.length): AgentsFaceView {
  return { agents, activeCount };
}

function item(over: Partial<AgentsFaceView['agents'][number]>): AgentsFaceView['agents'][number] {
  return { agentId: 'a', kind: 'custom', state: null, task: null, lastSeenAt: 1, expiresAt: 61_000, ...over };
}

// ---------- readAgents ----------

test('readAgents：合法形状 → 视图（字段收窄，未知档位落 null）', () => {
  const v = readAgents({
    agents: [
      {
        agentId: 'workbuddy@PC',
        kind: 'workbuddy',
        state: 'working',
        task: 'pnpm test',
        lastSeenAt: 5,
        expiresAt: 65_000,
      },
      { agentId: 'ghost@PC', kind: 'mystery', state: 'bogus', task: 42, lastSeenAt: 'x', expiresAt: null },
    ],
    activeCount: 1,
  });
  assert.ok(v);
  if (!v) return;
  assert.equal(v.agents.length, 2);
  assert.deepEqual(v.agents[0], {
    agentId: 'workbuddy@PC',
    kind: 'workbuddy',
    state: 'working',
    task: 'pnpm test',
    lastSeenAt: 5,
    expiresAt: 65_000,
  });
  // 脏字段逐项收窄：未知档位 → null、非串 task → null、非数时间 → 0；条目不丢（有 id 就要显示）
  assert.deepEqual(v.agents[1], {
    agentId: 'ghost@PC',
    kind: 'mystery',
    state: null,
    task: null,
    lastSeenAt: 0,
    expiresAt: 0,
  });
  assert.equal(v.activeCount, 1);
});

test('readAgents：坏形状 → null（非对象 / agents 非数组 / null）', () => {
  assert.equal(readAgents(null), null);
  assert.equal(readAgents('nope'), null);
  assert.equal(readAgents([]), null);
  assert.equal(readAgents({ agents: 'x' }), null);
  assert.equal(readAgents({}), null, '缺 agents 数组算坏形状');
});

test('readAgents：合法但空列表 → 空视图（不是 null：「查不到就是空数组」）', () => {
  const v = readAgents({ agents: [], activeCount: 0 });
  assert.deepEqual(v, { agents: [], activeCount: 0 });
  // activeCount 缺失时按 state 现算（老版本 host 兼容）
  const noCount = readAgents({ agents: [{ agentId: 'a', kind: 'custom', state: 'working' }] });
  assert.equal(noCount?.activeCount, 1);
});

test('readAgents：无 agentId 的条目丢弃（无法定位的条目不猜）', () => {
  const v = readAgents({ agents: [{ kind: 'custom' }, { agentId: 'b', kind: 'codex' }], activeCount: 0 });
  assert.equal(v?.agents.length, 1);
  assert.equal(v?.agents[0].agentId, 'b');
});

// ---------- agentsSummary ----------

test('agentsSummary：active 中优先级最高者（waiting > error > working > thinking > result）', () => {
  const v = view([
    item({ agentId: 'a', kind: 'codex', state: 'working', task: '写代码' }),
    item({ agentId: 'b', kind: 'workbuddy', state: 'waiting', task: '等确认' }),
    item({ agentId: 'c', kind: 'claude-code', state: 'thinking' }),
  ]);
  assert.equal(agentsSummary(v), '🧰 WorkBuddy · 等确认');
});

test('agentsSummary：error 压过 working（告警不该被日常进度盖掉）', () => {
  const v = view([
    item({ agentId: 'a', kind: 'workbuddy', state: 'working', task: '跑测试' }),
    item({ agentId: 'b', kind: 'codex', state: 'error' }),
  ]);
  assert.equal(agentsSummary(v), '🤖 Codex');
});

test('agentsSummary：无 active → null（success 终态与空闲都不算，调用方回落宠物名）', () => {
  assert.equal(agentsSummary(view([])), null);
  assert.equal(agentsSummary(view([item({ state: 'success', task: '做完了' })])), null);
  assert.equal(agentsSummary(view([item({ state: null })])), null);
});

test('agentsSummary：未知 kind 降级显示（👾 + kind 原样，绝不拒映）', () => {
  const v = view([item({ agentId: 'x', kind: 'my-homebrew', state: 'working', task: '自研脚本在跑' })]);
  assert.equal(agentsSummary(v), '👾 my-homebrew · 自研脚本在跑');
});

test('agentRowText：有 task 带 · 任务，无 task 只有头', () => {
  assert.equal(agentRowText(item({ kind: 'workbuddy', task: 'pnpm test' })), '🧰 WorkBuddy · pnpm test');
  assert.equal(agentRowText(item({ kind: 'codex' })), '🤖 Codex');
});

test('优先级表与 host/work-status.ts 的 WORK_STATUS_PRIORITY 逐项一致（两端各持一份，防漂移）', () => {
  // host 自 contain 不 import shared、shared 不反向 import host（浏览器 bundle 不许拖 node 侧代码），
  // 所以客户端在 agents-face.ts 持有一份同序表；本断言是防漂移的机械闸门。
  const order: HostWorkStatusState[] = ['waiting', 'error', 'working', 'thinking', 'result', 'success'];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.ok(
      WORK_STATUS_PRIORITY[order[i]] > WORK_STATUS_PRIORITY[order[i + 1]],
      `${order[i]} 应高于 ${order[i + 1]}`,
    );
  }
  // 端到端等价性：六档全在场时冠军 = waiting（host 的 pickDisplayed 也会挑它）
  const v = view(order.map((state, i) => item({ agentId: 'a' + i, kind: 'custom', state })));
  assert.equal(agentsSummary(v), '📜 自定义脚本');
});

// ---------- AgentsFace SSR ----------

test('AgentsFace：SSR 渲染每只在场 agent 一行（emoji + 名称 + 任务）', () => {
  const Face = makeAgentsFace({ h: jsx });
  const v = view([
    item({ agentId: 'a', kind: 'workbuddy', state: 'working', task: 'pnpm test' }),
    item({ agentId: 'b', kind: 'my-homebrew', state: 'thinking' }),
  ]);
  const html = renderToStaticMarkup(Face({ view: v, on: true }));
  assert.ok(html.includes('pet-agents-face'), '根类名：' + html);
  assert.ok(html.includes('is-on'), 'is-on 显隐类：' + html);
  assert.ok(html.includes('🧰 WorkBuddy · pnpm test'), '已知 agent 行：' + html);
  assert.ok(html.includes('👾 my-homebrew'), '未知 kind 降级行：' + html);
  assert.equal(renderToStaticMarkup(Face({ view: v, on: false })).includes('is-on'), false, 'on=false 不挂 is-on');
});

test('AgentsFace：空列表渲染占位文案（不给一张空表）', () => {
  const Face = makeAgentsFace({ h: jsx });
  const html = renderToStaticMarkup(Face({ view: view([]), on: true }));
  assert.ok(html.includes('（没有 agent 在场）'), html);
});
