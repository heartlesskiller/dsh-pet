/**
 * 网关发现目录（R0 S7 的「被发现」半边）—— `<DSH_HOME>/dsh-pet/gateways/<pid>.json`。
 *
 * ## 为什么是「目录 + 每实例一文件」而不是单文件（07 v2.2 裁决）
 * 单文件在「两个宿主并存」时会互相覆盖：DSH 模式与独立模式同时跑是用户的合法选择
 * （一个网页里养鱼、一个独立窗看余额），单文件只能记住最后一个，先启动的那只就"消失"了。
 * 每实例一个文件天然无写冲突：谁写谁的，读方合并。
 *
 * ## 生命周期
 * - **写**：监听成功后立即写（端口确定的时刻）；端口变化（如未来支持换端口）→ 重写自己的文件；
 * - **删**：停机时**先读回来校验 `pid === process.pid` 才删**——防止误删「别的实例恰好复用了我的 pid」
 *   这种极端情况下的文件（PID 复用是已知局限，见 instance-lock.ts）；
 * - **读**：glob 目录 → 逐个解析 → **校验 pid 存活**（`process.kill(pid, 0)`，EPERM 仍算活）→
 *   合并可用列表。进程被 SIGKILL 时没机会删文件，靠的就是这条自动判 stale。
 *
 * ## 兜底
 * 目录为空或全 stale 时，按 3080..3080+24 逐个 `GET /health` 探测（**注意 S0 之后端口已不顺延**，
 * 这里的语义是「找别的实例」，不是给自己挑端口）。
 *
 * 本模块只做文件与纯判定；不做 HTTP（扫描兜底接受注入的探测函数，测试可假造）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHomeDir } from '../host/helper-process';
import { defaultIsAlive } from './instance-lock';

/** 发现记录（schema 1；字段与 07 §5 的示例一致，`instanceId` 与 /capabilities 同源） */
export interface GatewayRecord {
  schema: 1;
  instanceId: string;
  mode: 'standalone' | 'dsh';
  url: string;
  routePrefix: string;
  port: number;
  pid: number;
  startedAt: string;
  capabilities: string[];
  tokenRequired: boolean;
}

/** 发现目录：`<DSH_HOME>/dsh-pet/gateways`（DSH_HOME 由 host 侧解析，不自己拼） */
export function gatewaysDir(home?: string): string {
  return join(home ?? dshHomeDir(), 'dsh-pet', 'gateways');
}

/** 某实例的发现文件路径 */
export function gatewayRecordPath(pid: number, home?: string): string {
  return join(gatewaysDir(home), String(pid) + '.json');
}

/**
 * 写自己的发现文件（原子：临时文件 + rename；目录不存在先建）。
 * 端口变化时直接重写同一路径（覆盖自己那份）。
 */
export function writeGatewayRecord(record: GatewayRecord, home?: string): string {
  const dir = gatewaysDir(home);
  mkdirSync(dir, { recursive: true });
  const file = gatewayRecordPath(record.pid, home);
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

/**
 * 删除自己的发现文件（**pid 校验后才删**）。
 * 返回 true = 删了；false = 文件不存在或 pid 不匹配（不是我的，绝不删别人的）。
 */
export function removeGatewayRecord(pid: number = process.pid, home?: string): boolean {
  const file = gatewayRecordPath(pid, home);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false; // 读不到（不存在/坏文件）：没东西可删，也不该删
  }
  const ownerPid = (parsed as { pid?: unknown } | null)?.pid;
  if (ownerPid !== pid) return false; // 文件里记的不是这个 pid：不是我的，不删
  rmSync(file, { force: true });
  return true;
}

/** 解析单个发现文件（形状非法 → undefined，不抛） */
export function parseGatewayRecord(raw: unknown): GatewayRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const schema = o.schema;
  const instanceId = o.instanceId;
  const mode = o.mode;
  const url = o.url;
  const port = o.port;
  const pid = o.pid;
  const startedAt = o.startedAt;
  if (schema !== 1) return undefined;
  if (typeof instanceId !== 'string' || !instanceId) return undefined;
  if (mode !== 'standalone' && mode !== 'dsh') return undefined;
  if (typeof url !== 'string' || !url) return undefined;
  if (typeof port !== 'number' || !Number.isFinite(port)) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'string' || !startedAt) return undefined;
  return {
    schema: 1,
    instanceId,
    mode,
    url,
    routePrefix: typeof o.routePrefix === 'string' && o.routePrefix ? o.routePrefix : '/dsh-pet-7340',
    port,
    pid,
    startedAt,
    capabilities: Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === 'string') : [],
    tokenRequired: o.tokenRequired === true,
  };
}

/**
 * 读目录里的全部**存活**实例（stale 文件不删——那是别的进程的残骸，留着让用户可见/自查；
 * 判活只看 pid）。按启动时间排序（先启动的在前，稳定）。
 */
export function listGatewayRecords(home?: string, isAlive: (pid: number) => boolean = defaultIsAlive): GatewayRecord[] {
  const dir = gatewaysDir(home);
  if (!existsSync(dir)) return [];
  const out: GatewayRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue; // 坏文件：跳过（不抛，读方不该被一个残骸拖垮）
    }
    const record = parseGatewayRecord(raw);
    if (!record) continue;
    if (!isAlive(record.pid)) continue; // 进程已死 → stale，不返回
    out.push(record);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** 端口扫描兜底的上限（与 server.ts 的 PORT_SCAN_LIMIT 同口径：3080..3080+24） */
export const DISCOVERY_SCAN_LIMIT = 25;
/** 扫描起始端口（独立模式默认端口） */
export const DISCOVERY_BASE_PORT = 3080;

/**
 * 端口扫描兜底：目录为空/全 stale 时，逐个 `GET /health` 找活着的实例。
 *
 * @param probe 注入的探测函数（返回 true = 该端口有存活桌宠）；默认实现走 fetch
 * @returns 探到的端口列表（按端口升序）
 */
export async function scanGatewayPorts(
  probe: (port: number) => Promise<boolean> = defaultProbe,
  limit: number = DISCOVERY_SCAN_LIMIT,
): Promise<number[]> {
  const found: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const port = DISCOVERY_BASE_PORT + i;
    try {
      if (await probe(port)) found.push(port);
    } catch {
      // 单个端口探测失败不影响其余（ECONNREFUSED 是常态：大多数端口没有服务）
    }
  }
  return found;
}

/** 默认探针：GET /health，200 且 body.name 是桌宠即算活 */
async function defaultProbe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    return body?.name === 'dsh-pet-standalone';
  } catch {
    return false;
  }
}
