/**
 * 注册表单测（docs/19 §8 A2）：kind 唯一；agentMeta 已知命中 + 未知降级；transports/mcp 合法。
 *
 * 钉死的是「新 agent = 数据一行」这条纪律的**数据侧不变量**——谁改了行内容/删了行/
 * 把未知 kind 改成拒映，这里就红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KNOWN_AGENTS, agentMeta, type AgentTransport } from './agents.ts';

test('kind 唯一：同一 kind 出现两次 = 元数据歧义（渲染层无法决策）', () => {
  const kinds = KNOWN_AGENTS.map((a) => a.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'kind 必须唯一');
});

test('每行字段合法：name/emoji/color/tag 非空，transports ⊆ {http,cli,mcp} 且非空，mcp 是布尔', () => {
  const ALLOWED: readonly AgentTransport[] = ['http', 'cli', 'mcp'];
  for (const a of KNOWN_AGENTS) {
    assert.ok(a.name.length > 0, a.kind + ' 缺 name');
    assert.ok(a.emoji.length > 0, a.kind + ' 缺 emoji');
    assert.ok(/^#[0-9a-f]{6}$/i.test(a.color), a.kind + ' color 不是 #rrggbb：' + a.color);
    assert.ok(a.tag.length >= 1 && a.tag.length <= 4, a.kind + ' tag 须 1–4 字符');
    assert.ok(a.transports.length > 0, a.kind + ' transports 不能空');
    for (const t of a.transports) assert.ok(ALLOWED.includes(t), a.kind + ' 未知 transport：' + t);
    assert.equal(typeof a.mcp, 'boolean', a.kind + ' mcp 必须是布尔');
    if (a.hookHint !== undefined) assert.ok(a.hookHint.length > 0, a.kind + ' hookHint 不能是空串');
  }
});

test('agentMeta：已知 kind 命中注册表（known=true，元数据原样）', () => {
  const meta = agentMeta('workbuddy');
  assert.deepEqual(meta, {
    kind: 'workbuddy',
    name: 'WorkBuddy',
    emoji: '🧰',
    color: '#6366f1',
    tag: 'WB',
    known: true,
  });
});

test('agentMeta：未知 kind 优雅降级（👾 / 中性灰 / tag … / known=false，name 原样）', () => {
  const meta = agentMeta('my-homebrew-agent');
  assert.deepEqual(meta, {
    kind: 'my-homebrew-agent',
    name: 'my-homebrew-agent',
    emoji: '👾',
    color: '#6b7280',
    tag: '…',
    known: false,
  });
});

test('agentMeta：未知 kind 超长 → 按码点截 24 + 省略号（不把代理对截成半个字符）', () => {
  // 25 个码点（含一个代理对 emoji 占 2 码点之外的普通字符）：截到 24 + …
  const long = 'a'.repeat(30);
  const meta = agentMeta(long);
  assert.equal(meta.name, 'a'.repeat(24) + '…');
  assert.equal(meta.known, false);
  // emoji 代理对不被切碎：名称里出现的 🧰 是完整码点
  const withEmoji = agentMeta('x'.repeat(23) + '🧰' + 'y');
  assert.ok(withEmoji.name.includes('🧰'), '代理对必须完整保留：' + withEmoji.name);
});

test('agentMeta：空/非字符串 kind → 可渲染的降级对象（绝不抛、绝不 null）', () => {
  assert.equal(agentMeta('').known, false);
  assert.equal(agentMeta('').name, '');
  // 运行时脏数据（host 侧 kind 理论上是字符串，防御式收口）
  assert.equal(agentMeta(undefined as unknown as string).known, false);
  assert.equal(agentMeta(null as unknown as string).known, false);
});

test('注册表覆盖设计承诺的最小集：workbuddy / codex / claude-code / custom', () => {
  assert.deepEqual(
    KNOWN_AGENTS.map((a) => a.kind),
    ['workbuddy', 'codex', 'claude-code', 'custom'],
  );
  // 设计默认值：custom 不给 MCP 配置片段（脚本自己写 HTTP/CLI 更直接）
  assert.equal(agentMeta('custom').known, true);
  assert.equal(KNOWN_AGENTS.find((a) => a.kind === 'custom')?.mcp, false);
});
