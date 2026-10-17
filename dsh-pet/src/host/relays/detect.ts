/**
 * 站点类型识别 —— **纯函数**（HTTP 请求由 T03 的 `POST /relays/detect` 端点负责，
 * 本文件不碰网络、不读全局路径，可无 GUI、无副作用地测）。
 *
 * 真站实测结论（docs/10 F6）：`system_name` 会被站长自定义（实测站被改成 "st-api"）、
 * `version` 可能是空串 —— **两者都不可用于类型识别**。可靠信号只有两个：
 *   1. `/api/status` 响应存在 `HeaderNavModules` / `SidebarModulesAdmin` 字段
 *      （new-api 前端模块配置，标准 new-api 必有）；
 *   2. `/v1/models` 元素含 `supported_endpoint_types`（new-api 的模型强特征）。
 *
 * `system_name` 只作弱辅助记进 evidence，不参与判定。
 */

import { detectQuotaPerUnit } from './money';
import { parseStatus } from './providers/newapi';
import type { RelayKind } from './types';

/** 识别置信度：certain = 双信号命中；likely = 单信号；unknown = 无信号 */
export type RelayDetectConfidence = 'certain' | 'likely' | 'unknown';

export interface RelayDetectResult {
  kind: RelayKind | 'unknown';
  confidence: RelayDetectConfidence;
  /** 判定依据（人类可读，给 UI 展示「为什么判定成这个类型」） */
  evidence: string[];
  /** 从 /api/status 探测到的换算率（探不到 → 键不存在，调用方标 rateUnconfirmed） */
  suggestedQuotaPerUnit?: number;
  /** 站点是否以货币计价（`display_in_currency`） */
  displayInCurrency?: boolean;
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `/v1/models` 响应 → `supported_endpoint_types` 强特征。
 *
 * new-api 新版每个模型元素带 `supported_endpoint_types`（如 `["openai"]`）；
 * one-api 老版本与多数魔改站没有这个字段 → 只作「像 new-api」的佐证，不作充分条件。
 */
export function modelSignals(body: unknown): { looksLikeNewApi: boolean; evidence: string[] } {
  const root = asObj(body);
  const list = Array.isArray(root?.data)
    ? (root!.data as unknown[])
    : Array.isArray(body)
      ? (body as unknown[])
      : [];
  const hit = list.some((item) => {
    const o = asObj(item);
    return o !== undefined && 'supported_endpoint_types' in o;
  });
  return {
    looksLikeNewApi: hit,
    evidence: hit ? ['/v1/models 元素含 supported_endpoint_types（new-api 强特征）'] : [],
  };
}

/** 仅凭 `/api/status` 识别（免鉴权可拿，detect 的第一步） */
export function detectFromStatus(body: unknown): RelayDetectResult {
  const s = parseStatus(body);
  const rate = detectQuotaPerUnit(body);
  return {
    kind: s.looksLikeNewApi ? 'new-api' : 'unknown',
    confidence: s.looksLikeNewApi ? 'likely' : 'unknown',
    evidence: [...s.evidence],
    ...(rate !== undefined ? { suggestedQuotaPerUnit: rate } : {}),
    ...(s.displayInCurrency !== undefined ? { displayInCurrency: s.displayInCurrency } : {}),
  };
}

/**
 * 综合识别：`/api/status` + `/v1/models` 两个信号都命中 → certain。
 * 识别不出 → `kind:'unknown'`（端点据此引导用户手动选择类型或手工填余额，不静默失败）。
 */
export function detectRelayKind(input: { status?: unknown; models?: unknown }): RelayDetectResult {
  const fromStatus = input.status !== undefined ? detectFromStatus(input.status) : undefined;
  const fromModels = input.models !== undefined ? modelSignals(input.models) : undefined;
  const evidence = [...(fromStatus?.evidence ?? []), ...(fromModels?.evidence ?? [])];
  const looksLikeNewApi = fromStatus?.kind === 'new-api' || fromModels?.looksLikeNewApi === true;
  return {
    kind: looksLikeNewApi ? 'new-api' : 'unknown',
    confidence: looksLikeNewApi ? (fromStatus?.kind === 'new-api' && fromModels?.looksLikeNewApi ? 'certain' : 'likely') : 'unknown',
    evidence,
    ...(fromStatus?.suggestedQuotaPerUnit !== undefined ? { suggestedQuotaPerUnit: fromStatus.suggestedQuotaPerUnit } : {}),
    ...(fromStatus?.displayInCurrency !== undefined ? { displayInCurrency: fromStatus.displayInCurrency } : {}),
  };
}
