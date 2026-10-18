#!/usr/bin/env node
/**
 * mcp-server.mjs —— dsh-pet 的 MCP server（stdio，给 WorkBuddy / Codex / Claude Code 等
 * 有 MCP client 的 agent 用）。设计依据 docs/19 §4.4(b)。
 *
 * ## 协议：MCP over stdio = newline-delimited JSON-RPC
 * **手写最小子集**，不引 @modelcontextprotocol/sdk（07 §3.8.5：依赖树/体积未验证；
 * 单文件可审计，Phase 3 再评估官方 SDK）。实现四个方法：
 *   initialize / ping / tools/list / tools/call
 * notification（无 id，含 initialize 之后的 `initialized`）**不回包**。
 *
 * ## 三个 tool（最小集）
 *   pet_status(status, task?)    → POST /events（六档驱动 + 任务详情）
 *   pet_notice(severity, text, coalesceKey?) → POST /events（气泡）
 *   pet_agents()                 → GET /agents（在场列表）
 * tools/call 内部就是 POST /events 的转译——**不新造协议**（方案 B 的 C-transport 形态）。
 *
 * ## 接入成本低的关键：每次 tools/call 自带 hello 心跳
 * agent 不需要理解「先登记再驱动」两段协议；登记+事件一次完成（与 CLI 同口径）。
 *
 * ## 退出收敛（MCP 独有优势，设计 §4.7）
 * stdin close/end（agent 退出或被杀时内核关管道，同样触发）→ 尽力 POST /events
 * `{status:'idle'}`（1s 超时）→ exit 0。从没 initialize 过的会话不发（没登记过无需收敛）。
 *
 * ## 身份
 * initialize 的 params.clientInfo.name → kind 猜型（workbuddy/codex/claude-code/custom）；
 * agentId 缺省 `<kind>@<主机名>`，单次调用可用参数 agentId 覆盖。**kind 自声明不可信**
 * （K9）：只影响展示元数据，不参与任何权限判定。
 *
 * 用法：node tools/mcp-server.mjs [--base http://127.0.0.1:8231]
 *   --base 跳过发现逻辑（冒烟/测试注入）；缺省走 pet-gateway-client 的发现（目录 → 端口扫描）。
 */
/* global fetch */
import { hostname } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { discoverGatewayBase, helloAgent, listAgents, postEvent } from './pet-gateway-client.mjs';

/** 默认协议版本（client 没带 protocolVersion 时的回话值） */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** server 自述（/capabilities 之外的第二个自述面；版本与 package.json 同源节奏） */
const SERVER_NAME = 'dsh-pet';
const SERVER_VERSION = '0.3.7';

