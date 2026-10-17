/**
 * dev/mock-server.mjs —— 桌面模式运行时验证用 mock DSH 宿主（开发自测工具，不入 npm 包）。
 *
 * 模拟 /dsh-pet-7340 前缀的宿主端点（与浏览器 overlay 共用同一套契约）：
 *   GET  /dsh-pet-7340/config              成品配置聚合（{ main: <真实 config.jsonc 解析> }，
 *                                        mock 环境无用户层/文件宠物，只有 main 条目）
 *   GET  /dsh-pet-7340/thumb/<petId>/<name>.webm  从 assets/webm 读素材（petId 段剥掉，统一素材根）
 *   GET  /dsh-pet-7340/balance               模拟 DeepSeek 余额（固定 11.06 元）
 *   GET  /dsh-pet-7340/balance/trigger       触发计数（恒 0，验证轮询基线）
 *
 * 系统通知是浏览器半侧（notify.ts）的独立能力，走 DSH 网页自身事件流，与桌面模式/mock 无关。
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
    { ok: true, siteId: 'a', provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '10.00', granted: '10.00', toppedUp: '0.00', fullBalance: '20.00' } },
    { ok: true, siteId: 'b', provider: 'relay:new-api', shape: 'money', source: 'auto', data: { currency: 'USD', total: '3.02', granted: '3.02', toppedUp: '0.00' } },
    { ok: true, siteId: 'c', provider: 'relay:new-api', shape: 'money', source: 'auto', unlimited: true, spent: '34.58', data: { currency: 'USD', total: '34.58', granted: '34.58', toppedUp: '0.00' } },
    { ok: false, siteId: 'd', provider: 'relay:new-api', reason: 'blocked', message: 'HTTP 403 疑似 Cloudflare 拦截' },
  ],
  health: [
    { siteId: 'a', health: 'online', status: 200, checkedAt: '2026-10-17T00:00:00.000Z' },
    { siteId: 'b', health: 'auth-failed', status: 401, checkedAt: '2026-10-17T00:00:00.000Z' },
  ],
  refreshedAt: '2026-10-17T00:00:00.000Z',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // 统一轮询状态（GET /state）：客户端 overlay 唯一的数据来源。
  // counter 每次请求全局递增（与 host 的 PollStateStore.next() 同口径：单调、同毫秒不重复）
  // → 客户端首拉记基线、之后每拍 takeChanged 都能捕获变化，正是轮询链路的实拍。
  // sections.relays 是构造的「3 站 1 无限 1 低额 1 失败 + 1 外币」舰队叶（T04 验收口径），
  // 与 sections.balance 并存——客户端据此把余额展示切换成舰队口径。
  if (pathname === '/dsh-pet-7340/state') {
    stateCounter += 1;
    sendJson(res, 200, {
      sections: {
        balance: {
          counter: stateCounter,
          data: { ok: true, provider: 'deepseek', shape: 'money', data: { currency: 'CNY', total: '11.06', granted: '5.00', toppedUp: '10.00' } },
        },
        relays: { counter: stateCounter, data: RELAYS_FLEET },
      },
      pets: {},
    });
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
