/**
 * dev/mock-server.mjs —— 桌面模式运行时验证用 mock DSH 宿主（开发自测工具，不入 npm 包）。
 *
 * 模拟 /dsh-pet-7340 前缀的宿主端点（与浏览器 overlay 共用同一套契约）：
 *   GET  /dsh-pet-7340/config              成品配置聚合（{ main: <真实 config.jsonc 解析> }，
 *                                        mock 环境无用户层/文件宠物，只有 main 条目）
 *   GET  /dsh-pet-7340/thumb/<petId>/<name>.webm  从 assets/webm 读素材（petId 段剥掉，统一素材根）
 *   GET  /dsh-pet-7340/balance               模拟 DeepSeek 余额（固定 11.06 元）
 *   GET  /dsh-pet-7340/balance/trigger       触发计数（恒 0，验证轮询基线）
 *   GET  /dsh-pet-7340/relays                中转站脱敏列表（T06）
 *   POST /dsh-pet-7340/relays                新建站点（body = 站点字段 + 可选 credential）
 *   PUT|DELETE /dsh-pet-7340/relays/{id}     更新 / 删除（删站同时删凭证）
 *   POST /dsh-pet-7340/relays/{id}/refresh   刷新该站余额（RelayBalanceResult）
 *   POST /dsh-pet-7340/relays/{id}/health    连通性探测（RelayHealthResult）
 *   POST /dsh-pet-7340/relays/{id}/manual-balance  设置/清除手工余额（空 amount = 清除）
 *   POST /dsh-pet-7340/relays/detect         站点类型识别（不落库）
 *   POST /dsh-pet-7340/relays/{id}/models    实时抓取模型清单（写缓存由真宿主管，mock 直接回）
 *   POST /dsh-pet-7340/relays/focus          设置/清除焦点站点
 *   POST /dsh-pet-7340/relays/refresh-all    并发刷新全部启用站点
 *
 * 系统通知是浏览器半侧（notify.ts）的独立能力，走 DSH 网页自身事件流，与桌面模式/mock 无关。
 *
 * 中转站端点按 openapi.yaml 第五节的契约构造响应（内存存储，自起自收）：
 * 列表/新建/更新/删除/手工余额/焦点全部落同一份内存态，counter 语义同 /state——
 * 每次变更即时反映在后续请求里（T06 验收脚本据此验证客户端的真实请求路径）。
 *
 * 用法：node scripts/dev/mock-server.mjs [port]
 * 配合：npm run start:desktop -- http://127.0.0.1:<port>/dsh-pet-7340/config
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8231);
const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PACKAGE_ROOT = resolve(here, '..', '..');
const WEBM_ROOT = join(PACKAGE_ROOT, 'assets', 'webm');
const CONFIG_FILE = join(PACKAGE_ROOT, 'assets', 'config.jsonc');

/** 剥除 JSONC 注释（与真实宿主 readAllConfig 的 stripJsonc 同规则），返回纯 JSON */
const stripJsonc = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

/** /state 的全局计数器（每次请求 +1；host 侧同口径） */
let stateCounter = 0;

// ---------- 中转站内存存储（T06 验收口径） ----------
// 2 站：a = api-key 凭证的 new-api 站（换算率已确认）；b = 无凭证的 sub2api 站
// （manual 降级：带手工余额）。新建/更新/删除/手工余额/焦点全部落这份内存态。

/** 站点 id 自增（新建站 r3、r4…） */
const relayStore = {
  seq: 3,
  sites: [
    {
      id: 'a',
      name: 'A站',
      url: 'https://a.example.com',
      kind: 'new-api',
      quotaPerUnit: 500000,
      rateConfirmed: true,
      enabled: true,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    },
    {
      id: 'b',
      name: 'B站',
      url: 'https://b.example.com',
      kind: 'sub2api',
      quotaPerUnit: 500000,
      enabled: true,
      note: '降级档',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    },
  ],
  credentials: { a: { kind: 'api-key', secret: 'sk-a1234567890123456' } },
  manualBalance: { b: { amount: '5.00', currency: 'USD', updatedAt: '2026-10-18T08:30:00.000Z' } },
  /** 焦点站点 id（null = 全舰队口径） */
  focus: null,
};

