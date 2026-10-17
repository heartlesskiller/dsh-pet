import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectFromStatus, detectRelayKind, modelSignals } from './detect.ts';

// ---------- 真站响应原文（docs/10-real-site-verification.md 留档） ----------

/** /api/status —— 实测站：system_name 被改成 "st-api"、version 空串，但模块字段在 */
const STATUS_REAL = {
  success: true,
  data: {
    system_name: 'st-api',
    version: '',
    quota_per_unit: 500000,
    display_in_currency: true,
    HeaderNavModules: '["chat"]',
    SidebarModulesAdmin: '[{"id":"chat"}]',
  },
};

/** /v1/models —— 实测站形状：supported_endpoint_types 是 new-api 强特征 */
const MODELS_REAL = { data: [{ id: 'gpt-4o', supported_endpoint_types: ['openai'] }] };

/** 普通 OpenAI 兼容站形状：没有 supported_endpoint_types */
const MODELS_PLAIN = { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] };

test('detectFromStatus：F6 —— 实测站 → new-api（likely）+ evidence + 换算率建议', () => {
  const r = detectFromStatus(STATUS_REAL);
  assert.equal(r.kind, 'new-api');
  assert.equal(r.confidence, 'likely');
  assert.equal(r.suggestedQuotaPerUnit, 500_000);
  assert.equal(r.displayInCurrency, true);
  assert.ok(r.evidence.some((e) => /HeaderNavModules/.test(e)));
});

test('detectFromStatus：只有 system_name/version → unknown（F6：两者不可用于识别）', () => {
  const r = detectFromStatus({ success: true, data: { system_name: 'New API', version: 'v0.9.0' } });
  assert.equal(r.kind, 'unknown');
  assert.equal(r.confidence, 'unknown');
  assert.equal(r.evidence.length, 0);
  assert.ok(!('suggestedQuotaPerUnit' in r));
});

test('detectFromStatus：/api/status 免鉴权可拿（探测不到换算率也不影响识别）', () => {
  const r = detectFromStatus({ success: true, data: { HeaderNavModules: '[]', quota_per_unit: 'x' } });
  assert.equal(r.kind, 'new-api');
  assert.ok(!('suggestedQuotaPerUnit' in r), '换算率探不到 → 键不存在，调用方标 rateUnconfirmed');
});

test('modelSignals：supported_endpoint_types → new-api 强特征', () => {
  const s = modelSignals(MODELS_REAL);
  assert.equal(s.looksLikeNewApi, true);
  assert.ok(s.evidence.some((e) => /supported_endpoint_types/.test(e)));
});

test('modelSignals：普通 OpenAI 兼容形状 → 无强特征（不作充分条件）', () => {
  const s = modelSignals(MODELS_PLAIN);
  assert.equal(s.looksLikeNewApi, false);
  assert.equal(s.evidence.length, 0);
});

test('detectRelayKind：双信号命中 → certain', () => {
  const r = detectRelayKind({ status: STATUS_REAL, models: MODELS_REAL });
  assert.equal(r.kind, 'new-api');
  assert.equal(r.confidence, 'certain');
  assert.equal(r.evidence.length, 2, '两个信号的 evidence 都要带上');
});

test('detectRelayKind：单信号 → likely；无信号 → unknown（引导用户手选，不静默失败）', () => {
  const onlyModels = detectRelayKind({ models: MODELS_REAL });
  assert.equal(onlyModels.confidence, 'likely');
  const none = detectRelayKind({});
  assert.equal(none.kind, 'unknown');
  assert.equal(none.confidence, 'unknown');
  assert.equal(none.evidence.length, 0);
});

test('detectRelayKind：只给 status 时透出换算率与货币计价建议', () => {
  const r = detectRelayKind({ status: STATUS_REAL });
  assert.equal(r.suggestedQuotaPerUnit, 500_000);
  assert.equal(r.displayInCurrency, true);
});
