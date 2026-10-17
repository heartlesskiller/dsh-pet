/**
 * 独立模式实例锁（S0）。
 *
 * ## 为什么必须有它
 * 独立模式的 HTTP 服务原本在「首选端口被占用」时会向后顺延（`bindFirstFree`）。
 * 于是用户第二次启动（或误双击）会**静默**起出第二只桌宠，后果是三重的：
 *   1. 桌面上出现两只鱼；
 *   2. 两个实例都写 `agent-gateway.json` 发现文件 → 互相覆盖，外部 agent 连到哪一个纯靠运气；
 *   3. 两个实例各自轮询 N 个中转站 → 双倍请求量，站长侧可能触发限流。
 *
 * 所以这里改成「**一个用户一个独立实例**」：绑定端口之前先拿锁，锁被占用就明确失败，
 * 调用方以非零退出码退出，**绝不顺延到别的端口**。
 *
 * ## 实现口径
 * - **原子性**：`open(path, 'wx')`（O_CREAT|O_EXCL）——「创建成功」即「拿到锁」，
 *   不存在 read-then-write 的竞态窗口；
 * - **崩溃/被杀后自动恢复**：锁里记 PID。拿不到锁时判定该 PID 是否存活
 *   （`process.kill(pid, 0)`）：不存在 → 判为 stale 并回收，用户下次照常能起。
 *   进程被 SIGKILL 时没有机会删锁文件，靠的就是这条；
 * - **不忙等、不轮询**：一次创建 + 有限次 stale 重试，没有任何 sleep/interval；
 * - **可单测**：锁路径、存活判定与 stale 回收动作（`removeLock`）都可注入，不碰真实用户目录；
 * - **零依赖**：只用 `node:fs`（常驻内存有硬指标，不引重量级锁库）。
 *
 * ## 已知局限（如实记账）
 * - **PID 复用**：旧进程已退出、其 PID 被新进程复用时会误判为「仍存活」，
 *   用户这一次起不来。概率极低，且错误信息里给了锁文件路径，删掉即可；
 *   要彻底消除需要跨平台取进程启动时间（Windows 无 /proc），V2 再议。
 * - **锁文件落在用户数据目录**：卸载/清理工具删掉它属于预期行为（删了正好解锁）。
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 锁文件里记的内容（诊断用：告诉用户是谁占着） */
export interface InstanceLockInfo {
  pid: number;
  /** 该实例打算监听的端口（0 = 交给系统分配）；仅作诊断展示 */
  port: number;
  startedAt: string;
}

export interface InstanceLock {
  /** 锁文件绝对路径（诊断与测试用） */
  readonly path: string;
  readonly info: InstanceLockInfo;
  /** 释放锁（幂等；进程退出时会自动调用） */
  release(): void;
}

/** 锁已被另一个存活实例持有 */
export class InstanceLockBusyError extends Error {
  readonly heldBy: InstanceLockInfo;
  readonly lockPath: string;

  constructor(heldBy: InstanceLockInfo, lockPath: string) {
    super(
      `已有实例在运行（PID=${heldBy.pid}，端口=${heldBy.port || '系统分配'}，启动于 ${heldBy.startedAt || '未知'}）。` +
        `锁文件：${lockPath}。若要强制接管，请先结束该进程，或删除该锁文件后重试。`,
    );
    this.name = 'InstanceLockBusyError';
    this.heldBy = heldBy;
    this.lockPath = lockPath;
  }
}

export interface AcquireInstanceLockOptions {
  /** 锁文件路径（测试注入；不要指向共享目录） */
  lockPath: string;
  /** 该实例打算监听的端口，写进锁里供诊断 */
  port: number;
  /** 进程存活判定，默认 {@link defaultIsAlive}（测试注入以覆盖各种 PID 场景） */
  isAlive?: (pid: number) => boolean;
  /** stale 锁回收后的最大重试次数，默认 3（防两个进程同时抢同一个 stale 锁时无限循环） */
  maxRetries?: number;
  /**
   * stale 锁的回收动作，默认删除锁文件（`rmSync(path, { force: true })`）。
   * 测试注入「删不掉」的版本来制造持续竞争，验证 maxRetries 兜底真的生效。
   */
  removeLock?: (path: string) => void;
}

/**
 * 默认进程存活判定。
 *
 * `process.kill(pid, 0)` 不发信号、只探存在性：ESRCH = 进程不存在；
 * EPERM = 进程存在但无权发信号（**仍然算存活**，不能因为没权限就把它当死锁回收）。
 */
export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件；读不到 / 不是合法 JSON / 没有 pid → undefined（调用方按 stale 处理） */
function readLockInfo(lockPath: string): InstanceLockInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<InstanceLockInfo>;
    if (typeof raw.pid !== 'number' || !Number.isFinite(raw.pid)) return undefined;
    return {
      pid: raw.pid,
      port: Number.isFinite(raw.port) ? Number(raw.port) : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * 取实例锁。成功返回锁对象（已挂 `process.on('exit')` 自动释放）；
 * 被存活实例占用 → 抛 {@link InstanceLockBusyError}。
 */
export function acquireInstanceLock(options: AcquireInstanceLockOptions): InstanceLock {
  const { lockPath, port } = options;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const maxRetries = options.maxRetries ?? 3;
  const removeLock = options.removeLock ?? ((path: string) => rmSync(path, { force: true }));
  const info: InstanceLockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };

  // 锁文件的父目录可能还不存在（首次运行 / 全新的 DSH_HOME）：`open(..., 'wx')` 在父目录缺失时
  // 报的是 ENOENT（不是 EEXIST），会被误当成「IO 故障」直接崩。先建目录再取锁。
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let fd: number;
    try {
      // 'wx' = O_CREAT | O_EXCL：文件已存在就抛 EEXIST，绝不会覆盖别人的锁
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = readLockInfo(lockPath);
      if (held && isAlive(held.pid)) throw new InstanceLockBusyError(held, lockPath);
      // 读不到内容，或记录的进程已不存在 → 上一个实例崩了/SIGKILL 了，回收锁重试
      removeLock(lockPath);
      continue;
    }

    try {
      writeSync(fd, JSON.stringify(info, null, 2));
    } finally {
      closeSync(fd);
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      process.off('exit', release);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // 进程都要退了，删不掉也无妨：下一次拿锁时会按 stale 回收
      }
    };
    process.on('exit', release);
    return { path: lockPath, info, release };
  }

  throw new Error(`实例锁竞争失败：重试 ${maxRetries} 次仍未拿到 ${lockPath}`);
}
