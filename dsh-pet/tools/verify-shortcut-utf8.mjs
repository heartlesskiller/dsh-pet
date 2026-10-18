#!/usr/bin/env node
/**
 * verify-shortcut-utf8.mjs —— **可重复运行**的中文快捷方式校验（不再靠一次性脚本）。
 *
 * 它证明的是这条不变式：**中文 description 经 JSON 进、写进 .lnk、再读回来，逐码点一致**
 * （不是"看起来对"）。这正是当初 argv 传中文变「鍚姩 DSH 妗屽疇」的那个坑。
 *
 * 做法：
 *   1. 读 `tools/fixtures/shortcut-zh.spec.json`（UTF-8，含中文），把 out 改到临时目录
 *   2. 用 electron 跑 `make-shortcut.mjs <临时 spec>`（首参是 .json 即 JSON 模式）
 *   3. 抓 stdout 里的 `RESULT {...}`，取 `read.description`
 *   4. 把 description 拆成码点与期望值逐字比对
 *
 * 注意：子进程输出**按 Buffer 收再 toString('utf8')** —— 走控制台编码就白测了，
 * 这正是要绕开的那层。
 *
 * 用法：node tools/verify-shortcut-utf8.mjs
 * 退出码：0 = 一致；1 = 不一致或运行失败。
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** tools/ 的 eslint 配置没有 console 全局 —— 统一走 stream（与 make-shortcut.mjs 一致） */
const say = (...parts) => process.stdout.write(parts.join(' ') + '\n');
const yell = (...parts) => process.stderr.write(parts.join(' ') + '\n');
const FIXTURE = join(HERE, 'fixtures', 'shortcut-zh.spec.json');
/** 期望的中文备注（与 fixture 保持一致；两边都改才算改） */
const EXPECTED_DESCRIPTION = '启动 DSH 桌宠';

/** electron 可执行文件：环境变量优先，否则用插件的落地路径 */
function resolveElectron() {
  const fromEnv = process.env.DSH_PET_ELECTRON_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const landed = join(home, '.dsh', 'electron', 'electron.exe');
  if (existsSync(landed)) return landed;
  return null;
}

/** 跑一次 electron 子进程，返回 stdout 文本（Buffer → utf8，绕开控制台编码） */
function runElectron(exe, scriptPath, extraArgs) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    // ELECTRON_RUN_AS_NODE 存在时 electron 会当 node 跑，windows 上还会直接 abort
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [scriptPath, ...extraArgs], { env, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** 从 stdout 里取出 `RESULT {...}` 那段 JSON */
function parseResult(stdout) {
  const start = stdout.indexOf('RESULT ');
  if (start < 0) return null;
  const jsonText = stdout.slice(start + 'RESULT '.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

const codepoints = (text) =>
  Array.from(String(text ?? ''))
    .map((ch) => ch.codePointAt(0).toString(16))
    .join(' ');

/**
 * 要验的两种 .lnk 文件名：
 *   ascii —— 常规名字
 *   cjk   —— **多字节文件名**（"启动 DSH 桌宠_测试.lnk"）：写/读 .lnk 的路径本身也要能
 *            处理中文，只验 description 字段不够 —— 路径里的中文走的是另一条系统调用。
 */
const CASES = [
  { name: 'ascii', fileName: 'utf8-check.lnk' },
  { name: 'cjk', fileName: '启动 DSH 桌宠_测试.lnk' },
];

/** 跑一个用例；返回 { ok, lines } */
async function runCase(exe, dir, testCase) {
  const outLnk = join(dir, testCase.fileName);
  const specPath = join(dir, `spec-${testCase.name}.json`);
  const lines = [];

  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  spec.lnk = outLnk;
  writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

  // 首参以 .json 结尾 → make-shortcut 自动走 JSON 模式（不需要 flag）
  const run = await runElectron(exe, resolve(HERE, 'make-shortcut.mjs'), [specPath]);
  const result = parseResult(run.stdout);
  if (result === null) {
    lines.push(`  [${testCase.name}] 没拿到 RESULT；stdout=${JSON.stringify(run.stdout.slice(0, 400))} stderr=${JSON.stringify(run.stderr.slice(0, 400))}`);
    return { ok: false, lines };
  }

  const actual = result?.read?.description;
  const actualCp = codepoints(actual);
  const expectedCp = codepoints(EXPECTED_DESCRIPTION);
  // 防「假绿」：两边都空串也会相等 —— 必须先断言期望值非空、实际值非空
  const expectedNotEmpty = expectedCp.length > 0;
  const actualNotEmpty = actualCp.length > 0;
  const same = expectedNotEmpty && actualNotEmpty && actualCp === expectedCp;

  lines.push(`  [${testCase.name}] lnk      = ${result.lnk}`);
  lines.push(`  [${testCase.name}] target   = ${result?.read?.target}`);
  lines.push(`  [${testCase.name}] exitCode = ${run.code}`);
  lines.push(`  [${testCase.name}] actual   = ${JSON.stringify(actual)}`);
  lines.push(`  [${testCase.name}] actual   cps = ${actualCp || '(空串 —— 假绿！)'}`);
  lines.push(`  [${testCase.name}] expected cps = ${expectedCp || '(空串 —— 期望值本身坏了)'}`);
  lines.push(`  [${testCase.name}] ${same ? 'PASS' : 'FAIL'}（期望非空=${expectedNotEmpty} 实际非空=${actualNotEmpty} 码点一致=${actualCp === expectedCp}）`);
  return { ok: same && run.code === 0, lines };
}

async function main() {
  const exe = resolveElectron();
  if (exe === null) {
    yell('[verify-shortcut] 找不到 electron：设 DSH_PET_ELECTRON_PATH，或先跑 pnpm ensure:electron');
    return 1;
  }
  if (!existsSync(FIXTURE)) {
    yell(`[verify-shortcut] 缺少 fixture：${FIXTURE}`);
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), 'shortcut-utf8-'));
  try {
    let allOk = true;
    for (const testCase of CASES) {
      const r = await runCase(exe, dir, testCase);
      for (const line of r.lines) say(line);
      if (!r.ok) allOk = false;
    }
    say(allOk ? '[verify-shortcut] ALL PASS —— 两种文件名下中文都逐码点一致' : '[verify-shortcut] FAIL');
    return allOk ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    yell('[verify-shortcut] 异常：', e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
