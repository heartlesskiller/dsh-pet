/**
 * 构建陈旧检测 —— **纯函数**（无 IO、无时钟、无进程操作）。
 *
 * ## 为什么需要它
 * 桌面快捷方式跑的是 `lib/standalone.js`（构建产物）。源码改了但没重新构建时，
 * 双击跑的还是旧代码 —— 用户看到的是"我改了却没生效"，然后开始怀疑软件。
 * 所以在启动前比一次 mtime，旧了就自动重建。
 *
 * ## 为什么把"取 mtime"和"判断"分开
 * 判断是纯函数 → 能无文件系统单测（四种边界：lib 新 / 一样新 / lib 旧 / lib 缺失）。
 * 取 mtime 是有 IO 的那半边，留在 `pet-service.mjs` 里，只负责喂数据。
 *
 * ## 扫哪些目录（这里只做判断，不扫）
 * 只扫 `src/**` —— 因为 `lib/standalone.js` 与 `runtime/electron-helper/shared-core.js`
 * **都只由 src/ 生成**。`runtime/` 下其余文件是 Electron 直接加载的手写 JS，
 * 不参与 lib 的构建，把它们算进来只会让检测永远为真（尤其 shared-core.js 本身就是产物）。
 */

/**
 * 需不需要重建。
 * @param {number} libMtimeMs       构建产物的 mtime（毫秒）；读不到传 NaN
 * @param {number} srcNewestMtimeMs 源码里最新的 mtime（毫秒）；读不到传 NaN
 * @returns {boolean}
 */
export function needsRebuild(libMtimeMs, srcNewestMtimeMs) {
  // 产物缺失/读不到 → 必须构建（否则根本起不来）
  if (!Number.isFinite(libMtimeMs)) return true;
  // 源码也读不到 → 无从判断，**不**乱构建（避免把一次 IO 失败变成"每次都重建"）
  if (!Number.isFinite(srcNewestMtimeMs)) return false;
  // 严格大于：mtime 相同视为不旧（同一时刻构建完就是最新的）
  return srcNewestMtimeMs > libMtimeMs;
}

/**
 * 一组 mtime 里取最新值；空集合 → NaN（调用方据此走"源码读不到"分支）。
 * @param {Array<{mtimeMs: number}>} entries
 * @returns {number}
 */
export function newestMtimeMs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return NaN;
  let newest = NaN;
  for (const entry of entries) {
    const value = entry?.mtimeMs;
    if (Number.isFinite(value) && (!Number.isFinite(newest) || value > newest)) newest = value;
  }
  return newest;
}
