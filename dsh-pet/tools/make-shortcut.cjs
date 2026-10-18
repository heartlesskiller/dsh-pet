// 一次性工具：用 Electron 原生 shell.writeShortcutLink 生成 Windows 快捷方式，并立刻读回校验。
// 用法：electron.exe tools/make-shortcut.cjs <输出.lnk> <目标.exe> <参数> <工作目录> <图标> <描述>
// 路径一律用正斜杠（Windows 接受，且不会被 shell 转义吃掉反斜杠）。
'use strict';
const { app, shell } = require('electron');

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

  let read = null;
  try {
    read = shell.readShortcutLink(out);
  } catch (e) {
    read = { error: String(e && e.message ? e.message : e) };
  }

  process.stdout.write(
    'RESULT ' +
      JSON.stringify({ ok, out, wrote: { target, args, cwd, icon }, read }, null, 2) +
      '\n',
  );
  app.exit(ok ? 0 : 1);
});