/** 脱敏预览（前 4 + **** + 后 4；与宿主 maskSecret 同形） */
const maskSecret = (s) => (s.length <= 8 ? s : s.slice(0, 4) + '****' + s.slice(-4));

/** Base URL 归一化：去尾斜杠、去 /v1 后缀（与宿主 normalizeBaseUrl 同规则） */
const normalizeRelayUrl = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');

/** 站点 → 脱敏视图（ RelaySiteView：credential 只带掩码，绝不明文 ） */
const relaySiteView = (site) => {
  const cred = relayStore.credentials[site.id];
  const manual = relayStore.manualBalance[site.id];
  return {
    ...site,
    ...(manual ? { manualBalance: manual } : {}),
    credential: {
      kind: cred ? cred.kind : 'manual',
      masked: cred ? maskSecret(cred.secret) : '',
      present: cred !== undefined && cred.kind !== 'manual',
    },
  };
};

/** 全部站点视图（按名称排序，与宿主 siteViews 同口径） */
const relayViews = () =>
  relayStore.sites
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(relaySiteView);

/** 读 JSON body（POST/PUT 用） */
const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });

/** 该站的手工余额结果（降级路径，不是失败） */
const relayManualResult = (site, note) => {
  const manual = relayStore.manualBalance[site.id];
  if (!manual) return { ok: false, siteId: site.id, provider: 'relay:' + site.kind, reason: 'manual', message: note };
  return {
    ok: true,
    siteId: site.id,
    provider: 'relay:' + site.kind,
    shape: 'money',
    source: 'manual',
    data: { currency: manual.currency, total: manual.amount, granted: manual.amount, toppedUp: '0.00' },
  };
};

/**
 * /relays 子域路由（契约见 openapi.yaml 第五节）。
 * 内存存储 + 构造响应；失败路径（404/400/detect unknown）与宿主同形。
 */
