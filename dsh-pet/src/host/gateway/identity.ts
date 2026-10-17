/**
 * 网关实例标识（进程级单例）。
 *
 * 为什么需要它：发现文件（`gateways/<pid>.json`）里的 `instanceId` 与 `GET /capabilities`
 * 返回的 `instanceId` **必须是同一个值**——发现机制的口径是「文件里的 instanceId 即判据，
 * 再由 GET /capabilities 复核」（07 §3 Q2 2a）。两边各自 randomUUID 会让复核永远失败。
 *
 * 放哪里：standalone 侧（`./discovery`）与 host 侧（`./gateway/capabilities`）都要用，
 * 而 import 方向必须是 standalone → host（cli.ts 早就这么 import host 模块），所以单例落在
 * host 侧这个两边都能 import 的叶子模块里。
 */
import { randomUUID } from 'node:crypto';

/** 进程内缓存的实例 id（每个进程一份；测试进程各自独立，互不干扰） */
let cached: string | undefined;

/** 本进程的网关实例 id（首次调用生成，之后恒稳定） */
export function gatewayInstanceId(): string {
  if (cached === undefined) cached = randomUUID();
  return cached;
}
