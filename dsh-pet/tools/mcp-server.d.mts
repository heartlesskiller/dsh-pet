/**
 * `mcp-server.mjs` 的类型声明（与 `shortcut-spec.d.mts` 同一理由：
 * 实现是纯 JS、由 node 直接跑；单测在 `src/` 下用 TS 写）。
 */

/** 一个 MCP tool 声明（最小子集：name + description + JSON Schema） */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: McpTool[];

/** clientInfo.name → kind 猜型（workbuddy / codex / claude-code / custom） */
export function kindFromClientInfo(clientInfo: unknown): string;

/** tools/call 的 name+arguments → `/events` 请求体（纯函数；pet_agents 返回 null） */
export function toolEventsBody(
  name: string,
  args: unknown,
  ctx: { agentId: string },
): Record<string, unknown> | null;

export interface McpServer {
  /** 处理一条已解析的 JSON-RPC 消息；notification（无 id）→ null */
  handleMessage(raw: unknown): Promise<Record<string, unknown> | null>;
  /** 处理一行（newline-delimited）；返回要写出的 JSON 字符串或 null */
  handleLine(line: string): Promise<string | null>;
  /** 退出收敛：尽力 POST /events {status:'idle'}（1s 超时）；从不 initialize 过则跳过 */
  idleBestEffort(): Promise<void>;
}

export interface McpServerOptions {
  /** 直接指定 API base（跳过发现；冒烟/测试用） */
  base?: string;
  /** 注入 fetch（测试不碰真网络） */
  fetchImpl?: typeof fetch;
  /** 注入主机名（测试钉 agentId） */
  host?: string;
}

/** stdin 的最小形状（process.stdin 与测试的 PassThrough 都满足） */
export interface StdinLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface StdoutLike {
  write(chunk: string): unknown;
}

export interface ServeStdioOptions {
  stdin?: StdinLike;
  stdout?: StdoutLike;
  exit?: (code: number) => void;
}

export function createMcpServer(options?: McpServerOptions): McpServer;
export function serveStdio(server: McpServer, options?: ServeStdioOptions): Promise<void>;
