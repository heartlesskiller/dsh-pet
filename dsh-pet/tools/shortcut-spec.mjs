/**
 * 快捷方式规格解析 —— **纯函数**（无 IO、无 electron、无 argv 读取）。
 *
 * ## 为什么把这一层单独拆出来
 * 原来 `make-shortcut.mjs` 直接从 argv 取值：`description` 里的中文经 shell → native
 * 传参会被按本地代码页转换，写进 .lnk 就变成「鍚姩 DSH 妗屽疇」（UTF-8 字节被当 GBK 读）。
 * 这个坑每次重建快捷方式都要踩。
 *
 * 根治办法是**让中文完全不经过 argv**：从 UTF-8 的 JSON 文件读。为了让"走哪种模式、
 * 字段合不合法"能脱离 electron 单测，把判断逻辑全放在这里。
 *
 * ## 走哪条路由**看参数形状**，不靠 flag
 * `argv[0]` 以 `.json` 结尾（大小写不敏感）→ JSON 模式；否则按旧的 6 个位置参数解释。
 * 为什么不加 `--json`：多一个 flag 就多一个「忘了加 flag 然后中文变乱码」的机会，
 * 而按形状分流是自明的，旧命令一行不改也照跑。
 */

/** `--help` 输出。中文明确指路到 JSON 方式。 */
export const USAGE = `make-shortcut.mjs —— 生成 Windows 快捷方式（Electron 原生 shell.writeShortcutLink）

用法一（推荐，**中文必须走这个**）：
  electron.exe tools/make-shortcut.mjs <spec.json>

   spec.json（UTF-8）字段（键名与下面位置参数一一对应，便于互查）：
     { "lnk": "C:/path/foo.lnk",       // 必填：要生成的 .lnk
       "target": "C:/path/app.exe",    // 必填：快捷方式指向的目标
       "args": "",                      // 可选：命令行参数
       "cwd": "C:/path",               // 可选：起始目录
       "icon": "C:/path/icon.ico",     // 可选：图标
       "description": "启动 DSH 桌宠"   // 可选：备注（中文请只写在这里）
     }
   （"lnk" 也接受别名 "out"，向后兼容早期脚本。）

用法二（兼容旧脚本；**中文经 argv 会变 mojibake，别用**）：
  electron.exe tools/make-shortcut.mjs <lnk> <target> <args> <cwd> <icon> <description>

路径一律用正斜杠（Windows 接受，且不会被 shell 转义吃掉反斜杠）。
成功后打印一行 RESULT {...}，其中 read 是 readShortcutLink 的读回结果。
退出码：0 成功 / 1 写入失败 / 2 参数或规格有问题。
`;

/** 首参是不是一个 `.json` 规格文件（只看形状，大小写不敏感） */
export function isJsonSpecPath(value) {
  return typeof value === 'string' && /\.json$/i.test(value.trim());
}

/**
 * 决定这次调用走哪条路。
 * @param {string[]} argv 不含 node/electron 自身参数的 argv
 * @returns {{kind:'help'} | {kind:'error', message:string} | {kind:'json', path:string} | {kind:'argv', argv:string[]}}
 */
export function pickSpecSource(argv) {
  const list = Array.isArray(argv) ? argv : [];
  if (list.length === 0) return { kind: 'help' };
  const head = list[0];
  if (head === '--help' || head === '-h') return { kind: 'help' };
  if (isJsonSpecPath(head)) return { kind: 'json', path: head.trim() };
  return { kind: 'argv', argv: list };
}

/**
 * 校验 + 归一化一份规格（JSON 与 argv 两条来源共用，避免两套校验漂移）。
 * @param {unknown} raw
 * @returns {{ok:true, value:{lnk:string,target:string,args:string,cwd?:string,icon?:string,description?:string}} | {ok:false, message:string}}
 */
export function normalizeSpec(raw) {
  const obj = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const optional = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : undefined);

  // 规范键是 `lnk`；`out` 作为别名接受（早期脚本/我第一版 fixture 用的是 out）
  const lnk = text(obj.lnk) || text(obj.out);
  const target = text(obj.target);
  if (lnk.length === 0) return { ok: false, message: '缺少 lnk：要生成的 .lnk 路径' };
  if (target.length === 0) return { ok: false, message: '缺少 target：快捷方式指向的目标' };

  return {
    ok: true,
    value: {
      lnk,
      target,
      // args 允许是空串（= 不带参数），不能当"没提供"处理
      args: typeof obj.args === 'string' ? obj.args : '',
      cwd: optional(obj.cwd),
      icon: optional(obj.icon),
      description: optional(obj.description),
    },
  };
}

/** 旧用法：<lnk> <target> <args> <cwd> <icon> <description> */
export function specFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const [lnk, target, args, cwd, icon, description] = list;
  return normalizeSpec({ lnk, target, args, cwd, icon, description });
}

/** 新用法：JSON 对象（字段同名） */
export function specFromObject(obj) {
  return normalizeSpec(obj);
}