async function handleRelays(req, res, method, pathname) {
  const rest = pathname.slice('/dsh-pet-7340/relays'.length);
  const bad = (status, message) => sendJson(res, status, { ok: false, error: message });
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try {
      body = await readJsonBody(req);
    } catch {
      return bad(400, 'invalid JSON body');
    }
  }
  const o = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // ---- /relays（GET 列表 / POST 新建）----
  if (rest === '' || rest === '/') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, sites: relayViews() });
    if (method === 'POST') {
      if (typeof o.name !== 'string' || o.name.trim().length === 0) return bad(400, '站点名称必填');
      if (!/^https?:\/\//i.test(String(o.url ?? ''))) return bad(400, 'URL 必须 http(s):// 开头');
      if (!['new-api', 'sub2api', 'openai-compat'].includes(o.kind)) return bad(400, '未知站点类型');
      const now = new Date().toISOString();
      const site = {
        id: 'r' + relayStore.seq++,
        name: o.name.trim(),
        url: normalizeRelayUrl(o.url),
        kind: o.kind,
        quotaPerUnit:
          Number.isFinite(Number(o.quotaPerUnit)) && Number(o.quotaPerUnit) > 0 ? Number(o.quotaPerUnit) : 500000,
        rateConfirmed: o.rateConfirmed === true,
        enabled: o.enabled !== false,
        createdAt: now,
        updatedAt: now,
        ...(typeof o.note === 'string' ? { note: o.note } : {}),
        ...(typeof o.lowThreshold === 'string' ? { lowThreshold: o.lowThreshold } : {}),
      };
      relayStore.sites.push(site);
      if (o.credential && typeof o.credential === 'object' && o.credential.kind !== 'manual' && o.credential.secret) {
        relayStore.credentials[site.id] = { kind: o.credential.kind, secret: o.credential.secret };
      }
      return sendJson(res, 200, { ok: true, site: relaySiteView(site) });
    }
    return bad(405, 'method not allowed');
  }

  // ---- /relays/detect（识别不落库；凭证只用于本次探测）----
  if (rest === '/detect') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    if (typeof o.url !== 'string' || o.url.trim().length === 0) return bad(400, '缺少站点 URL');
    // 坏凭证 → unknown + 原因（客户端要引导手选/手工填余额，不静默失败）
    if (o.credential && o.credential.secret === 'sk-bad') {
      return sendJson(res, 200, {
        ok: true,
        detect: { kind: 'unknown', confidence: 'unknown', evidence: [], message: '凭证无效（HTTP 401）' },
      });
    }
    return sendJson(res, 200, {
      ok: true,
      detect: {
        kind: 'new-api',
        confidence: 'certain',
        evidence: ['/api/status: system_name 命中 new-api', '/v1/models: supported_endpoint_types 命中'],
        suggestedQuotaPerUnit: 500000,
      },
    });
  }

  // ---- /relays/focus（空 siteId = 清除）----
  if (rest === '/focus') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    const siteId = typeof o.siteId === 'string' ? o.siteId.trim() : '';
    if (siteId.length > 0 && !relayStore.sites.some((s) => s.id === siteId))
      return bad(404, 'site not found: ' + siteId);
    relayStore.focus = siteId.length > 0 ? siteId : null;
    return sendJson(res, 200, { ok: true, focusSiteId: relayStore.focus });
  }

  // ---- /relays/refresh-all ----
  if (rest === '/refresh-all') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    const results = [];
    for (const site of relayStore.sites.filter((s) => s.enabled === true)) {
      const cred = relayStore.credentials[site.id];
      if (!cred) results.push(relayManualResult(site, '未配置凭证'));
      else if (site.kind === 'sub2api') results.push(relayManualResult(site, '站点已设为手工填写'));
      else
        results.push({
          ok: true,
          siteId: site.id,
          provider: 'relay:' + site.kind,
          shape: 'money',
          source: 'auto',
          scope: 'token',
          ...(site.rateConfirmed === true ? {} : { rateUnconfirmed: true }),
          data: { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00' },
        });
    }
    return sendJson(res, 200, results);
  }

  // ---- /relays/{id}[/action] ----
  const m = /^\/([^/]+)(?:\/(refresh|health|manual-balance|models))?$/.exec(rest);
  if (!m) return bad(404, 'unknown relays route: ' + rest);
  const site = relayStore.sites.find((s) => s.id === m[1]);
  if (!site) return bad(404, 'site not found: ' + m[1]);
  const action = m[2];

  if (action === undefined) {
    if (method === 'PUT') {
      if (typeof o.name === 'string' && o.name.trim().length > 0) site.name = o.name.trim();
      if (typeof o.url === 'string' && /^https?:\/\//i.test(o.url)) site.url = normalizeRelayUrl(o.url);
      if (['new-api', 'sub2api', 'openai-compat'].includes(o.kind)) site.kind = o.kind;
      if (typeof o.note === 'string') site.note = o.note;
      if (Number.isFinite(Number(o.quotaPerUnit)) && Number(o.quotaPerUnit) > 0)
        site.quotaPerUnit = Number(o.quotaPerUnit);
      if (typeof o.rateConfirmed === 'boolean') site.rateConfirmed = o.rateConfirmed;
      if (typeof o.lowThreshold === 'string') site.lowThreshold = o.lowThreshold;
      if (typeof o.enabled === 'boolean') site.enabled = o.enabled;
      site.updatedAt = new Date().toISOString();
      // credential：缺省 = 不动；显式 null = 清除；对象 = 校验后写入
      if (Object.prototype.hasOwnProperty.call(o, 'credential')) {
        if (o.credential === null || o.credential === undefined) delete relayStore.credentials[site.id];
        else if (o.credential.kind !== 'manual' && o.credential.secret)
          relayStore.credentials[site.id] = { kind: o.credential.kind, secret: o.credential.secret };
      }
      return sendJson(res, 200, { ok: true, site: relaySiteView(site) });
    }
    if (method === 'DELETE') {
      relayStore.sites = relayStore.sites.filter((s) => s.id !== site.id);
      delete relayStore.credentials[site.id];
      delete relayStore.manualBalance[site.id];
      if (relayStore.focus === site.id) relayStore.focus = null;
      return sendJson(res, 200, { ok: true, sites: relayViews() });
    }
    return bad(405, 'method not allowed');
  }

  if (action === 'refresh') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    const cred = relayStore.credentials[site.id];
    if (!cred) return sendJson(res, 200, relayManualResult(site, '未配置凭证，回退到手工填写值'));
    if (site.kind === 'sub2api') return sendJson(res, 200, relayManualResult(site, '站点已设为手工填写'));
    return sendJson(res, 200, {
      ok: true,
      siteId: site.id,
      provider: 'relay:' + site.kind,
      shape: 'money',
      source: 'auto',
      scope: 'account',
      ...(site.rateConfirmed === true ? {} : { rateUnconfirmed: true }),
      data: { currency: 'USD', total: '10.00', granted: '10.00', toppedUp: '0.00', fullBalance: '20.00' },
    });
  }

  if (action === 'health') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    const cred = relayStore.credentials[site.id];
    if (!cred || cred.kind === 'manual') {
      return sendJson(res, 200, {
        siteId: site.id,
        health: 'unknown',
        message: '未配置凭证，跳过探测',
        checkedAt: new Date().toISOString(),
      });
    }
    return sendJson(res, 200, {
      siteId: site.id,
      health: 'online',
      endpoint: '/api/status',
      status: 200,
      latencyMs: 120,
      checkedAt: new Date().toISOString(),
    });
  }

  if (action === 'manual-balance') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    const amount = typeof o.amount === 'string' ? o.amount.trim() : '';
    const currency = typeof o.currency === 'string' ? o.currency.trim().toUpperCase() : '';
    if (amount.length === 0) {
      delete relayStore.manualBalance[site.id]; // 空 amount = 清除（撤销降级）
    } else {
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) return bad(400, 'amount 必须是非负金额（至多两位小数）');
      if (currency.length === 0) return bad(400, '缺少 currency');
      relayStore.manualBalance[site.id] = { amount, currency, updatedAt: new Date().toISOString() };
    }
    return sendJson(res, 200, { ok: true, site: relaySiteView(site) });
  }

  // action === 'models'
  if (method !== 'POST') return bad(405, 'method not allowed');
  const cred = relayStore.credentials[site.id];
  if (!cred || cred.kind === 'manual') {
    return sendJson(res, 200, { ok: false, reason: 'credential-missing', message: '未配置凭证，无法抓取模型清单' });
  }
  return sendJson(res, 200, {
    ok: true,
    siteId: site.id,
    source: 'pricing',
    models: [
      { id: 'deepseek-chat', ratio: 1 },
      { id: 'gpt-4o', ratio: 2 },
    ],
    fetchedAt: new Date().toISOString(),
  });
}

