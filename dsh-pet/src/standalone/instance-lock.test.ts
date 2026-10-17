/**
 * 独立模式实例锁（S0）的契约测试 —— 全部无 GUI、无网络、无真实端口。
 *
 * 钉住四件事：
 *   1. 冲突即失败（且错误信息里带得上「谁占着、锁在哪」）；
 *   2. 释放后能再拿到；
 *   3. stale 锁（进程已死 / 文件读不出来）能被回收 —— 崩溃与 SIGKILL 的恢复路径；
 *   4. 默认存活判定的口径（ESRCH 死、EPERM 仍算活）。
 *
 * 存活判定一律注入，不杀真进程：测试自己决定「那个 PID 活不活」。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { acquireInstanceLock, defaultIsAlive, InstanceLockBusyError, type InstanceLock } from './instance-lock.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-lock-'));
}

/** 拿到一把锁，并保证测试结束后释放 + 清目录 */
function withLock(dir: string, over: Partial<Parameters<typeof acquireInstanceLock>[0]> = {}): InstanceLock {
  return acquireInstanceLock({ lockPath: join(dir, 'standalone.lock'), port: 3080, ...over });
}

test('第一次获取成功，锁文件里记下 PID 与端口', () => {
  const dir = tmpDir();
  try {
    const lock = withLock(dir, { port: 3080 });
    const info = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number; port: number; startedAt: string };
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, 3080);
    assert.ok(info.startedAt.length > 0, '启动时间要记，诊断时用');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锁被占用（PID 存活）→ InstanceLockBusyError，消息带 PID / 端口 / 锁路径', () => {
  const dir = tmpDir();
  try {
    const first = withLock(dir, { port: 3080 });
    assert.throws(
      () => withLock(dir),
      (error: unknown) => {
        assert.ok(error instanceof InstanceLockBusyError);
        assert.equal(error.heldBy.pid, process.pid);
        assert.equal(error.heldBy.port, 3080);
        assert.ok(error.message.includes(String(process.pid)), '消息要能看出是谁占着');
        assert.ok(error.message.includes(lock0Path(dir)), '消息要给出锁文件路径，用户才知道删哪个');
        return true;
      },
    );
    first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('释放后可以再获取（release 幂等，且真的删掉锁文件）', () => {
  const dir = tmpDir();
  try {
    const first = withLock(dir);
    first.release();
    first.release(); // 幂等：不得抛错、不得误删别人的锁
    const second = withLock(dir);
    assert.equal(second.path, first.path);
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale：锁里的进程已不存在 → 自动回收并拿到锁（崩溃 / SIGKILL 的恢复路径）', () => {
  const dir = tmpDir();
  try {
    // 先写一把"别人的"锁，但判定它已死
    writeFileSync(
      join(dir, 'standalone.lock'),
      JSON.stringify({ pid: 999999, port: 3080, startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const lock = withLock(dir, { isAlive: () => false });
    assert.equal(lock.info.pid, process.pid, 'stale 锁必须被回收，否则用户永远起不来');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale：锁文件读不出来（半截写入 / 被清空）→ 同样按 stale 回收', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'standalone.lock'), '{ "pid": 12'); // 半截 JSON
    const lock = withLock(dir, { isAlive: () => true });
    assert.equal(lock.info.pid, process.pid);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锁里没有 pid 字段 → 视为 stale（不把垃圾文件当成永久锁）', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'standalone.lock'), JSON.stringify({ port: 3080 }));
    const lock = withLock(dir);
    assert.equal(lock.info.pid, process.pid);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EPERM 仍算存活：没权限发信号不代表进程死了', () => {
  // 用真实进程探一次：当前进程必然存在（EPERM 只在权限不足时出现，这里至少不能误判为死）
  assert.equal(defaultIsAlive(process.pid), true);
  // 明显不存在的 PID → false（不抛错）
  assert.equal(defaultIsAlive(-1), false);
  assert.equal(defaultIsAlive(0), false);
  assert.equal(defaultIsAlive(Number.NaN), false);
});

test('maxRetries 用尽仍抢不到 → 抛错而不是死循环', () => {
  const dir = tmpDir();
  try {
    // 持续竞争三要素：锁文件一直在（回收动作「删不掉」）+ 每次都被判 stale（持有者已死）
    // + 合法 JSON（走 readLockInfo 成功路径，只靠 isAlive 判死）。
    // 注意不能反过来用「存活 PID」：那会按设计直接抛 InstanceLockBusyError（明确失败，不等重试）。
    writeFileSync(
      join(dir, 'standalone.lock'),
      JSON.stringify({ pid: 4242, port: 3080, startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    let attempts = 0;
    assert.throws(
      () =>
        acquireInstanceLock({
          lockPath: join(dir, 'standalone.lock'),
          port: 3080,
          isAlive: () => false,
          maxRetries: 2,
          removeLock: () => {
            attempts += 1;
          },
        }),
      /竞争失败/,
    );
    // 每次 stale 判定后都会尝试回收一次：初始尝试 + maxRetries 次重试 = maxRetries + 1 次，
    // 然后明确抛错 —— 既证明没有死循环，也证明重试次数是有上限的
    assert.equal(attempts, 3, 'removeLock 应被调用 maxRetries + 1 次');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 测试里引用的锁路径（与 withLock 一致） */
function lock0Path(dir: string): string {
  return join(dir, 'standalone.lock');
}

test('父目录不存在（首次运行 / 全新 DSH_HOME）→ 自动建目录后取锁成功', () => {
  const dir = tmpDir();
  try {
    // 模拟 <DSH_HOME>/dsh-pet/ 尚不存在：锁文件落在两层新目录里
    const lockPath = join(dir, 'dsh-pet', 'nested', 'standalone.lock');
    const lock = acquireInstanceLock({ lockPath, port: 3080 });
    assert.equal(lock.path, lockPath);
    assert.ok(readFileSync(lockPath, 'utf8').includes(String(process.pid)));
    lock.release();
    assert.equal(existsSync(lockPath), false, 'release 后锁文件应被删掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
