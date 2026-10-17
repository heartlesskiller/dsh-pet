/**
 * relays-admin 的纯逻辑单测 —— T06「设置页中转站管理」。
 *
 * 覆盖不碰 DOM 的部分：URL 校验、表单状态归约（默认值/视图回填/校验/body 构造）、
 * detect 结果渲染决策、错误态映射、余额格决策、健康点归键、金额/币种、焦点切换决策、
 * mapLimit 并发原语、zh/en 字典键 parity。DOM 级断言走 dev 验收脚本
 * （scripts/dev/verify-relays-admin.ts，renderToStaticMarkup 渲染真实组件）。
 *
 * 跑法：node --experimental-strip-types --test src/client/relays-admin.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDENTIAL_KINDS,
  DEFAULT_QUOTA_PER_UNIT,
  RELAY_KINDS,
  balanceCellOf,
  buildSiteBody,
  checkAmount,
  checkRelayUrl,
  decideDetect,
  emptySiteForm,
  en,
  focusTarget,
  formFromSite,
  healthKeyOf,
  mapLimit,
  mapRelayError,
  moneyText,
  parseExtraHeaders,
  validateSiteForm,
  zh,
  type RelayDetectInfo,
  type RelaySiteAdminView,
} from './relays-admin.ts';

/** 测试用站点视图（默认 = 已确认换算率、api-key 凭证在位的 new-api 站） */
function siteOf(over: Partial<RelaySiteAdminView> = {}): RelaySiteAdminView {
  return {
    id: 's1',
    name: 'A站',
    url: 'https://a.example.com',
    kind: 'new-api',
    quotaPerUnit: 500_000,
    rateConfirmed: true,
    enabled: true,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    credential: { kind: 'api-key', masked: 'sk-a****3456', present: true },
    ...over,
  };
}

describe('checkRelayUrl —— URL 校验（镜像宿主 normalizeBaseUrl 规则）', () => {
  test('合法 URL：去首尾空白、去尾斜杠、去 /v1 后缀', () => {
    assert.deepEqual(checkRelayUrl('https://a.com'), { ok: true, url: 'https://a.com' });
    assert.deepEqual(checkRelayUrl('  https://a.com/  '), { ok: true, url: 'https://a.com' });
    assert.deepEqual(checkRelayUrl('https://a.com/v1'), { ok: true, url: 'https://a.com' });
    assert.deepEqual(checkRelayUrl('https://a.com/v1/'), { ok: true, url: 'https://a.com' });
    assert.deepEqual(checkRelayUrl('http://127.0.0.1:8231/v1'), { ok: true, url: 'http://127.0.0.1:8231' });
  });

  test('非法 URL：空串 → empty；无 http(s) 前缀 → scheme', () => {
    assert.deepEqual(checkRelayUrl(''), { ok: false, error: 'empty' });
    assert.deepEqual(checkRelayUrl('   '), { ok: false, error: 'empty' });
    assert.deepEqual(checkRelayUrl('a.com'), { ok: false, error: 'scheme' });
    assert.deepEqual(checkRelayUrl('ftp://a.com'), { ok: false, error: 'scheme' });
  });
});

