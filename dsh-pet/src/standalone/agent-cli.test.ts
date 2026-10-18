/**
 * CLI 纯逻辑测试（docs/19 §8 A7）：argv 解析（缺 kind 默认 custom、--base 覆盖）、
 * agentId 缺省 `<kind>@<host>`、退出码口径（0 成功 / 1 不在场或网络失败 / 2 参数错）。
 *
 * 执行层用注入的假 io + 假 fetch 跑（不碰真网络、不碰真发现目录）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NOTIFY_SEVERITIES, NOTIFY_STATUSES, main, notifyArgsFromArgv } from '../../tools/dsh-pet-notify.mjs';

// ---------- argv 解析（纯函数） ----------

test('最小用法：--status working → kind 缺省 custom、agentId 缺省 <kind>@<host>', () => {
  const r = notifyArgsFromArgv(['--status', 'working'], 'MY-PC');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'custom', 'kind 缺省 custom');
  assert.equal(r.value.agentId, 'custom@MY-PC', 'agentId 缺省 <kind>@<主机名>');
  assert.equal(r.value.status, 'working');
  assert.equal(r.value.base, '', '没给 --base → 走发现');
});

test('--kind workbuddy → agentId 跟着变（workbuddy@MY-PC）', () => {
  const r = notifyArgsFromArgv(['--kind', 'workbuddy', '--status', 'thinking'], 'MY-PC');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'workbuddy');
  assert.equal(r.value.agentId, 'workbuddy@MY-PC');
});

test('--agent-id 显式覆盖缺省', () => {
  const r = notifyArgsFromArgv(['--agent-id', 'my-agent', '--status', 'idle'], 'MY-PC');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.agentId, 'my-agent');
});

test('--base 覆盖（冒烟/测试注入，跳过发现）', () => {
  const r = notifyArgsFromArgv(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--status', 'working'], 'MY-PC');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.base, 'http://127.0.0.1:8231/dsh-pet-7340');
});

test('notice 组合：--severity + --text（+ 可选 --coalesce-key）', () => {
  const r = notifyArgsFromArgv(['--severity', 'error', '--text', '构建失败', '--coalesce-key', 'build-fail'], 'MY-PC');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.severity, 'error');
  assert.equal(r.value.text, '构建失败');
  assert.equal(r.value.coalesceKey, 'build-fail');
});

test('--list-agents / --help 直达（不需要 status/notice）', () => {
  const list = notifyArgsFromArgv(['--list-agents'], 'MY-PC');
  assert.equal(list.ok, true);
  if (list.ok) assert.equal(list.value.listAgents, true);
  const help = notifyArgsFromArgv(['--help'], 'MY-PC');
  assert.equal(help.ok, true);
  if (help.ok) assert.equal(help.value.help, true);
  const short = notifyArgsFromArgv(['-h'], 'MY-PC');
  assert.equal(short.ok, true);
});

test('status/severity 枚举校验（与 host 口径一致，勿漂移）', () => {
  assert.deepEqual(NOTIFY_STATUSES, ['idle', 'thinking', 'working', 'waiting-approval', 'done', 'error']);
  assert.deepEqual(NOTIFY_SEVERITIES, ['info', 'warning', 'error']);
  const bad = notifyArgsFromArgv(['--status', 'exploded'], 'MY-PC');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /status/);
  const badSev = notifyArgsFromArgv(['--severity', 'fatal', '--text', 'x'], 'MY-PC');
  assert.equal(badSev.ok, false);
});

test('参数错一律 {ok:false, message}（缺值 / 空 notice / 未知 flag）', () => {
  assert.equal(notifyArgsFromArgv(['--status'], 'MY-PC').ok, false);
  assert.equal(notifyArgsFromArgv(['--severity', 'info', '--text', '   '], 'MY-PC').ok, false);
  assert.equal(notifyArgsFromArgv(['--severity', 'info'], 'MY-PC').ok, false, '有 severity 没 text');
  assert.equal(notifyArgsFromArgv([], 'MY-PC').ok, false, '什么都没有');
  assert.equal(notifyArgsFromArgv(['--bogus'], 'MY-PC').ok, false, '未知参数');
});

test('task 与 status 同段：单独给 task / idle 带 task 都明说（host 会 400，提前拦）', () => {
  const alone = notifyArgsFromArgv(['--task', 'pnpm test'], 'MY-PC');
  assert.equal(alone.ok, false);
  if (!alone.ok) assert.match(alone.message, /task/);
  const withIdle = notifyArgsFromArgv(['--status', 'idle', '--task', 'x'], 'MY-PC');
  assert.equal(withIdle.ok, false);
  if (!withIdle.ok) assert.match(withIdle.message, /idle/);
  // 正路：working + task
  const ok = notifyArgsFromArgv(['--status', 'working', '--task', 'pnpm test'], 'MY-PC');
  assert.equal(ok.ok, true);
});

// ---------- 执行层（假 fetch + 假 io） ----------

/** 记录型假 fetch（按 URL 片段分流） */
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
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(preset.body ?? {}) } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":"not found"}' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } };
}

