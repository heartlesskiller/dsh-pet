# 项目接管评估与后续规划（takeover assessment）

> 主理人：齐活林（Qi）｜ 日期：2026-10-17 ｜ 评估基线：`D:\dev\dsh-pet-agent` 分支 `feat/relay-management` HEAD=`b88b6e7`
> 输入：本工作区 `C:\Users\admin\WorkBuddy\2026-10-16-23-57-31` 全量文件 + 上一会话记忆日志 + `docs/11-plan-v1.1.md`（架构师修订规划）
> 本文是**给用户的交接文档**：现状是什么、能跑到什么程度、问题在哪、接下来怎么干、哪些是假设与风险。

---

## 0. TL;DR

- **项目真相**：本工作区里的 `relay_pet`（Tauri 桌宠）已被上一会话**主动弃置**；活跃项目是 fork 上游 `dsh-pet` 的 `D:\dev\dsh-pet-agent`（用户要求：全部项目文件在 D 盘）。接手对象 = 后者。
- **完成度**：中转站功能的宿主侧（契约/持久化/脱敏/编排/8 端点/状态叶）**代码已完成且 756 测试全绿**；一个 new-api 真站已端到端实测；**客户端（桌宠 UI）零消费、适配器落后于真站结论、三个端点与两个适配器未写、API 文档未同步**。
- **可运行性**：`pnpm typecheck` / `pnpm lint` / `pnpm test`（757 例，1.8s 干净退出）**三绿**；沙箱内不能起 GUI，视觉验证需用户桌面。
- **本轮已修复并提交**：S0 单实例锁在途的 2 个测试缺陷 + 1 个 lint 错误（`b88b6e7`），全量测试从「600s 跑不完」恢复为 1.8s 干净退出。
- **后续规划**：见架构师 `docs/11-plan-v1.1.md`——12 个任务分 3 里程碑，**优先级裁决：适配器真站化 → 客户端消费 → R0 网关**，关键路径约 7–9 个工作日到 M2。
- **最需要用户的三样东西**：一个 AccessToken 站点、一个有额度（非无限）的 Key、一个被 Cloudflare 拦过的站点（sub2api 站点次之）。

---

## 1. 接管范围与「两个项目」的关系

| 目录 | 是什么 | 状态 |
|---|---|---|
| `C:\Users\admin\WorkBuddy\2026-10-16-23-57-31\relay_pet` | 自建 Tauri v2 桌宠（M1：透明窗/穿透/托盘/皮肤通道，67 测试全绿，git 干净） | **已弃置**（10-17 用户指出漏掉热门同类项目 dsh-pet，定位失真，方向变更） |
| `C:\Users\admin\WorkBuddy\2026-10-16-23-57-31\docs\` | 原路线的调研/PRD/架构/任务分解（01–04 + mermaid） | 历史文档，保留备查 |
| `D:\dev\dsh-pet-agent` | **fork dsh-pet 的活跃项目**（分支 `feat/relay-management`，10 个 commit） | **接手对象** |
| `D:\dev\dsh-pet-agent\dsh-pet\` | 上游 v0.3.7 包（Cordis 插件 + Electron Helper + React 客户端），fork 定制都在这里 | 活跃代码 |
| `D:\dev\dsh-pet-agent\docs\` | 新路线全部决策文档（PLAN-v1、06/06b/07/08、10 真站报告、11 修订规划） | 6 份 untracked，本轮已提交 |

上游合规红线（继承）：代码 MIT；**素材禁商用**；二创在任何介绍/展示/分发处**必须附原作者地址** `https://github.com/PC2005-cloud/dsh-pet`；本项目定位个人自用/开源免费。

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node ≥ 22.12（ESM，`--experimental-strip-types` 直跑 TS） | 无构建依赖即可测试 |
| 包管理 | pnpm workspace（单包 `dsh-pet`） | 全部装在 D 盘 |
| 桌面壳 | Electron（上游 Helper 进程，每桌宠一个 220×220 局部窗） | 由上游提供，本项目未改 |
| 前端 | React 18（经 DSH 客户端插槽注入 `h`/jsx-runtime） | 桌宠页 `client/pet.ts` + 设置页 `client/settings.ts` |
| 宿主侧 | Cordis 插件半侧（`src/host/`）+ 独立模式伪 ctx（`src/standalone/`） | HTTP 路由单一 prefix handler |
| 测试 | `node:test` + 自注册 loader，**无 GUI、无网络可测**（纯函数 + 注入） | 757 例 1.8s |
| 质量门 | tsc 双配置 / eslint 10 / prettier / check:openapi（prepack 链） | 三绿 |

---

## 3. 核心模块与关键文件（relay 功能，全部宿主侧）

