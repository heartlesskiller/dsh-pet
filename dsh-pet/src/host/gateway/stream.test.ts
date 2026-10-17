/**
 * S8 SSE 测试：连接帧、去抖合并、连接上限 429、closeAll。
 * 用假 req/res（不占端口），全部同步/短定时器驱动。
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import { createSseStream } from './stream.ts';

interface FakeRes {
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, unknown>;
  body: () => string;
  ended: () => boolean;
}

function fakeRes(): FakeRes {
  let status = 0;
  let headers: Record<string, unknown> = {};
  let body = '';
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      headers = h ?? {};
      return res;
    },
    flushHeaders() {},
    write(chunk: string) {
      body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') body += chunk;
      ended = true;
      return res;
    },
    on() {
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    headers: () => headers,
    body: () => body,
    ended: () => ended,
  };
}

const fakeReq = () => ({ on() {} }) as unknown as IncomingMessage;

/** 等一个宏任务 + 一点点时间（去抖窗口 5ms） */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('SSE：连上立刻推一帧当前快照（id = 最大 counter），响应头是 text/event-stream', () => {
  const stream = createSseStream({
    subscribe: () => () => {},
    snapshot: () => ({ sections: { balance: { counter: 42, data: null } } }),
    heartbeatMs: 0,
  });
  const f = fakeRes();
  stream.handle(fakeReq(), f.res);
  assert.equal(f.status(), 200);
  assert.equal(f.headers()['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(f.body(), /^id: 42\nevent: snapshot\ndata: \{.*"counter":42.*\}\n\n$/);
  assert.equal(stream.count(), 1);
  stream.closeAll();
  assert.equal(stream.count(), 0);
  assert.equal(f.ended(), true);
});

test('SSE：一次写入爆发被 50ms（测试用 5ms）去抖合并成一帧', async () => {
  let notify: (() => void) | undefined;
  const stream = createSseStream({
    subscribe: (fn) => {
      notify = fn;
      return () => {};
    },
    snapshot: () => ({ sections: { workStatus: { counter: 7, data: { state: 'working' } } } }),
    flushMs: 5,
    heartbeatMs: 0,
  });
  const f = fakeRes();
  stream.handle(fakeReq(), f.res);
  const before = f.body();
  notify?.();
  notify?.();
  notify?.();
  await tick();
  const frames = f.body().slice(before.length);
  const count = (frames.match(/^data: /gm) ?? []).length;
  assert.equal(count, 1, '三次写入只该多一帧');
  stream.closeAll();
});

test('SSE：连接上限 —— 第 N+1 条连接 429，并给出可读指引', () => {
  const stream = createSseStream({
    subscribe: () => () => {},
    snapshot: () => ({}),
    maxConnections: 1,
    heartbeatMs: 0,
  });
  const first = fakeRes();
  stream.handle(fakeReq(), first.res);
  assert.equal(stream.count(), 1);

  const second = fakeRes();
  stream.handle(fakeReq(), second.res);
  assert.equal(second.status(), 429);
  assert.match(second.body(), /too-many-connections/);
  assert.match(second.body(), /上限（1）/);
  assert.equal(stream.count(), 1, '被拒的连接不占额度');
  stream.closeAll();
});

test('SSE：closeAll 结束全部连接（停机不挂住）', () => {
  const stream = createSseStream({ subscribe: () => () => {}, snapshot: () => ({}), heartbeatMs: 0 });
  const a = fakeRes();
  const b = fakeRes();
  stream.handle(fakeReq(), a.res);
  stream.handle(fakeReq(), b.res);
  assert.equal(stream.count(), 2);
  stream.closeAll();
  assert.equal(stream.count(), 0);
  assert.equal(a.ended(), true);
  assert.equal(b.ended(), true);
});

test('SSE：取消订阅被调用（客户端断开后不再推送，不泄漏监听器）', () => {
  let unsubscribed = false;
  const stream = createSseStream({
    subscribe: () => () => {
      unsubscribed = true;
    },
    snapshot: () => ({}),
    heartbeatMs: 0,
  });
  const f = fakeRes();
  stream.handle(fakeReq(), f.res);
  // 模拟连接关闭：res.on('close') 在我们的假 res 上是 no-op，直接走 closeAll 的等价路径
  stream.closeAll();
  assert.equal(unsubscribed, true);
});
