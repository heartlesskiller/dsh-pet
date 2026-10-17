/**
 * 网关鉴权（S7 之三）：分域可选 token，**默认全关**。
 *
 * ## 为什么默认全关（07 Q4）
 * 现状就是无 token：服务只监听 127.0.0.1（`standalone/server.ts`），威胁模型是「本机其他进程 /
 * 同一用户」，与 DSH 自身口径一致（API.md：「没有鉴权…请勿转发到公网」）。给个人自用加强制
 * token = 每个 agent 都要先找文件读 token，纯负担。**默认关时本模块不 enforce 任何东西。**
 *
 * ## 收紧的范围（只给 L3 域设计）
 * 可选 token **只为 L3 域**（改配置与凭证：PUT/POST /config、POST /reload、POST /relays、
 * PUT/DELETE /relays/{id}、POST /shutdown）设计，L0–L2 保持开放——「为了防删除而把刷新也锁上」
 * 会让个人自用变难用（定级轴见 ../capabilities.ts 的注释）。开启后该域要求
 * `Authorization: Bearer <token>`，未带/带错 → 401 `{ error: 'unauthorized', domain }`。
 *
 * ## 三层来源（按优先级，用户不用选）
 * 1. 环境变量 `DSH_PET_AGENT_TOKEN`（CI/容器场景，**优先级最高**）；
 * 2. 本机文件 `<DSH_HOME>/dsh-pet/agent-token.json`（0600，首次启用时生成 32 随机字节 base64url）；
 * 3. DSH 凭证库：`ctx.credentials.resolve(credentialRef('DSH_PET_AGENT_TOKEN'))`（零新增机制）。
 *
 * 本轮（R0）只落地模块本体 + 默认全关；L3 域的 enforce 接线留待启用开关落地时补
 * （默认关时保持极简，不碰任何既有分支）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHomeDir } from '../helper-process';

/** 门控域：只有 L3（不可逆后果）才值得要 token */
export type AuthDomain = 'config:write' | 'relays:write' | 'shutdown';

/** 启用时的默认门控域集合（L3 全集） */
export const L3_DOMAINS: readonly AuthDomain[] = ['config:write', 'relays:write', 'shutdown'];

/** 401 响应体（带域名：调用方知道是哪个域要的 token） */
export interface AuthFailure {
  ok: false;
  status: 401;
  body: { error: 'unauthorized'; domain: AuthDomain };
}

export type AuthResult = { ok: true } | AuthFailure;

export interface GatewayAuthOptions {
  /** 是否启用 token 门控。默认 false = 全关（不 enforce） */
  enabled?: boolean;
  /** 直接提供的 token（测试/注入用；给了就不再走三层解析） */
  token?: string;
  /** 三层来源解析器（默认 {@link resolveAgentToken} 的默认来源组合） */
  resolveToken?: () => Promise<string | undefined>;
  /** 域 → 是否要求 token；缺省 = 启用时 {@link L3_DOMAINS} 全要求 */
  domains?: Partial<Record<AuthDomain, boolean>>;
}

/** 三层来源的注入点（默认组合见 {@link defaultTokenSources}；测试逐个覆盖） */
export interface TokenSources {
  env?: () => string | undefined;
  /** 读本机 0600 文件（返回文件里的 token；没有/读不到 → undefined） */
  readLocalFile?: () => string | undefined;
  /** DSH 凭证库（返回 resolve 出来的值；不在场 → undefined） */
  credentials?: () => Promise<string | undefined>;
}

/** 环境变量来源（优先级最高：CI/容器场景） */
export const AGENT_TOKEN_ENV = 'DSH_PET_AGENT_TOKEN';

/** 本地 token 文件名（落在 <DSH_HOME>/dsh-pet/ 下，与发现目录同级） */
export const AGENT_TOKEN_FILE = 'agent-token.json';

export class GatewayAuth {
  declare private readonly enabled: boolean;
  declare private readonly token: string | undefined;
  declare private readonly resolveToken: (() => Promise<string | undefined>) | undefined;
  declare private readonly domains: Map<AuthDomain, boolean>;
  /** 解析结果缓存（启用后每次 L3 请求都读一遍文件太吵；进程内缓存，重启刷新） */
  declare private cached: { token: string | undefined } | undefined;

