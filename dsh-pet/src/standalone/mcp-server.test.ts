/**
 * MCP server 纯逻辑测试（docs/19 §8 A6/A13/A9 的沙箱可验部分）：
 *   initialize / tools-list / tools-call / ping 行级 JSON-RPC 进出一致；
 *   tools/call 构造的 /events body 形状正确（mock fetch 注入）；
 *   stdin close → 发 status:idle → exit 0（退出收敛）。
 *
 * 全部不起真管道、不碰真网络：fetch / stdin / stdout / exit 全注入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';

import {
  TOOLS,
  createMcpServer,
  kindFromClientInfo,
  serveStdio,
  toolEventsBody,
  type McpServer,
  type ServeStdioOptions,
} from '../../tools/mcp-server.mjs';

const BASE = 'http://127.0.0.1:8231/dsh-pet-7340';

/** PassThrough 当 stdin 注入（类型与 process.stdin 同构的最小形状） */
function asStdin(stream: PassThrough): NonNullable<ServeStdioOptions>['stdin'] {
  return stream as unknown as NonNullable<ServeStdioOptions>['stdin'];
}

/** 起 serveStdio：写出口与退出码进 sink */
function serveCaptured(
  server: McpServer,
  stdin: PassThrough,
): { written: string[]; exits: number[]; done: Promise<void> } {
  const written: string[] = [];
  const exits: number[] = [];
  const done = serveStdio(server, {
    stdin: asStdin(stdin),
    stdout: { write: (s: string) => written.push(s) },
    exit: (code: number) => exits.push(code),
  });
  return { written, exits, done };
}

/** 记录型假 fetch：按 URL 记调用，按队返回预置响应 */
function fakeFetch(handlers: Record<string, { status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    let parsed;
    try {
      parsed = init.body ? JSON.parse(String(init.body)) : null;
    } catch {
      parsed = null;
    }
    calls.push({ url: String(url), method: init.method ?? 'GET', body: parsed });
    for (const [frag, preset] of Object.entries(handlers)) {
      if (String(url).includes(frag)) {
        const status = preset.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(preset.body ?? {}),
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":"not found"}' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 默认 happy-path 假 fetch（hello ok / events ok / agents 一条） */
function happyFetch() {
  return fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: true } },
    '/agents': { body: { ok: true, agents: [{ agentId: 'a', kind: 'codex' }] } },
  });
}

/** 起一个 server（固定 host，agentId 可钉） */
function makeServer(fetchImpl: typeof fetch, base = BASE) {
  return createMcpServer({ base, fetchImpl, host: 'MOCK-PC' });
}

/** 发一行、收一行（handleLine 的往返） */
async function roundTrip(server: ReturnType<typeof makeServer>, obj: unknown): Promise<Record<string, unknown> | null> {
  const line = await server.handleLine(JSON.stringify(obj));
  return line === null ? null : (JSON.parse(line) as Record<string, unknown>);
}

// ---------- 协议四方法 ----------

test('initialize：回 protocolVersion/serverInfo/capabilities，并按 clientInfo 定 kind 与 agentId', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  const res = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'WorkBuddy', version: '1.0' } },
  });
  assert.equal(res?.id, 1);
  const result = res?.result as Record<string, unknown>;
  assert.equal(result.protocolVersion, '2024-11-05', '回话客户端请求的协议版本');
  assert.deepEqual(result.serverInfo, { name: 'dsh-pet', version: '0.3.7' });
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(calls.length, 0, 'initialize 不碰网络');

  // clientInfo=WorkBuddy → kind=workbuddy、agentId=workbuddy@MOCK-PC（随后 tools/call 带上）
  await roundTrip(server, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'pet_status', arguments: { status: 'working' } },
  });
  const hello = calls.find((c) => c.url.includes('/agents/hello'));
  assert.ok(hello, 'tools/call 前必须先 hello');
  assert.deepEqual(hello?.body, { agentId: 'workbuddy@MOCK-PC', kind: 'workbuddy' });
});

