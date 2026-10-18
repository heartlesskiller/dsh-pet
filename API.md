# dsh-pet 对外 HTTP 接口一览

dsh-pet 的宿主半侧向 DSH 自己的 Web 服务注册了**一条前缀路由** `/dsh-pet-7340`，浏览器端、
桌面端、设置页与第三方插件全都访问同一份实现。本文只做**功能预览**（接口名 + 一句话），
完整契约——参数、响应体、字段含义、错误码与示例——见根目录的 [`openapi.yaml`](openapi.yaml)。

- **基址**：`http://127.0.0.1:<port>/dsh-pet-7340`，`<port>` 是 DSH Web 服务实际监听的端口
- **只监听 127.0.0.1，且没有鉴权**：任何能访问本机该端口的进程都能调用，请勿转发到公网

---

## 一、读状态

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/state` | **轮询唯一数据源**：一次拿到说话、工作状态、系统通知、余额、在场 agent 五类状态；另带 `configVersion`（配置版本指纹，变了就该重拉 `/config`） |
| `GET /dsh-pet-7340/config` | 读合并后的成品配置（内置默认 + 用户层，字段已填满） |
| `GET /dsh-pet-7340/config/meta` | 配置文件路径、各类数据落盘位置、卸载该用哪个 profile |
| `GET /dsh-pet-7340/models` | 可用服务商与模型清单（与 DSH 自己的模型选择器同源） |
| `GET /dsh-pet-7340/chat?pet=` | 读某只桌宠最近的对话记忆窗口 |

## 二、让桌宠做事

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/whisper?pet=` | 让桌宠**生成**一句碎碎念（走当前模型） |
| `POST /dsh-pet-7340/broadcast?pet=` | **第三方投喂**：把外部给定的文本直接写进气泡（不生成，只搬运） |
| `POST /dsh-pet-7340/anim?pet=` | **点播动画**：让桌宠播一段指定动画，效果与右键「动作」菜单一致 |
| `POST /dsh-pet-7340/chat?pet=` | 对桌宠说一句话并生成回复，同时写入对话记忆 |
| `POST /dsh-pet-7340/balance` | 立即刷新一次余额 |
| `POST /dsh-pet-7340/reload` | 重载桌面端（重启桌面宠物进程，按最新配置重建窗口） |

## 三、改配置

| 接口 | 功能 |
| --- | --- |
| `PUT /dsh-pet-7340/config` | 保存用户层配置（白名单重建，用户手写的精调字段会保留） |
| `POST /dsh-pet-7340/pet-display` | **改单只宠物的显示位置**（`web` / `desktop` / `both` / `none`）：只传 `{ id, display }`，**不必回传整段 pets**——写哪一层（主配置还是 `pet/<前缀>-config.json`）由宿主按 id 反查；两端右键菜单「显示位置」走的就是它。返回改动后的成品聚合 |
| `POST /dsh-pet-7340/config` | 用内置默认整份覆盖用户配置，即「恢复默认」 |

