import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { containsSecret, maskHeaders, maskSecret } from './redact.ts';
import {
  CREDENTIALS_FILE,
  FOCUS_FILE,
  MODELS_FILE,
  SITES_FILE,
  clearCredential,
  clearFocus,
  getCredential,
  listDataFiles,
  loadCredentials,
  loadSites,
  putCredential,
  readFocus,
  readModelCache,
  removeSite,
  saveSites,
  setSiteModels,
  siteViews,
  toSiteView,
  upsertSite,
  validateSiteInput,
  writeFocus,
} from './store.ts';
import type { RelaySite } from './types.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'relay-store-'));
}

const SECRET = 'sk-abcdef1234567890wxyz';

function seed(dir: string, over: { name?: string } = {}): RelaySite {
  return upsertSite(dir, { name: over.name ?? 'A鱼站', url: 'https://a.example.com/v1', kind: 'new-api' });
}

test('loadSites：目录不存在 → 空列表（不炸）', () => {
  assert.deepEqual(loadSites(join(tmp(), 'nope')), []);
});

test('upsertSite：新建 + 读回往返，URL 归一化（去 /v1 与尾斜杠）', () => {
  const dir = tmp();
  const s = seed(dir);
  assert.ok(s.id.length > 0, '必须生成 id');
  assert.equal(s.url, 'https://a.example.com');
  assert.equal(s.quotaPerUnit, 500_000, '没配换算率就显式写默认值');
  assert.equal(s.rateConfirmed, false, '修订 #11：建站即标记「换算率未确认」，绝不静默默认');
  assert.equal(s.enabled, true);

  const back = loadSites(dir);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], s);
});

test('upsertSite：同 id 更新，保留 createdAt；不同字段可分别改', () => {
  const dir = tmp();
  const s = seed(dir);
  const u = upsertSite(dir, { id: s.id, name: '改名了', url: 'https://a.example.com', kind: 'new-api', quotaPerUnit: 250_000 });
  assert.equal(u.id, s.id);
  assert.equal(u.createdAt, s.createdAt, 'createdAt 必须保留');
  assert.equal(u.name, '改名了');
  assert.equal(u.quotaPerUnit, 250_000);
  assert.equal(u.rateConfirmed, false, '换算率改了但没确认 → 仍未确认（要重新核对）');
  assert.equal(loadSites(dir).length, 1, '不能更新出第二条');
});

test('upsertSite：修订 #11 —— 换算率确认状态可显式写入与更新（不传则保留原值）', () => {
  const dir = tmp();
  const s = seed(dir);
  assert.equal(s.rateConfirmed, false);
  // 显式确认（探测到 quota_per_unit 或用户核对过）
  const confirmed = upsertSite(dir, { id: s.id, name: s.name, url: s.url, kind: 'new-api', rateConfirmed: true });
  assert.equal(confirmed.rateConfirmed, true);
  // 更新别的字段时不动确认状态
  const renamed = upsertSite(dir, { id: s.id, name: 'X', url: s.url, kind: 'new-api' });
  assert.equal(renamed.rateConfirmed, true, '没传就保留原值');
  // 也可以显式改回未确认
  const back = upsertSite(dir, { id: s.id, name: 'X', url: s.url, kind: 'new-api', rateConfirmed: false });
  assert.equal(back.rateConfirmed, false);
});

test('validateSiteInput：非法入参一律 throw，不落脏数据', () => {
  assert.throws(() => validateSiteInput({ name: '', url: 'https://a.com', kind: 'new-api' }), /名称必填/);
  assert.throws(() => validateSiteInput({ name: 'x', url: 'https://a.com', kind: 'bogus' as never }), /未知站点类型/);
  assert.throws(() => validateSiteInput({ name: 'x', url: 'a.com', kind: 'new-api' }), /http/);
  assert.throws(() => validateSiteInput({ name: 'x', url: 'https://a.com', kind: 'new-api', quotaPerUnit: 0 }), /quotaPerUnit/);
  assert.throws(() => validateSiteInput({ name: 'x', url: 'https://a.com', kind: 'new-api', quotaPerUnit: -1 }), /quotaPerUnit/);
  assert.throws(() => validateSiteInput({ name: 'x', url: 'https://a.com', kind: 'new-api', rateConfirmed: 'yes' as never }), /rateConfirmed/);
  // 站点文件确实没被写坏
  const dir = tmp();
  assert.throws(() => upsertSite(dir, { name: '', url: 'https://a.com', kind: 'new-api' }));
  assert.deepEqual(loadSites(dir), []);
});