describe('表单状态归约', () => {
  test('emptySiteForm：API Key 优先、默认换算率显式写出且未确认、默认参与刷新', () => {
    const f = emptySiteForm();
    assert.equal(f.credentialKind, 'api-key');
    assert.equal(f.quotaPerUnit, String(DEFAULT_QUOTA_PER_UNIT));
    assert.equal(f.rateConfirmed, false);
    assert.equal(f.enabled, true);
    assert.equal(f.manualCurrency, 'USD');
    assert.equal(f.kind, 'new-api');
    // 凭证值恒空（绝不预填任何真实凭证）
    assert.equal(f.secret, '');
  });

  test('formFromSite：视图 → 表单；掩码不回显（secret 留空 = 不动）', () => {
    const site = siteOf({
      note: '自用',
      lowThreshold: '5',
      rateConfirmed: false,
      enabled: false,
      manualBalance: { amount: '3.50', currency: 'USD', updatedAt: '2026-10-18T08:30:00.000Z' },
      credential: { kind: 'session-cookie', masked: 'sess****abcd', present: true },
    });
    const f = formFromSite(site);
    assert.equal(f.name, 'A站');
    assert.equal(f.url, 'https://a.example.com');
    assert.equal(f.kind, 'new-api');
    assert.equal(f.note, '自用');
    assert.equal(f.lowThreshold, '5');
    assert.equal(f.enabled, false);
    assert.equal(f.rateConfirmed, false);
    assert.equal(f.quotaPerUnit, '500000');
    assert.equal(f.credentialKind, 'session-cookie');
    assert.equal(f.secret, '');
    assert.equal(f.manualAmount, '3.50');
    assert.equal(f.manualCurrency, 'USD');
  });

  test('validateSiteForm：名称 / URL / 换算率 / 阈值 / 附加头 / 手工余额各项规则', () => {
    const base = emptySiteForm();
    base.name = 'A站';
    base.url = 'https://a.com';
    assert.deepEqual(validateSiteForm(base), { ok: true });

    assert.deepEqual(validateSiteForm({ ...base, name: '  ' }), { ok: false, error: 'name' });
    assert.deepEqual(validateSiteForm({ ...base, url: 'a.com' }), { ok: false, error: 'url' });
    assert.deepEqual(validateSiteForm({ ...base, url: '' }), { ok: false, error: 'url' });
    assert.deepEqual(validateSiteForm({ ...base, quotaPerUnit: '0' }), { ok: false, error: 'quota' });
    assert.deepEqual(validateSiteForm({ ...base, quotaPerUnit: 'abc' }), { ok: false, error: 'quota' });
    assert.deepEqual(validateSiteForm({ ...base, lowThreshold: '1.234' }), { ok: false, error: 'threshold' });
    assert.deepEqual(validateSiteForm({ ...base, lowThreshold: '5' }), { ok: true });
    // 附加头：名称与值必须成对
    assert.deepEqual(validateSiteForm({ ...base, headerKey: 'New-Api-User' }), { ok: false, error: 'header' });
    assert.deepEqual(validateSiteForm({ ...base, headerValue: '1' }), { ok: false, error: 'header' });
    assert.deepEqual(validateSiteForm({ ...base, headerKey: 'New-Api-User', headerValue: '1' }), { ok: true });
    // 手工余额：金额为空 = 不设置（预填币种忽略）；金额非空时币种必须齐备、至多两位小数
    assert.deepEqual(validateSiteForm({ ...base, manualAmount: '1.5', manualCurrency: '' }), {
      ok: false,
      error: 'manual',
    });
    assert.deepEqual(validateSiteForm({ ...base, manualCurrency: 'CNY' }), { ok: true });
    assert.deepEqual(validateSiteForm({ ...base, manualAmount: '1.555', manualCurrency: 'CNY' }), {
      ok: false,
      error: 'manual',
    });
    assert.deepEqual(validateSiteForm({ ...base, manualAmount: '1.55', manualCurrency: 'cny' }), { ok: true });
  });

  test('buildSiteBody：URL 归一化 + lowThreshold/note 恒带（空串 = 清空语义）', () => {
    const f = { ...emptySiteForm(), name: ' A站 ', url: 'https://a.com/v1/', note: ' 备注 ', lowThreshold: '' };
    const body = buildSiteBody(f);
    assert.equal(body.name, 'A站');
    assert.equal(body.url, 'https://a.com');
    assert.equal(body.note, '备注');
    assert.equal(body.lowThreshold, '');
    assert.equal(body.quotaPerUnit, DEFAULT_QUOTA_PER_UNIT);
    assert.equal(body.enabled, true);
    assert.equal(body.rateConfirmed, false);
    // 没填凭证值 → credential 段缺省（宿主：缺省 = 不动）
    assert.equal('credential' in body, false);
  });

  test('buildSiteBody：填了新凭证 → 带 secret 与附加头；manual → 显式声明无凭证', () => {
    const withKey = buildSiteBody({
      ...emptySiteForm(),
      credentialKind: 'api-key',
      secret: 'sk-live-123',
      headerKey: 'New-Api-User',
      headerValue: '42',
    });
    assert.deepEqual(withKey.credential, {
      kind: 'api-key',
      secret: 'sk-live-123',
      extraHeaders: { 'New-Api-User': '42' },
    });

    const manual = buildSiteBody({ ...emptySiteForm(), credentialKind: 'manual' });
    assert.deepEqual(manual.credential, { kind: 'manual' });

    // 编辑态留空 secret → 不带 credential（不动已存凭证）
    const keepOld = buildSiteBody({ ...emptySiteForm(), credentialKind: 'access-token', secret: '   ' });
    assert.equal('credential' in keepOld, false);
  });

  test('parseExtraHeaders：单键值对；任一为空 → undefined', () => {
    assert.deepEqual(parseExtraHeaders('New-Api-User', ' 42 '), { 'New-Api-User': '42' });
    assert.equal(parseExtraHeaders('', '42'), undefined);
    assert.equal(parseExtraHeaders('K', ''), undefined);
  });
});

