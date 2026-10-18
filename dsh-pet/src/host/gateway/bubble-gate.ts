/**
 * 气泡仲裁门（docs/19 §4.3）：1500ms 窗口内低优先级不得覆盖高优先级，error 永不被吞。
 *
 * ## 解决什么
 * say 叶子是**单槽后到覆盖先到**：一条 info 气泡能把 200ms 前的 error 告警盖掉，
 * 用户就此错过关键信息（「error 被 info 盖掉」是这个门的立项理由）。
 *
 * ## 规则（照设计写死）
 *   priority < 当前记录 && now - 记录.at < holdMs → 拒（静默合并，不弹也不计数）；
 *   否则放行并记账。**同优先级放行**（防嘴被堵住：连续同 severity 的气泡各有信息量）；
 *   error(20) 是最高优先级，永不被拒（没有比它高的记录可压）。
 *
 * ## severity → priority 的口径
 *   复用 `gateway/ingest.ts` 的 SEVERITY_PRIORITY（info:0 / warning:10 / error:20）——
 *   **不开第二张表**。本模块只认 priority 数字；调用方（index.ts 包装 pushSay 时）
 *   传的是 ingest payload 里已由该表算好的 priority。
 *
 * ## 接线方式
 *   index.ts 给 ingest 注入的 pushSay 包一层 gate——**ingest.ts 本体不改**（T07 测试零影响）。
 *   被拒 = 不写 say 叶子（前端根本看不到，符合「静默合并」）。
 */
export interface BubbleGate {
  /** true = 放行（调用方写气泡）；false = 窗口内被更高优先级压掉（静默合并） */
  pass(petId: string, priority: number): boolean;
}

/** 压制窗口默认值（ms）：气泡自然存留约 3s，1500ms 足够让用户看见高优先级内容 */
const DEFAULT_HOLD_MS = 1500;

/** 造一个气泡门（per-pet 记账；now/holdMs 可注入，测试用假时钟） */
export function createBubbleGate(now?: () => number, holdMs?: number): BubbleGate {
  const clock = now ?? Date.now;
  const hold = holdMs ?? DEFAULT_HOLD_MS;
  /** petId → 最近一次放行的 { priority, at } */
  const last = new Map<string, { priority: number; at: number }>();

  return {
    pass(petId: string, priority: number): boolean {
      const at = clock();
      const prev = last.get(petId);
      // 仅当「严格更低」且「仍在窗口内」才拒：同优先级放行、更高优先级放行、窗口外放行
      if (prev && priority < prev.priority && at - prev.at < hold) return false;
      last.set(petId, { priority, at });
      return true;
    },
  };
}