/** 把假 fetch 织进 discoverGatewayBase 不可行的边界：--base 显式给，发现逻辑不跑 */
test('main：--base 给裸 origin（不带 /dsh-pet-7340）也收（冒烟常用给法，自动补前缀）', async () => {
  const { impl, calls } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: true } },
  });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231', '--status', 'working'], { ...io, fetchImpl: impl });
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['http://127.0.0.1:8231/dsh-pet-7340/agents/hello', 'http://127.0.0.1:8231/dsh-pet-7340/events'],
    '裸 origin 自动补路由前缀',
  );
});

test('main：--status working 全链路（hello + events，各一次 POST，退出码 0）', async () => {
  const { impl, calls } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: true } },
  });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--kind', 'workbuddy', '--status', 'working', '--task', 'pnpm test'], {
    ...io,
    fetchImpl: impl,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2, 'hello + events 正好两次');
  assert.equal((calls[0].body as { kind: string }).kind, 'workbuddy');
  const agentId = (calls[0].body as { agentId: string }).agentId;
  assert.match(agentId, /^workbuddy@/, 'agentId 缺省 <kind>@<host>');
  assert.deepEqual(calls[1].body, { agentId, status: 'working', task: 'pnpm test' });
  assert.equal(io.out.length, 1, '一行 JSON 回执');
  assert.equal(JSON.parse(io.out[0]).ok, true);
});

test('main：--status idle（退出清理）→ events 只带 idle，不带 task', async () => {
  const { impl, calls } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: true } },
  });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--status', 'idle'], { ...io, fetchImpl: impl });
  assert.equal(code, 0);
  assert.deepEqual(calls[1].body, { agentId: (calls[0].body as { agentId: string }).agentId, status: 'idle' });
});

test('main：notice（severity+text+coalesce-key）→ events body 形状', async () => {
  const { impl, calls } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: true } },
  });
  const io = captureIo();
  const code = await main(
    ['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--kind', 'codex', '--severity', 'error', '--text', '构建失败', '--coalesce-key', 'build-fail'],
    { ...io, fetchImpl: impl },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[1].body, {
    agentId: (calls[0].body as { agentId: string }).agentId,
    notice: { severity: 'error', text: '构建失败', coalesceKey: 'build-fail' },
  });
});

test('main：--list-agents → GET /agents，原样打印，退出码 0', async () => {
  const { impl, calls } = fakeFetch({ '/agents': { body: { ok: true, agents: [{ agentId: 'a', kind: 'codex' }] } } });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--list-agents'], { ...io, fetchImpl: impl });
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(JSON.parse(io.out[0]), { ok: true, agents: [{ agentId: 'a', kind: 'codex' }] });
});

test('main：桌宠不在场（hello 非 2xx）→ 退出码 1，stderr 明说（不静默）', async () => {
  const { impl, calls } = fakeFetch({ '/agents/hello': { status: 400, body: { error: 'bad' } } });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--status', 'working'], { ...io, fetchImpl: impl });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, 'hello 就失败：不发 events');
  assert.match(io.err.join(''), /hello 失败/);
  assert.equal(io.out.length, 0, '失败不打印假回执');
});

test('main：桌宠拒绝驱动（HTTP 200 + ok:false，如 no-active-pet）→ 退出码 1', async () => {
  const { impl } = fakeFetch({
    '/agents/hello': { body: { ok: true, leaseId: 'L1', ttlSec: 60, granted: [] } },
    '/events': { body: { ok: false, reason: 'no-active-pet', message: '没有可显示的桌宠' } },
  });
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--status', 'working'], { ...io, fetchImpl: impl });
  assert.equal(code, 1, 'ok:false 是业务失败，退出码必须非零');
  assert.match(io.err.join(''), /no-active-pet/);
});

test('main：网络失败（fetch 抛错）→ 退出码 1', async () => {
  const impl = (async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8231');
  }) as unknown as typeof fetch;
  const io = captureIo();
  const code = await main(['--base', 'http://127.0.0.1:8231/dsh-pet-7340', '--status', 'working'], { ...io, fetchImpl: impl });
  assert.equal(code, 1);
  assert.match(io.err.join(''), /ECONNREFUSED|不可达/);
});

test('main：参数错 → 退出码 2 + usage（不碰网络）', async () => {
  const { impl, calls } = fakeFetch({});
  const io = captureIo();
  const code = await main(['--status', 'exploded'], { ...io, fetchImpl: impl });
  assert.equal(code, 2);
  assert.equal(calls.length, 0, '参数错不发请求');
  assert.match(io.out.join(''), /用法/);
});

test('main：--help → 退出码 0 打印 usage（不碰网络）', async () => {
  const { impl, calls } = fakeFetch({});
  const io = captureIo();
  const code = await main(['--help'], { ...io, fetchImpl: impl });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(io.out.join(''), /dsh-pet-notify/);
});
