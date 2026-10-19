/**
 * 构建陈旧检测（`scripts/build-freshness.mjs` 的纯函数）。
 *
 * 钉的是「源码改了 → 必须重建」这条不变式：桌面快捷方式跑的是 `lib/standalone.js`，
 * 不重建的话用户改了代码双击还是旧行为，会以为"改了没生效"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsRebuild, newestMtimeMs } from '../../scripts/build-freshness.mjs';

test('lib 比源码新 → 不用重建（常态，零额外耗时）', () => {
  assert.equal(needsRebuild(2000, 1000), false);
});

test('lib 与源码一样新 → 不用重建（同一时刻构建完就是最新的）', () => {
  assert.equal(needsRebuild(1000, 1000), false, '严格大于才算旧，相等不能触发重建');
});

test('lib 比源码旧 → 必须重建（源码改过）', () => {
  assert.equal(needsRebuild(1000, 2000), true);
});

test('lib 缺失/读不到 → 必须重建（否则根本起不来）', () => {
  assert.equal(needsRebuild(NaN, 1000), true);
  assert.equal(needsRebuild(NaN, NaN), true);
});

test('源码也读不到 → 不重建（别把一次 IO 失败变成"每次都重建"）', () => {
  assert.equal(needsRebuild(1000, NaN), false);
});

test('newestMtimeMs：取最大值；空集合 → NaN', () => {
  assert.equal(newestMtimeMs([{ mtimeMs: 5 }, { mtimeMs: 9 }, { mtimeMs: 7 }]), 9);
  assert.equal(newestMtimeMs([]), NaN);
  assert.equal(Number.isNaN(newestMtimeMs(undefined)), true);
  // 混进非法值不许把结果带偏
  assert.equal(newestMtimeMs([{ mtimeMs: NaN }, { mtimeMs: 3 }]), 3);
  assert.equal(Number.isNaN(newestMtimeMs([{ mtimeMs: NaN }])), true);
});
