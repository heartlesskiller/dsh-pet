/**
 * verify-relays-client.ts —— T04 沙箱内验收脚本（dev 自测工具，不入 npm 包）。
 *
 * 用**真实的客户端代码路径**验证「sections.relays → 桌宠展示」全链路：
 *   自起 mock-server（scripts/dev/mock-server.mjs，/state 吐构造的舰队叶）
 *     → fetchState（src/shared/state.ts）
 *     → flattenCounters / takeChanged（通配捕获证明：不为 relays 改 state.ts）
 *     → readRelays / relaysBalanceState / relaysBubbleRows（src/shared/relays.ts）
 *     → makeRelayBubble + renderToStaticMarkup（src/client/relay-face.ts，真实组件输出）
 *
 * 断言全过 → 打印 EVIDENCE OK 并零退出；任一不过 → 非零退出。
 * 用法：node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/verify-relays-client.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import { balanceEventIndex, balancePercent } from '../../src/shared/balance.ts';
import { fetchState, flattenCounters, takeChanged } from '../../src/shared/state.ts';
import { readRelays, relaysAlertKey, relaysBalanceState, relaysBubbleRows } from '../../src/shared/relays.ts';
import { makeRelayBubble } from '../../src/client/relay-face.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}/dsh-pet-7340/state`;

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
  assert.equal(baseline['sections.relays'], 1, '新 section 自动进基线');
  assert.deepEqual(takeChanged(s1, baseline), [], '首拉不渲染');

  // ② 第二拍：counter 变化 → 通配捕获（不需要为 relays 改 state.ts）
  const s2 = await fetchState(BASE);
  const changed = takeChanged(s2, baseline);
  const relayChange = changed.find((c) => c.path === 'sections.relays');
  assert.ok(relayChange, 'sections.relays 变化未被 takeChanged 捕获');

  // ③ 解析 + 折算（六档动画机吃的是 money 形态）
  const view = readRelays(relayChange.leaf.data);
  assert.ok(view, 'readRelays 返回 null');
  const folded = relaysBalanceState(view);
  assert.ok(folded !== null && folded.ok, '舰队汇总必须折成 money 成功态');
  if (folded === null || !folded.ok) throw new Error('unreachable');
  assert.equal(folded.total, '10.00');
  assert.equal(folded.fullBalance, '20.00');

  // ④ 文案（舰队口径）
  const texts = relaysBubbleRows(view).map((r) => r.text);
  assert.ok(texts.includes('舰队总余额 $10.00'), '总余额文案：' + texts.join(' | '));
  assert.ok(texts.some((t) => t === '⚡ 1 个站余额偏低：B鲸站 $3.02'), '低额告警文案：' + texts.join(' | '));
  assert.ok(texts.some((t) => t === '∞ 1 站无限额度（不计入合计）'), '无限站文案：' + texts.join(' | '));
  assert.ok(texts.some((t) => t === '另有 1 站为其他币种，未计入'), '外币文案：' + texts.join(' | '));
  assert.ok(!texts.some((t) => t.includes('Cloudflare')), '失败站不进气泡文案（避免刷屏）');

  // ⑤ 告警去重键
  assert.equal(relaysAlertKey(view), 'b');

  // ⑥ 真实组件渲染（renderToStaticMarkup —— overlay 实际挂载的就是这棵树）
  const RelayBubble = makeRelayBubble({ h: jsx });
  const html = renderToStaticMarkup(RelayBubble({ view, on: true }));
  assert.ok(html.includes('dsh-pet-bubble'), '气泡根类名：' + html);
  assert.ok(html.includes('is-on'), 'is-on 显隐类：' + html);
  assert.ok(html.includes('舰队总余额 $10.00'), '渲染出的总余额：' + html);
  assert.ok(html.includes('B鲸站 $3.02'), '渲染出的低额告警：' + html);
  assert.ok(html.includes('pet-bub-row'), '行样式类：' + html);

  // ⑦ 档位动画证据：余额 10/20 → 已用 50% → 事件索引 2
  const p = balancePercent(folded);
  assert.equal(p, 50);
  assert.equal(balanceEventIndex(p), 2);

  console.log('folded       =', JSON.stringify(folded));
  console.log('rows         =', JSON.stringify(texts));
  console.log('alertKey     =', JSON.stringify(relaysAlertKey(view)));
  console.log('tier percent =', p, '→ event index', balanceEventIndex(p));
  console.log('bubbleHTML   =', html);
  console.log('EVIDENCE OK: sections.relays → takeChanged → readRelays → 折算 → 文案 → 组件渲染 全链路通');
} finally {
  mock.kill();
}
