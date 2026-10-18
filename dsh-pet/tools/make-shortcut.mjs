// 一次性工具：用 Electron 原生 shell.writeShortcutLink 生成 Windows 快捷方式，并立刻读回校验。
// 用法：electron.exe tools/make-shortcut.mjs <输出.lnk> <目标.exe> <参数> <工作目录> <图标> <描述>
// 路径一律用正斜杠（Windows 接受，且不会被 shell 转义吃掉反斜杠）。
//
// 为什么不用 PowerShell 的 WScript.Shell：受限环境里 COM 实例化被安全策略硬禁；
// Electron 的 writeShortcutLink 是原生实现，不经过 COM 脚本接口。
import process from 'node:process';

import { app, shell } from 'electron';

const [out, target, args, cwd, icon, description] = process.argv.slice(2);

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const ok = shell.writeShortcutLink(out, 'create', {
    target,
    args: args || '',
    cwd: cwd || undefined,
    icon: icon || undefined,
    iconIndex: 0,
    description: description || undefined,
  });

  let read;
  try {
    read = shell.readShortcutLink(out);
  } catch (e) {
    read = { error: e instanceof Error ? e.message : String(e) };
  }

  process.stdout.write('RESULT ' + JSON.stringify({ ok, out, wrote: { target, args, cwd, icon }, read }, null, 2) + '\n');
  app.exit(ok ? 0 : 1);
});