| 模块 | 关键文件 | 作用 |
|---|---|---|
| 契约层 | `src/host/relays/types.ts` | 站点/凭证/余额/健康/provider 契约；**复用上游 `MoneyBalance` 使客户端六档动画零改动** |
| 金额权威 | `src/host/relays/money.ts` | quota↔金额**唯一换算**（默认 500000=$1，可按站覆盖）；非法一律 throw，绝不静默当 0 |
| 适配器 | `src/host/relays/providers/newapi.ts` | one-api/new-api 系：`/api/user/self`、`/v1/models`、`/api/status`；纯函数解析可喂真站 JSON 测试 |
| 持久化 | `src/host/relays/store.ts` | 站点 `relays.json` 与凭证 `relay-credentials.json` **分文件**；原子写；损坏改名 `.corrupt-*` 留存后抛错（不静默丢） |
| 脱敏 | `src/host/relays/redact.ts` | `maskSecret/maskHeaders/containsSecret` —— 所有对外输出的唯一脱敏出口 |
| 编排 | `src/host/relays/index.ts` | 注册表、`querySiteBalance` 降级链（manual→无凭证回退手工→fetch-error）、`checkSiteHealth`、并发 4 信号量、`selectLowSites`（阈值不猜/手工值不告警）、`aggregateBalances`（多币种不混算） |
| 路由纯逻辑 | `src/host/relays/routes.ts` | 路径解析、入参校验、`assertNoSecret` 响应前自检（检出明文凭证**抛错让请求失败**，宁可端点坏不泄露） |
| 宿主接线 | `src/host/index.ts`（relay 相关 ~95 行） | `handleRelayRoute` 8 端点 + `refreshRelays` + `sections.relays` 状态叶；周期刷新挂上游 balance poll，与单服务商链路**并存不合流** |
| 状态地基 | `src/host/state.ts` | `SectionName` 已加 `'relays'`；`walkLeaves` 通配新 section |
| 独立模式 | `src/standalone/{cli,server,instance-lock,context,options}.ts` | 不开 DSH 直接跑桌宠；**S0 单实例锁**（本轮落地）：`openSync 'wx' 原子取锁 + PID 存活判定回收 stale + 端口被占明确失败绝不顺延` |

---

## 4. 完成度评估（对账 docs/11-plan-v1.1.md §1）

| 项 | 状态 | 证据 |
|---|---|---|
| R1 契约层 + newapi 适配器 | ✅ 代码完成（24+12 单测） | commit `e604146` |
| R2 持久化 + 脱敏 | ✅（17 单测） | `304d87c` |
| R2b 查询编排 | ✅（14 单测） | `8f58db0` |
| R3 宿主侧（8 端点 + 状态叶 + 周期刷新） | ✅ | `2e7aecb` |
| 真站实测（1 个 new-api 站，curl 一手证据） | ✅ | `docs/10-real-site-verification.md` |
| S0 单实例锁 | ✅ **本轮收尾提交** | `b88b6e7` |
| R3 客户端消费 `sections.relays` | ❌ **零消费**（桌宠不显示中转站余额） | `src/client/` 无 relay 代码 |
| R4 其余适配器（sub2api / openai-compat） | ❌ 未写 | 注册表只有 `newApiProvider` |
| R4 三端点（detect / models / focus） | ❌ 未实现 | `parseRelayRoute` 无对应 action |
| R5 文档契约（API.md / openapi.yaml / README） | ❌ 无 `/relays` 契约 | 仓库根两份文档 grep 无果 |
| R0 宿主无关网关 | ❌ 未开工（只有设计文档 07） | `src/standalone/` 无 gateway 代码 |

**适配器与真站结论的差距（最关键）**：当前 `providers/newapi.ts` 只打 `/api/user/self`，而真站实测 API Key 打它**必返 HTTP 200 + `{"success":false}`**——**现在这个适配器对唯一验证过的站点必败**。真站报告同时给出 9 条事实（F1–F9）：`/api/usage/token/` 才应是 API-Key 场景第一优先端点、`unlimited_quota` 布尔判据、`total_available` 可负、分 vs quota 单位、200-with-error、识别信号（`system_name`/`version` 不可靠）、CF 判定条件、`quota_per_unit` 可自动探测、`/api/pricing` 带倍率。**适配器改造是后续第一优先级**。

---

## 5. 可运行性评估

**命令基线（`D:\dev\dsh-pet-agent\dsh-pet`，本轮主理人独立复跑）**：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ 0 error（修复前 2 error） |
| `pnpm test` | ✅ **757 tests / 756 pass / 0 fail / 1 skipped**（平台相关既有跳过），1.8s 干净退出 |
| `pnpm build` / `pnpm check:openapi` | 上一会话验过 build ✅；openapi 契约未补（T08 任务） |

