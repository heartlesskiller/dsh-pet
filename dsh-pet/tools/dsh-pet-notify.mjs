#!/usr/bin/env node
/**
 * dsh-pet-notify.mjs —— 桌宠通知 CLI（给没有 MCP 的 agent / hook 脚本 / cron 用）。
 * 设计依据 docs/19 §4.4(a)。
 *
 * ## 用法
 *   node tools/dsh-pet-notify.mjs --kind workbuddy --status working --task "pnpm test"
 *   node tools/dsh-pet-notify.mjs --kind codex --severity error --text "构建失败" --coalesce-key build-fail
 *   node tools/dsh-pet-notify.mjs --status idle          # 退出清理（hook on-stop 用）
 *   node tools/dsh-pet-notify.mjs --list-agents          # 调试：打印在场 agent
 *   node tools/dsh-pet-notify.mjs --base http://127.0.0.1:8231 --status working   # 冒烟/测试注入，跳过发现
 *
 * ## 两个设计决策
 * 1. **每次调用自带 hello 心跳**：登记+事件一次完成，agent 不需要理解两段协议——
 *    这是「接入成本低」的关键（与 MCP server 同口径）。
 * 2. **参数解析是纯函数**（notifyArgsFromArgv，照 tools/shortcut-spec.mjs 模式）：
 *    node:test 可测，执行层薄。agentId 缺省 `<kind>@<主机名>`（node:os hostname）。
 *
 * ## 退出码（hook 脚本要能感知，不静默——延续「查不到就明确失败」）
 *   0 = 成功；1 = 桌宠不在场 / 网络失败；2 = 参数或用例错误。
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { discoverGatewayBase, helloAgent, listAgents, localHostname, postEvent } from './pet-gateway-client.mjs';

/** `--help` 输出 */
export const USAGE = `dsh-pet-notify.mjs —— 桌宠通知 CLI（任意 agent / hook 脚本 / cron 可用）

用法：
  node tools/dsh-pet-notify.mjs --status working [--task "pnpm test"]
  node tools/dsh-pet-notify.mjs --severity error --text "构建失败" [--coalesce-key build-fail]
  node tools/dsh-pet-notify.mjs --status idle            # 退出清理（hook on-stop 用）
  node tools/dsh-pet-notify.mjs --list-agents            # 调试：打印在场 agent

参数：
  --kind <类型>       agent 类型（workbuddy / codex / claude-code / custom…；缺省 custom。
                     未登记的类型也能用——桌宠降级显示，不拒绝）
  --agent-id <id>     agent 标识（缺省 <kind>@<主机名>）
  --status <档位>     idle / thinking / working / waiting-approval / done / error
  --task <文本>       任务详情（≤40 码点；与 --status 同段给，idle 不要带）
  --severity <档位>   info / warning / error（气泡；与 --text 一起给）
  --text <文本>       气泡文本（≤500 码点）
  --coalesce-key <k>  去重键（同键 5s 窗口内不重复弹）
  --base <url>        直接指定网关（http://127.0.0.1:3080 或带 /dsh-pet-7340 全路径，两种都收；跳过发现）
  --list-agents       只列在场 agent，不驱动
  --help              本帮助

发现顺序：<DSH_HOME>/dsh-pet/gateways/*.json（pid 活性校验）→ 127.0.0.1:3080..3104 扫描兜底。
退出码：0 成功 / 1 桌宠不在场或网络失败 / 2 参数错误。
`;

/** status 六态（与 host gateway/ingest.ts 的 IngestStatus 一致，勿漂移） */
export const NOTIFY_STATUSES = ['idle', 'thinking', 'working', 'waiting-approval', 'done', 'error'];

/** notice severity 三档（与 host 的 NoticeSeverity 一致） */
export const NOTIFY_SEVERITIES = ['info', 'warning', 'error'];

/**
 * argv → 参数（**纯函数**：host 可注入，node:test 可测）。
 *
 * 缺省：kind=custom；agentId=`<kind>@<host>`。校验在解析层一次做完——
 * 参数错返回 { ok:false, message }（退出码 2），不让坏参数走到网络层。
 */