  constructor(options: GatewayAuthOptions = {}) {
    this.enabled = options.enabled === true;
    this.token = options.token;
    this.resolveToken = options.resolveToken;
    this.domains = new Map();
    for (const domain of L3_DOMAINS) {
      this.domains.set(domain, options.domains?.[domain] ?? this.enabled);
    }
  }

  /** 该域是否要求 token（默认全关时恒 false） */
  require(domain: AuthDomain): boolean {
    return this.domains.get(domain) === true;
  }

  /** 有没有任何域要求 token（/capabilities 的 tokenRequired 与 hello 响应用） */
  anyRequired(): boolean {
    for (const domain of L3_DOMAINS) if (this.require(domain)) return true;
    return false;
  }

  /**
   * 校验一个请求。未启用 / 该域不门控 → 直接放行；
   * 启用且该域门控 → 比对 `Authorization: Bearer <token>`，未带/带错 → 401。
   */
  async check(domain: AuthDomain, authorization: string | undefined): Promise<AuthResult> {
    if (!this.require(domain)) return { ok: true };
    const expected = await this.resolve();
    // 启用但解析不到 token = 配置不完整：**fail-open 还是 fail-closed？**
    // 选 fail-closed（401）：门控是用户显式开的，悄悄放行比拒绝更 surprise。
    if (!expected) return unauthorized(domain);
    const presented = bearerOf(authorization);
    if (!presented || presented !== expected) return unauthorized(domain);
    return { ok: true };
  }

  /** 取生效 token（显式注入 > 三层解析；带进程内缓存） */
  private async resolve(): Promise<string | undefined> {
    if (this.token !== undefined) return this.token;
    if (this.cached) return this.cached.token;
    const token = this.resolveToken ? await this.resolveToken() : undefined;
    this.cached = { token };
    return token;
  }
}

function unauthorized(domain: AuthDomain): AuthFailure {
  return { ok: false, status: 401, body: { error: 'unauthorized', domain } };
}

/** 从 Authorization 头取 Bearer token（不是 Bearer 方案 / 空值 → undefined） */
export function bearerOf(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m?.[1]?.trim() || undefined;
}

/**
 * 三层来源解析（优先级：环境变量 > 本机 0600 文件 > DSH 凭证库）。
 * 返回第一个非空值；全没有 → undefined（调用方按「启用但配不好」处理，见 GatewayAuth.check）。
 */
export async function resolveAgentToken(sources: TokenSources = defaultTokenSources()): Promise<string | undefined> {
  const fromEnv = sources.env?.();
  if (fromEnv) return fromEnv;
  const fromFile = sources.readLocalFile?.();
  if (fromFile) return fromFile;
  const fromCredentials = await sources.credentials?.();
  if (fromCredentials) return fromCredentials;
  return undefined;
}

/** 默认来源组合：env + <DSH_HOME>/dsh-pet/agent-token.json（DSH 凭证库由调用方按宿主形态注入） */
export function defaultTokenSources(dshHome?: string): TokenSources {
  return {
    env: () => process.env[AGENT_TOKEN_ENV],
    readLocalFile: () => readLocalAgentToken(dshHome),
  };
}

/** 读本机 token 文件；不存在 / 读不到 / 形状不对 → undefined */
export function readLocalAgentToken(dshHome?: string): string | undefined {
  const file = agentTokenPath(dshHome);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    return typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 确保本机 token 文件存在（不存在则生成并落盘），返回文件里的 token。
 * 文件 mode 0600（仅属主可读）；目录不存在先建。**只在启用门控时才会被调用。**
 */
export function ensureLocalAgentToken(dshHome?: string): string {
  const existing = readLocalAgentToken(dshHome);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  const file = agentTokenPath(dshHome);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}

/**
 * token 文件路径（`<DSH_HOME>/dsh-pet/agent-token.json`）。
 * dshHome 缺省时走 `dshHomeDir()`（host 侧现成解析，与发现目录同根——不自己拼路径）；
 * 测试注入临时目录。
 */
export function agentTokenPath(dshHome?: string): string {
  return join(dshHome ?? dshHomeDir(), 'dsh-pet', AGENT_TOKEN_FILE);
}

/** 文件是否已存在（调用方决定要不要 ensureLocalAgentToken；测试用） */
export function agentTokenExists(dshHome: string | undefined): boolean {
  return existsSync(agentTokenPath(dshHome));
}