describe('decideDetect —— detect 结果渲染决策', () => {
  test('certain/likely → 回填类型 + 证据 + 换算率建议', () => {
    const certain: RelayDetectInfo = {
      kind: 'new-api',
      confidence: 'certain',
      evidence: ['/api/status 命中', '/v1/models 命中'],
      suggestedQuotaPerUnit: 500_000,
    };
    const d1 = decideDetect(certain);
    assert.ok(d1 !== null && d1.kind === 'apply');
    if (d1 === null || d1.kind !== 'apply') return;
    assert.equal(d1.siteKind, 'new-api');
    assert.equal(d1.confidence, 'certain');
    assert.deepEqual(d1.evidence, ['/api/status 命中', '/v1/models 命中']);
    assert.equal(d1.suggestedQuota, 500_000);

    const likely = decideDetect({ kind: 'sub2api', confidence: 'likely', evidence: ['单信号'] });
    assert.ok(likely !== null && likely.kind === 'apply');
    if (likely === null || likely.kind !== 'apply') return;
    assert.equal(likely.siteKind, 'sub2api');
    assert.equal(likely.confidence, 'likely');
    assert.equal(likely.suggestedQuota, undefined);
  });

  test('unknown → 引导手选/手工填余额（带原因，不静默失败）', () => {
    const d = decideDetect({ kind: 'unknown', confidence: 'unknown', evidence: [], message: '连接超时' });
    assert.ok(d !== null && d.kind === 'unknown');
    if (d === null || d.kind !== 'unknown') return;
    assert.equal(d.message, '连接超时');
    assert.deepEqual(d.evidence, []);
  });

  test('还没探测过 → null（界面不显示识别区）', () => {
    assert.equal(decideDetect(null), null);
  });
});

describe('mapRelayError —— 错误态映射（阶段标题 + 细节键 + 是否值得重试）', () => {
  test('网络错（无 status）→ errNetwork，值得重试', () => {
    assert.deepEqual(mapRelayError(new Error('fetch failed'), 'load'), {
      titleKey: 'errLoad',
      detailKey: 'errNetwork',
      retry: true,
    });
  });

  test('404 → errNotFound（重试没意义）；400 → errBadRequest', () => {
    assert.deepEqual(mapRelayError({ status: 404 }, 'act'), {
      titleKey: 'errAct',
      detailKey: 'errNotFound',
      retry: false,
    });
    assert.deepEqual(mapRelayError({ status: 400 }, 'save'), {
      titleKey: 'errSave',
      detailKey: 'errBadRequest',
      retry: false,
    });
  });

  test('5xx → errServer 值得重试；其余状态码 → errUnknown', () => {
    assert.deepEqual(mapRelayError({ status: 500 }, 'load'), {
      titleKey: 'errLoad',
      detailKey: 'errServer',
      retry: true,
    });
    assert.deepEqual(mapRelayError({ status: 503 }, 'act'), {
      titleKey: 'errAct',
      detailKey: 'errServer',
      retry: true,
    });
    assert.deepEqual(mapRelayError({ status: 302 }, 'act'), {
      titleKey: 'errAct',
      detailKey: 'errUnknown',
      retry: true,
    });
  });
});

describe('balanceCellOf —— 行内余额展示决策', () => {
  test('auto：金额 + 数据口径（account/token）+ 未确认标记', () => {
    const cell = balanceCellOf({ ok: true, source: 'auto', total: '10.00', currency: 'USD', scope: 'account' });
    assert.deepEqual(cell, { kind: 'auto', text: '$10.00', scope: 'account', unconfirmed: false });
    const token = balanceCellOf({ ok: true, total: '3.02', currency: 'USD', scope: 'token', rateUnconfirmed: true });
    assert.deepEqual(token, { kind: 'auto', text: '$3.02', scope: 'token', unconfirmed: true });
    // 探不到口径 → scope null（不猜账户级/令牌级）
    const noScope = balanceCellOf({ ok: true, total: '1.00', currency: 'USD' });
    assert.equal(noScope.kind === 'auto' && noScope.scope, null);
  });

  test('manual：带「手工」语义的单元格（组件侧再叠标签）', () => {
    assert.deepEqual(balanceCellOf({ ok: true, source: 'manual', total: '5.00', currency: 'CNY' }), {
      kind: 'manual',
      text: '¥5.00',
    });
  });

  test('unlimited：语义是「已用」不是「余额」', () => {
    const cell = balanceCellOf({ ok: true, unlimited: true, spent: '34.58', total: '34.58', currency: 'USD' });
    assert.deepEqual(cell, { kind: 'unlimited', text: '$34.58', unconfirmed: false });
  });

  test('failed：六种 reason 一个出口；脏 reason 归 fetch-error', () => {
    assert.deepEqual(balanceCellOf({ ok: false, reason: 'blocked', message: 'HTTP 403' }), {
      kind: 'failed',
      reason: 'blocked',
      message: 'HTTP 403',
    });
    assert.deepEqual(balanceCellOf({ ok: false, reason: 'credential-missing' }), {
      kind: 'failed',
      reason: 'credential-missing',
      message: '',
    });
    const dirty = balanceCellOf({ ok: false, reason: 'mystery' as 'fetch-error' });
    assert.equal(dirty.kind === 'failed' && dirty.reason, 'fetch-error');
  });

  test('还没查到（undefined）→ none（不伪造 0 余额）', () => {
    assert.deepEqual(balanceCellOf(undefined), { kind: 'none' });
  });

  test('moneyText：USD $ / CNY ¥ / 其他币种带代码（不假装是美元）', () => {
    assert.equal(moneyText('1.00', 'USD'), '$1.00');
    assert.equal(moneyText('1.00', 'CNY'), '¥1.00');
    assert.equal(moneyText('1.00', 'EUR'), '1.00 EUR');
    assert.equal(moneyText('1.00', 'usd'), '$1.00');
  });
});

