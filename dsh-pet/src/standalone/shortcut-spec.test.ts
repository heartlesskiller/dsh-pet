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

test('首参以 .json 结尾 → JSON 模式（中文走这条路，完全不经过 argv）', () => {
  const src = pickSpecSource(['C:/tmp/spec.json']);
  assert.equal(src.kind, 'json');
  assert.equal(src.kind === 'json' ? src.path : '', 'C:/tmp/spec.json');
  // 大小写不敏感（Windows 上 .JSON 很常见）
  assert.equal(pickSpecSource(['C:/tmp/SPEC.JSON']).kind, 'json');
  assert.equal(pickSpecSource(['C:/tmp/Spec.Json']).kind, 'json');
  // 带空格的也认（复制粘贴常见）
  assert.equal(pickSpecSource(['  C:/tmp/spec.json  ']).kind, 'json');
});

test('没有 --json 这种 flag：按参数形状分流，不靠 flag', () => {
  // `--json` 不是 flag，它只会被当成旧 argv 模式的第一个位置参数（lnk）——
  // 于是得到 lnk='--json'、target='x.json' 这种"结构合法但语义是垃圾"的规格。
  // 这正是**不加 flag** 的取舍：少一个 flag，就少一个"忘了加 → 中文变乱码"的机会；
  // 代价是误用不会被拦住，但 writeShortcutLink 会因路径非法而失败（ok:false）。
  assert.equal(pickSpecSource(['--json', 'x.json']).kind, 'argv');
  assert.equal(pickSpecSource(['--json', 'x.json']).kind === 'json', false, '--json 绝不能触发 JSON 模式');
});

test('其余形态 → 兼容旧 argv 方式', () => {
  const src = pickSpecSource(['a.lnk', 'b.exe']);
  assert.equal(src.kind, 'argv');
  assert.deepEqual(src.kind === 'argv' ? src.argv : [], ['a.lnk', 'b.exe']);
});

// ---------- 校验与归一化 ----------

test('最小规格：lnk + target 必填，args 归一化为空串', () => {
  const r = normalizeSpec({ lnk: 'C:/x/a.lnk', target: 'C:/x/app.exe' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.lnk, 'C:/x/a.lnk');
  assert.equal(r.value.target, 'C:/x/app.exe');
  assert.equal(r.value.args, '', 'args 缺省是空串（不是 undefined —— 下游要用它）');
  assert.equal(r.value.cwd, undefined);
  assert.equal(r.value.icon, undefined);
  assert.equal(r.value.description, undefined);
});

test('中文 description 原样保留（不做任何转码）', () => {
  const r = normalizeSpec({ lnk: 'a.lnk', target: 'b.exe', description: '启动 DSH 桌宠' });
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

test('缺 lnk / 缺 target / 非字符串 → 明确报错（不写半截 .lnk）', () => {
  assert.equal(normalizeSpec({ target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec({ lnk: 'a.lnk' }).ok, false);
  assert.equal(normalizeSpec({ lnk: '   ', target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec({ lnk: 1, target: 'b.exe' }).ok, false);
  assert.equal(normalizeSpec(null).ok, false);
  assert.equal(normalizeSpec('nope').ok, false);
  const r = normalizeSpec({ target: 'b.exe' });
  assert.equal(r.ok === false ? r.message.includes('lnk') : false, true, '错误信息要指出缺哪个字段');
});

test('空串可选字段归一化为 undefined（不往 .lnk 里写空值）', () => {
  const r = normalizeSpec({ lnk: 'a.lnk', target: 'b.exe', cwd: '', icon: '  ', description: '' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.cwd, undefined);
  assert.equal(r.value.icon, undefined);
  assert.equal(r.value.description, undefined);
});

test('args 允许是空串（= 不带参数），不能当"没提供"吃掉', () => {
  const r = normalizeSpec({ lnk: 'a.lnk', target: 'b.exe', args: '' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.args, '');
  assert.equal(typeof r.value.args, 'string');
});

// ---------- 两条来源共用同一套校验（避免两套逻辑漂移） ----------

test('specFromArgv：位置参数按 lnk/target/args/cwd/icon/description 顺序映射', () => {
  const r = specFromArgv(['C:/a.lnk', 'C:/b.exe', '/c foo', 'C:/cwd', 'C:/i.ico', '启动 DSH 桌宠']);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, {
    lnk: 'C:/a.lnk',
    target: 'C:/b.exe',
    args: '/c foo',
    cwd: 'C:/cwd',
    icon: 'C:/i.ico',
    description: '启动 DSH 桌宠',
  });
});

test('specFromArgv：参数不足时与 JSON 方式报同样的错', () => {
  assert.equal(specFromArgv(['C:/a.lnk']).ok, false);
  assert.equal(specFromObject({ lnk: 'C:/a.lnk' }).ok, false);
  const a = specFromArgv(['C:/a.lnk']);
  const b = specFromObject({ lnk: 'C:/a.lnk' });
  assert.equal(a.ok === false && b.ok === false ? a.message === b.message : false, true, '两条来源必须共用校验');
});

test('specFromObject 与 normalizeSpec 等价', () => {
  const raw = { lnk: 'a.lnk', target: 'b.exe', description: '中文' };
  assert.deepEqual(specFromObject(raw), normalizeSpec(raw));
});

test('lnk 的别名 out 仍被接受（向后兼容早期脚本/第一版 fixture）', () => {
  const r = normalizeSpec({ out: 'legacy.lnk', target: 'b.exe' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.lnk, 'legacy.lnk', '别名必须归一化到规范键名 lnk');
});

test('lnk 优先于别名 out（同时给时以 lnk 为准）', () => {
  const r = normalizeSpec({ lnk: 'primary.lnk', out: 'stale.lnk', target: 'b.exe' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.lnk, 'primary.lnk');
});
