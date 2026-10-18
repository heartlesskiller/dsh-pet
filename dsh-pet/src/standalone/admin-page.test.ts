/**
 * 独立模式管理页（`/admin`）的**纯函数**契约测试。
 *
 * 纪律由来：页面生成必须与 serving 分离，才能无浏览器单测 —— 否则这张页等于零覆盖。
 * 这里只对 `renderAdminPage()` 做字符串断言，不起 socket、不起浏览器。
 *
 * 钉三件事：
 *   1. **安全底线**：HTML 里不得出现任何凭证明文（页面零数据嵌入，服务端数据一律走
 *      运行时 fetch + textContent 渲染）；
 *   2. **功能完备**：所有必需区块的标识都在（列表/表单/刷新/识别/焦点/模型/
 *      rateUnconfirmed 提示/unlimited 提示）；
 *   3. **口径正确**：页面里的 API 路径与真实路由一致（不出现会 404 的路径），
 *      且没有写死端口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ADMIN_PAGE_PATH, renderAdminPage } from './admin-page.ts';

/** 一组「像凭证」的假明文：只要有一个出现在 HTML 里就说明零数据嵌入被破坏 */
const FAKE_SECRETS = [
  'sk-plaintext-abcdef123456',
  'at-super-secret-token-value',
  'uid-98765-secret-header',
  'PLAINTEXT-COOKIE-VALUE',
];

/** 页面必须覆盖的功能区块 → HTML 里的标识 */
const REQUIRED_MARKERS: Array<[string, string]> = [
  ['标题', '中转站管理'],
  ['站点列表表格', 'id="site-rows"'],
  ['空列表提示', 'id="empty-hint"'],
  ['新增站点表单', 'id="add-form"'],
  ['名称输入', 'id="add-name"'],
  ['URL 输入', 'id="add-url"'],
  ['类型选择', 'id="add-kind"'],
  ['凭证类型选择', 'id="add-cred-kind"'],
  ['凭证值输入', 'id="add-secret"'],
  ['附加头输入', 'id="add-extra"'],
  ['刷新全部按钮', 'id="refresh-all"'],
  ['识别按钮', 'id="detect-btn"'],
  ['识别 URL 输入', 'id="detect-url"'],
  ['识别结果区', 'id="detect-result"'],
  // 行内按钮是运行时 createElement + setAttribute('data-action', …) 造出来的，
  // 所以钉的是「动作名作为字面量出现在分发逻辑里」——少一个动作就少一项能力。
  ['单站刷新动作', "action === 'refresh'"],
  ['健康探测动作', "action === 'health'"],
  ['模型抓取动作', "action === 'models'"],
  ['焦点切换动作', "action === 'focus'"],
  ['删除动作', "action === 'delete'"],
  ['换算率未确认提示', 'id="rate-unconfirmed-banner"'],
  ['换算率警告文案', '换算率未确认'],
  ['1000 倍警告', '1000 倍'],
  ['无限额度渲染', '无限额度'],
  ['全局错误区', 'id="global-error"'],
  ['汇总区', 'id="summary"'],
];

/** 页面会调用的真实路由（少一个就说明页面在打 404） */
/**
 * 页面会调用的真实路由。
 *
 * 页面用 `API + '<相对路径>'` 拼 URL（API = '/dsh-pet-7340'），所以钉的是**组成片段**：
 * 前缀在、每个相对路径也在，合起来就不会打 404。
 */
const REQUIRED_API_PATHS = [
  "'/dsh-pet-7340'", // API 前缀
  "'/relays'",
  "'/relays/refresh-all'",
  "'/relays/detect'",
  "'/relays/focus'",
  "'/state'",
];

test('renderAdminPage 是纯函数：两次调用结果完全一致，且不接任何参数', () => {
  assert.equal(renderAdminPage.length, 0, '渲染器不应接收参数（零数据嵌入的硬保证）');
  assert.equal(renderAdminPage(), renderAdminPage());
});

test('HTML 里不得出现任何凭证明文（安全底线：零数据嵌入）', () => {
  const html = renderAdminPage();
  for (const secret of FAKE_SECRETS) {
    assert.equal(html.includes(secret), false, `页面里出现了明文凭证 ${secret}`);
  }
  // 页面里也不该出现任何 "secret" 赋值形态的服务端数据（凭证只在凭证文件里）
  assert.equal(/\bsecret\s*[:=]\s*['"]sk-/.test(html), false);
});

test('所有功能区块都在（漏一个就等于用户少一项能力）', () => {
  const html = renderAdminPage();
  for (const [label, marker] of REQUIRED_MARKERS) {
    assert.ok(html.includes(marker), `缺少功能区块「${label}」的标识 ${marker}`);
  }
});

test('页面调用的 API 路径与真实路由一致（不出现会 404 的路径）', () => {
  const html = renderAdminPage();
  for (const path of REQUIRED_API_PATHS) {
    assert.ok(html.includes(path), `页面没调用 ${path}`);
  }
  // 单站操作用模板串出来，逐个核
  assert.ok(html.includes("'/relays/' + encodeURIComponent(id) + '/refresh'"));
  assert.ok(html.includes("'/relays/' + encodeURIComponent(id) + '/health'"));
  assert.ok(html.includes("'/relays/' + encodeURIComponent(id) + '/models'"));
  // 没有写死端口：相对路径才能跟着 --port 走
  assert.equal(/127\.0\.0\.1:\d+|localhost:\d+|:3080/.test(html), false, '页面不得写死端口');
});

test('unlimited 与 rateUnconfirmed 的渲染口径正确（语义不能反）', () => {
  const html = renderAdminPage();
  // unlimited 必须渲染成「无限额度 · 已用 $X」，不能渲染成余额
  assert.ok(html.includes("'无限额度 · 已用 $'"));
  assert.ok(html.includes('r.unlimited === true'));
  // rateUnconfirmed 必须显式警告，且不让它悄悄混进余额
  assert.ok(html.includes('⚠换算率未确认'));
  assert.ok(html.includes('r.rateUnconfirmed === true'));
  // 失败回执必须带 reason（不许吞）
  assert.ok(html.includes('查不到（'));
  assert.ok(html.includes('failText'));
});

test('服务端数据一律用 textContent 渲染（不用 innerHTML，堵住注入）', () => {
  const html = renderAdminPage();
  assert.equal(html.includes('innerHTML'), false, '页面不得用 innerHTML 渲染服务端数据');
  assert.ok(html.includes('createElement'), '应使用 createElement + textContent');
});

test('CSP 由 server 单独下发，且允许内联脚本（单文件零依赖的前提）', async () => {
  // 这里只钉「页面自身不依赖任何外部资源」——CSP 的值在 server.ts 里断言（见 server.test.ts）
  const html = renderAdminPage();
  assert.equal(/<script[^>]+src=/.test(html), false, '页面不得引用外部脚本');
  assert.equal(/<link[^>]+href=["']https?:/.test(html), false, '页面不得引用外部样式/字体');
});

test('ADMIN_PAGE_PATH 与 server 用的路径一致（在 /dsh-pet-7340 前缀之外）', () => {
  assert.equal(ADMIN_PAGE_PATH, '/admin');
  assert.equal(ADMIN_PAGE_PATH.startsWith('/dsh-pet-7340'), false, '管理页不该占插件 API 前缀');
});
