/**
 * 快捷方式规格解析（`tools/shortcut-spec.mjs`）的单元测试。
 *
 * 这一层钉的是"从哪儿取规格 / 字段合不合法"，**不需要 electron**。
 * 中文编码问题本身由 `pnpm verify:shortcut` 端到端证明（那条必须真跑 electron，
 * 因为它验的正是"值怎么进 writeShortcutLink"），这里只覆盖纯逻辑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeSpec, pickSpecSource, specFromArgv, specFromObject } from '../../tools/shortcut-spec.mjs';

// ---------- 来源判定 ----------

test('无参数 / --help / -h → help', () => {
  assert.equal(pickSpecSource([]).kind, 'help');
  assert.equal(pickSpecSource(['--help']).kind, 'help');
  assert.equal(pickSpecSource(['-h']).kind, 'help');
});

test('--json <path> → json 来源（中文走这条路，不经过 argv）', () => {
  const src = pickSpecSource(['--json', 'C:/tmp/spec.json']);
  assert.equal(src.kind, 'json');
  assert.equal(src.kind === 'json' ? src.path : '', 'C:/tmp/spec.json');
});

test('--json 缺路径 → error（不静默当 help）', () => {
  assert.equal(pickSpecSource(['--json']).kind, 'error');
  assert.equal(pickSpecSource(['--json', '   ']).kind, 'error');
});

test('其余形态 → 兼容旧 argv 方式', () => {
  const src = pickSpecSource(['a.lnk', 'b.exe']);
  assert.equal(src.kind, 'argv');
  assert.deepEqual(src.kind === 'argv' ? src.argv : [], ['a.lnk', 'b.exe']);
});

// ---------- 校验与归一化 ----------

test('最小规格：out + target 必填，args 归一化为空串', () => {
  const r = normalizeSpec({ out: 'C:/x/a.lnk', target: 'C:/x/app.exe' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.out, 'C:/x/a.lnk');
  assert.equal(r.value.target, 'C:/x/app.exe');
  assert.equal(r.value.args, '', 'args 缺省是空串（不是 undefined —— 下游要用它）');
  assert.equal(r.value.cwd, undefined);
  assert.equal(r.value.icon, undefined);
  assert.equal(r.value.description, undefined);
});

test('中文 description 原样保留（不做任何转码）', () => {
  const r = normalizeSpec({ out: 'a.lnk', target: 'b.exe', description: '启动 DSH 桌宠' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.description, '启动 DSH 桌宠');
  assert.equal(
    Array.from(r.value.description ?? '')
      .map((ch) => (ch.codePointAt(0) ?? 0).toString(16))
      .join(' '),
    '542f 52a8 20 44 53 48 20 684c 5ba0',
  );
});

test('缺 out / 缺 target / 非字符串 → 明确报错（不写半截 .lnk）', () => {
  assert.equal(normalizeSpec({ target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec({ out: 'a.lnk' }).ok, false);
  assert.equal(normalizeSpec({ out: '   ', target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec({ out: 1, target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec(null).ok, false);
  assert.equal(normalizeSpec('nope').ok, false);
  const r = normalizeSpec({ target: 'b.exe' });
  assert.equal(r.ok === false ? r.message.includes('out') : false, true, '错误信息要指出缺哪个字段');
});

test('空串可选字段归一化为 undefined（不往 .lnk 里写空值）', () => {
  const r = normalizeSpec({ out: 'a.lnk', target: 'b.exe', cwd: '', icon: '  ', description: '' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.cwd, undefined);
  assert.equal(r.value.icon, undefined);
  assert.equal(r.value.description, undefined);
});

test('args 允许是空串（= 不带参数），不能当"没提供"吃掉', () => {
  const r = normalizeSpec({ out: 'a.lnk', target: 'b.exe', args: '' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.args, '');
  assert.equal(typeof r.value.args, 'string');
});

// ---------- 两条来源共用同一套校验（避免两套逻辑漂移） ----------

test('specFromArgv：位置参数按 out/target/args/cwd/icon/description 顺序映射', () => {
  const r = specFromArgv(['C:/a.lnk', 'C:/b.exe', '/c foo', 'C:/cwd', 'C:/i.ico', '启动 DSH 桌宠']);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, {
    out: 'C:/a.lnk',
    target: 'C:/b.exe',
    args: '/c foo',
    cwd: 'C:/cwd',
    icon: 'C:/i.ico',
    description: '启动 DSH 桌宠',
  });
});

test('specFromArgv：参数不足时与 JSON 方式报同样的错', () => {
  assert.equal(specFromArgv(['C:/a.lnk']).ok, false);
  assert.equal(specFromObject({ out: 'C:/a.lnk' }).ok, false);
  const a = specFromArgv(['C:/a.lnk']);
  const b = specFromObject({ out: 'C:/a.lnk' });
  assert.equal(a.ok === false && b.ok === false ? a.message === b.message : false, true, '两条来源必须共用校验');
});

test('specFromObject 与 normalizeSpec 等价', () => {
  const raw = { out: 'a.lnk', target: 'b.exe', description: '中文' };
  assert.deepEqual(specFromObject(raw), normalizeSpec(raw));
});