// ---------- 在场 agent 内存存储（docs/19 T04/T05 冒烟与验收口径） ----------
// 与宿主同构的两份内存态：
//   agentStore = 在场登记表（hello 驱动，TTL 60s 读时 prune）→ GET /agents 与 /state 的 agents 列表；
//   statusStore = 六档会话（/events 驱动，键 http:<agentId> 的 mock 简化：直接用 agentId）
//     → /state agents 叶里每条的 state/task。没 hello 过的 agent 发 /events 只进 statusStore
//     （与真宿主一致：档位会话不依赖在场登记，投影器只给在场条目贴档位）。
const AGENT_TTL_MS = 60_000;
/** status 六态 → 工作状态档位（与 host gateway/ingest.ts 的 statusToWorkState 同口径） */
const statusToWorkState = (status) =>
  ({
    idle: null,
    thinking: 'thinking',
    working: 'working',
    'waiting-approval': 'waiting',
    done: 'success',
    error: 'error',
  })[status];

const agentStore = {
  entries: new Map(),
  hello(agentId, kind) {
    const now = Date.now();
    const prev = this.entries.get(agentId);
    this.entries.set(agentId, {
      agentId,
      kind: kind || (prev && prev.kind) || 'unknown',
      lastSeenAt: now,
      expiresAt: now + AGENT_TTL_MS,
    });
  },
  prune() {
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(id);
  },
  list() {
    this.prune();
    return [...this.entries.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  },
};
const statusStore = new Map(); // agentId → { state, task }

// 种子：一个已知 kind（working + task，摘要冠军）+ 一个未知 kind（降级显示 👾 用）
agentStore.entries.set('workbuddy@MOCK-PC', {
  agentId: 'workbuddy@MOCK-PC',
  kind: 'workbuddy',
  lastSeenAt: Date.now() - 5_000,
  expiresAt: Date.now() + AGENT_TTL_MS,
});
statusStore.set('workbuddy@MOCK-PC', { state: 'working', task: 'pnpm test' });
agentStore.entries.set('my-script@MOCK-PC', {
  agentId: 'my-script@MOCK-PC',
  kind: 'my-script',
  lastSeenAt: Date.now() - 2_000,
  expiresAt: Date.now() + AGENT_TTL_MS,
});
statusStore.set('my-script@MOCK-PC', { state: 'thinking', task: null });

/** /state 的 sections.agents 叶数据（host 投影器同口径：state/task 取自合成会话，无会话 → null） */
const agentsSectionData = () => {
  const agents = agentStore.list().map((e) => {
    const st = statusStore.get(e.agentId);
    return {
      agentId: e.agentId,
      kind: e.kind,
      state: st ? st.state : null,
      task: st ? st.task : null,
      lastSeenAt: e.lastSeenAt,
      expiresAt: e.expiresAt,
    };
  });
  const activeCount = agents.filter((a) => a.state !== null && a.state !== 'success').length;
  return { agents, activeCount };
};

/** 构造的中转站舰队叶（T04 验收口径：3 站 1 无限 1 低额 1 失败 + 1 外币） */
const RELAYS_FLEET = {
  focusSiteId: null,
  summary: {
    currency: 'USD',
    total: '10.00',
    fullBalance: '20.00',
    siteCount: 2,
    unlimitedCount: 1,
    failedCount: 1,
    lowSites: [{ siteId: 'b', name: 'B鲸站', amount: '3.02', currency: 'USD', threshold: '5' }],
    otherCurrencies: ['CNY'],
  },
  sites: [
    {
      ok: true,
      siteId: 'a',
      provider: 'relay:new-api',
      shape: 'money',
      source: 'auto',
      data: { currency: 'USD', total: '10.00', granted: '10.00', toppedUp: '0.00', fullBalance: '20.00' },
    },
    {
      ok: true,
      siteId: 'b',
      provider: 'relay:new-api',
      shape: 'money',
      source: 'auto',
      data: { currency: 'USD', total: '3.02', granted: '3.02', toppedUp: '0.00' },
    },
    {
      ok: true,
      siteId: 'c',
      provider: 'relay:new-api',
      shape: 'money',
      source: 'auto',
      unlimited: true,
      spent: '34.58',
      data: { currency: 'USD', total: '34.58', granted: '34.58', toppedUp: '0.00' },
    },
    { ok: false, siteId: 'd', provider: 'relay:new-api', reason: 'blocked', message: 'HTTP 403 疑似 Cloudflare 拦截' },
  ],
  health: [
    { siteId: 'a', health: 'online', status: 200, checkedAt: '2026-10-17T00:00:00.000Z' },
    { siteId: 'b', health: 'auth-failed', status: 401, checkedAt: '2026-10-17T00:00:00.000Z' },
  ],
  refreshedAt: '2026-10-17T00:00:00.000Z',
};

/**
 * 在场 agent 子域路由（docs/19；契约同 openapi.yaml 第六节）。
 * GET /agents（L1）/ POST /agents/hello（L0 心跳）/ POST /events（L2 驱动）。
 */
async function handleAgents(req, res, method, pathname) {
  const bad = (status, message) => sendJson(res, status, { ok: false, error: message });

  if (pathname === '/dsh-pet-7340/agents') {
    if (method !== 'GET') return bad(405, 'method not allowed');
    const agents = agentStore.list().map((e) => ({
      agentId: e.agentId,
      kind: e.kind,
      lastSeenAt: e.lastSeenAt,
      expiresAt: e.expiresAt,
    }));
    return sendJson(res, 200, { ok: true, agents });
  }

  if (pathname === '/dsh-pet-7340/agents/hello') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return bad(400, 'invalid JSON body');
    }
    const o = body && typeof body === 'object' ? body : {};
    const agentId = typeof o.agentId === 'string' ? o.agentId.trim() : '';
    if (!agentId) return bad(400, '缺少 agentId');
    agentStore.hello(agentId, typeof o.kind === 'string' ? o.kind : '');
    return sendJson(res, 200, { ok: true, leaseId: 'mock-lease-' + agentId, ttlSec: 60, granted: [] });
  }

  if (pathname === '/dsh-pet-7340/events') {
    if (method !== 'POST') return bad(405, 'method not allowed');
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return bad(400, 'invalid JSON body');
    }
    const o = body && typeof body === 'object' ? body : {};
    const agentId = typeof o.agentId === 'string' ? o.agentId.trim() : '';
    if (!agentId) return bad(400, '缺少 agentId');
    const hasNotice = o.notice !== undefined && o.notice !== null;
    const hasStatus = o.status !== undefined && o.status !== null;
    if (!hasNotice && !hasStatus) return bad(400, 'notice 或 status 至少给一个');
    if (hasStatus && statusToWorkState(o.status) === undefined) return bad(400, '未知 status');
    if (hasNotice) {
      const n = o.notice && typeof o.notice === 'object' ? o.notice : {};
      if (!['info', 'warning', 'error'].includes(n.severity))
        return bad(400, 'notice.severity 必须是 info / warning / error');
      if (typeof n.text !== 'string' || !n.text.trim()) return bad(400, 'notice.text 不能为空');
    }
    if (hasStatus) {
      const state = statusToWorkState(o.status);
      if (state === null)
        statusStore.delete(agentId); // idle = 清会话
      else
        statusStore.set(agentId, { state, task: typeof o.task === 'string' && o.task.trim() ? o.task.trim() : null });
    }
    return sendJson(res, 200, { ok: true });
  }

  return bad(404, 'unknown agents route: ' + pathname);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method ?? 'GET';

  // 统一轮询状态（GET /state）：客户端 overlay 唯一的数据来源。
  // counter 每次请求全局递增（与 host 的 PollStateStore.next() 同口径：单调、同毫秒不重复）
  // → 客户端首拉记基线、之后每拍 takeChanged 都能捕获变化，正是轮询链路的实拍。
  // sections.relays 是构造的「3 站 1 无限 1 低额 1 失败 + 1 外币」舰队叶（T04 验收口径），
  // 与 sections.balance 并存——客户端据此把余额展示切换成舰队口径。
  // focusSiteId 与 /relays/focus 写入同一份内存态（T06 验收据此验证焦点读取链路）。
  // sections.agents 是在场 agent 投影叶（docs/19：与 workStatus 同源分工——列表回答
  // 「谁在场、各自什么状态」；mock 口径 = 种子 2 条 + hello/events 内存态，见 agentStore）。
  if (pathname === '/dsh-pet-7340/state') {
    stateCounter += 1;
    sendJson(res, 200, {
      sections: {
        balance: {
          counter: stateCounter,
          data: {
            ok: true,
            provider: 'deepseek',
            shape: 'money',
            data: { currency: 'CNY', total: '11.06', granted: '5.00', toppedUp: '10.00' },
          },
        },
        relays: { counter: stateCounter, data: { ...RELAYS_FLEET, focusSiteId: relayStore.focus } },
        agents: { counter: stateCounter, data: agentsSectionData() },
      },
      pets: {},
    });
    return;
  }

  // 中转站管理（/relays 子域，T06）：CRUD / 刷新 / 健康 / 手工余额 / detect / focus。
  // 内存存储（见 relayStore）；必须在 thumb/ 静态资源之前拦下来。
  if (pathname.startsWith('/dsh-pet-7340/relays')) {
    void handleRelays(req, res, req.method ?? 'GET', pathname);
    return;
  }

  // 在场 agent（docs/19）：GET /agents（L1）/ POST /agents/hello（L0 心跳）/ POST /events（L2 驱动）。
  // 契约同 openapi.yaml 第六节；内存态见上方 agentStore / statusStore。
  if (pathname.startsWith('/dsh-pet-7340/agents') || pathname === '/dsh-pet-7340/events') {
    void handleAgents(req, res, method, pathname);
    return;
  }

  if (pathname === '/dsh-pet-7340/balance') {
    // 模拟 DeepSeek 余额：fixed 11.06 元 -> 档位 p≈44.7 -> 池索引 2（钱袋如常）
    sendJson(res, 200, {
      ok: true,
      provider: 'deepseek',
      kind: 'deepseek',
      data: { currency: 'CNY', total: '11.06', granted: '5.00', toppedUp: '10.00' },
    });
    return;
  }

  if (pathname === '/dsh-pet-7340/balance/trigger') {
    sendJson(res, 200, { count: 0 });
    return;
  }

  // 成品配置：mock 环境无用户层/文件宠物 → 只有 main 条目（= 内置默认，字段原样保留）；
  // 消费端按成品结构读取（不校验）。
  if (pathname === '/dsh-pet-7340/config') {
    if (!existsSync(CONFIG_FILE)) {
      res.writeHead(404);
      res.end('no config.jsonc');
      return;
    }
    sendJson(res, 200, { main: JSON.parse(stripJsonc(readFileSync(CONFIG_FILE, 'utf8'))) });
    return;
  }

  // 动画文件：/dsh-pet-7340/thumb/<petId>/<name>.webm（与宿主路由同一形态）。
  // petId 仅作归属标识：mock 服务器从统一素材根读（开发环境不模拟独立素材目录）；
  // 剥掉 petId 段后按文件名解析，目标仍在 WEBM_ROOT 内才放行。
  if (pathname.startsWith('/dsh-pet-7340/thumb/')) {
    let rel = pathname.slice('/dsh-pet-7340/thumb/'.length);
    const slash = rel.indexOf('/');
    rel = slash >= 0 ? rel.slice(slash + 1) : rel;
    if (!rel || rel.length === 0) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    const candidate = normalize(join(WEBM_ROOT, rel));
    const rootWithSep = WEBM_ROOT.endsWith(sep) ? WEBM_ROOT : WEBM_ROOT + sep;
    if (candidate !== WEBM_ROOT && !candidate.startsWith(rootWithSep)) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    if (!existsSync(candidate)) {
      res.writeHead(404);
      res.end('asset not found');
      return;
    }
    const { size } = statSync(candidate);
    res.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': size,
      'cache-control': 'public, max-age=3600',
    });
    createReadStream(candidate).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`mock: not found ${pathname}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-server] listening on http://127.0.0.1:${PORT}/dsh-pet-7340/`);
  console.log(`[mock-server] config:  http://127.0.0.1:${PORT}/dsh-pet-7340/config`);
  console.log(`[mock-server] assets:  ${WEBM_ROOT}`);
});
