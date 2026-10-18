/**
 * 端到端契约：伪 ctx + **真实 apply** + 真实 `node:http` 服务。
 *
 * 这一层回答"独立模式到底有没有把插件自己的宿主半边跑起来"，并钉住三件事：
 *   1. `apply` 注册的路由前缀确实被独立服务接管 —— 只有一份路由表，没有第二套实现；
 *   2. 不依赖包内素材的端点与 DSH 内同形（`/state`、`/models`、`/config/meta` 的路径口径）；
 *   3. 路径安全与"配置不可达"的口径经**真实 HTTP** 仍然成立（独立服务不重写 URL、不吞异常）。
 *
 * 覆盖范围的限制与 `routes.test.ts` 相同：源码形态下包根解析成 `<pkg>/src`，
 * 包内 `assets/config.jsonc` 不可达 → `readAllConfig` 必抛。因此这里不断言"成品配置"，
 * 那条路径由构建产物（`lib/standalone.js`）的端到端验证覆盖（见 README 的独立运行一节）。
 *
 * 顺序上先监听、再 `apply` —— 与 CLI 完全一致：插件的 `launchHelper` 依赖
 * `ctx.webServer.port > 0`，端口为 0 时它只会 500ms 重试一次、永不拉起桌面窗口。
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageRoot } from '../host/helper-process.ts';
import { apply } from '../host/index.ts';
import { putCredential, upsertSite } from '../host/relays/store.ts';
import { createStandaloneContext, type RegisteredRoute, type StandaloneLogger } from './context.ts';
import { configPathsFor } from './options.ts';
import { listenStandaloneServer, type StandaloneServer } from './server.ts';

/** 静默日志器（插件仍会往 console 打少量 warn，那是它自己的诊断，这里不拦） */
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let home = '';
let base = '';
let server: StandaloneServer | undefined;
let context: ReturnType<typeof createStandaloneContext> | undefined;
let savedHome: string | undefined;
let savedElectron: string | undefined;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-standalone-'));
  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = home;
  // 指向一个真实存在的可执行文件：万一走到拉起分支也不会真的下载 Electron
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  const routes: RegisteredRoute[] = [];
  const portRef = { value: 0 };
  const created = createStandaloneContext({ port: () => portRef.value, logger: silent, routes });
  const listening = await listenStandaloneServer({
    routes,
    logger: silent,
    port: 0,
    // 与 CLI 同一个运维信息形状（这条断言顺带钉住 CLI 用的字段名）
    status: () => ({ name: 'dsh-pet-standalone', plugin: { root: packageRoot } }),
  });
  // 顺序与 CLI 完全一致：先监听拿到端口，再 apply —— 插件的 launchHelper 依赖 port > 0
  portRef.value = listening.port;
  apply(created.ctx);
  context = created;
  server = listening;
  base = `http://127.0.0.1:${listening.port}`;
});

after(async () => {
  // 释放 effect（停 Helper、清两条自续期轮询定时器）——不释放的话 node:test 跑完不退出
  await context?.dispose().catch(() => {});
  await context?.dispose().catch(() => {}); // 幂等：重复释放不得抛错
  await server?.close().catch(() => {});
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  rmSync(home, { recursive: true, force: true });
});

/** 取一条插件路由的响应 */
async function get(path: string): Promise<{ status: number; text: string; json: () => unknown }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

/** POST 一条插件路由（带 JSON body） */
async function post(path: string, body?: unknown): Promise<{ status: number; text: string; json: () => unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

describe('插件宿主半边在独立模式下跑起来了', () => {
  test('apply 注册了插件自己的路由前缀（独立模式不自己写路由表）', () => {
    const routes = context?.routes ?? [];
    assert.equal(routes.length, 1, '当前插件只注册一条 prefix 路由；多出来的注册要在这里显式确认');
    assert.equal(routes[0]?.kind, 'prefix');
    assert.equal(routes[0]?.path, '/dsh-pet-7340');
    assert.equal(typeof routes[0]?.handler, 'function');
  });

  test('/state 与 DSH 内同形（独立模式没有任何会话事件 → 叶子保持初始值）', async () => {
    const response = await get('/dsh-pet-7340/state');
    assert.equal(response.status, 200);
    const body = response.json() as {
      sections: Record<string, { counter: number; data: unknown }>;
      pets: Record<string, unknown>;
    };
    // agents = 在场 agent 投影叶（docs/19 T01 新增；新 section 必须同轮补进键集断言）
    assert.deepEqual(Object.keys(body.sections).sort(), ['agents', 'balance', 'notify', 'relays', 'workStatus']);
    assert.equal(body.sections.balance?.counter, 0);
    assert.equal(body.sections.balance?.data, null);
    assert.deepEqual(body.pets, {});
  });

  test('/models 是空清单（独立模式没有 llm 服务，但不报错、不静默失败）', async () => {
    const response = await get('/dsh-pet-7340/models');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { providers: [] });
  });

  test('/config/meta 的路径口径与 options.configPathsFor 完全一致（镜像不得漂移）', async () => {
    const response = await get('/dsh-pet-7340/config/meta');
    assert.equal(response.status, 200);
    const meta = response.json() as { user: string; default: string; animations: string };
    const paths = configPathsFor(packageRoot, home);
    // 这三条就是独立模式体检（--check）所依赖的推导；插件改了路径而 options.ts 没跟，这里会红
    assert.equal(meta.user, paths.userFile);
    assert.equal(meta.default, paths.defaultFile);
    assert.equal(meta.animations, join(home, 'dsh-pet', 'main-animation'));
  });
});