test('kindFromClientInfo：按名字猜型，猜不出归 custom（未知 kind 优雅降级）', () => {
  assert.equal(kindFromClientInfo({ name: 'WorkBuddy' }), 'workbuddy');
  assert.equal(kindFromClientInfo({ name: 'codex-cli' }), 'codex');
  assert.equal(kindFromClientInfo({ name: 'Claude Code' }), 'claude-code');
  assert.equal(kindFromClientInfo({ name: 'my-thing' }), 'custom');
  assert.equal(kindFromClientInfo(null), 'custom');
  assert.equal(kindFromClientInfo({}), 'custom');
});

test('ping：回空 result', async () => {
  const server = makeServer(happyFetch().impl);
  const res = await roundTrip(server, { jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 7, result: {} });
});

test('tools/list：三个 tool 齐整（pet_status / pet_notice / pet_agents）', async () => {
  const server = makeServer(happyFetch().impl);
  const res = await roundTrip(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['pet_status', 'pet_notice', 'pet_agents'],
  );
  // inputSchema 必备项在（agent 侧据此生成调用）
  const status = TOOLS.find((t) => t.name === 'pet_status');
  assert.deepEqual((status?.inputSchema as { required: string[] }).required, ['status']);
});

test('notification（无 id）→ 不回包（含 initialized）', async () => {
  const server = makeServer(happyFetch().impl);
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })), null);
  assert.equal(await server.handleLine(''), null);
  assert.equal(await server.handleLine('   '), null);
});

test('坏 JSON 行 → -32700 parse error（id null），不静默', async () => {
  const server = makeServer(happyFetch().impl);
  const line = await server.handleLine('{not json');
  assert.ok(line);
  const res = JSON.parse(line as string) as { id: unknown; error: { code: number } };
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32700);
});

test('未知方法 → -32601；未知 tool → -32602', async () => {
  const server = makeServer(happyFetch().impl);
  const m = await roundTrip(server, { jsonrpc: '2.0', id: 3, method: 'nope/nope' });
  assert.equal((m?.error as { code: number }).code, -32601);
  const t = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'pet_destroy', arguments: {} },
  });
  assert.equal((t?.error as { code: number }).code, -32602);
});

// ---------- tools/call → /events body 形状 ----------

test('toolEventsBody：pet_status → {agentId,status}（task 有时才带；trim）', () => {
  assert.deepEqual(toolEventsBody('pet_status', { status: 'working' }, { agentId: 'a@PC' }), {
    agentId: 'a@PC',
    status: 'working',
  });
  assert.deepEqual(toolEventsBody('pet_status', { status: 'working', task: '  pnpm test  ' }, { agentId: 'a@PC' }), {
    agentId: 'a@PC',
    status: 'working',
    task: 'pnpm test',
  });
  // args.agentId 覆盖会话默认
  assert.deepEqual(toolEventsBody('pet_status', { status: 'thinking', agentId: 'b@PC' }, { agentId: 'a@PC' }), {
    agentId: 'b@PC',
    status: 'thinking',
  });
});

test('toolEventsBody：pet_notice → {agentId,notice:{severity,text[,coalesceKey]}}', () => {
  assert.deepEqual(toolEventsBody('pet_notice', { severity: 'error', text: '挂了' }, { agentId: 'a@PC' }), {
    agentId: 'a@PC',
    notice: { severity: 'error', text: '挂了' },
  });
  assert.deepEqual(
    toolEventsBody('pet_notice', { severity: 'warning', text: '卡住', coalesceKey: 'stuck' }, { agentId: 'a@PC' }),
    { agentId: 'a@PC', notice: { severity: 'warning', text: '卡住', coalesceKey: 'stuck' } },
  );
  assert.equal(toolEventsBody('pet_agents', {}, { agentId: 'a@PC' }), null);
});

test('tools/call pet_status：hello + events 两次 POST，body 形状正确', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  await roundTrip(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'codex' } },
  });
  const res = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'pet_status', arguments: { status: 'working', task: 'pnpm test' } },
  });
  const result = res?.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(result.isError, undefined, '成功回执不带 isError');
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).ok, true, 'text 是 /events 响应 JSON');

  const hello = calls.find((c) => c.url.endsWith('/agents/hello'));
  const event = calls.find((c) => c.url.endsWith('/events'));
  assert.ok(hello && event, '应先 hello 再 events');
  assert.deepEqual(hello?.body, { agentId: 'codex@MOCK-PC', kind: 'codex' });
  assert.deepEqual(event?.body, { agentId: 'codex@MOCK-PC', status: 'working', task: 'pnpm test' });
  assert.equal(event?.method, 'POST');
});