/** 三个 tool 的声明（最小集；inputSchema 是 JSON Schema 子集） */
export const TOOLS = [
  {
    name: 'pet_status',
    description: '驱动桌宠的六档工作状态（切档位动画 + tooltip 摘要）。idle = 退出清理（清会话回空闲）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['idle', 'thinking', 'working', 'waiting-approval', 'done', 'error'],
          description: '六档；idle = 回合结束回空闲',
        },
        task: { type: 'string', description: '任务详情（≤40 码点；与 status 同段，idle 时不要带）' },
        agentId: { type: 'string', description: '覆盖默认 agentId（缺省 <kind>@<主机名>）' },
      },
      required: ['status'],
    },
  },
  {
    name: 'pet_notice',
    description: '让桌宠弹一条气泡（notice）。同 coalesceKey 5s 窗口内不重复弹；error 永不被吞。',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'info→0 / warning→10 / error→20' },
        text: { type: 'string', description: '气泡文本（≤500 码点）' },
        coalesceKey: { type: 'string', description: '去重键（可选）' },
        agentId: { type: 'string', description: '覆盖默认 agentId' },
      },
      required: ['severity', 'text'],
    },
  },
  {
    name: 'pet_agents',
    description: '当前在场的 agent 列表（GET /agents；过期自动滤除）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** clientInfo.name → kind 猜型（猜不出归 custom：未知 kind 优雅降级，不拒绝） */
export function kindFromClientInfo(clientInfo) {
  const name = String(clientInfo && clientInfo.name ? clientInfo.name : '').toLowerCase();
  if (name.includes('workbuddy')) return 'workbuddy';
  if (name.includes('codex')) return 'codex';
  if (name.includes('claude')) return 'claude-code';
  return 'custom';
}

/** 取非空字符串参数（非字符串 / 空串 → ''） */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * tools/call 的 name+arguments → `/events` 请求体（**纯函数**，单测钉形状）。
 *
 * @param name 'pet_status' | 'pet_notice'（pet_agents 不走这条，返回 null）
 * @param args tools/call 的 arguments
 * @param ctx  { agentId } 会话默认身份（args.agentId 可覆盖）
 */
export function toolEventsBody(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const agentId = str(a.agentId) || str(ctx && ctx.agentId);
  if (name === 'pet_status') {
    const body = { agentId, status: str(a.status) };
    const task = str(a.task);
    if (task) body.task = task;
    return body;
  }
  if (name === 'pet_notice') {
    const notice = { severity: str(a.severity), text: str(a.text) };
    const key = str(a.coalesceKey);
    if (key) notice.coalesceKey = key;
    return { agentId, notice };
  }
  return null;
}

/** JSON-RPC 错误响应 */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/** tools/call 的失败回执（isError:true；reason 不吞） */
function toolError(id, text) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

/** tools/call 的成功回执（text = /events 或 /agents 的响应 JSON，agent 可直接解析） */
function toolOk(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload ?? null) }] } };
}

/**
 * 造一个 MCP server（无 stdio 依赖：handleLine/handleMessage/idleBestEffort 都可单测；
 * stdio 接线见 {@link serveStdio}）。
 *
 * @param options.base 直接指定 API base（跳过发现；冒烟/测试用）
 * @param options.fetchImpl 注入 fetch（测试不碰真网络）
 * @param options.host 注入主机名（测试钉 agentId）
 */
