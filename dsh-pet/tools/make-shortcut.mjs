/**
 * make-shortcut.mjs —— 用 Electron 原生 shell.writeShortcutLink 生成 Windows 快捷方式，
 * 写完立刻 readShortcutLink 读回校验。
 *
 * ## 为什么改成从 JSON 读（这次修的坑）
 * 旧版从 argv 取值，于是 `description` 里的中文经 PowerShell → native 传参时会被按本地
 * 代码页转换，写进 .lnk 变成「鍚姩 DSH 妗屽疇」（UTF-8 字节被当 GBK 读）。
 * 现在中文只从 **UTF-8 的 JSON 文件** 进，完全不碰 argv。
 *
 * 用法（**走哪条路由看参数形状，不需要 flag**）：
 *   electron.exe tools/make-shortcut.mjs <spec.json>     ← 首参以 .json 结尾 → JSON 模式（中文必须走这个）
 *   electron.exe tools/make-shortcut.mjs <lnk> <target> <args> <cwd> <icon> <desc>   ← 兼容旧脚本
 *   electron.exe tools/make-shortcut.mjs --help
 *
 * 为什么不用 PowerShell 的 WScript.Shell：受限环境里 COM 实例化被安全策略硬禁；
 * Electron 的 writeShortcutLink 是原生实现，不经过 COM 脚本接口。
 *
 * 输出：一行 `RESULT {...}`（`read` 是 readShortcutLink 的读回结果），
 * 退出码 0 = 成功 / 1 = 写入失败 / 2 = 参数或规格有问题。
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { app, shell } from 'electron';

import { pickSpecSource, specFromArgv, specFromObject, USAGE } from './shortcut-spec.mjs';

/** 打印一行机读结果（调用方/校验脚本按 `RESULT ` 前缀抓） */
function emit(payload) {
  process.stdout.write('RESULT ' + JSON.stringify(payload, null, 2) + '\n');
}

app.disableHardwareAcceleration();

const argv = process.argv.slice(2);
const source = pickSpecSource(argv);

if (source.kind === 'help') {
  process.stdout.write(USAGE + '\n');
  app.exit(0);
} else {
  // 先把规格解析出来（纯逻辑，没有 electron 也能单测）
  let parsed;
  if (source.kind === 'error') {
    parsed = { ok: false, message: source.message };
  } else if (source.kind === 'json') {
    try {
      parsed = specFromObject(JSON.parse(readFileSync(source.path, 'utf8')));
    } catch (e) {
      parsed = {
        ok: false,
        message: `读不了 JSON 规格 ${source.path}：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    parsed = specFromArgv(source.argv);
  }

  if (parsed.ok !== true) {
    emit({ ok: false, error: parsed.message, source: source.kind });
    app.exit(2);
  } else {
    const spec = parsed.value;
    app.whenReady().then(() => {
      const ok = shell.writeShortcutLink(spec.lnk, 'create', {
        target: spec.target,
        args: spec.args,
        cwd: spec.cwd,
        icon: spec.icon,
        iconIndex: 0,
        description: spec.description,
      });

      let read;
      try {
        read = shell.readShortcutLink(spec.lnk);
      } catch (e) {
        read = { error: e instanceof Error ? e.message : String(e) };
      }

      emit({ ok, source: source.kind, lnk: spec.lnk, wrote: spec, read });
      app.exit(ok ? 0 : 1);
    });
  }
}