describe('配置与素材不可达时的口径 —— 显式失败，不静默兜底', () => {
  test('包内默认配置读不到（源码形态）→ /config 500 + 错误正文', async () => {
    const response = await get('/dsh-pet-7340/config');
    assert.equal(response.status, 500, '读不到配置必须显式失败：静默返回空配置会让桌宠"看起来正常但什么都没有"');
    const body = response.json() as { error?: string };
    assert.equal(typeof body.error, 'string');
    assert.ok((body.error ?? '').length > 0, '错误正文必须可读');
  });

  test('thumb 的路由安全口径经真实 HTTP 仍然成立', async () => {
    // 反斜杠不被 URL 的 pathname 拆段，会作为 petId 直接进路径拼接 —— 必须 400
    assert.equal((await get('/dsh-pet-7340/thumb/..%5C..%5Coutside/leak.webm')).status, 400);
    // 扩展名白名单
    assert.equal((await get('/dsh-pet-7340/thumb/main/x.txt')).status, 400);
    // 不存在的素材（主素材链与独占目录都查不到）
    assert.equal((await get(`/dsh-pet-7340/thumb/main/${encodeURIComponent('不存在.webm')}`)).status, 404);
  });

  test('pic/memes 的素材根同样不得当路径片段', async () => {
    assert.equal((await get('/dsh-pet-7340/pic/memes/..%5C..%5Coutside-memes/leak.png')).status, 400);
    assert.equal((await get('/dsh-pet-7340/pic/memes/main/nope.png')).status, 404);
  });
});

describe('独立服务自己的端点', () => {
  test('/ 回报插件版本与端口（运维信息，带跨源头）', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = (await response.json()) as { name: string; plugin: { root: string } };
    assert.equal(body.name, 'dsh-pet-standalone');
    assert.equal(body.plugin.root, packageRoot);
  });

  test('/shutdown 在没有收尾回调时也只回 200，不影响服务继续工作', async () => {
    const response = await fetch(`${base}/shutdown`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, stopping: true });
    assert.equal((await get('/dsh-pet-7340/state')).status, 200, '测试里没人真的停机：服务应继续可用');
  });
});

describe('中转站在独立模式下可用（用户目标①：任何 agent 都能驱动）', () => {
  /** 与 routes.test.ts 同理由：两个用例共用一个 home，不清场会互相看见对方建的站 */
  beforeEach(() => {
    rmSync(join(home, 'dsh-pet', 'relays'), { recursive: true, force: true });
  });

  /**
   * 独立模式的 ctx 把 DSH 的 credentials / agentDefaultModel 降级成了结构化失败替身
   * （见 ./context.ts）。中转站**不依赖那两个服务**：凭证读自己的 relay-credentials.json，
   * 余额/健康走 providers/newapi.ts —— 所以独立模式下它们必须是真的可用，而不是降级。
   * 这正是「桌宠不绑定 DSH 这一个宿主」的落地证据。
   */
  test('CRUD + 余额 + 健康在独立模式下全部可用（不靠 DSH 凭证服务）', async () => {
    const relayDir = join(home, 'dsh-pet', 'relays');
    const created = await post('/dsh-pet-7340/relays', {
      name: '独立站', url: 'https://solo.example.com/', kind: 'new-api',
      credential: { kind: 'access-token', secret: 'sk-solo-abcdef123456' },
    });
    assert.equal(created.status, 200);
    const site = (created.json() as { site: { id: string; credential: { masked: string } } }).site;
    assert.equal(created.text.includes('sk-solo-abcdef123456'), false, '独立模式同样不得泄漏明文凭证');

    const list = await get('/dsh-pet-7340/relays');
    assert.equal(list.status, 200);
    assert.equal((list.json() as { sites: unknown[] }).sites.length, 1);

    // 余额：manual 凭证 → 用手工值（不发请求，也不需要 DSH 的凭证服务）
    const withManual = await post(`/dsh-pet-7340/relays/${site.id}/manual-balance`, { amount: '9.90', currency: 'USD' });
    assert.equal(withManual.status, 200);
    putCredential(relayDir, site.id, { kind: 'manual', secret: '' });
    const balance = await post(`/dsh-pet-7340/relays/${site.id}/refresh`);
    assert.equal(balance.status, 200);
    const b = balance.json() as { ok: boolean; source: string; data: { total: string } };
    assert.equal(b.ok, true);
    assert.equal(b.source, 'manual');
    assert.equal(b.data.total, '9.90');

    // 健康：无凭证 → 明确报 unknown 并说明原因（不假装成功）
    const health = await post(`/dsh-pet-7340/relays/${site.id}/health`);
    assert.equal(health.status, 200);
    assert.equal((health.json() as { health: string }).health, 'unknown');

    // 删站点（凭证一起删）
    assert.equal((await fetch(`${base}/dsh-pet-7340/relays/${site.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(((await get('/dsh-pet-7340/relays')).json() as { sites: unknown[] }).sites, []);
  });

  test('sections.relays 与单服务商 balance 叶并存（互不覆盖）', async () => {
    const relayDir = join(home, 'dsh-pet', 'relays');
    const site = upsertSite(relayDir, {
      name: '并存站', url: 'https://coexist.example.com', kind: 'new-api',
      manualBalance: { amount: '2.00', currency: 'USD' },
    });
    putCredential(relayDir, site.id, { kind: 'manual', secret: '' });
    await post('/dsh-pet-7340/balance');
    const state = await get('/dsh-pet-7340/state');
    const body = state.json() as {
      sections: Record<string, { counter: number; data: Record<string, unknown> | null }>;
    };
    assert.ok(body.sections.balance.counter > 0, '单服务商链路照旧工作');
    assert.ok(body.sections.relays.counter > 0, '中转站叶也被写上');
    const data = body.sections.relays.data as { summary: { total: string } };
    assert.equal(data.summary.total, '2.00');
  });
});
