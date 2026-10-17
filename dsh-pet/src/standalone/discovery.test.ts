/**
 * 发现目录测试：写入/读回/pid 校验删除/坏文件跳过/端口扫描兜底（注入探针）。
 * 全部在临时目录，不碰真实 DSH_HOME。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DISCOVERY_BASE_PORT,
  gatewayRecordPath,
  gatewaysDir,
  listGatewayRecords,
  parseGatewayRecord,
  removeGatewayRecord,
  scanGatewayPorts,
  writeGatewayRecord,
  type GatewayRecord,
} from './discovery.ts';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-discovery-'));
}

function record(over: Partial<GatewayRecord> = {}): GatewayRecord {
  return {
    schema: 1,
    instanceId: 'inst-1',
    mode: 'standalone',
    url: 'http://127.0.0.1:3080',
    routePrefix: '/dsh-pet-7340',
    port: 3080,
    pid: process.pid,
    startedAt: '2026-10-18T00:00:00.000Z',
    capabilities: ['presence'],
    tokenRequired: false,
    ...over,
  };
}

test('写入 → 目录/文件落位；原子写不残留 .tmp', () => {
  const home = tmpHome();
  try {
    const file = writeGatewayRecord(record(), home);
    assert.ok(existsSync(file));
    assert.ok(file.endsWith(join('gateways', String(process.pid) + '.json')));
    assert.deepEqual(readdirSync(gatewaysDir(home)), [String(process.pid) + '.json'], '没有 .tmp 残留');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('读回：存活 pid 的实例被返回；stale（pid 已死）被滤除但不删文件', () => {
  const home = tmpHome();
  try {
    writeGatewayRecord(record({ pid: 1111, instanceId: 'alive' }), home);
    writeGatewayRecord(record({ pid: 2222, instanceId: 'dead' }), home);
    const alive = listGatewayRecords(home, (pid) => pid === 1111);
    assert.deepEqual(alive.map((r) => r.instanceId), ['alive']);
    assert.ok(existsSync(gatewayRecordPath(2222, home)), 'stale 文件保留（让用户可见残骸）');
    // 两个都活 → 按启动时间排序
    const both = listGatewayRecords(home, () => true);
    assert.equal(both.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('删除：pid 不匹配 → 拒绝（绝不删别人的文件）；匹配 → 删除', () => {
  const home = tmpHome();
  try {
    writeGatewayRecord(record({ pid: 3333 }), home);
    assert.equal(removeGatewayRecord(9999, home), false, '不是我 pid 的文件不许删');
    assert.ok(existsSync(gatewayRecordPath(3333, home)));
    assert.equal(removeGatewayRecord(3333, home), true);
    assert.ok(!existsSync(gatewayRecordPath(3333, home)));
    assert.equal(removeGatewayRecord(3333, home), false, '已经删了再删 → false，不抛');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseGatewayRecord：形状不对一律 undefined（schema/字段/类型）', () => {
  assert.ok(parseGatewayRecord(record()));
  assert.equal(parseGatewayRecord(null), undefined);
  assert.equal(parseGatewayRecord([]), undefined);
  assert.equal(parseGatewayRecord({ ...record(), schema: 2 }), undefined);
  assert.equal(parseGatewayRecord({ ...record(), pid: 0 }), undefined);
  assert.equal(parseGatewayRecord({ ...record(), port: '3080' }), undefined);
  assert.equal(parseGatewayRecord({ ...record(), mode: 'bogus' }), undefined);
  assert.equal(parseGatewayRecord({ ...record(), instanceId: '' }), undefined);
});

test('读目录：坏 JSON 文件跳过，不拖垮整个列表', () => {
  const home = tmpHome();
  try {
    writeGatewayRecord(record({ instanceId: 'good' }), home);
    writeFileSync(join(gatewaysDir(home), 'broken.json'), '{ not json', 'utf8');
    writeFileSync(join(gatewaysDir(home), 'ignore.txt'), 'x', 'utf8');
    const list = listGatewayRecords(home, () => true);
    assert.deepEqual(list.map((r) => r.instanceId), ['good']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('目录不存在 → 空列表（不炸）', () => {
  assert.deepEqual(listGatewayRecords(join(tmpHome(), 'nope'), () => true), []);
});

test('端口扫描兜底：注入探针，只回活着的端口（按升序）', async () => {
  const probed: number[] = [];
  const found = await scanGatewayPorts(async (port) => {
    probed.push(port);
    return port === DISCOVERY_BASE_PORT + 1 || port === DISCOVERY_BASE_PORT + 3;
  }, 5);
  assert.deepEqual(found, [DISCOVERY_BASE_PORT + 1, DISCOVERY_BASE_PORT + 3]);
  assert.equal(probed.length, 5, '扫满 5 个端口（上限可注入）');
});

test('端口扫描兜底：单个端口探测抛错不影响其余', async () => {
  const found = await scanGatewayPorts(async (port) => {
    if (port === DISCOVERY_BASE_PORT) throw new Error('ECONNREFUSED');
    return port === DISCOVERY_BASE_PORT + 2;
  }, 4);
  assert.deepEqual(found, [DISCOVERY_BASE_PORT + 2]);
});
