/**
 * S5 能力分级测试：档位投影（读/写同路径不同档）与能力投影（独立模式不撒谎）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPABILITY_TIERS,
  capabilitiesFrom,
  capabilityMissing,
  hostModeOf,
  projectCapabilitySet,
  tierOfEndpoint,
  type CapabilitySet,
} from './capabilities.ts';

test('tierOfEndpoint：同路径不同方法不同档（GET /config L1 vs PUT /config L3）', () => {
  assert.equal(tierOfEndpoint('GET', 'config'), 'L1');
  assert.equal(tierOfEndpoint('PUT', 'config'), 'L3');
  assert.equal(tierOfEndpoint('POST', 'config'), 'L3');
  assert.equal(tierOfEndpoint('GET', 'relays'), 'L1');
  assert.equal(tierOfEndpoint('POST', 'relays'), 'L3');
});

test('tierOfEndpoint：L0 在场（capabilities / agents/hello / health）任何方法都不改档', () => {
  assert.equal(tierOfEndpoint('GET', 'capabilities'), 'L0');
  assert.equal(tierOfEndpoint('POST', 'agents/hello'), 'L0');
  assert.equal(tierOfEndpoint('GET', 'health'), 'L0');
});

test('tierOfEndpoint：relays 动作段 —— 刷新/健康/抓模型/手工余额 = L2，删改 = L3', () => {
  assert.equal(tierOfEndpoint('POST', 'relays/abc/refresh'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'relays/abc/health'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'relays/abc/models'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'relays/abc/manual-balance'), 'L2');
  assert.equal(tierOfEndpoint('DELETE', 'relays/abc'), 'L3');
  assert.equal(tierOfEndpoint('PUT', 'relays/abc'), 'L3');
  assert.equal(tierOfEndpoint('GET', 'relays/abc'), 'L1');
});

test('tierOfEndpoint：驱动类（broadcast/anim/events）L2；reload/shutdown L3', () => {
  assert.equal(tierOfEndpoint('POST', 'broadcast'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'anim'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'events'), 'L2');
  assert.equal(tierOfEndpoint('POST', 'reload'), 'L3');
  assert.equal(tierOfEndpoint('POST', 'shutdown'), 'L3');
});

test('tierOfEndpoint：表外路径 → undefined（不得当成 L0 放行）；查询串/前导斜杠被归一', () => {
  assert.equal(tierOfEndpoint('GET', 'bogus'), undefined);
  assert.equal(tierOfEndpoint('GET', '/state?x=1'), 'L1');
  assert.equal(tierOfEndpoint('get', '/capabilities/'), 'L0');
});

test('hostModeOf：显式 standalone 标记才认独立模式（缺失字段 = DSH）', () => {
  assert.equal(hostModeOf({ hostMode: 'standalone' }), 'standalone');
  assert.equal(hostModeOf({}), 'dsh');
  assert.equal(hostModeOf({ hostMode: 'anything' }), 'dsh');
});

test('projectCapabilitySet：独立模式的凭证来源是本机文件，不依赖 ctx.credentials', () => {
  const p = projectCapabilitySet({}, 'standalone');
  assert.equal(p.credentials, 'local-file');
  assert.equal(p.llm, false);
  assert.equal(p.sessionEvents, 'http', '有 HTTP 摄入轨');
  const noIngest = projectCapabilitySet({}, 'standalone', false);
  assert.equal(noIngest.sessionEvents, 'none');
});

test('projectCapabilitySet：DSH 模式按槽位在场与否报（不虚报）', () => {
  const empty = projectCapabilitySet({}, 'dsh');
  assert.deepEqual(empty, { llm: false, credentials: 'none', account: false, sessionEvents: 'http' });
  const caps: CapabilitySet = {
    llm: { listProviders: () => [], listModels: async () => [], stream: () => (async function* () {})() },
    credentials: { resolve: async () => undefined },
    account: { getBalance: async () => null },
    sessionEvents: { on: () => () => {} },
  };
  const full = projectCapabilitySet(caps, 'dsh');
  assert.deepEqual(full, { llm: true, credentials: 'dsh', account: true, sessionEvents: 'dsh' });
});

test('capabilitiesFrom：独立模式只认显式注入的 ctx.capabilities（伪 ctx 替身不是能力）', () => {
  // 伪 ctx 的 llm 替身在场，但没 hostMode 标记 → 会被当 DSH 采信；有标记 → 不采信
  const fakeLlm = { listProviders: () => [], listModels: async () => [], stream: () => (async function* () {})() };
  assert.ok(capabilitiesFrom({ llm: fakeLlm }).llm, '无标记时按 DSH 采信（兼容既有 DSH 宿主）');
  const standalone = capabilitiesFrom({ hostMode: 'standalone', llm: fakeLlm });
  assert.equal(standalone.llm, undefined, '独立模式下替身不算能力（报了就是撒谎）');
  const injected = capabilitiesFrom({ hostMode: 'standalone', capabilities: { llm: fakeLlm } });
  assert.ok(injected.llm, 'S6 的显式注入才认');
});

test('capabilityMissing：第三种失败理由，与 unsupported / provider-missing 区分', () => {
  const r = capabilityMissing('llm');
  assert.equal(r.reason, 'capability-missing');
  assert.match(r.message, /llm/);
});

test('CAPABILITY_TIERS：四档都存在且 L3 只含不可逆操作（配置/凭证/停机）', () => {
  assert.deepEqual(Object.keys(CAPABILITY_TIERS), ['L0', 'L1', 'L2', 'L3']);
  assert.ok(CAPABILITY_TIERS.L3.includes('/shutdown'));
  assert.ok(!CAPABILITY_TIERS.L3.includes('/state'), '只读端点不许进 L3');
});
