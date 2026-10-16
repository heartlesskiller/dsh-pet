/**
 * 中转站（API relay）管理 —— 契约层。
 *
 * 这里**只放形状与契约**，不放任何具体站点的知识：接口地址、认证方式、响应解析
 * 都在 `./providers/<名>.ts` 里各自一份。加一种站点类型 = 加一个 provider 文件 + 在
 * `./index.ts` 的注册表里加一行；本文件与客户端展示层都不用动。
 *
 * 设计继承上游 `src/host/balance/` 的纪律：
 * - provider 只负责**成功路径**；任何失败一律 `throw`，由查询入口统一落成结构化失败，
 *   **绝不伪造 0 余额**；
 * - 展示形态直接复用上游的 `shape: 'money'`（`MoneyBalance`）—— 这样六档余额动画、
 *   「余额（峰/谷）¥x.xx」气泡、档位基准全部沿用，客户端一行不用改。
 */

import type { MoneyBalance } from '../balance/types';

// ---------- 站点类型 ----------

/**
 * 已支持的站点类型（= provider 的 id 词干）。
 *
 * - `new-api`：new-api / one-api 系（`GET /api/user/self`，系统访问令牌 AccessToken）
 * - `sub2api`：Sub2API 系（`GET <base>/usage`，sk key 自查）
 * - `openai-compat`：通用 OpenAI 兼容兜底（`GET <base>/dashboard/billing/subscription`）
 */
export type RelayKind = 'new-api' | 'sub2api' | 'openai-compat';

/** 全部站点类型（注册表自检用：漏登记会在测试里炸） */
export const RELAY_KINDS: readonly RelayKind[] = ['new-api', 'sub2api', 'openai-compat'];

// ---------- 凭证 ----------

/**
 * 凭证种类。
 * - `access-token`：站点「个人设置 → 系统令牌」生成的系统访问令牌（**推荐**，能查余额）
 * - `api-key`：模型 API Key（sk-…）。多数站点查不了总余额，仅 new-api 新版可查 user_quota
 * - `session-cookie`：浏览器会话 Cookie（高级，易失效）
 * - `manual`：**无凭证**，余额由用户手工填写（查不到时的降级路径，不是失败）
 */
export type RelayCredentialKind = 'access-token' | 'api-key' | 'session-cookie' | 'manual';

/** 一份凭证（值本身绝不进任何返回体 / 日志） */
export interface RelayCredential {
  kind: RelayCredentialKind;
  /** 凭证值。仅存在于凭证存储内，任何 API 响应与日志都不得带出 */
  secret: string;
  /**
   * 附加请求头。如 new-api 新版要求 `New-Api-User: <uid>`。
   * 值同样视为敏感：不脱敏就会把 uid 泄进响应。
   */
  extraHeaders?: Record<string, string>;
}

// ---------- 站点 ----------

/** 一个中转站（持久化实体；不含凭证值，凭证单独存放） */
export interface RelaySite {
  id: string;
  /** 站点名称（用户可改，必填） */
  name: string;
  /** Base URL，必填。不含末尾斜杠 */
  url: string;
  kind: RelayKind;
  /** 备注 */
  note?: string;
  /**
   * quota ↔ 金额换算率。one-api / new-api 默认 500000 quota = 1 USD，
   * 站长可改 → 必须允许按站点覆盖。**换算只在 ./money.ts 做，别处不许自算。**
   */
  quotaPerUnit: number;
  /** 是否参与刷新与告警 */
  enabled: boolean;
  /** 手工填写的余额（`source: 'manual'` 时使用）。与自动值互斥，不参与自动刷新覆盖 */
  manualBalance?: { amount: string; currency: string; updatedAt: string };
  /** 低余额阈值（金额，与 manualBalance.currency 同币种） */
  lowThreshold?: string;
  createdAt: string;
  updatedAt: string;
}

/** 站点 + 脱敏后的凭证摘要（这是唯一允许出现在 API 响应里的形状） */
export interface RelaySiteView extends RelaySite {
  credential: {
    kind: RelayCredentialKind;
    /** 脱敏预览，形如 `sk-ab****wxyz`；manual 时为空串 */
    masked: string;
    /** 凭证是否已配置（manual 也算已配置） */
    present: boolean;
    /** 最近一次凭证验证时间 */
    lastValidatedAt?: string;
  };
}

// ---------- 余额 ----------

/** 余额来源：自动查询 / 用户手工填写 */
export type RelayBalanceSource = 'auto' | 'manual';

/** 成功结果。`data` 直接复用上游 `MoneyBalance`，客户端展示层零改动 */
export interface RelayBalanceSuccess {
  ok: true;
  siteId: string;
  /** provider id（`relay:<kind>`），展示层据此区分来源 */
  provider: string;
  shape: 'money';
  source: RelayBalanceSource;
  data: MoneyBalance;
}

/**
 * 失败结果。五种 reason 一个出口。
 *
 * `manual` 不是失败而是**降级路径**：查不到余额时用户手工填，界面必须带「手工」标签与
 * 填写时间，不得伪装成实时数据。
 */
export type RelayBalanceResult =
  | RelayBalanceSuccess
  | {
      ok: false;
      siteId: string;
      provider: string;
      reason: 'unsupported' | 'credential-missing' | 'fetch-error' | 'manual';
      message?: string;
    };

// ---------- 健康状态 ----------

/**
 * 连通性分类。三者文案必须不同（用户要能分清「站点挂了」还是「只是查不到余额」）。
 */
export type RelayHealth = 'online' | 'unreachable' | 'auth-failed' | 'blocked' | 'unknown';

export interface RelayHealthResult {
  siteId: string;
  health: RelayHealth;
  /** 探测用的端点 */
  endpoint?: string;
  /** HTTP 状态码（拿得到才带） */
  status?: number;
  /** 失败原因（人类可读） */
  message?: string;
  /** 探测耗时（ms） */
  latencyMs?: number;
  checkedAt: string;
}

// ---------- provider 契约 ----------

/** 查询上下文：所有站点类型的 `fetch` 收到同一个形状 */
export interface RelayFetchContext {
  siteId: string;
  /** Base URL（已去尾斜杠） */
  baseUrl: string;
  /** 凭证（`kind === 'manual'` 时为空串） */
  secret: string;
  kind: RelayCredentialKind;
  extraHeaders?: Record<string, string>;
  quotaPerUnit: number;
}

/**
 * 一种站点类型的余额查询定义 —— 一行 = 一个自包含站点类型。
 * 接口地址、认证方式、响应解析全在它自己的文件里。
 */
export interface RelayProvider {
  /** 可命中的站点类型 */
  kinds: RelayKind[];
  /** 该类型支持的凭证种类（用于表单校验：不允许给 new-api 选 manual 之外查不到的组合） */
  credentialKinds: RelayCredentialKind[];
  /**
   * 取数 + 解析。**只负责成功路径**：任何失败（HTTP 非 2xx、字段缺失/非法、未登录、
   * 被 Cloudflare 拦）一律 `throw`，由查询入口统一落成 `fetch-error`。
   */
  fetch(ctx: RelayFetchContext): Promise<Omit<RelayBalanceSuccess, 'siteId'>>;
  /** 连通性探测（低开销，不消耗业务额度）。同样只负责成功路径 */
  health?(ctx: RelayFetchContext): Promise<Omit<RelayHealthResult, 'siteId'>>;
}