test('manualBalance：更新时打上填写时间；不传则保留原值', () => {
  const dir = tmp();
  const s = upsertSite(dir, {
    name: '手填站', url: 'https://b.example.com', kind: 'new-api',
    manualBalance: { amount: '3.02', currency: 'USD' },
  });
  assert.ok(s.manualBalance?.updatedAt, '手工值必须带时间');

  const u = upsertSite(dir, { id: s.id, name: '手填站', url: 'https://b.example.com', kind: 'new-api' });
  assert.deepEqual(u.manualBalance, s.manualBalance, '不传就不能抹掉用户手填的值');
});

test('凭证：写入 / 读取 / 清除往返', () => {
  const dir = tmp();
  const s = seed(dir);
  putCredential(dir, s.id, { kind: 'access-token', secret: SECRET });
  assert.equal(getCredential(dir, s.id)?.secret, SECRET);
  clearCredential(dir, s.id);
  assert.equal(getCredential(dir, s.id), undefined);
});

test('removeSite：删站点的同时删凭证（不留孤儿密钥）', () => {
  const dir = tmp();
  const s = seed(dir);
  putCredential(dir, s.id, { kind: 'access-token', secret: SECRET });
  const left = removeSite(dir, s.id);
  assert.equal(left.length, 0);
  assert.equal(getCredential(dir, s.id), undefined, '凭证必须跟着删');
  assert.deepEqual(Object.keys(loadCredentials(dir)), []);
});

test('站点文件里没有任何密钥字段', () => {
  const dir = tmp();
  const s = seed(dir);
  putCredential(dir, s.id, { kind: 'access-token', secret: SECRET });
  const sitesText = readFileSync(join(dir, SITES_FILE), 'utf8');
  assert.ok(!containsSecret(sitesText, [SECRET]), 'relays.json 不得含凭证');
  const credsText = readFileSync(join(dir, CREDENTIALS_FILE), 'utf8');
  assert.ok(containsSecret(credsText, [SECRET]), '凭证只准出现在凭证文件');
});

test('toSiteView：凭证只以掩码出现，响应体序列化后不含明文', () => {
  const dir = tmp();
  const s = seed(dir);
  const uid = '1234567'; // 7 位 ≤ 8 → 全掩（保留头尾会泄过多信息）
  const view = toSiteView(s, { kind: 'access-token', secret: SECRET, extraHeaders: { 'New-Api-User': uid } });
  assert.equal(view.credential.masked, 'sk-a****wxyz');
  assert.equal(view.credential.present, true);
  assert.equal(view.credential.extraHeaders?.['New-Api-User'], '*******', '头值必须掩码');

  const json = JSON.stringify(siteViews(dir));
  assert.ok(!containsSecret(json, [SECRET, uid]), '对外 JSON 不得泄露凭证或附加头原值');
});

test('toSiteView：没有凭证 → present=false、掩码为空串（不用 **** 冒充有凭证）', () => {
  const s = seed(tmp());
  const view = toSiteView(s, undefined);
  assert.equal(view.credential.present, false);
  assert.equal(view.credential.masked, '');
  assert.equal(view.credential.kind, 'manual');
});

test('siteViews：按名称排序，结果稳定', () => {
  const dir = tmp();
  upsertSite(dir, { name: 'C站', url: 'https://c.example.com', kind: 'new-api' });
  upsertSite(dir, { name: 'A站', url: 'https://a.example.com', kind: 'new-api' });
  upsertSite(dir, { name: 'B站', url: 'https://b.example.com', kind: 'new-api' });
  assert.deepEqual(siteViews(dir).map((v) => v.name), ['A站', 'B站', 'C站']);
});

test('损坏的 relays.json：改名留存为 .corrupt-* 并抛错，不静默丢数据', () => {
  const dir = tmp();
  writeFileSync(join(dir, SITES_FILE), '{ this is not json', 'utf8');
  assert.throws(() => loadSites(dir), /损坏/);
  const files = listDataFiles(dir);
  assert.ok(files.some((f) => f.startsWith(SITES_FILE + '.corrupt-')), '坏文件必须留存：' + files.join(','));
});