describe('healthKeyOf / focusTarget / checkAmount', () => {
  test('healthKeyOf：白名单原样；白名单外（含脏数据）→ unknown', () => {
    assert.equal(healthKeyOf('online'), 'online');
    assert.equal(healthKeyOf('auth-failed'), 'auth-failed');
    assert.equal(healthKeyOf('unreachable'), 'unreachable');
    assert.equal(healthKeyOf('blocked'), 'blocked');
    assert.equal(healthKeyOf('unknown'), 'unknown');
    assert.equal(healthKeyOf('ONLINE'), 'unknown');
    assert.equal(healthKeyOf(undefined), 'unknown');
    assert.equal(healthKeyOf(''), 'unknown');
  });

  test('focusTarget：点当前焦点 = 清除（回全舰队）；点别的 = 设过去', () => {
    assert.equal(focusTarget('a', 'a'), null);
    assert.equal(focusTarget('a', 'b'), 'b');
    assert.equal(focusTarget(null, 'b'), 'b');
  });

  test('checkAmount：非负、至多两位小数；空串按「清除」由调用方处理', () => {
    assert.deepEqual(checkAmount('12.34'), { ok: true, amount: '12.34' });
    assert.deepEqual(checkAmount(' 0 '), { ok: true, amount: '0' });
    assert.equal(checkAmount('').ok, false);
    assert.equal(checkAmount('12.345').ok, false);
    assert.equal(checkAmount('-1').ok, false);
    assert.equal(checkAmount('abc').ok, false);
  });
});

describe('mapLimit —— 并发受限映射（批量刷新/探测用）', () => {
  test('保序返回，且同时在飞的数量不超过 limit', async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapLimit(items, 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n * 2;
    });
    assert.deepEqual(
      out,
      items.map((n) => n * 2),
    );
    assert.ok(peak <= 4, '并发峰值 ' + String(peak) + ' 超过 limit 4');
    assert.ok(peak >= 2, '并发峰值 ' + String(peak) + ' —— 没有真正并发起来');
  });

  test('空数组 / limit 小于 1 都不炸', async () => {
    assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
    assert.deepEqual(await mapLimit([1, 2], 0, async (n: number) => n + 1), [2, 3]);
  });
});

describe('契约常量与字典', () => {
  test('RELAY_KINDS / CREDENTIAL_KINDS：顺序即引导顺序（API Key 优先）', () => {
    assert.deepEqual([...RELAY_KINDS], ['new-api', 'sub2api', 'openai-compat']);
    assert.deepEqual([...CREDENTIAL_KINDS], ['api-key', 'access-token', 'session-cookie', 'manual']);
  });

  test('zh/en 键集一致、无空值、占位符一致', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const placeholders = (s: string): string[] => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    for (const key of Object.keys(zh)) {
      assert.ok(zh[key].length > 0, 'zh 空文案：' + key);
      assert.ok(en[key].length > 0, 'en 空文案：' + key);
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), '占位符不一致：' + key);
    }
  });

  test('关键文案在位（导航 / 空态 / 错误态 / 未确认态 / 手工标签）', () => {
    for (const key of [
      'nav',
      'empty',
      'errLoad',
      'errNetwork',
      'unconfirmedBanner',
      'manualTag',
      'manualEntry',
      'focusFleet',
    ]) {
      assert.ok(key in zh, 'zh 缺键：' + key);
      assert.ok(key in en, 'en 缺键：' + key);
    }
  });
});
