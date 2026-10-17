/**
 * verify-relays-admin.ts —— T06 沙箱内验收脚本（dev 自测工具，不入 npm 包）。
 *
 * 无 GUI 环境下验证「设置页中转站管理」两条链路：
 *   ① API 层实测：自起 mock-server（scripts/dev/mock-server.mjs 的 /relays 子域，
 *      契约同 openapi.yaml 第五节）→ makeRelaysAdminApi 真实 fetch →
 *      断言列表/新建/识别/刷新/健康/手工余额/焦点/模型/删除与 404 错误路径；
 *   ② 渲染层断言：makeRelaysAdminSection 制造真实组件 → renderToStaticMarkup
 *      （设置页实际挂载的就是这棵树）→ 断言关键文案/结构出现在 HTML
 *      （站点名、掩码 sk-a****3456、「手工」标签、焦点标记 ★、未确认提示、
 *        失败站的「手工填写」入口、空态、错误态重试）。
 *
 * 断言全过 → 打印 EVIDENCE OK 并零退出；任一不过 → 非零退出。
 * 用法：node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/verify-relays-admin.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  makeRelaysAdminApi,
  makeRelaysAdminSection,
  readFocusSiteId,
  zh,
  type RelaysAdminSeed,
} from '../../src/client/relays-admin.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}/dsh-pet-7340/relays`;
const STATE = `http://127.0.0.1:${PORT}/dsh-pet-7340/state`;

// ---- 自起 mock-server（子进程；验收结束无论成败都收掉） ----
const mock = spawn(process.execPath, [join(here, 'mock-server.mjs'), String(PORT)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
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
  // ===================== ① API 层：真实 fetch 打 mock =====================
  const api = makeRelaysAdminApi(BASE);

  // 列表：2 站（a=api-key 掩码 / b=manual 降级带手工余额），按名称排序
  const list = await api.list();
  assert.equal(list.length, 2, '初始应有 2 站');
  assert.deepEqual(
    list.map((s) => s.name),
    ['A站', 'B站'],
    '按名称排序',
  );
  const a = list.find((s) => s.id === 'a');
  const b = list.find((s) => s.id === 'b');
  assert.ok(a !== undefined && b !== undefined, 'a/b 两站都应在列表里');
  if (a === undefined || b === undefined) throw new Error('unreachable');
  assert.equal(a.credential.masked, 'sk-a****3456', '掩码预览');
  assert.equal(a.credential.present, true, 'a 有凭证');
  assert.equal(b.credential.kind, 'manual', 'b 无凭证（manual）');
  assert.equal(b.credential.present, false, 'b 凭证不在位');
  assert.equal(b.manualBalance?.amount, '5.00', 'b 带手工余额');

  // detect：双信号命中 + 换算率建议；坏凭证 → unknown + 原因（不静默失败）
  const detected = await api.detect({ url: 'https://x.example.com/v1/' });
  assert.equal(detected.kind, 'new-api');
  assert.equal(detected.confidence, 'certain');
  assert.ok(detected.evidence.length >= 2, '判定依据应有多条');
  assert.equal(detected.suggestedQuotaPerUnit, 500000, '换算率建议');
  const badCred = await api.detect({ url: 'https://x.example.com', credential: { kind: 'api-key', secret: 'sk-bad' } });
  assert.equal(badCred.kind, 'unknown');
  assert.ok((badCred.message ?? '').length > 0, 'unknown 必须带原因');

  // 新建：URL 归一化（去 /v1）+ 凭证落位（掩码回显）+ 未确认换算率
  const created = await api.create({
    name: 'C站',
    url: 'https://c.example.com/v1/',
    kind: 'new-api',
    note: '',
    quotaPerUnit: 500000,
    rateConfirmed: false,
    lowThreshold: '',
    enabled: true,
    credential: { kind: 'api-key', secret: 'sk-c999888777' },
  });
  assert.ok(created.id.length > 0, '新建应有 id');
  assert.equal(created.url, 'https://c.example.com', 'URL 归一化（去尾斜杠 + /v1）');
  assert.equal(created.credential.masked, 'sk-c****8777', '新建凭证掩码回显');
  assert.equal(created.rateConfirmed, false, '新建站换算率默认未确认');

  // 刷新：未确认站带 rateUnconfirmed；健康：有凭证 → online
  const refreshed = await api.refresh(created.id);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.rateUnconfirmed, true, '未确认换算率的站余额必须带标记');
  const health = await api.health('a');
  assert.equal(health.health, 'online');

  // 模型抓取：有凭证 → 2 个模型；无凭证 → ok:false + 原因
  assert.deepEqual(await api.fetchModels('a'), { count: 2, source: 'pricing' });
  await assert.rejects(() => api.fetchModels('b'), /未配置凭证/, '无凭证抓模型必须报错（不静默）');

  // 手工余额：设置（币种统一大写 + updatedAt）→ 清除（空 amount）
  const withManual = await api.manualBalance(created.id, '7.25', 'usd');
  assert.equal(withManual.manualBalance?.amount, '7.25');
  assert.equal(withManual.manualBalance?.currency, 'USD', '币种统一大写');
  assert.ok((withManual.manualBalance?.updatedAt ?? '').length > 0, '必须带填写时间');
  const cleared = await api.manualBalance(created.id, '', '');
  assert.equal(cleared.manualBalance, undefined, '空 amount = 清除');

  // 焦点：设 / 清；/state 叶同步（readFocusSiteId 走真实 /state）
  assert.equal(await api.focus('a'), 'a');
  assert.equal(await readFocusSiteId(STATE), 'a', '焦点写入后 /state 叶应同步');
  assert.equal(await api.focus(''), null, '空 siteId = 清除焦点');
  assert.equal(await readFocusSiteId(STATE), null);

  // 错误路径：不存在的站 → 404（客户端映射 errNotFound）
  await assert.rejects(
    () => api.refresh('nope'),
    (e: unknown) => (e as { status?: unknown }).status === 404,
    '404 必须带 status',
  );

  // 删除：返回剩余列表
  const afterRemove = await api.remove(created.id);
  assert.equal(afterRemove.length, 2, '删除后剩 2 站');

  // ===================== ② 渲染层：renderToStaticMarkup 打真实组件 =====================
  const t = (key: string): string => zh[key] ?? key;
  const rt = { h: jsx, useState, useEffect, useRef, useCallback, t };
  const TS = '2026-10-18T08:30:00.000Z';

  // ②-1 就绪态：auto 口径 + 手工标签 + 焦点标记 + 未确认提示 + 失败站手工入口
  const seed: RelaysAdminSeed = {
    sites: [
      {
        id: 'a',
        name: 'A站',
        url: 'https://a.example.com',
        kind: 'new-api',
        quotaPerUnit: 500000,
        rateConfirmed: true,
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
        credential: { kind: 'api-key', masked: 'sk-a****3456', present: true },
      },
      {
        id: 'b',
        name: 'B站',
        url: 'https://b.example.com',
        kind: 'sub2api',
        quotaPerUnit: 500000,
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
        credential: { kind: 'manual', masked: '', present: false },
        manualBalance: { amount: '5.00', currency: 'USD', updatedAt: TS },
      },
      {
        id: 'c',
        name: 'C站',
        url: 'https://c.example.com',
        kind: 'new-api',
        quotaPerUnit: 500000,
        rateConfirmed: true,
        enabled: false,
        createdAt: TS,
        updatedAt: TS,
        credential: { kind: 'session-cookie', masked: 'sess****abcd', present: true },
      },
    ],
    balances: {
      a: { ok: true, source: 'auto', total: '10.00', currency: 'USD', scope: 'account' },
      b: { ok: true, source: 'manual', total: '5.00', currency: 'USD' },
      c: { ok: false, reason: 'blocked', message: 'HTTP 403 疑似 Cloudflare 拦截' },
    },
    healths: { a: 'online', b: 'unknown', c: 'blocked' },
    focusSiteId: 'a',
    loadState: 'ready',
  };
  const Section = makeRelaysAdminSection(rt, seed);
  const html = renderToStaticMarkup(jsx(Section, {}));
  // 站点名与结构
  assert.ok(html.includes('dsh-pet-ra'), '根类名：' + html.slice(0, 200));
  for (const name of ['A站', 'B站', 'C站']) assert.ok(html.includes(name), '站点名：' + name);
  // 掩码凭证（绝不明文）
  assert.ok(html.includes('sk-a****3456'), '掩码凭证：' + html);
  assert.ok(!html.includes('sk-a1234567890123456'), '绝不明文凭证');
  // auto 口径 / 手工标签 / 失败站手工填写入口
  assert.ok(html.includes('账户级'), 'auto 数据口径');
  assert.ok(html.includes('手工'), '「手工」标签');
  assert.ok(html.includes('手工填写'), '失败站的「手工填写」入口');
  assert.ok(html.includes('被拦截'), '失败原因文案');
  // 焦点标记（★ + 焦点按钮组 aria-pressed）
  assert.ok(html.includes('★'), '焦点标记');
  assert.ok(html.includes('aria-pressed="true"'), '焦点按钮组按下态');
  // 未确认提示（B 站 rateConfirmed 缺省 → 横幅 + 余额格标记）
  assert.ok(html.includes('换算率未确认'), '未确认提示：' + html);
  // 焦点卡片按钮组：全舰队 + 三站
  assert.ok(html.includes('全舰队（汇总）'), '焦点「全舰队」选项');

  // ②-2 空态：无站点 → 引导添加（不给一张空表）
  const EmptySection = makeRelaysAdminSection(rt, {
    sites: [],
    balances: {},
    healths: {},
    focusSiteId: null,
    loadState: 'ready',
  });
  const emptyHtml = renderToStaticMarkup(jsx(EmptySection, {}));
  assert.ok(emptyHtml.includes('还没有中转站'), '空态引导文案');
  assert.ok(emptyHtml.includes('添加站点'), '空态添加入口');

  // ②-3 错误态：列表拉取失败 → 可读文案 + 重试（不许白屏）
  const ErrorSection = makeRelaysAdminSection(rt, { sites: [], balances: {}, healths: {}, loadState: 'error' });
  const errHtml = renderToStaticMarkup(jsx(ErrorSection, {}));
  assert.ok(errHtml.includes('加载失败'), '错误态可读文案');
  assert.ok(errHtml.includes('重试'), '错误态重试按钮');

  // ②-4 加载态：进行中提示
  const LoadingSection = makeRelaysAdminSection(rt, { sites: [], balances: {}, healths: {}, loadState: 'loading' });
  const loadingHtml = renderToStaticMarkup(jsx(LoadingSection, {}));
  assert.ok(loadingHtml.includes('正在加载站点'), '加载态提示');

  console.log(
    'api.list        =',
    JSON.stringify(list.map((s) => ({ id: s.id, name: s.name, masked: s.credential.masked }))),
  );
  console.log('api.detect      =', JSON.stringify(detected));
  console.log('api.create      =', created.id, created.url, created.credential.masked);
  console.log('api.focus       = a →', await api.focus('a'), '；清除 →', await api.focus(''));
  console.log('render(len)     =', html.length, 'chars');
  console.log(
    'EVIDENCE OK: /relays API 层（list/create/detect/refresh/health/models/manual-balance/focus/remove/404）',
  );
  console.log(
    'EVIDENCE OK: 渲染层（站点名/掩码/手工标签/焦点★/未确认提示/手工填写入口/空态/错误态/加载态）全在静态 HTML 中',
  );
} finally {
  mock.kill();
}