test('原子写：不残留 .tmp 文件', () => {
  const dir = tmp();
  seed(dir);
  putCredential(dir, 'x', { kind: 'api-key', secret: SECRET });
  const files = listDataFiles(dir);
  assert.deepEqual(files, [CREDENTIALS_FILE, SITES_FILE].sort());
});

test('saveSites：直接写整表也能被读回', () => {
  const dir = tmp();
  const s = seed(dir);
  saveSites(dir, [{ ...s, name: '改过的' }]);
  assert.equal(loadSites(dir)[0].name, '改过的');
});

// ---------- 脱敏单元 ----------

test('maskSecret：保留头尾，短凭证全掩，空值空串', () => {
  assert.equal(maskSecret(SECRET), 'sk-a****wxyz');
  assert.equal(maskSecret('12345678'), '********');
  assert.equal(maskSecret('short'), '*****');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(undefined), '');
  assert.equal(maskSecret(null), '');
});

test('maskHeaders：键保留、值按 maskSecret 规则掩（短值全掩，长值留头尾）', () => {
  assert.deepEqual(maskHeaders({ 'New-Api-User': '42', Authorization: 'Bearer abc' }), {
    'New-Api-User': '**',
    Authorization: 'Bear**** abc',
  });
  assert.deepEqual(maskHeaders(undefined), {});
});

test('containsSecret：短密钥不参与匹配（避免误报）', () => {
  assert.equal(containsSecret('hello sk-abcdef1234567890wxyz', [SECRET]), true);
  assert.equal(containsSecret('hello', ['abc']), false);
  assert.equal(containsSecret('hello', [undefined as never]), false);
});

// ---------- 焦点站点（T03） ----------

test('focus：写入 / 读取 / 清除往返；缺目录不炸', () => {
  const dir = tmp();
  try {
    assert.equal(readFocus(dir), undefined, '没有 focus.json → 无焦点');
    const s = seed(dir);
    writeFocus(dir, s.id);
    assert.equal(readFocus(dir), s.id);
    clearFocus(dir);
    assert.equal(readFocus(dir), undefined, '清除后回到全舰队口径');
    clearFocus(dir); // 幂等：再清一次不炸
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus：损坏的 focus.json → undefined（派生数据可重新设，不抛错）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, FOCUS_FILE), 'not-json', 'utf8');
    assert.equal(readFocus(dir), undefined);
    // 且能直接覆盖写回去
    const s = seed(dir);
    writeFocus(dir, s.id);
    assert.equal(readFocus(dir), s.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 模型清单缓存（T03） ----------

test('models 缓存：按站写入 / 读回 / 覆盖； fetchedAt 带上', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readModelCache(dir), {}, '没有缓存文件 → 空缓存');
    const a = seed(dir, { name: 'A' });
    const b = upsertSite(dir, { name: 'B', url: 'https://b.example.com', kind: 'new-api' });
    setSiteModels(dir, a.id, [{ id: 'gpt-4o', ratio: 0.5 }]);
    setSiteModels(dir, b.id, [{ id: 'claude-3' }]);
    const cache = readModelCache(dir);
    assert.deepEqual(cache[a.id].models, [{ id: 'gpt-4o', ratio: 0.5 }]);
    assert.deepEqual(cache[b.id].models, [{ id: 'claude-3' }]);
    assert.ok(cache[a.id].fetchedAt.length > 0, '抓取时间要记');
    // 覆盖写入（重新抓取）只换该站条目
    setSiteModels(dir, a.id, [{ id: 'gpt-4o-mini' }]);
    const after = readModelCache(dir);
    assert.deepEqual(after[a.id].models, [{ id: 'gpt-4o-mini' }]);
    assert.deepEqual(after[b.id].models, [{ id: 'claude-3' }], '不该动别的站');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('models 缓存：损坏的 models.json → 空缓存（可重新抓，不抛错）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, MODELS_FILE), '{ broken', 'utf8');
    assert.deepEqual(readModelCache(dir), {});
    setSiteModels(dir, 'x', [{ id: 'm' }]);
    assert.deepEqual(readModelCache(dir)['x'].models, [{ id: 'm' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