export function notifyArgsFromArgv(argv, host = localHostname()) {
  const value = {
    kind: 'custom',
    agentId: '',
    status: '',
    severity: '',
    text: '',
    coalesceKey: '',
    task: '',
    base: '',
    listAgents: false,
    help: false,
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    const next = () => {
      i += 1;
      if (i >= list.length) return null;
      return list[i];
    };
    switch (flag) {
      case '--help':
      case '-h':
        return { ok: true, value: { ...value, help: true } };
      case '--kind': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --kind 缺值' };
        value.kind = v.trim() || 'custom';
        break;
      }
      case '--agent-id': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --agent-id 缺值' };
        value.agentId = v.trim();
        break;
      }
      case '--status': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --status 缺值' };
        value.status = v.trim();
        break;
      }
      case '--severity': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --severity 缺值' };
        value.severity = v.trim();
        break;
      }
      case '--text': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --text 缺值' };
        value.text = v;
        break;
      }
      case '--coalesce-key': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --coalesce-key 缺值' };
        value.coalesceKey = v.trim();
        break;
      }
      case '--task': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --task 缺值' };
        value.task = v;
        break;
      }
      case '--base': {
        const v = next();
        if (v === null) return { ok: false, message: '参数 --base 缺值' };
        value.base = v.trim();
        break;
      }
      case '--list-agents':
        value.listAgents = true;
        break;
      default:
        return { ok: false, message: `未知参数：${flag}（--help 看用法）` };
    }
  }

  // agentId 缺省 <kind>@<host>（kind 已定，host 注入）
  if (!value.agentId) value.agentId = `${value.kind}@${host}`;

  if (value.help || value.listAgents) return { ok: true, value };

  const hasStatus = value.status.length > 0;
  const hasNotice = value.severity.length > 0 || value.text.length > 0;
  // task 同段校验放在「至少给一个」之前：单独给 task 是更具体的错误，先说具体的
  if (value.task.trim() && !hasStatus) {
    return { ok: false, message: '--task 需要与 --status 一起给（host 侧 task 挂在 status 段）' };
  }
  if (value.status === 'idle' && value.task.trim()) {
    return { ok: false, message: '--status idle 是清会话回空闲，不要同时带 --task（host 会 400）' };
  }
  if (!hasStatus && !hasNotice) {
    return { ok: false, message: '至少给 --status 或 --severity + --text（--list-agents 只列在场）' };
  }
  if (hasStatus && !NOTIFY_STATUSES.includes(value.status)) {
    return { ok: false, message: `--status 必须是 ${NOTIFY_STATUSES.join(' / ')}` };
  }
  if (hasNotice) {
    if (!NOTIFY_SEVERITIES.includes(value.severity)) {
      return { ok: false, message: `--severity 必须是 ${NOTIFY_SEVERITIES.join(' / ')}（与 --text 一起给）` };
    }
    if (!value.text.trim()) return { ok: false, message: '--text 不能为空' };
  }
  return { ok: true, value };
}

/** 执行层（薄）：发现 → hello → events → 一行 JSON 回执。返回退出码。
 *  @param io.stdout / io.stderr 输出注入（测试用）
 *  @param io.fetchImpl fetch 注入（测试不碰真网络） */
export async function main(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const http = io.fetchImpl ? { fetchImpl: io.fetchImpl } : {};
  const parsed = notifyArgsFromArgv(argv);
  if (!parsed.ok) {
    err.write(`参数错误：${parsed.message}\n`);
    out.write(USAGE + '\n');
    return 2;
  }
  const a = parsed.value;
  if (a.help) {
    out.write(USAGE + '\n');
    return 0;
  }

  const base = a.base || (await discoverGatewayBase());
  if (!base) {
    err.write('找不到桌宠网关：发现目录为空且 3080..3104 无存活实例（桌宠没起？或用 --base 指定）\n');
    return 1;
  }

  if (a.listAgents) {
    const r = await listAgents(base, http);
    if (!r.ok) {
      err.write(`GET /agents 失败：HTTP ${r.status}${r.error ? ' ' + r.error : ''}\n`);
      return 1;
    }
    out.write(JSON.stringify(r.body ?? null) + '\n');
    return 0;
  }

  // 每次调用自带 hello 心跳（登记+事件一次完成——agent 不需要理解两段协议）
  const hello = await helloAgent(base, { agentId: a.agentId, kind: a.kind }, http);
  if (!hello.ok || !(hello.body && hello.body.ok === true)) {
    const reason = hello.body && hello.body.message ? hello.body.message : hello.error || `HTTP ${hello.status}`;
    err.write(`桌宠不在场或不可达：hello 失败（${reason}）\n`);
    return 1;
  }

  const body = { agentId: a.agentId };
  if (a.status) body.status = a.status;
  if (a.task.trim()) body.task = a.task.trim();
  if (a.severity) {
    body.notice = { severity: a.severity, text: a.text.trim() };
    if (a.coalesceKey) body.notice.coalesceKey = a.coalesceKey;
  }
  const r = await postEvent(base, body, http);
  if (!r.ok) {
    err.write(`POST /events 失败：HTTP ${r.status} ${r.text || r.error || ''}\n`);
    return 1;
  }
  out.write(JSON.stringify(r.body ?? null) + '\n');
  const ok = Boolean(r.body && typeof r.body === 'object' && r.body.ok === true);
  if (!ok) {
    const reason = r.body && r.body.reason ? r.body.reason : 'unknown';
    err.write(`桌宠拒绝了这次驱动：${reason}\n`);
  }
  return ok ? 0 : 1;
}

// ---------- 直接运行入口（被 import 时不跑：测试要） ----------
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`运行失败：${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
