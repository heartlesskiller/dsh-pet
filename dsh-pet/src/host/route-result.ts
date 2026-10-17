/**
 * 单次业务路由的应答契约（WebServer 注册与桌面 Helper 管道共用的同一形状）。
 *
 * 为什么从 `index.ts` 上移出来：宿主无关网关（T07）的子路由模块（`./gateway/index`）
 * 也要返回这个形状，而它们不能在运行时回头 import `index.ts`（ESM 循环导入：
 * index → gateway/index → index，虽不致崩但会把模块初始化顺序变成隐藏依赖）。
 * 类型本身上移是**零行为变化**的纯重构（ union 一字未动），既有的 11 个分支匹配顺序不受影响。
 *
 * 消费方各自落盘：HTTP 侧 sendJson/sendText/sendFile，桌面桥侧转成 scheme 应答的 JSON 行。
 */

/** 单次业务路由的应答：JSON / 纯文本 / 文件流（三者互斥，kind 即分发依据） */
export type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string };
