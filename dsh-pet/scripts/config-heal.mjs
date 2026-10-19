/**
 * 启动自愈：`display: "none"` → `"desktop"` —— **纯函数**（无 IO、无时钟、无进程操作）。
 *
 * ## 为什么需要它（用户真实踩到的坑）
 * 菜单「显示位置 → 都不」会把桌宠从**两端同时**藏掉（浏览器与桌面都不显示）。
 * 恢复入口原本只有「设置页的下拉框」—— 而**独立模式没有设置页**，菜单又长在那个
 * 已经看不见的桌宠上。于是用户双击「桌宠」什么都没发生，且没有任何可视化入口能改回来。
 *
 * 用户双击这个快捷方式，意图就是"我要看到桌宠"。此时帮他自愈，比让他去手改 JSON 正确一万倍。
 *
 * ## 边界（重要）
 * - **只治 `display === 'none'` 这一种**。`web` / `both` / 缺失 / 非法值一律不动 ——
 *   那些更可能是用户有意为之，顺手"修"它们会把配置改坏。
 * - 配置文件损坏 → **不清洗**，只回报原因让调用方警告（写坏一个已经坏的文件只会更坏）。
 */

/** 备份文件名后缀：带日期时间，避免同一天多次自愈互相覆盖 */
export function backupSuffix(now) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 去掉 JSONC 的注释（`//` 行注释与 `/* *\/` 块注释），字符串内的 `//` 不受影响。
 * 不处理尾随逗号（本项目的配置没有）；解析失败由 parseConfigText 回报。
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  const src = String(text ?? '');
  let out = '';
  let inString = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 解析配置文本（JSONC）。
 * @param {string} text
 * @returns {{ok:true, value:any} | {ok:false, message:string}}
 */
export function parseConfigText(text) {
  const stripped = stripJsonComments(text);
  if (stripped.trim().length === 0) return { ok: false, message: '配置文件是空的' };
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e) {
    return { ok: false, message: `配置文件不是合法 JSON(C)：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 判断要不要自愈，并给出改完的配置。
 *
 * @param {unknown} config 已解析的配置对象
 * @returns {{changed:boolean, reason:string, value:unknown}}
 *   - `changed:false` 时 `value` 原样返回（调用方不该写盘）
 *   - `reason` 是给人看的一句话（自愈时打印）
 */
/**
 * 判断要不要自愈，并给出改完的配置。
 *
 * @param {unknown} config 已解析的配置对象
 * @param {{mode?: 'standalone' | 'bridge'}} [options]
 *   - `standalone`（独立模式启动器）：`none` 与 `web` **都是死路** —— 独立模式没有网页界面，
 *     `web` 意味着桌宠只存在于 DSH 的网页 UI 里，而这里根本没有那个 UI。
 *   - `bridge` / 不传：只治 `none`（DSH 下 `web` 是合法的，由 DSH 设置页管）。
 * @returns {{changed:boolean, reason:string, value:unknown}}
 */
export function planDisplayHeal(config, options = {}) {
  const mode = options && options.mode === 'standalone' ? 'standalone' : 'bridge';
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { changed: false, reason: '配置不是对象（形状异常，不动它）', value: config };
  }
  const pets = config.pets;
  if (!Array.isArray(pets)) {
    return { changed: false, reason: '配置里没有 pets 数组（不动它）', value: config };
  }
  // 死路值：none 两端都没有；web 在独立模式下等于没有（没有网页 UI）
  const dead = mode === 'standalone' ? ['none', 'web'] : ['none'];
  const why = (value) =>
    value === 'web' ? '只在网页显示（独立模式没有网页界面，桌宠等于不可见）' : '不在桌面显示';

  let healed = 0;
  let lastValue = '';
  const nextPets = pets.map((pet) => {
    if (pet === null || typeof pet !== 'object' || Array.isArray(pet)) return pet;
    const p = pet;
    // **只治死路值**：desktop / both / 缺失 / 非法都可能是用户有意为之，一律不动
    if (!dead.includes(p.display)) return pet;
    healed += 1;
    lastValue = p.display;
    return { ...p, display: 'desktop' };
  });
  if (healed === 0) {
    return { changed: false, reason: '没有需要自愈的宠物', value: config };
  }
  return {
    changed: true,
    reason: `检测到 ${healed} 只桌宠被设置为「${why(lastValue)}」，已自动改为「桌面显示」`,
    value: { ...config, pets: nextPets },
  };
}