export function createMcpServer(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = options.host ?? hostname();
  let base = options.base ?? '';
  let kind = 'custom';
  let agentId = '';
  let initialized = false;

  /** 解析（并缓存）API base：显式 --base 优先，否则走发现（目录 → 端口扫描） */
  const resolveBase = async () => {
    if (base) return base;
    base = (await discoverGatewayBase({})) ?? '';
    return base;
  };

  /** 当前 agentId（initialize 后恒定；没 initialize 过时给个合理缺省） */
  const currentAgentId = (args) => str(args && args.agentId) || agentId || `${kind}@${host}`;

  async function handleToolCall(id, params) {
    const name = str(params.name);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const known = TOOLS.some((t) => t.name === name);
    if (!known) return rpcError(id, -32602, 'unknown tool: ' + name);

    const b = await resolveBase();
    if (!b) return toolError(id, '找不到桌宠网关（发现目录为空且 3080..3104 无存活实例；桌宠没起？）');

    if (name === 'pet_agents') {
      const r = await listAgents(b, { fetchImpl });
      if (!r.ok) return toolError(id, `GET /agents 失败：HTTP ${r.status}${r.error ? ' ' + r.error : ''}`);
      return toolOk(id, r.body);
    }

    // pet_status / pet_notice：每次调用自带 hello 心跳（登记+事件一次完成）
    const who = currentAgentId(args);
    const hello = await helloAgent(b, { agentId: who, kind }, { fetchImpl });
    if (!hello.ok || !(hello.body && hello.body.ok === true)) {
      const reason = hello.body && hello.body.message ? hello.body.message : hello.error || `HTTP ${hello.status}`;
      return toolError(id, `hello 失败：${reason}`);
    }
    const body = toolEventsBody(name, args, { agentId: who });
    const r = await postEvent(b, body, { fetchImpl });
    if (!r.ok) return toolError(id, `POST /events 失败：HTTP ${r.status} ${r.text || r.error || ''}`);
    return toolOk(id, r.body);
  }

  /** 处理一条已解析的 JSON-RPC 消息；notification（无 id）→ null（不回包） */
  async function handleMessage(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rpcError(null, -32600, 'invalid request');
    const id = raw.id;
    const hasId = id !== undefined && id !== null;
    const method = str(raw.method);
    const params = raw.params && typeof raw.params === 'object' ? raw.params : {};
    if (!hasId) return null; // notification：不回包（含 initialized）
    try {
      switch (method) {
        case 'initialize': {
          initialized = true;
          kind = kindFromClientInfo(params.clientInfo);
          agentId = `${kind}@${host}`;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
              capabilities: { tools: {} },
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call':
          return await handleToolCall(id, params);
        default:
          return rpcError(id, -32601, 'method not found: ' + method);
      }
    } catch (e) {
      return rpcError(id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  /** 处理一行（newline-delimited）；返回要写出去的 JSON 字符串或 null（notification/空行） */
  async function handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return null;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(rpcError(null, -32700, 'parse error'));
    }
    const res = await handleMessage(raw);
    return res === null ? null : JSON.stringify(res);
  }

  /**
   * 退出收敛（stdin close 后调）：尽力 POST /events {status:'idle'}（1s 超时）→ 由调用方 exit 0。
   * 从没 initialize 过的会话不发（没登记过，无需收敛）；失败不抛——agent 已经没了，
   * 桌宠那边 TTL 60s 兜底（§4.7 三层收敛的最后一层）。
   */
  async function idleBestEffort() {
    if (!initialized) return;
    try {
      const b = await resolveBase();
      if (!b) return;
      await postEvent(b, { agentId: agentId || `${kind}@${host}`, status: 'idle' }, { timeoutMs: 1000, fetchImpl });
    } catch {
      /* 尽力而为：收敛失败由 TTL 兜底 */
    }
  }

  return { handleMessage, handleLine, idleBestEffort };
}

/**
 * stdio 接线：newline-delimited 读 → handleLine → 写回；close/end → 等在途请求收尾 →
 * 尽力 idle → exit(0)。stdin/stdout/exit 全部可注入（测试不起真管道）。
 */
export async function serveStdio(server, options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const exit = options.exit ?? ((code) => process.exit(code));
  let buffer = '';
  // 串行处理：一行响应落盘再处理下一行（JSON-RPC over stdio 的请求/响应语义；
  // 乱序回包虽不违约，但客户端与人都按序读，确定性更好排查）
  let chain = Promise.resolve();

  const pump = (line) => {
    chain = chain
      .then(() => server.handleLine(line))
      .then((out) => {
        if (out !== null && out !== undefined) stdout.write(out + '\n');
      })
      .catch((e) => {
        // 单行处理炸了不该杀 server：回一个 error 行（不静默），链继续
        stdout.write(JSON.stringify(rpcError(null, -32603, e instanceof Error ? e.message : String(e))) + '\n');
      });
  };

  const onData = (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pump(line);
    }
  };
  stdin.on('data', onData);

  await new Promise((resolve) => {
    stdin.on('close', resolve);
    stdin.on('end', resolve);
  });
  stdin.off?.('data', onData);
  // 尾巴上没换行的残行也当一行处理（个别 client 最后一帧不带 \n）
  if (buffer.trim()) pump(buffer);
  buffer = '';
  await chain; // 等在途请求全部按序收尾（agent 可能 close 的同时还有 in-flight tools/call）
  await server.idleBestEffort();
  exit(0);
}

/** --base 解析（跳过发现；冒烟/测试注入用） */
function baseFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && i + 1 < argv.length) return argv[i + 1].trim();
  }
  return '';
}

// ---------- 直接运行入口（被 import 时不跑：测试要） ----------
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const server = createMcpServer({ base: baseFromArgv(process.argv.slice(2)) });
  await serveStdio(server);
}