**环境硬限制（继承且已验证，后续任务按此规划）**：
1. 沙箱内**不能启动 GUI 进程**（Electron/WebView2 渲染进程 0.7–1.1s 后退出）→ 所有客户端/视觉任务按「沙箱内 mock-server（`scripts/dev/mock-server.mjs`）+ 单测完成 90%，**真机观感交用户桌面验证**」分工；
2. 沙箱网络层对回环空闲端口的连接行为不稳定（ECONNREFUSED/静默接受/502 四种都出现过）→ 测试不用连接级断言验证「无监听」，用「端口仍可 bind」；
3. 团队子代理曾全员 429 限流（上一会话 15:32，重置 20:36）→ 本轮已恢复正常，但仍需警惕长任务被限流打断。

---

## 6. 发现的问题（按严重度）

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| P0-1 | 适配器对唯一实测站必败（API Key 打 `/api/user/self` 必 200+success:false） | 🔴 高 | T02 适配器真站化重构（规划第一优先） |
| P0-2 | `sections.relays` 无客户端消费者——后端数据不显示，用户价值为零 | 🔴 高 | T04 客户端消费 |
| P0-3 | 全量测试曾 600s 跑不完（在途测试缺陷泄漏句柄） | 🔴 高 | ✅ **本轮已修复**（`b88b6e7`） |
| P1-1 | 无单实例锁时双实例 = 双倍轮询 → 站点 429 风险（one-api 系默认 480/180s） | 🟠 中 | ✅ **本轮已落地 S0** |
| P1-2 | `money.ts` `siteQuotaPerUnit(undefined)→500000` 仍是静默默认，违背修订 #11（`rateUnconfirmed`） | 🟠 中 | T02-3 拆除无标记兜底入口 |
| P1-3 | detect/models/focus 三端点缺失；sub2api/openai-compat 适配器缺失 | 🟠 中 | T03 / T05 / T09 |
| P1-4 | API.md/openapi.yaml 无 `/relays` 契约；check:openapi 是 prepack 门禁 | 🟠 中 | T08 |
| P1-5 | 6 份决策文档 untracked（「不入库等于没发生」） | 🟠 中 | ✅ **本轮已提交** |
| P2-1 | 凭证明文落盘（`relay-credentials.json`，Q1 决策 V2 上 DPAPI/keytar） | 🟡 低（已知） | README 显著提示（T08）+ T10 |
| P2-2 | `types.ts` 注释仍写 access-token「推荐」，与「API Key 优先」立场矛盾；无 `jwt` kind | 🟡 低 | T02-3 顺手修 |
| P2-3 | `handleRelayRoute` 内联 ~170 行技术债（V1 接受，达 3 个分支时抽 RouteModule） | 🟡 低 | TD-1，不在本轮 |

---

## 7. 本轮已完成的修复（独立验证记录）

commit `b88b6e7`「feat(standalone): S0 单实例锁落地」，修复主理人定位的三个缺陷：

1. **`server.ts` preserve-caught-error**：EADDRINUSE 分支抛新 Error 未带 cause → 按 `store.ts` 口径转型挂 `cause`（ES2020 lib 无 ErrorOptions，运行时 Node≥22.12 原生支持）。
2. **instance-lock 测试失败 + prefer-const**：原测试写非法 JSON 锁文件 → 实现按 stale 回收后第二次即成功，永远走不到「重试耗尽」分支。修法：`acquireInstanceLock` 增加可注入 `removeLock`（默认行为不变），测试用「删除无效 + 已死 PID + 合法 JSON」制造**持续竞争**，断言抛 `/竞争失败/` 且 removeLock 被调用 `maxRetries+1` 次——**断言比原来更强**。
3. **server.test.ts 断言方向写反 + 句柄泄漏**：端口空闲时 `occupyPort(port+1)` 成功是「符合预期」（证明无偷听），原测试却期待它失败，失败路径泄漏监听句柄 → 全量测试永不退出。修法：改为「相邻端口必须仍可占用」+ 探针 server 立即登记收尾。

**独立复验（主理人亲手跑，非采信自报）**：typecheck ✅ / lint 0 error ✅ / 全量 757·756·0·1skip·1.8s ✅ / 测试 diff 逐条审查无弱化 ✅。工程师如实汇报了两处偏离（isAlive 取值理由、连接级验证因沙箱网络不稳定而移除），均有据可查，接受。

---

## 8. 后续规划（摘要；全文见 `docs/11-plan-v1.1.md`，架构师高见远产出）

**优先级裁决：适配器 → 客户端 → R0 网关。** 理由：适配器决定数据真伪（接错数据源 = 精美的错误展示）；客户端是目标②的直接兑现且单位成本价值最高；R0 依赖链最长且与目标②无耦合，排 P1 并行。另有一条排序逻辑：**先堵漏再装修**——S0 是唯一「正在流血」的项，已最先落地。

