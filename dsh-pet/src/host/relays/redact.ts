/**
 * 敏感值脱敏 —— **所有对外输出的唯一出口**。
 *
 * 中转站的访问令牌 / 会话 Cookie 等同于账户权限，泄露即可被他人操作账户。
 * 因此：任何 API 响应、日志、错误信息都**不准**出现凭证原值，只能出现本文件产出的掩码。
 */

/**
 * 掩码规则：保留前 4 / 后 4，中间固定 4 个星号。
 * - 空 / 非字符串 → 空串（没有凭证就不显示掩码，而不是显示 `****` 冒充有）
 * - ≤ 8 位 → 全掩（短凭证保留头尾会泄过多信息）
 */
export function maskSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length === 0) return '';
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return secret.slice(0, 4) + '****' + secret.slice(-4);
}

/** 附加请求头脱敏：键保留（键名不是机密），值全部掩码 */
export function maskHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k] = maskSecret(v);
  return out;
}

/**
 * 自检用：判断一段文本里是否**含有明文凭证**。
 * 供测试与路由层兜底断言使用（例如「响应体 JSON 化后不得包含任何凭证原值」）。
 */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 6) continue;
    if (text.includes(s)) return true;
  }
  return false;
}
