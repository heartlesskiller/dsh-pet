/**
 * `GET /state/stream`（S8，L1 只读）：SSE 推送版的状态订阅（opt-in）。
 *
 * ## 为什么是 SSE 不是 WebSocket（07 Q7）
 * 数据流向是**单向下行**（host → 观察者），SSE 就是为这个形状设计的：纯 HTTP、零握手协议、
 * 浏览器原生 `EventSource` 直接消费、断线自动重连（带 `Last-Event-ID`）。上 WebSocket 要
 * 双向框架 + 心跳/重连自己写，换来的是一个本产品用不到的上行通道。
 *
 * ## 契约
 * - 帧格式：`id: <counter>\ndata: <GET /state 的完整 JSON>\n\n`——id 取快照里最大 counter，
 *   与轮询口径同源（同一次写入产生同一 counter，客户端按它去重）；
 * - **不重放历史**：没有历史缓冲，`Last-Event-ID` 只用于客户端去重，连上就发当前快照；
 * - 50ms 去抖：一次请求可能连写多片（余额刷新会同时写 sections.balance 和 sections.relays），
 *   合并成一帧，避免把客户端刷成幻灯片；
 * - 连接上限 8，超出 → 429（个人自用场景，防误开一堆标签页把宿主拖住）；
 * - 25s 发一行注释心跳（`: ping`），让中间层知道连接活着；
 * - **轮询契约不动**：`GET /state` 仍是唯一事实源，SSE 只是加速通道，断了不影响正确性。
 *
 * 本模块直接持有 `res`（流式响应无法用 RouteResult 表达），所以由 `index.ts` 的 HTTP
 * handler 在调 `handlePetRoute` **之前**拦下，独立于业务路由表。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** SSE 依赖：状态仓的订阅与快照由调用方注入（本模块不 import 状态仓） */
export interface SseDeps {
  /** 订阅任意写入（返回取消订阅） */
  subscribe: (listener: () => void) => () => void;
  /** 取当前完整状态快照（GET /state 的响应体） */
  snapshot: () => unknown;
  /** 连接上限，默认 8 */
  maxConnections?: number;
  /** 去抖窗口，默认 50ms */
  flushMs?: number;
  /** 心跳间隔，默认 25s；0 = 不发 */
  heartbeatMs?: number;
}

/** 一条活跃连接（诊断与停机清理用） */
interface LiveConnection {
  res: ServerResponse;
  /** 该连接的清理函数（退订 + 清定时器 + 关流）；closeAll 也走它，避免退订漏执行 */
  cleanup: () => void;
}

export interface SseStream {
  /** HTTP handler（自己写响应头与 body，永不再写第二份响应） */
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  /** 当前连接数 */
  count: () => number;
  /** 关闭全部连接（插件 dispose 时调用；不关闭会让进程在停机时挂着） */
  closeAll: () => void;
}

const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_FLUSH_MS = 50;
const DEFAULT_HEARTBEAT_MS = 25_000;

/** 快照里最大 counter（帧 id 用；没有 counter 时退化为 0） */
function maxCounter(snapshot: unknown): number {
  let max = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.counter === 'number' && Number.isFinite(o.counter) && o.counter > max) max = o.counter;
    for (const value of Object.values(o)) visit(value);
  };
  visit(snapshot);
  return max;
}

export function createSseStream(deps: SseDeps): SseStream {
  const maxConnections = deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const connections = new Set<LiveConnection>();

  return {
    handle(req, res) {
      if (connections.size >= maxConnections) {
        // 429 而不是排队：SSE 连接是长连接，排队等于永远等不到；让调用方知道上限在哪
        const body = JSON.stringify({
          error: 'too-many-connections',
          message: `SSE 连接已达上限（${maxConnections}），请复用已有连接或改用轮询 GET /state`,
        });
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // 反向代理（若用户自行加了）不要缓冲流——本地场景无害，写了更稳
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();

      const conn: LiveConnection = { res, cleanup: () => {} };
      connections.add(conn);

      let closed = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      /** 发一帧（同一时刻只发一份快照） */
      const send = (event = 'state'): void => {
        if (closed || res.writableEnded) return;
        const snap = deps.snapshot();
        const id = maxCounter(snap);
        res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(snap)}\n\n`);
      };
      /** 去抖：窗口内的多次写入合并成一帧 */
      const scheduleFlush = (): void => {
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          send();
        }, flushMs);
        flushTimer.unref?.();
      };

      const unsubscribe = deps.subscribe(scheduleFlush);
      const heartbeat =
        heartbeatMs > 0
          ? setInterval(() => {
              if (!closed && !res.writableEnded) res.write(': ping\n\n');
            }, heartbeatMs)
          : undefined;
      heartbeat?.unref?.();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        connections.delete(conn);
        if (!res.writableEnded) res.end();
      };
      conn.cleanup = cleanup;
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);

      // 连上立刻给一份当前快照（客户端不必等下一次写入——它可能就是来看一眼的）
      send('snapshot');
    },

    count: () => connections.size,

    closeAll() {
      // 逐个走各自的 cleanup：退订 + 清定时器 + end()——只 end 不清理会留下悬挂的订阅者
      for (const conn of [...connections]) {
        try {
          conn.cleanup();
        } catch {
          // 已经断开的连接：忽略
        }
      }
    },
  };
}
