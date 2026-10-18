/**
 * 快捷方式规格解析 —— **纯函数**（无 IO、无 electron、无 argv 读取）。
 *
 * ## 为什么把这一层单独拆出来
 * 原来 `make-shortcut.mjs` 直接从 argv 取值：`description` 里的中文经
 * PowerShell → native 传参会被按本地代码页转换，写进 .lnk 就变成
 * 「鍚姩 DSH 妗屽疇」（UTF-8 字节被当 GBK 读）。这个坑每次重建快捷方式都要踩。
 *
 * 根治办法是**让中文完全不经过 argv**：从 UTF-8 的 JSON 文件读。为了让"读哪种来源、
 * 字段合不合法"能脱离 electron 单测，把判断逻辑全放在这里。
 *
 * 兼容：argv 旧用法保留（老命令不炸），但不建议传中文。
 */

/** `--help` 输出。中文明确指路到 JSON 方式。 */
export const USAGE = `make-shortcut.mjs —— 生成 Windows 快捷方式（Electron 原生 shell.writeShortcutLink）

用法一（推荐，中文必须走这个）：
  electron.exe tools/make-shortcut.mjs --json <spec.json>

   spec.json（UTF-8）字段：
     { "out": "C:/path/foo.lnk",      // 必填：要生成的 .lnk
       "target": "C:/path/app.exe",   // 必填：快捷方式指向的目标
       "args": "",                     // 可选：命令行参数
       "cwd": "C:/path",              // 可选：起始目录
       "icon": "C:/path/icon.ico",    // 可选：图标
       "description": "启动 DSH 桌宠"  // 可选：备注（中文请只在这里写）
     }

用法二（兼容旧脚本；**中文会变 mojibake，别用**）：
  electron.exe tools/make-shortcut.mjs <out.lnk> <target> <args> <cwd> <icon> <description>

路径一律用正斜杠（Windows 接受，且不会被 shell 转义吃掉反斜杠）。
成功后打印一行 RESULT {...}，其中 read 是 readShortcutLink 的读回结果。
`;

/**
 * 决定这次调用从哪儿取规格。
 * @param {string[]} argv 不含 node/electron 自身参数的 argv
 * @returns {{kind:'help'} | {kind:'error', message:string} | {kind:'json', path:string} | {kind:'argv', argv:string[]}}
 */
export function pickSpecSource(argv) {
  const list = Array.isArray(argv) ? argv : [];
  if (list.length === 0) return { kind: 'help' };
  const head = list[0];
  if (head === '--help' || head === '-h') return { kind: 'help' };
  if (head === '--json') {
    const path = list[1];
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { kind: 'error', message: '--json 后面要给一个 JSON 规格文件的路径' };
    }
    return { kind: 'json', path };
  }
  return { kind: 'argv', argv: list };
}

/**
 * 校验 + 归一化一份规格（JSON 与 argv 两条来源共用，避免两套校验漂移）。
 * @param {unknown} raw
 * @returns {{ok:true, value:{out:string,target:string,args:string,cwd?:string,icon?:string,description?:string}} | {ok:false, message:string}}
 */
export function normalizeSpec(raw) {
  const obj = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const optional = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : undefined);

  const out = text(obj.out);
  const target = text(obj.target);
  if (out.length === 0) return { ok: false, message: '缺少 out：要生成的 .lnk 路径' };
  if (target.length === 0) return { ok: false, message: '缺少 target：快捷方式指向的目标' };

  return {
    ok: true,
    value: {
      out,
      target,
      // args 允许是空串（= 不带参数），不能当"没提供"处理
      args: typeof obj.args === 'string' ? obj.args : '',
      cwd: optional(obj.cwd),
      icon: optional(obj.icon),
      description: optional(obj.description),
    },
  };
}

/** 旧用法：<out> <target> <args> <cwd> <icon> <description> */
export function specFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const [out, target, args, cwd, icon, description] = list;
  return normalizeSpec({ out, target, args, cwd, icon, description });
}

/** 新用法：JSON 对象（字段同名） */
export function specFromObject(obj) {
  return normalizeSpec(obj);
}
