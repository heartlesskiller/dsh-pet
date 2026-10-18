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
import { KNOWN_AGENTS } from '../shared/agents.ts';

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
  ['模型矩阵区块', 'id="matrix-section"'],
  ['模型矩阵表格', 'id="matrix-table"'],
  ['模型矩阵行容器', 'id="matrix-rows"'],
  ['模型矩阵表头行', 'id="matrix-head-row"'],
  ['矩阵加载按钮', 'id="matrix-load"'],
  ['矩阵未知提示', 'id="matrix-hint"'],
  // 「接入的 agent」区块（docs/19 T03）
  ['agent 区块标题', '接入的 agent'],
  ['agent 区块', 'id="agents-section"'],
  ['agent 行容器', 'id="agents-rows"'],
  ['agent 表格', 'id="agents-table"'],
  ['agent 刷新按钮', 'id="agents-refresh"'],
  ['agent 汇总区', 'id="agents-summary"'],
  ['agent 未知 kind 降级', "'👾 ' + a.kind"],
  ['agent 空态文案', '当前没有 agent 在场'],
  ['三态文案-有', "'有'"],
  ['三态文案-无', "'无'"],
  ['三态文案-未知', "'未知'"],
  ['消耗统计区块', 'id="burn-section"'],
  ['消耗统计表格', 'id="burn-table"'],
  ['消耗统计行容器', 'id="burn-rows"'],
  ['消耗统计按钮', 'id="burn-load"'],
  ['数据不足文案', '数据不足'],
  ['无限额度无预计天数', '无限额度'],
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
  "'/agents'", // 在场 agent 权威列表（docs/19 T03）
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

// ---------- 模型矩阵三态（unknown ≠ no） ----------

test('矩阵三态表达式与 shared/relays.ts 的 matrixCellState 逐字一致（防漂移）', () => {
  // admin-page.ts 是纯字符串页、无法 import shared；这里把它的分类表达式钉死，
  // 谁改坏了这条就红（权威实现在 src/shared/relays.ts，有 null !== false 专项单测）。
  const html = renderAdminPage();
  assert.ok(
    html.includes("return v === true ? 'yes' : v === false ? 'no' : 'unknown'"),
    '矩阵三态分类表达式被改动 —— 请同步 src/shared/relays.ts 的 matrixCellState 并更新本断言',
  );
  // 绝不许出现把 null 揉进「无」的写法
  assert.equal(/cellState\([^)]*\)\s*\?\s*'yes'\s*:\s*'no'/.test(html), false, '三元不能把 null 归到 no');
  assert.equal(html.includes('!cell.available'), false);
  assert.equal(html.includes('!v'), false);
});

test('矩阵三态在页面上视觉可区分（未知必须有独立样式类）', () => {
  const html = renderAdminPage();
  assert.ok(html.includes('.cell-yes'));
  assert.ok(html.includes('.cell-no'));
  assert.ok(html.includes('.cell-unknown'), '未知态必须有独立样式，不能与「无」共用');
  // 「无」无底色、「未知」有底色：CSS 层面就可区分
  assert.ok(/\.cell-no\s*\{[^}]*background:\s*transparent/.test(html), '「无」应无底色');
  assert.ok(/\.cell-unknown\s*\{[^}]*background:/.test(html), '「未知」应有底色');
  // 文案也必须不同
  assert.ok(html.includes("unknown: '未知'"));
  assert.ok(html.includes("no: '无'"));
});

