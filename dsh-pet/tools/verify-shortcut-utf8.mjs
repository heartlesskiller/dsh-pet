#!/usr/bin/env node
/**
 * verify-shortcut-utf8.mjs —— **可重复运行**的中文快捷方式校验（不再靠一次性脚本）。
 *
 * 它证明的是这条不变式：**中文 description 经 JSON 进、写进 .lnk、再读回来，逐码点一致**
 * （不是"看起来对"）。这正是当初 argv 传中文变「鍚姩 DSH 妗屽疇」的那个坑。
 *
 * 做法：
 *   1. 读 `tools/fixtures/shortcut-zh.spec.json`（UTF-8，含中文），把 out 改到临时目录
 *   2. 用 electron 跑 `make-shortcut.mjs --json <临时 spec>`
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
  const outLnk = join(dir, 'utf8-check.lnk');
  const specPath = join(dir, 'spec.json');
  try {
    const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    spec.out = outLnk;
    writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const run = await runElectron(exe, resolve(HERE, 'make-shortcut.mjs'), ['--json', specPath]);
    const result = parseResult(run.stdout);
    if (result === null) {
      yell('[verify-shortcut] 没拿到 RESULT，stdout/stderr：');
      yell(run.stdout);
      yell(run.stderr);
      return 1;
    }

    const actual = result?.read?.description;
    const actualCp = codepoints(actual);
    const expectedCp = codepoints(EXPECTED_DESCRIPTION);
    const same = actualCp === expectedCp;

    say('[verify-shortcut] source        =', result.source);
    say('[verify-shortcut] exitCode      =', run.code);
    say('[verify-shortcut] target        =', result?.read?.target);
    say('[verify-shortcut] description   =', JSON.stringify(actual));
    say('[verify-shortcut] actual   cps  =', actualCp);
    say('[verify-shortcut] expected cps  =', expectedCp);
    say(same ? '[verify-shortcut] PASS —— 中文逐码点一致' : '[verify-shortcut] FAIL —— 码点不一致');
    return same && run.code === 0 ? 0 : 1;
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
