# V1 完成报告（2026-10-18）

> 主理人汇报｜ 分支 `feat/relay-management` HEAD=`f588509`｜ 全部验证由主理人亲手复跑
> 本轮按用户指令「继续工作，直到完成整个项目」推进；T06 由团队工程师交付、T07 因 429 限流由主理人接手实现。

---

## 0. TL;DR

**V1 计划内所有不依赖外部输入的项全部完成**：T01–T08 + S0 + T06（设置页管理 UI）+ T07（宿主无关网关），共 6 个里程碑闭环。
五个门禁全绿：**930 例测试 929 过 0 失败 1 平台跳过**、typecheck / lint / bundle / check:openapi（29 路径 34 操作）全过；CLI 真跑冒烟通过。
剩余未完成项只有两类：**等你提供素材的真站验证（V1–V4、T09 sub2api、T12 VoAPI）**，以及**明确划在 V2/V1.5 的项（凭证加密、历史快照、S1 路由抽离）**。

---

## 1. V1 任务清单状态

| 任务 | 内容 | 状态 | 证据 |
|---|---|---|---|
| T01 | S0 单实例锁 + 端口被占即失败 | ✅ | `b88b6e7`，本轮冒烟又修了「全新 DSH_HOME 锁父目录缺失」 |
| T02 | newapi 适配器真站化（三级链路 + 四守卫） | ✅ | `82cc069`，`/api/status` 活数据复测 |
| T03 | detect / models / focus 三端点 | ✅ | `8798b9e` |
| T04 | 客户端消费 `sections.relays`（气泡 + 六档 + 告警去重） | ✅ | `425642a`，`verify:relays` EVIDENCE OK |
| T05 | openai-compat 适配器 + 失败退避 + 舰队 deadline | ✅ | `71236d7` |
| T06 | 设置页中转站管理 UI（CRUD/detect/凭证/手工余额/焦点/三态） | ✅ | `e9df63e`，`verify:relays-admin` 双 EVIDENCE（按 D3 砍模型矩阵渲染） |
| T07 | R0 网关：S5 能力分级 + S7 三件套 + S8 SSE + 发现机制 | ✅ | `66829c7`，真实 HTTP E2E 4 例 + CLI 冒烟 |
| T08 | 契约同步（openapi/API.md/README/合规） | ✅ | `0f73428`，check:openapi 29/34 |

### T07 交付明细（本轮主理人实现）

- **S5 能力分级**：`CapabilitySet` 四可选槽 + L0–L3 档位表 + 端点→档位投影（同路径不同方法不同档）+ `capability-missing` 第三种失败理由
- **S7 网关**：`/capabilities`（能力自述，独立模式不虚报 llm）、`/agents/hello`（60s TTL 心跳）+ `/agents`（在场列表）、`/events`（severity→priority、coalesce 去重且 error 穿透、六态归一化、与 DSH 事件源互斥）、`auth.ts`（默认全关，L3 域设计）
- **S8 SSE**：`/state/stream`（50ms 去抖、8 连接上限、25s 心跳、`Last-Event-ID` 去重、停机 closeAll）
- **发现机制**：`<DSH_HOME>/dsh-pet/gateways/<pid>.json`（原子写、pid 校验删除、stale 过滤、端口扫描兜底）
- **接线**：`handlePetRoute` 精确路径前置拦截；SSE 在 HTTP handler 前置拦截（bridge 侧 501 显式说明）；伪 ctx 加 `hostMode` 标记

---

## 2. 验证基线（五绿 + 冒烟）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm lint` | ✅ 0 error |
| `pnpm test` | ✅ **930 tests / 929 pass / 0 fail / 1 skipped**（平台相关既有跳过） |
| `pnpm bundle` | ✅ |
| `pnpm check:openapi` | ✅ 29 路径 / 34 操作 / 117 ref 全解析 / 路由双向对齐 |
| `pnpm verify:relays` | ✅ EVIDENCE OK（客户端展示链路） |
| `pnpm verify:relays-admin` | ✅ 双 EVIDENCE（管理 UI 的 API 层 + 渲染层） |
| CLI 冒烟 | ✅ 起服务 → 发现记录落盘 → `/capabilities` 正确自报 |

测试演进：757（接手时）→ **930**，净增 173 例；其中本轮 T06 +28、T07 +53、冒烟修复 +1。

---

## 3. 现在能怎么用（用户下一步）

### 3.1 独立模式起桌宠（不打开 DSH）

```bash
cd D:/dev/dsh-pet-agent/dsh-pet
pnpm bundle && node lib/standalone.js          # 默认 3080；被占会明确失败（单实例）
```

### 3.2 加一个中转站

**图形界面**：DSH 设置页 →「中转站」（order 31）→ 粘贴 URL 自动识别 → 选凭证类型（API Key 优先）→ 保存。换算率未确认会强制弹核对。

**curl**：
```bash
BASE=http://127.0.0.1:3080/dsh-pet-7340
curl -X POST $BASE/relays -H 'content-type: application/json' -d '{"name":"我的站","url":"https://站点","kind":"new-api","credential":{"kind":"api-key","secret":"sk-..."}}'
curl -X POST $BASE/relays/detect -H 'content-type: application/json' -d '{"url":"https://站点"}'
curl -X POST $BASE/relays/refresh-all
curl $BASE/relays
```

### 3.3 任意 agent 接入（一个 curl）

```bash
curl -X POST $BASE/events -H 'content-type: application/json' \
  -d '{"agentId":"my-agent","notice":{"severity":"info","text":"任务跑完了"},"status":"done"}'
curl -N $BASE/state/stream          # SSE 订阅
cat $DSH_HOME/dsh-pet/gateways/*.json   # 发现记录
```

---

## 4. 未完成项（分类，不含糊）

### A. 等你提供素材才能闭环（不是代码问题）
| # | 项 | 需要什么 |
|---|---|---|
| V1 | `/api/user/self` 账户级余额真实形状 | 一个 AccessToken 站点 |
| V2 | 非无限 Key 的 billing 剩余公式 | 一个有额度的 Key |
| V3 | Cloudflare 真拦截响应形态 | 一个被挑战过的站点 |
| T09 | sub2api 适配器 | 一个 sub2api 站点（站点不到不写代码） |
| T12 | VoAPI jwt | JWT 获取路径资料（目前全无） |

### B. 已明确排到 V2 / V1.5（不是遗漏）
- **凭证加密**（Windows DPAPI/keytar）：Q1 决策 V1 明文 + README 显著提示（已落）；改决策需你拍板
- **历史快照 + burn rate**（T11，P2）
- **S1 路由抽离**：`handleRelayRoute` 已 249 行贴 250 触发线、`index.ts` 净增 +458——V1.5 优先做
- **S6 独立模式能力填充 / S9 hooks 轨**：07 文档与 11-plan 都未排入本轮

---

## 5. Commit 序列（本分支最近 10 个）

```
f588509 fix(standalone): 冒烟抓出的两个首运行问题
66829c7 feat(gateway): T07 宿主无关网关（S5/S7/S8）
e9df63e feat(client): T06 设置页中转站管理 UI
bccdfd6 docs: 2026-10-17 晚间轮次工作汇报
0f73428 docs: T08 契约同步
71236d7 feat(relays): T05 openai-compat + 退避
425642a feat(client): T04 客户端消费 sections.relays
8798b9e feat(relays): T03 三端点
82cc069 feat(relays): T02 适配器真站化
54f98ff docs: PM 调研报告
```

未 push（等你的指令）。