test('矩阵调用真实路由 /relays/models（GET，不写死端口）', () => {
  const html = renderAdminPage();
  assert.ok(html.includes("api('/relays/models', 'GET')"));
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

// ---------- 消耗速率（T11）：与 shared/relays.ts 同口径，防漂移 ----------

test('消耗速率表达式与 shared/relays.ts 的 computeBurnRate 同口径（防漂移）', () => {
  const html = renderAdminPage();
  // 坑 1：只有 1 天快照 → null，绝不是 0
  assert.ok(html.includes('if (days.length < 2) return null;'), '1 天快照必须返回 null');
  // 坑 2：跨度不足 3 天 → null（断档不当 0 消耗）
  assert.ok(html.includes('span < BURN_MIN_SPAN) return null;'), '跨度不足必须判数据不足');
  assert.ok(html.includes('var BURN_MIN_SPAN = 3;'));
  // 速率必须 > 0 才算（负速率 = 充值过，对"还能用多久"没意义）
  assert.ok(html.includes('return burn > 0 ? burn : null;'), '负速率必须返回 null');
  // 坑 3：无限额度站没有预计天数那一行
  assert.ok(html.includes('无限额度'), '无限额度站只显示已用');
  // 坑 5：手工值不参与速率计算
  assert.ok(html.includes('手工填写，无消耗统计'));
  // 坑 4：换算率未确认不给数字
  assert.ok(html.includes('换算率未确认，请核对'));
});

test('消耗统计：拿不到就显示「数据不足」，绝不显示 0 或 ∞', () => {
  const html = renderAdminPage();
  assert.ok(html.includes('数据不足'));
  // 不得出现把 null 当 0 / Infinity 的写法
  assert.equal(html.includes('|| 0'), false, '不得用 || 0 兜底（会把 null 变成 0）');
  assert.equal(/Infinity/.test(html), false, '不得出现 Infinity');
  assert.equal(html.includes('daily === null ? \'数据不足\''), true, '速率未知必须显示数据不足');
});

// ---------- 接入的 agent（docs/19 T03 / A11） ----------

test('嵌入的 KNOWN_AGENTS 与 src/shared/agents.ts 逐字一致（防漂移的机械闸门）', () => {
  // admin-page.ts 是纯字符串页、不能 import shared；这里把嵌入值钉回唯一事实源。
  // 谁改了注册表忘了同步页面（或反之），这条就红。
  const html = renderAdminPage();
  assert.ok(
    html.includes(JSON.stringify(KNOWN_AGENTS)),
    '页面嵌入的 KNOWN_AGENTS 与 shared/agents.ts 不一致——请同步两处',
  );
  // 页内查表函数按 kind 精确匹配（不用 includes：'codex' 不该命中 'codex-cli'）
  assert.ok(html.includes('KNOWN_AGENTS[i].kind === kind'));
});

test('agent 区块口径：未知 kind 降级展示（不拒绝）、active 不含 success', () => {
  const html = renderAdminPage();
  // 未知 kind → 👾 + 原样 kind（K9：仅展示元数据错配，无安全影响）
  assert.ok(html.includes("meta ? meta.emoji + ' ' + meta.name : '👾 ' + a.kind"));
  // success 是终态不算活动（与 host 投影器 activeCount 同口径）
  assert.ok(html.includes("cur.state !== 'success'"), 'success 不计入活动数');
  // 拿不到就明说，不给假数字
  assert.ok(html.includes('当前没有 agent 在场'));
  assert.equal(html.includes('innerHTML'), false, 'agent 行同样不许 innerHTML');
});

test('agent 区块打的是真实路由：GET /agents + /state（不写死端口）', () => {
  const html = renderAdminPage();
  assert.ok(html.includes("api('/agents', 'GET')"));
  assert.ok(html.includes("api('/state', 'GET')"));
  assert.equal(/127\.0\.0\.1:\d+|localhost:\d+|:3080/.test(html), false, '页面不得写死端口');
});

test('agent 区块不嵌任何用户数据（注册表是公开静态数据；凭证/站点一律运行时 fetch）', () => {
  const html = renderAdminPage();
  // 嵌入块里只有注册表四行（公开元数据），没有任何 agentId/任务文本/站点/凭证形状的运行时数据
  assert.ok(html.includes('var KNOWN_AGENTS = [{'), '注册表应是构建期静态嵌入');
  for (const secret of FAKE_SECRETS) {
    assert.equal(html.includes(secret), false, `页面里出现了明文凭证 ${secret}`);
  }
  // agent 行数据全部来自运行时 fetch + textContent（td() 是既有的安全单元格工厂）
  assert.ok(html.includes('function td(text, cls)'), 'agent 行应复用 td() 工厂（createElement + textContent）');
});