## 四、素材

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/thumb/{petId}/{file}` | 动画素材（`.webm` / `.mov`，按宠物归属） |
| `GET /dsh-pet-7340/font/{file}` | 字体文件 |
| `GET /dsh-pet-7340/pic/{file}` | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属） |

---

## 五、中转站管理（`/relays`）

管理多个 LLM API 中转站的资产：余额 / 健康状态 / 模型清单 / 焦点站点。**本子域是「数据直返」
例外**——动作类端点直接返回结果数据而不是 `{ ok }`（agent 一次调用就要拿到结果）；
该例外**只限 `/relays` 子域**，不扩散到 `/balance`、`/whisper` 等既有端点。

| 接口 | 功能 |
| --- | --- |
| `GET /relays` | 全部站点脱敏视图（`credential.masked`，**绝不明文**） |
| `POST /relays` | 新建站点（body = 站点字段 + 可选 `credential`） |
| `PUT /relays/{id}` | 更新站点（可同时更新/清除凭证） |
| `DELETE /relays/{id}` | 删站点并删凭证（不留孤儿密钥） |
| `POST /relays/refresh-all` | 并发刷新全部启用站点 → 各站结果数组 |
| `POST /relays/{id}/refresh` | 刷新该站余额 → `RelayBalanceResult` |
| `POST /relays/{id}/health` | 连通性探测 → `RelayHealthResult` |
| `POST /relays/{id}/manual-balance` | 设置/清除手工余额（空 `amount` = 清除） |
| `POST /relays/detect` | 站点类型识别（**不落库**；body = `{url, credential?}`） |
| `GET /relays/models` | 模型清单矩阵（只读缓存聚合，不外发抓取） |
| `POST /relays/{id}/models` | 实时抓取该站模型清单并写缓存 |
| `POST /relays/focus` | 设置/清除焦点站点（body = `{siteId}`，空 = 清除） |

几个要知道的点：

- **凭证明文零外泄**：站点与凭证分文件存储（`relays.json` 无任何密钥字段，
  `relay-credentials.json` 只放密钥）；每个响应体返回前过脱敏自检，**检出明文凭证该请求
  直接失败**——宁可端点坏掉，不泄露。
- **余额结果六种 reason**：`unsupported` / `credential-missing` / `fetch-error` /
  `manual`（降级路径：手工填写，带「手工」标签与填写时间）/ `blocked`（被 Cloudflare /
  反代 / Bot Detection 拦）/ `rate-limited`（站点 429 或失败退避中）。**绝不伪造 0 余额。**
- **无限额度**：`unlimited_quota` 或 `hard_limit_usd >= 1e8` 哨兵站显示「无限额度 ·
  已用 $X」，不参与低余额告警、不计入舰队合计。
- **换算率**：默认 500000 quota = $1，可按站覆盖；探测不到会标 `rateUnconfirmed`
  （客户端提示核对，未确认站不告警）——**绝不静默默认**。
- **错误口径**：结构性参数错误（坏 JSON / 缺字段 / 站点不存在）→ 4xx + `{ error }`；
  业务失败 → HTTP 200 + `{ ok: false, reason }`（与 `/whisper` 同形）。

## 六、宿主无关网关（让任意 agent 接入）

让**不跑 DSH 的 agent**（Claude Code / Codex / WorkBuddy / 自己的脚本）也能用上桌宠：自述能力、登记在场、
推送气泡与六档工作状态、订阅状态流。设计依据见
[`docs/07-architecture-host-agnostic.md`](docs/07-architecture-host-agnostic.md) 与
[`docs/19-agent-adapter-design.md`](docs/19-agent-adapter-design.md)。

| 接口 | 档位 | 功能 |
| --- | --- | --- |
| `GET /capabilities` | L0 在场 | 能力自述：`mode`（standalone/dsh）、四个能力槽（llm/credentials/account/sessionEvents）、L0–L3 档位表、`relayKinds`、`instanceId` |
| `POST /agents/hello` | L0 在场 | 登记/心跳（TTL 60s，重复调用即续期；`leaseId` 不变） |
| `GET /agents` | L1 只读 | 在场 agent 列表（过期自动滤除） |
| `POST /events` | L2 驱动 | 事件摄入：`notice`（气泡，severity + coalesceKey 去重）与 `status`（六档，可带 `task` 任务详情 ≤40 码点） |
| `GET /state/stream` | L1 只读 | SSE 推送版状态（50ms 去抖、上限 8 连接、`Last-Event-ID` 去重） |

`GET /state` 另有一个 `sections.agents` 段（在场列表投影）：`{ agents: [{agentId, kind, state, task, lastSeenAt, expiresAt}], activeCount }`，
与 `sections.workStatus` **同源分工**——workStatus 答「桌宠该播哪档动画」（单值），agents 答「谁在场、各自什么状态」（列表）。

**三种 transport，协议只有一份**（都序列化成同一份 `POST /events`；选哪种看 agent 的形态）：

| transport | 适合谁 | 用法 |
| --- | --- | --- |
| **HTTP（curl）** | 任何能发 HTTP 的脚本 / cron | `curl -X POST .../events -d '{"agentId":"me","status":"working","task":"pnpm test"}'` |
| **CLI** `tools/dsh-pet-notify.mjs` | hook 脚本 / 无 MCP 的 agent | `node tools/dsh-pet-notify.mjs --kind workbuddy --status working --task "pnpm test"`（每次调用自带 hello 心跳；退出清理 `--status idle`） |
| **MCP server** `tools/mcp-server.mjs` | WorkBuddy / Codex / Claude Code 等有 MCP client 的 agent | mcpServers 配置指向该文件（stdio）；暴露 `pet_status` / `pet_notice` / `pet_agents` 三个 tool；stdio 关闭时自动补发 idle（收敛 ~0s） |

CLI 与 MCP 的**发现逻辑**：先读 `<DSH_HOME>/dsh-pet/gateways/*.json`（pid 活性校验），空/全失效时扫描
`127.0.0.1:3080..3104` 兜底；也可用 `--base` 直接指定。找不到桌宠时 CLI **exit 1**（hook 脚本可感知，不静默）。

**三条使用须知**：

- **一个 curl 就能接入**：`curl -X POST .../events -d '{"agentId":"me","notice":{"severity":"info","text":"跑完了"}}'`
  —— 事件写进**既有叶子**（气泡 = `pets.<id>.say`、六档 = `sections.workStatus`），前端零改动。
- **互斥规则**：`/capabilities` 的 `sessionEvents === "dsh"` 时（DSH 会话事件在场），`/events` 的
  `status` 段（**含 `task`**）会被忽略，只处理 `notice`——避免六档被两个源同时改写而抖动。
- **发现机制**：独立模式启动后会在 `<DSH_HOME>/dsh-pet/gateways/<pid>.json` 留一份发现记录
  （实例 id / 端口 / 能力），外部工具据此「看见」桌宠；进程被杀后记录自动判 stale。
  注意 **S0 之后端口不再顺延**：第二个实例会明确失败，不会偷偷起在 3081。
- **未注册的 agent 类型**照样能接入：`kind` 是自由字符串，桌宠侧按降级元数据显示（👾 + 原样 kind），**不拒绝**。

## 三条要记住的约定

1. **数据只有一个出口**：`GET /state`。它返回宿主内存里的已发布状态，每个状态位是
   `{ counter, data }`。
2. **动作端点不返回数据**：上表第二节与第三节的 `POST` 只回 `{ ok: true }`，表示"动作做完了"；
   结果写进状态，调用方随后拉一拍 `/state` 即可看到（立刻补拉就是 0 延迟，不必等下一个轮询周期）。
   **唯一例外是 `/relays` 子域**（见第五节）：它的动作端点直接返回结果数据——那是机器接口
   子域的明确契约决策，**不许扩散**到其他端点。
3. **`counter` 变了才渲染**：它是 `Date.now()` 且严格递增，宿主重启也不会倒退。
   状态位的路径（如 `sections.balance`、`sections.relays`、`pets.<id>.say`）请当作**不透明键**使用——
   宠物 id 允许含点号，**不要按 `.` 切分**。

## 快速试一下

```bash
BASE=http://127.0.0.1:<port>/dsh-pet-7340

# 拉一次状态（只读、零副作用，可以随便轮询）
curl -s $BASE/state

# 让桌宠说一句外部给的话，然后立刻回读状态
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕，一切正常"}'
curl -s $BASE/state   # → pets.main.say.data.text

# 让它播一段动画（名字取自 GET /config 里**该宠物所属条目**的 animations：
#  main 条目的宠物用 main 的池，pet/<名>-config.json 的种类各用自己的池）
curl -s -X POST "$BASE/anim?pet=main" \
     -H 'content-type: application/json' \
     -d '{"name":"东张西望"}'

# 中转站：识别一个站点的类型（不落库；带 API Key 时识别更准）
curl -s -X POST "$BASE/relays/detect" \
     -H 'content-type: application/json' \
     -d '{"url":"https://你的中转站"}'
# → { ok: true, detect: { kind: "new-api", confidence: "likely", evidence: [...], suggestedQuotaPerUnit: 500000 } }
```

## 独立模式（不打开 DSH）

不启动 DSH 时，同一份 `/dsh-pet-7340` 契约由一个本机 HTTP 服务提供（`src/standalone/server.ts`，
用法见 [`dsh-pet/README.md`](dsh-pet/README.md) 的「🧍 独立运行（完全不打开 DSH）」）：

```bash
BASE=http://127.0.0.1:3080/dsh-pet-7340   # 独立模式默认端口 3080（被占用会明确失败：独立模式只跑一个实例）
```

**上表所有端点与约定在这里完全不变** —— 独立模式把插件的宿主半边跑在伪 ctx 上，
路由表仍是 `src/host/index.ts` 那一份（桌面助手照旧走 bridge 管道）。因此本文件与
[`openapi.yaml`](openapi.yaml) 描述的 `/dsh-pet-7340` 契约**不需要为独立模式做任何改动**。

独立模式另外多两个只属于该服务的运维端点（不在 `/dsh-pet-7340` 前缀下，故不在 OpenAPI 契约里）：

| 端点 | 说明 |
| --- | --- |
| `GET /`、`GET /health` | 服务与插件信息：名称、插件根与版本、监听端口、已运行秒数 |
| `POST /shutdown` | 优雅停机：释放插件注册的 effect（停止桌面助手、清掉周期定时器）后关闭服务，进程退出码 0 |

依赖 DSH 的能力在独立模式下**明确降级**（结构化失败，不假装成功）：`POST /whisper`、`POST /chat`
回 `{ ok: false, reason: 'provider-missing' }`（没有模型服务），`POST /balance` 回
`{ ok: false, reason: 'unsupported' }`，`GET /state` 的各状态位保持空闲初始值。

**中转站管理（`/relays`）不依赖 DSH**：它是本项目自己的功能，独立模式下全套可用——
这正是「不打开 DSH 也能当中转站看板用」的底气。

## 相关

- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
