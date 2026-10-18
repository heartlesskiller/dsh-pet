/**
 * 启动失败分类 —— **纯函数**（无 IO、无时钟、无进程操作）。
 *
 * 为什么单独一份：`launch-pet.mjs` 要能说清"为什么没起来"，但它本身是一串
 * spawn/await，没法单测。把"从一段输出里判断原因"抽成纯函数，就能用测试钉住
 * 每种失败的人话（而不是等用户报"双击没反应"再去猜）。
 *
 * 判定依据是**服务自己的输出原文**（不是猜）：
 *   - `已有实例在运行`      ← src/standalone/instance-lock.ts（单实例锁拒绝）
 *   - `端口 N 已被占用`     ← src/standalone/server.ts（EADDRINUSE）
 *   - `desktop pet unavailable` / `cannot resolve Electron executable`
 *                          ← src/host/helper-process.ts（Electron 缺失/下载失败）
 *
 * 收尾原则：**拿不准就归 unknown，并附上输出里最像错误的那一行** —— 绝不编一个
 * 看起来很像的原因。
 */

/** 每种原因对应的人话：title = 发生了什么，hint = 该怎么办 */
const HINTS = {
  'not-built': {
    title: '没找到构建产物 lib/standalone.js',
    hint: '先在插件目录跑一次 pnpm bundle（或 pnpm install），再双击。',
  },
  'already-running': {
    title: '桌宠已经在运行了',
    hint: '桌面上应该已经有一只；要管理站点请双击「中转站管理」，要重启请先双击「关闭桌宠」。',
  },
  'port-busy': {
    title: '端口被占用',
    hint: '别的程序占着这个端口。关掉它，或设环境变量 DSH_PET_PORT 换一个端口后再启动。',
  },
  'electron-missing': {
    title: '服务起来了，但桌宠窗口没能创建（Electron 缺失或下载失败）',
    hint: '检查网络，或把 DSH_PET_ELECTRON_PATH 指向一个已有的 electron.exe 后重启。',
  },
  'electron-downloading': {
    title: 'Electron 运行时不在本机，服务正在后台下载（期间不会出现桌宠窗口）',
    hint: '首次启动要下 ~100MB，下完重启一次即可；不想等就设 DSH_PET_ELECTRON_PATH 指向已有的 electron.exe。',
  },
  timeout: {
    title: '30 秒内没起来',
    hint: '多半是端口被占或数据目录没有写权限；看日志最后几行。',
  },
  unknown: {
    title: '启动失败',
    hint: '看日志里的最后几行。',
  },
};

/** 从输出里挑一行最像错误的（unknown 兜底用；挑不到就返回空串） */
export function firstErrorLine(output) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // 倒着找：最后一条错误通常最接近真实原因；优先带 Error/error/失败 的行
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/error|失败|fatal|exception/i.test(lines[i])) return lines[i];
  }
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * 判断启动失败的原因。
 * @param {{ output?: string, port?: number }} input 子进程输出原文 + 端口
 * @returns {{ reason: string, title: string, hint: string, detail: string }}
 */
export function classifyLaunchFailure(input = {}) {
  const text = String(input.output ?? '');
  const port = Number.isFinite(input.port) ? input.port : 3080;

  let reason = 'unknown';
  if (/已有实例在运行/.test(text)) {
    reason = 'already-running';
  } else if (/已被占用|EADDRINUSE/.test(text)) {
    reason = 'port-busy';
  } else if (/desktop pet unavailable|cannot resolve Electron executable|Electron download failed/i.test(text)) {
    // 先判"失败"：下载失败的日志里同时含有下面的"下载中"标记，顺序不能反
    reason = 'electron-missing';
  } else if (/Electron not found, downloading/i.test(text)) {
    // 服务起来了但 Electron 在后台下 —— 对用户就是"双击了，桌宠没出现"
    reason = 'electron-downloading';
  } else if (/找不到.*lib[\\/]standalone\.js/.test(text)) {
    reason = 'not-built';
  }

  const hint = HINTS[reason] ?? HINTS.unknown;
  const title = reason === 'port-busy' ? `${hint.title}（端口 ${port}）` : hint.title;
  const detail = reason === 'unknown' ? firstErrorLine(text) : '';
  return { reason, title, hint: hint.hint, detail };
}

/** 把分类结果排成给人看的几行（打印用；纯字符串拼接，无副作用） */
export function formatLaunchFailure(info, logPath) {
  const lines = ['', '  ✗ ' + info.title];
  if (info.detail) lines.push('    ' + info.detail);
  lines.push('    → ' + info.hint);
  if (logPath) lines.push('    日志：' + logPath);
  lines.push('');
  return lines.join('\n');
}
