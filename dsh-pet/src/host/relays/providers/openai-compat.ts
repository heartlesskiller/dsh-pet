/**
 * 通用 OpenAI 兼容兜底适配器（`openai-compat`）。
 *
 * 端点与真站事实（docs/10 F4）：`/dashboard/billing/subscription` 与
 * `/v1/dashboard/billing/usage` 两条路径都注册（`/v1` 前缀不是版本分界），
 * 中间件 `TokenAuth()` —— **只要模型 API Key**，不需要 AccessToken。
 * 剩余公式 `hard_limit_usd − total_usage/100` 在非无限 Key 上**【待验证】**
 * （docs/10 V2：实测站令牌是 unlimited，公式无法实测；标记在案，不视为阻塞）。
 *
 * 解析逻辑与 new-api 的 billing 链路**完全同源**（复用 fetchViaBilling），
 * 差别只在这个类型没有 `/api/user/self` 与 `/api/usage/token/` 可退。
 *
 * 纪律继承上游：只负责**成功路径**，任何失败一律 `throw`（带分类 code），
 * 由查询入口统一落成结构化失败 —— **绝不伪造 0 余额**。
 */

import { fetchViaBilling, normalizeBaseUrl, RELAY_PROVIDER_PREFIX } from './newapi';
import type { RelayProvider } from '../types';

export const openaiCompatProvider: RelayProvider = {
  kinds: ['openai-compat'],
  // 通用兼容站只认模型 Key（billing 端点的鉴权口径）
  credentialKinds: ['api-key'],
  // billing 双端点直接返回 USD 金额，不经过 quota 换算 → 不打 rateUnconfirmed
  usesQuotaRate: false,
  async fetch(ctx) {
    return fetchViaBilling(normalizeBaseUrl(ctx.baseUrl), ctx, RELAY_PROVIDER_PREFIX + 'openai-compat');
  },
  // 不实现 health：通用站不一定有 /api/status，探测交给 checkSiteHealth 的 unknown 分支
  // （「该站点类型暂无探测实现」）—— 不为了探测假装一个端点存在。
};