| 级别 | 任务 | 一句话理由 | 复杂度 |
|---|---|---|---|
| P0 | T01 S0 收尾 | 双实例 = 双倍外发 = 429 放大器 | ✅ 已完成 |
| P0 | T02 newapi 适配器真站化 | 数据真伪的地基；不修则一切展示是假的 | 2–3 天 |
| P0 | T03 三端点 detect/models/focus | 用户原话三诉求（识别/模型/切换） | 1.5–2 天 |
| P0 | T04 客户端消费 sections.relays | 目标②兑现；后端数据零消费者是最大浪费 | 2 天 |
| P1 | T05 openai-compat + 429 退避 | 端点已真站实测，写了就有质量 | 2 天 |
| P1 | T06 设置页管理 UI | 无 UI 只能 curl 加站；工作量最大故 P1 | 3–4 天 |
| P1 | T07 R0 网关续建 S5/S7/S8 | 目标①承载；T01 后与 T02–T06 并行 | 4–5 天 |
| P1 | T08 文档契约 | 契约不落档 = 接入方无从下手 | 1 天 |
| P2 | T09 sub2api / T10 凭证加密 / T11 快照 burn rate / T12 VoAPI jwt | 等外部输入或长线 | — |

**里程碑**：M1「真站可跑 + 桌宠可见」（T01–T04）→ M2「可管理 + 目标①落地」（T05–T08）→ M3「覆盖更多站点 + 长线质量」（T09–T12）。关键路径约 7–9 个工作日到 M2。每任务均含文件清单/依赖/可验证完成判定（全文 §4）。

---

## 9. 假设与风险（分析中发现）

**已证实（真站实测/源码级）**：F1–F9 见 §4；`/dashboard/billing/*` 只要 API Key（`TokenAuth()`）；`/api/status` 免鉴权；`/v1` 前缀非版本分界；`sections.relays` 叶子形状恒定且 `walkLeaves` 通配。

**待验证（需要用户素材/桌面）**：
1. `/api/user/self` 账户级余额真实形状 → **需要一个 AccessToken**；
2. 有额度（非无限）Key 的 `hard_limit_usd − total_usage/100` 剩余公式 → **需要一个有额度的 Key**（实测站令牌是 unlimited，公式无法实测）；
3. Cloudflare 真拦截响应形态 → **需要一个被挑战过的站点**；
4. sub2api 适配器契约 → **需要一个 sub2api 站点**（站点不到不写代码，避免造不可验证的代码）；
5. 桌宠真机观感、Helper 桥对 `/relays` 的行为对齐 → 用户桌面（沙箱无 GUI）。

**假设（无证据，按合理判断推进）**：沙箱无 GUI 的分工模式成立（mock 90% + 用户桌面 10%）；429 退避参数（1s 起步封顶 60s）先按经验值后校准；instance-lock 的 PID 复用误判按已知局限接受（错误信息给锁路径即可）。

**主要风险**：R1 新状态叶破坏客户端既有渲染（中，通配测试 + mock 回归对冲）；R2 舰队轮询触发站点 429（高，S0 + 退避 + 隐藏即零功耗对冲）；R3 凭证明文落盘（高，README 提示 + V2 DPAPI）；R4 detect 误判（中，只用强信号 + 返回 evidence）；R7 文档漂移（中，本轮已提交 6 份 + T08 收口）。

---

## 10. 需要用户拍板/提供

1. **测试素材**（按优先级）：AccessToken 站点 → 有额度 Key → 被 CF 拦站点 → sub2api 站点；
2. **真机验证窗口**：M1 完成后在你自己桌面跑一次独立模式（桌宠显示 ≥1 个真站），沙箱内无法替代；
3. **主理人已裁决**（架构师提请的 4 项）：D2 focusSiteId 放 `sections.relays` data 内 ✅；D3 管理 UI 超期砍模型矩阵展示、保 CRUD+detect+focus ✅；D4 决策文档立即提交 ✅；D1（07 §8.2 分歧）留待 T07 开工前裁决，不阻塞 M1；
4. **安全提醒**：真站实测用过的 API Key 已在会话中泄露，**建议站长侧重置**（docs/10 已记录，本文不复述任何密钥值）。

---

## 11. 建议的下一步

1. 立即开工 **T02 适配器真站化**（P0 第一优先，与一切下游阻塞相关）；
2. T02 落地后并行 **T04 客户端消费** + **T03 三端点**；
3. 每轮遵守纪律：完成必复跑 typecheck/lint/test、贴原始输出、测试只增不减、声称完成不凭记忆；
4. 用户提供素材后插队验证 V1–V4，闭环一条划掉一条。