test('tools/call pet_notice：notice 段形状正确（severity/text/coalesceKey）', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  await roundTrip(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } });
  await roundTrip(server, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'pet_notice', arguments: { severity: 'warning', text: '卡住了', coalesceKey: 'stuck' } },
  });
  const event = calls.find((c) => c.url.endsWith('/events'));
  assert.deepEqual(event?.body, {
    agentId: 'custom@MOCK-PC',
    notice: { severity: 'warning', text: '卡住了', coalesceKey: 'stuck' },
  });
});

test('tools/call pet_agents：GET /agents，text 是响应 JSON', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  const res = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'pet_agents', arguments: {} },
  });
  const result = res?.result as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, agents: [{ agentId: 'a', kind: 'codex' }] });
  const get = calls.find((c) => c.url.endsWith('/agents'));
  assert.equal(get?.method, 'GET');
});

test('桌宠不在场：hello 失败 → isError:true 且带原因（不静默）', async () => {
  const { impl } = fakeFetch({
    '/agents/hello': { status: 400, body: { error: '缺少 agentId' } },
  });
  const server = makeServer(impl);
  const res = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'pet_status', arguments: { status: 'working' } },
  });
  const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /hello 失败/);
});

test('网络失败：fetch 抛错 → isError:true（不静默、不 500 杀 server）', async () => {
  const impl = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const server = makeServer(impl);
  const res = await roundTrip(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'pet_status', arguments: { status: 'working' } },
  });
  const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ECONNREFUSED/);
});

// ---------- 退出收敛（A13） ----------

test('stdin close → 尽力 POST /events {status:idle} → exit 0', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  const stdin = new PassThrough();
  const { written, exits, done } = serveCaptured(server, stdin);

  // 喂三行：initialize / tools/call / ping，然后关管道（模拟 agent 退出）
  stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } }) + '\n',
  );
  stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pet_status', arguments: { status: 'working' } },
    }) + '\n',
  );
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
  stdin.end();

  await done;
  assert.deepEqual(exits, [0], 'stdin close 后 exit(0)');
  assert.equal(written.length, 3, '三行请求三行响应（notification 才不回）');
  const idle = calls.filter((c) => c.url.endsWith('/events')).map((c) => c.body);
  assert.deepEqual(
    idle,
    [
      { agentId: 'codex@MOCK-PC', status: 'working' },
      { agentId: 'codex@MOCK-PC', status: 'idle' },
    ],
    '收尾必须补发 idle',
  );
});

test('stdin close：从没 initialize 过 → 不发 idle（没登记过无需收敛），仍 exit 0', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  const stdin = new PassThrough();
  const { exits, done } = serveCaptured(server, stdin);
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  stdin.end();
  await done;
  assert.deepEqual(exits, [0]);
  assert.equal(calls.filter((c) => c.url.endsWith('/events')).length, 0, '没 initialize 过不发 idle');
});

test('stdin close：idle 发送失败（网络断）也 exit 0（收敛尽力而为，TTL 兜底）', async () => {
  const impl = (async (url: string) => {
    if (String(url).includes('/events')) throw new Error('connect ECONNREFUSED');
    return {
      ok: true,
      status: 200,
      text: async () => '{"ok":true,"leaseId":"L1","ttlSec":60,"granted":[]}',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const server = makeServer(impl);
  const stdin = new PassThrough();
  const { exits, done } = serveCaptured(server, stdin);
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  stdin.end();
  await done;
  assert.deepEqual(exits, [0], 'idle 发不出去也正常退出（不拖住 agent 的关闭）');
});

test('尾巴上没换行的残行也当一行处理（个别 client 最后一帧不带 \\n）', async () => {
  const { impl, calls } = happyFetch();
  const server = makeServer(impl);
  const stdin = new PassThrough();
  const { written, exits, done } = serveCaptured(server, stdin);
  stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } }),
  ); // 无 \n
  stdin.end();
  await done;
  assert.equal(written.length, 1, '残行也被处理并回包');
  assert.deepEqual(exits, [0]);
  assert.ok(
    calls.some((c) => c.url.endsWith('/events')),
    'initialize 后 close → 发 idle',
  );
});
