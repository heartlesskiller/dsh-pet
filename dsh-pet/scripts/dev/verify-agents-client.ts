/**
 * verify-agents-client.ts —— T05 沙箱内验收脚本（dev 自测工具，不入 npm 包）。
 * 设计依据 docs/19 §8 A10。
 *
 * 用**真实的客户端代码路径**验证「sections.agents → 桌宠呈现」全链路，外加写入回路：
 *
 *   读链路（确定性种子）：
 *     自起 mock-server（/state 吐构造的 agents 投影叶）
 *       → fetchState（src/shared/state.ts）
 *       → flattenCounters / takeChanged（通配捕获证明：不为 agents 改 state.ts）
 *       → readAgents（src/shared/agents-face.ts，坏形状才 null、空列表是合法数据）
 *       → agentsSummary（active 中优先级最高者 → tooltip 文案）
 *       → makeAgentsFace + renderToStaticMarkup（真实组件输出，含未知 kind 降级行）
 *
 *   写回路（动态，经 tools/ 的真实客户端函数）：
 *     helloAgent + postEvent（tools/pet-gateway-client.mjs，CLI 与 MCP 共用的那一份）
 *       → 再拉 /state → 摘要随新事件变（error 压过 working）
 *
 * 断言全过 → 打印 EVIDENCE OK 并零退出；任一不过 → 非零退出。
 * 用法：node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/verify-agents-client.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import { fetchState, flattenCounters, takeChanged } from '../../src/shared/state.ts';
import { agentsSummary, makeAgentsFace, readAgents, type AgentsFaceView } from '../../src/shared/agents-face.ts';
import { helloAgent, postEvent } from '../../tools/pet-gateway-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8231;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/dsh-pet-7340/state`;

// ---- 自起 mock-server（子进程；验收结束无论成败都收掉） ----
const mock = spawn(process.execPath, [join(here, 'mock-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock-server 启动超时')), 10_000);
  mock.stdout.on('data', (chunk: Buffer) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(timer);
      resolve();
    }
  });
  mock.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error('mock-server 提前退出 code=' + String(code)));
  });
});

try {
  // ① 首拉：只记基线（与客户端一致——刷新页面不重放旧气泡）
  const s1 = await fetchState(BASE);
  assert.ok(s1, '首拉 /state 失败');
  const baseline = flattenCounters(s1);
  assert.ok(baseline['sections.agents'] !== undefined, '新 section 自动进基线');
  assert.deepEqual(takeChanged(s1, baseline), [], '首拉不渲染');

  // ② 第二拍：counter 变化 → 通配捕获（不需要为 agents 改 state.ts）
  const s2 = await fetchState(BASE);
  const changed = takeChanged(s2, baseline);
  const agentsChange = changed.find((c) => c.path === 'sections.agents');
  assert.ok(agentsChange, 'sections.agents 变化未被 takeChanged 捕获');

  // ③ 解析：种子两条（workbuddy working + task；my-script 未知 kind thinking）
  const view = readAgents(agentsChange.leaf.data);
  assert.ok(view, 'readAgents 返回 null');
  if (!view) throw new Error('unreachable');
  assert.equal(view.agents.length, 2, 'mock 种子两条');
  assert.equal(view.activeCount, 2, 'working 与 thinking 都算 active');
  assert.deepEqual(
    view.agents.map((a) => a.agentId),
    ['my-script@MOCK-PC', 'workbuddy@MOCK-PC'],
    '按 agentId 排序',
  );

  // ④ 摘要：working(40) 压过 thinking(30) → 已知 kind 的注册表元数据
  const summary = agentsSummary(view);
  assert.equal(summary, '🧰 WorkBuddy · pnpm test', '摘要取 active 中优先级最高者：' + String(summary));

  // ⑤ 真实组件渲染（renderToStaticMarkup —— overlay 将来挂载的就是这棵树）
  const AgentsFace = makeAgentsFace({ h: jsx });
  const html = renderToStaticMarkup(AgentsFace({ view, on: true }));
  assert.ok(html.includes('pet-agents-face'), '根类名：' + html);
  assert.ok(html.includes('is-on'), 'is-on 显隐类：' + html);
  assert.ok(html.includes('🧰 WorkBuddy · pnpm test'), '已知 agent 行：' + html);
  assert.ok(html.includes('👾 my-script'), '未知 kind 降级行（👾 + 原样 kind，不拒映）：' + html);

  // ⑥ 写回路：经 tools/ 的真实客户端函数发一次 hello + events（error 压过 working）
  const hello = await helloAgent(ORIGIN, { agentId: 'codex@VERIFY-PC', kind: 'codex' });
  assert.ok(hello.ok && (hello.body as { ok?: boolean })?.ok === true, 'hello 应成功');
  const posted = await postEvent(ORIGIN, { agentId: 'codex@VERIFY-PC', status: 'error', task: '构建失败' });
  assert.ok(posted.ok && (posted.body as { ok?: boolean })?.ok === true, 'POST /events 应成功');

  // ⑦ 再拉一拍：新 agent 进场且优先级更高 → 摘要换成它
  const s3 = await fetchState(BASE);
  const changed3 = takeChanged(s3, baseline);
  const agentsChange3 = changed3.find((c) => c.path === 'sections.agents');
  assert.ok(agentsChange3, '写入后再拉应见到 agents 变化');
  const view3 = readAgents(agentsChange3.leaf.data);
  assert.ok(view3, 'readAgents（第二拍）返回 null');
  if (!view3) throw new Error('unreachable');
  assert.equal(view3.agents.length, 3, '新 agent 已进场');
  assert.equal(view3.activeCount, 3, 'error 算 active');
  assert.equal(agentsSummary(view3), '🤖 Codex · 构建失败', 'error(50) 压过 working(40)：' + agentsSummary(view3));

  // ⑧ 退出清理：idle 清会话 → 该 agent 档位回落 null（不再进摘要）
  const idle = await postEvent(ORIGIN, { agentId: 'codex@VERIFY-PC', status: 'idle' });
  assert.ok(idle.ok, 'idle 应成功');
  const s4 = await fetchState(BASE);
  const view4 = readAgents(takeChanged(s4, baseline).find((c) => c.path === 'sections.agents')?.leaf.data);
  assert.ok(view4, 'readAgents（idle 后）返回 null');
  if (!view4) throw new Error('unreachable');
  const codex = view4.agents.find((a) => a.agentId === 'codex@VERIFY-PC');
  assert.equal(codex?.state, null, 'idle 后档位回落 null（会话已清）');
  assert.equal(agentsSummary(view4), '🧰 WorkBuddy · pnpm test', '摘要回落给 working');

  console.log('agents       =', JSON.stringify(view.agents));
  console.log('summary      =', JSON.stringify(summary));
  console.log('after error  =', JSON.stringify(agentsSummary(view3)));
  console.log('after idle   =', JSON.stringify(agentsSummary(view4)));
  console.log('faceHTML     =', html);
  console.log('EVIDENCE OK: /state → takeChanged → readAgents → agentsSummary → AgentsFace SSR 全链路通');
  console.log('EVIDENCE OK: hello + POST /events（error/idle）→ 摘要随动（写回路通）');
} finally {
  mock.kill();
}
