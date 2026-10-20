/**
 * 静态守卫：桌面壳里调用类方法**必须带 `this.`**
 *
 * ## 为什么需要这条
 * 真实事故（`0ee6353`）：`onContextMenu` 里写成了裸调用 `displayBranchForMode(),`。
 * 类方法挂在 `PetSprite.prototype` 上，**不是词法作用域里的名字**，所以每次右键都抛
 *   Uncaught ReferenceError: displayBranchForMode is not defined
 * 菜单树在挂载之前就中断 —— 用户看到的是「右键点桌宠没有任何反应」，而且渲染端异常
 * **不会进 launcher.log**，排查成本极高。
 *
 * 这类漏写没有任何类型检查能拦住（`runtime/` 是不经过 TS 构建的纯 JS），
 * 所以只能靠静态扫描兜住。
 *
 * 扫描规则（故意保守，宁可漏报也不误报）：
 *   1. 用「缩进恰为 2 空格的方法声明」收集类方法名（本文件只有一个类 PetSprite）；
 *   2. 逐行找「标识符后紧跟 `(`」，排除 `x.foo(`（属性访问）、`function foo(` / `new Foo(`（声明）；
 *   3. 扫描前剔掉行注释、跳过整行注释 —— 注释里写 `position()`、`relayout()` 是正常说明。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPRITE = join(HERE, '..', '..', 'runtime', 'electron-helper', 'sprite.js');

/** 类方法声明：缩进恰为 2 个空格（类体一级） */
const METHOD_DECL = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\([^)]*\)\s*\{/;
/** 任意缩进的方法/函数定义行（对象字面量里的简写方法等），用于排除误报 */
const ANY_DEFINITION = /^\s*(?:async\s+)?(?:get\s+|set\s+|static\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/;

/** 去掉行注释（`//` 之后），但不动字符串里的 `//`（简化处理：只处理明显不在字符串里的情况） */
function stripLineComment(line) {
  let inString = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** 收集类方法名 */
export function collectMethodNames(source) {
  const names = new Set();
  for (const line of source.split('\n')) {
    const m = METHOD_DECL.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * 找出裸调用类方法的行。
 * @returns {Array<{line:number, name:string, text:string}>}
 */
export function findBareMethodCalls(source) {
  const methods = collectMethodNames(source);
  const hits = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // 整行注释 / 块注释续行：跳过
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 方法/函数定义行：跳过（那是在"声明"，不是在"调用"）
    if (ANY_DEFINITION.test(raw)) continue;

    const code = stripLineComment(raw);
    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const [, before, name] = m;
      if (!methods.has(name)) continue;
      // `function foo(` / `new Foo(` 是声明或构造，不是裸调用
      if (/\bfunction\s+$/.test(before) || /\bnew\s+$/.test(before)) continue;
      hits.push({ line: i + 1, name, text: trimmed.slice(0, 100) });
    }
  }
  return hits;
}

test('sprite.js 里没有裸调用类方法（必须 this.method()）', () => {
  const source = readFileSync(SPRITE, 'utf8');
  const methods = collectMethodNames(source);
  assert.ok(methods.size > 20, `类方法应收集到 20+ 个，实际 ${methods.size} —— 收集规则可能失效了`);

  const hits = findBareMethodCalls(source);
  const detail = hits.map((h) => `  sprite.js:${h.line} 方法名=${h.name} → ${h.text}`).join('\n');
  assert.equal(
    hits.length,
    0,
    `发现 ${hits.length} 处裸调用类方法：\n${detail}\n` +
      '类方法必须用 this.method() 调用，裸调用会抛 ReferenceError，整个右键菜单会静默失效。',
  );
});

test('关键回归点：onContextMenu 必须用 this.displayBranchForMode()', () => {
  // 这条是 0ee6353 那个事故的直接锚点，单独钉一次（只做汇总断言不够醒目）
  const source = readFileSync(SPRITE, 'utf8');
  assert.ok(
    /this\.displayBranchForMode\(\)/.test(source),
    'onContextMenu 里必须用 this.displayBranchForMode()（裸调用会让右键菜单完全弹不出来）',
  );
});
