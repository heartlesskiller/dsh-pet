#!/usr/bin/env node
/**
 * pet-gateway-client.mjs —— CLI 与 MCP server **共用**的网关发现 + HTTP 薄客户端。
 *
 * ## 为什么单独一个文件
 * `dsh-pet-notify.mjs`（hook 脚本 / cron 用）与 `mcp-server.mjs`（WorkBuddy / Codex /
 * Claude Code 用）都要「找到桌宠 → hello 心跳 → POST /events」。发现逻辑与调用形状
 * **只有这一份**（K7：复制第二份必然漂移）。
 *
 * ## 发现口径（与 src/standalone/discovery.ts 同序，勿漂移）
 *   ① 读 `<DSH_HOME>/dsh-pet/gateways/*.json`（DSH_HOME 环境变量 → ~/.dsh），
 *      逐个校验 **pid 存活**（process.kill(pid,0)，EPERM 仍算活）——进程被 SIGKILL
 *      时没机会删文件，靠的就是这条自动判 stale；
 *   ② 目录为空 / 全 stale → `127.0.0.1:3080..3104` 逐个 `GET /health` 认名
 *      （name === 'dsh-pet-standalone'）。注意 S0 之后端口**不顺延**，这里的语义是
 *      「找别的实例」，不是给自己挑端口；
 *   ③ 都找不到 → null。调用方**明确失败**（exit 1 / MCP 报错），不静默、不猜。
 *
 * ## 为什么是 JS 镜像而不是 import src/standalone/discovery.ts
 * tools/ 由 `node tools/xxx.mjs` 直接跑（MCP client spawn、hook 脚本），不经构建、
 * 不带 --experimental-strip-types（engines 下限 node 22.12 需要 flag）——所以发现逻辑
 * 在 JS 侧持一份同序实现。改 discovery.ts 的语义时必须同步这里（两边都有测试钉口径）。
 *
 * 全部 node 内置（node:fs / node:os / node:path / fetch），零第三方依赖。
 */
/* global fetch, AbortSignal */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** 插件路由前缀（与 host 侧 ROUTE_PREFIX 一致） */
export const ROUTE_PREFIX = '/dsh-pet-7340';

/** 端口扫描兜底：起始端口与上限（与 standalone/discovery.ts 同口径） */
export const SCAN_BASE_PORT = 3080;
export const SCAN_LIMIT = 25;

/** DSH_HOME 解析（与 host/helper-process.ts 同口径：环境变量优先，落 ~/.dsh） */
export function dshHomeDir() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh');
}

/** 发现目录：`<DSH_HOME>/dsh-pet/gateways` */
export function gatewaysDir(home = dshHomeDir()) {
  return join(home, 'dsh-pet', 'gateways');
}

/** pid 活性：`process.kill(pid, 0)`；EPERM（存在但无权 signal）仍算活 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && e.code === 'EPERM';
  }
}

/**
 * 读目录里全部**存活**实例（stale 文件不删——那是别的进程的残骸；
 * 判活只看 pid）。按 startedAt 排序（先启动在前，稳定）。
 * 字段校验与 src/standalone/discovery.ts 的 parseGatewayRecord 同口径
 * （schema 1 / url / pid 必达）：坏形状跳过，不抛（读方不该被一个残骸拖垮）。
 */
export function listLiveGateways(home = dshHomeDir(), isAlive = isPidAlive) {
  const dir = gatewaysDir(home);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!rec || typeof rec !== 'object') continue;
      // 与 parseGatewayRecord 同口径：schema 1 + url + pid 必达（mode/instanceId 等于同族校验，从简）
      if (rec.schema !== 1) continue;
      if (typeof rec.url !== 'string' || !rec.url) continue;
      if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0) continue;
      if (!isAlive(rec.pid)) continue;
      out.push({
        url: rec.url.replace(/\/+$/, ''),
        routePrefix: typeof rec.routePrefix === 'string' && rec.routePrefix ? rec.routePrefix : ROUTE_PREFIX,
        pid: rec.pid,
        startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : '',
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** 默认端口探针：GET /health，200 且 body.name 是桌宠即算活 */
async function defaultProbe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.name === 'dsh-pet-standalone';
  } catch {
    return false;
  }
}

/**
 * 发现桌宠网关 → **API base**（`http://127.0.0.1:<port>/dsh-pet-7340`）；找不到 → null。
 *
 * @param home 注入的 DSH_HOME（测试假造目录用）
 * @param scanProbe 注入的端口探针（返回 true = 该端口有存活桌宠；测试用，默认真 fetch）
 */
export async function discoverGatewayBase({ home, scanProbe } = {}) {
  const live = listLiveGateways(home);
  if (live.length > 0) return live[0].url + live[0].routePrefix;
  const probe = scanProbe ?? defaultProbe;
  for (let i = 0; i < SCAN_LIMIT; i += 1) {
    const port = SCAN_BASE_PORT + i;
    let ok;
    try {
      ok = await probe(port);
    } catch {
      ok = false; // 单端口探测失败不影响其余（ECONNREFUSED 是常态）
    }
    if (ok) return `http://127.0.0.1:${port}${ROUTE_PREFIX}`;
  }
  return null;
}

// ---------- HTTP 薄客户端（fetch 可注入：测试不碰真网络） ----------

/**
 * 发一次请求（网络失败 → { ok:false, status:0, error }，绝不静默）。
 * 非 JSON 响应：body 落 null、text 原样带回，调用方看得见。
 */
async function request(url, init, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch (e) {
    return { ok: false, status: 0, body: null, text: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * base 归一化：去尾斜杠；**不带路由前缀就补上**。
 * 这样 `--base http://127.0.0.1:8231`（冒烟常用）与
 * `--base http://127.0.0.1:3080/dsh-pet-7340`（全路径）两种给法都收。
 */
function normalizeBase(base) {
  const trimmed = String(base ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith(ROUTE_PREFIX) ? trimmed : trimmed + ROUTE_PREFIX;
}

/** base + 路径（base 形如 http://127.0.0.1:3080/dsh-pet-7340；裸 origin 也收） */
function urlOf(base, path) {
  return normalizeBase(base) + path;
}

/** POST JSON */
export function postJson(url, body, options = {}) {
  return request(url, { method: 'POST', body: JSON.stringify(body ?? {}) }, options);
}

/** GET JSON */
export function getJson(url, options = {}) {
  return request(url, { method: 'GET' }, options);
}

// ---------- 三个 agent 向操作（CLI 与 MCP 共用同一组形状） ----------

/** 在场登记 / 心跳（L0；TTL 60s，重复调用 = 续期） */
export function helloAgent(base, input, options = {}) {
  return postJson(urlOf(base, '/agents/hello'), { agentId: input.agentId, kind: input.kind }, options);
}

/** 事件摄入（L2；body 形状 = EventsInput，见 openapi.yaml） */
export function postEvent(base, body, options = {}) {
  return postJson(urlOf(base, '/events'), body, options);
}

/** 在场列表（L1） */
export function listAgents(base, options = {}) {
  return getJson(urlOf(base, '/agents'), options);
}

/** 本机主机名（agentId 缺省 `<kind>@<host>` 用） */
export function localHostname() {
  return hostname();
}
