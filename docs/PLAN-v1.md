# dsh-pet-agent · V1 开发计划

> 基线：`github.com/PC2005-cloud/dsh-pet`（v0.3.7，MIT 代码 / 素材禁商用 / **二创必须附原作者地址**）
> 工作目录：`D:\dev\dsh-pet-agent`（**全部项目文件在 D 盘，不落 C 盘**）
> 本文档随迭代持续更新；每条完成项标注 commit hash。

---

## 0. 合规（不可协商）

上游 LICENSE 要求：**基于本项目的衍生 / 改版 / 换皮作品，在任何介绍、展示、分发的地方，须附原作者 GitHub 地址 `https://github.com/PC2005-cloud/dsh-pet`**；素材（动画 / 提示词 / 源视频）**禁止商用**；代码 MIT。

本 fork 的落实方式：
- `package.json` 的 `homepage` / `repository` 保留上游地址，并新增 `forkedFrom` 字段；
- `README.md` 顶部保留上游致谢与许可说明；
- 本项目定位为**个人自用 / 开源免费**，不收费、不挂广告、不打赏入口；
- 不把上游素材用于任何商业用途。

---

## 1. 两个目标（用户原话）

1. **适用于所有 agent 的桌宠（不绑定 DSH 这一个宿主）**
2. **能管理各个 API 中转站的桌宠（余额、健康状态、站点切换等）**

### 1.1 现状与缺口（本轮实测得出）

| 能力 | dsh-pet 现状 | 缺口 |
|---|---|---|
| 宿主 | 只作为 DSH 插件运行；有 `standalone` 模式但**余额/碎碎念/对话/通知全部降级为结构化失败** | 独立模式是一等公民，任何 agent 可经 HTTP 驱动 |
| 余额 | **单服务商**：`agentDefaultModel.currentSelection().provider` → 4 个 provider（DeepSeek 官方 / DSH 账号 / OpenCode Zen Go / Command Code） | **N 个中转站并行**：余额、健康、模型清单、站点切换 |
| 对外 API | `/dsh-pet-7340` 契约完整（API.md + openapi.yaml），但无中转站管理端点 | 需要 `/relays` 系列端点 |
| 凭证 | 经 DSH `ctx.credentials.resolve` 注入，插件不读凭证存储 | 独立模式需要自己的本地凭证存储 |

**结论**：不需要重写。上游的 provider 抽象（`src/host/balance/types.ts`：一个服务商 = 一个自包含文件 + 注册表一行）与展示形态（`shape: 'money' | 'windows'`）设计得正好够用——**中转站provider 只要落到 `money` 形态，客户端展示层与六档余额动画一行都不用改**。这是本次迭代能快的关键。

---

## 2. V1 范围（按优先级排序）

> **R0 是目标①的唯一承载，必须最先做**（原计划漏了它，详见 §6 修订记录）。
> R3 的余额**只能进 `sections.relays` 新叶子，绝不能进 `sections.balance`**——那会破坏既有客户端契约。

### R0 · 宿主无关网关（目标①，架构见 `docs/07-architecture-host-agnostic.md`）
- **S0 单实例锁**（🔴 阻塞项，当前是真 bug：端口被占就顺延到 3081 → 第二只桌宠静默启动 + 发现文件互相覆盖）
- 发现机制：3080 端口 + `agent-gateway.json` 发现文件 + 端口扫描兜底
- 握手与仲裁：`POST /agents/hello` 60s TTL 心跳；**优先级 + TTL，不搞租约锁**
- 能力分级：L0 在场 / L1 只读 / L2 驱动 / L3 改配置与凭证（**按「能否造成不可逆损害」切，不按读写切**）
- 鉴权：分域可选 token，**默认全关**（个人自用零成本），只收紧 L3
- `capabilities.ts`：把 DSH 专属能力收敛成 `CapabilitySet` 四个可选接口，独立模式从「硬降级」变「可填充」
- 摄入**四轨**（架构师裁决「部分借用」+ 产品经理 `06b-acp-integration.md` 成本分析合并，见修订 #16/#18）：
  - **HTTP `POST /events`**（P0 主轨，任意 agent 一条 curl 就能推状态，0.5 天）
  - **per-agent hooks**（P0，用 agent 原生 hook，覆盖「终端里已跑着的 agent」，1–2 天；优先 Claude Code + Codex）
  - **ACP**（P1，桌宠作 **Client** 端而非 agent；官方最小示例只需实现 `requestPermission` + `sessionUpdate` 两个方法，约 100–150 行）
  - **JSONL tail**（P2 兜底，按 `06-research-optimization.md` C3 规格）
  - 四轨**共用一层六态归一化**，可独立排期互不阻塞
  - **桌宠不把自己注册进 ACP Registry**（Registry 收录 agent，桌宠是 Client，范畴错误）；读 Registry 是可选 P2
  - **不实现反构**（桌宠做 ACP agent）：语义不成立（ACP agent 被期望响应 `prompt` 并推理，桌宠不能推理），且未找到任何先例
  - **⚠️ ACP 日志必须写 stderr 绝不写 stdout**，否则污染协议流
- 推送：轮询契约不动，另加 `GET /state/stream`（SSE）opt-in；**不做 WebSocket**

### R1 · 中转站契约层与 new-api 适配器
- `src/host/relays/types.ts`：站点 / 凭证 / 余额 / 健康状态的契约
- `src/host/relays/money.ts`：**quota ↔ 金额的唯一权威换算**（默认 500000 quota = 1 USD），禁止其他模块自算
- `src/host/relays/providers/newapi.ts`：one-api / new-api 系适配器
- 纯函数解析 + 单测（不依赖网络）

### R2 · 站点注册表与本地持久化
- `src/host/relays/store.ts`：站点 CRUD、JSON 落盘
- `src/host/relays/credential-store.ts`：本地凭证存储 + **全链路脱敏**
- `/relays` 系列 HTTP 端点

### R3 · 接入展示层与状态叶
- **`sections.relays` 新状态叶**（`{counter,data}` 与上游一致）；**不动 `sections.balance`**
- 聚合结果喂桌宠：六档余额动画 / 气泡 / 低余额告警
- `refreshBalance` 扩展为双链路并存（有启用站点走 relays，否则走原单服务商）
- 周期刷新接上游 `eventsRefreshSec.balance`

### R4 · 其余适配器与自动识别
- `sub2api.ts`（`GET <base>/usage` + sk key）
- `openai-compat.ts`（`GET <base>/dashboard/billing/subscription` 兜底）
- **站点类型自动识别**（`POST /relays/detect`，信号优先级与算法见 `06-research-optimization.md` 附录 C 第 8 节；**一次 `/api/status` 请求同时供存活探测与类型识别，不拆两次、不靠 URL 猜**）
- 模型清单抓取**优先试定价接口**，失败回落 `/v1/models`（附录 C 第 9 节）
- **`rateUnconfirmed` 语义**：换算率探测不到就标记未确认并要求用户确认，**绝不静默用默认值**（修订 #11）

### R5 · 文档与打包
- `README.md` 补「中转站管理」+ 上游致谢
- `openapi.yaml` 补 `/relays` 子域与 `/agents` 契约
- 独立模式一键启动脚本

---

## 3. 已知风险与待确认清单

> 按用户要求：需要确认的事先搁置，按合理判断继续推进，不卡住。

| # | 问题 | 我的判断 / 临时决定 | 影响 |
|---|---|---|---|
| Q1 | 凭证在独立模式如何安全存储？Node 无内置 keychain | V1 用**独立文件 + 0600 权限 + 全链路脱敏**，README 显著提示「凭证以明文落盘」；OS keychain（keytar/DPAPI）列 V2 | 安全 |
| Q2 | 单图素材如何表达四态？ | 桌宠本体用用户图，四态改用**外圈光晕变色 + 角落状态角标**（不侵入素材） | 展示 |
| Q3 | 「部分中转站查不到余额」 | 必然存在（站长未开接口 / Cloudflare / 魔改汇率）。设计上**必须支持手工填写余额**并标注「手工」，绝不伪造 0 | 功能完整性 |
| Q4 | 站点切换的语义 | V1 定义为「当前用于展示余额/健康的焦点站点」+「右键菜单可切」，**不做请求转发**（那是网关的活，明确 Non-Goal） | 范围 |
| Q5 | 动图（GIF）是否真会在 WebView2 里播 | 上游用 VP9-Alpha webm 而非 GIF，动画链是它自己的；自定义素材路径需实测。已在待确认清单 | 展示 |

**Non-Goals（明确不做）**：不做请求转发网关；不做 LLM 聊天客户端；不做多用户 / 云同步；不自动签到；不绕过任何人机验证。

---

## 4. 迭代纪律（本轮起生效）

1. **每一轮必须有实际产出**：代码改动 / 新文件 / 跑通的验证记录 / 查到的确凿资料。
2. **声称完成必须贴原始输出**：至少 `git log --oneline -1` 与 `ls -la <产出路径>`。
3. **不编造**：没做就说没做，不确定就说不确定，宁可报「失败，原因是 X」。
4. **卡住就换一件**：记下卡点转下一项。
5. **测试只增不减**；纯逻辑必须无 GUI 可测。
6. **上游纪律继承**：provider 只负责成功路径，任何失败 `throw`，统一落成 `fetch-error`，**绝不伪造 0 余额**。

---

## 6. 修订记录（架构师与产品经理的反馈，已纳入）

| # | 来源 | 问题 | 处置 |
|---|---|---|---|
| 1 | 架构师 | 🔴 **原计划 R1–R5 没有一步实现目标①（宿主无关）** | 新增 **R0** 并置顶；细节全部交给 `07-architecture-host-agnostic.md` |
| 2 | 架构师 | 🔴 原 R3 写「聚合成 `sections.balance`」会**破坏既有客户端契约**（`shared/balance.ts:106` 的形状被 `BalanceUnavailable` 注释锁死，`shared/state.ts:8` 的路径只当不透明键用） | 改为**只进 `sections.relays` 新叶子**，`sections.balance` 留给上游单服务商 |
| 3 | 架构师 | 🔴 **当前没有单实例锁**：`server.ts:139-166` 端口被占就顺延 3081 → 第二实例静默启动 → 两只桌宠 + `agent-gateway.json` 互相覆盖 | 提为 **S0 阻塞项**，用互斥体/锁文件（不是端口），已占用则明确失败 |
| 4 | 产品经理 | 🔴 「自建 AgentLink 协议」是在重复造 **ACP**（4.4k Star / Apache-2.0 / 5 语言 SDK / Registry 40+ agent） | 架构师裁决：**ACP 首选 + HTTP 兜底双轨，不自建 JSONL 总线** |
| 5 | 产品经理 | 源码确证 `/dashboard/billing/*` 只要 **API Key**（`TokenAuth()`），不需要 AccessToken | 凭证引导改为「API Key 优先」；取数链路改三级 |
| 6 | 产品经理 | 7 个会算错钱的接口坑（`hard_limit_usd` 非剩余、`total_usage` 单位是分、1e8 无限额度哨兵、令牌级 vs 账户级、200-with-error、hard_limit 累加、货币开关） | 已转工程师实施规格：三级链路 + 四个纯函数守卫 + `scope`/`unlimited` 标记 |
| 7 | 架构师 | `POST /relays/{id}/refresh` 直接返回数据，违反 API.md 约定二（动作端点只回 `{ok}`） | **裁决：保留**。`/relays` 是机器接口子域，agent 一次调用就要拿到结果；但必须**记为明确的子域契约决策**并同步改 API.md/openapi.yaml，且**不许扩散到 `/balance`、`/whisper` 等既有端点** |
| 8 | 架构师 | `handleRelayRoute` 内联 ~170 行在 `index.ts`，超过 50 行函数红线 | **裁决：V1 接受**（代码已在飞、重写风险更高），V1.5 抽 `RouteModule` 时一并解决 |
| 9 | 架构师 | 缺 `/relays/detect`、`/relays/models`、`/relays/focus` 三个端点 | **全部补**。`detect`=PRD P0-3 站点类型识别；`models`=用户最初痛点「可用模型」；`focus`=用户明确要求的「站点切换」 |
| 10 | 架构师 | `PetState`（5 态）与上游 6 档工作状态**是不同的两套东西**，别混 | 记录在案：我们的 5 态驱动桌宠表情，上游 6 档驱动工作状态动画，两者并存不互换 |
| 11 | 产品经理 | 🔴 **done-hub 的 `QuotaPerUnit` 默认值在官方文档里自相矛盾**：一处 `500`、一处 `500000`，**相差 1000 倍**；`DisplayIncurrencyEnabled` 默认值也两处冲突 | **「按站覆盖换算率」从可选升为必填**；且 `money.ts` 的 `siteQuotaPerUnit(undefined)→500000` 兜底**必须改成「未确认」语义**：能自动探测到才用，探测不到就标 `rateUnconfirmed` 并要求用户确认，**绝不静默用 500000** |
| 12 | 产品经理 | **VoAPI 查余额需要 JWT Token**（既不是 AccessToken 也不是 API Key） | `RelayCredentialKind` 预留 `jwt`；且 VoAPI 必须在**识别阶段就分流**，不能等查询失败再提示 |
| 13 | 产品经理 | `xc996/API_detect_tools` 的 **Bot Detection 能在 HTTP 200 下识别挑战页** | 解析守卫增加「**按内容特征判错**」一类（附录 B 坑 6 的升级版），命中走浏览器桥降级 |
| 14 | 产品经理 | **定价接口返回的模型清单（1000+）比 `/v1/models`（只返回当前 Key 有权限的）更全** | 模型清单抓取**优先试定价接口**，失败再回落 `/v1/models` |
| 15 | 产品经理 | `/api/status` 一个探针可两用（存活探测 + 类型识别），且**不要靠 URL 猜类型**（Veloera 界面与 new-api 高度相似） | `detect` 与 `health` **合并为一次 `/api/status` 请求**，不拆两次 |
| 16 | 架构师 | 🔴 **「ACP 优先」的收益前提不成立**：那 40+ agent 只对「自己 spawn agent 的 ACP client」可用；桌宠是**第三方观察者**，无权 attach 到不属于自己的会话上，所以「零适配覆盖 40+ agent」是伪命题。且 ACP 走 stdio subprocess，多 agent = 多常驻子进程，直接违背常驻资源硬指标 | **裁决：部分借用，不实现 ACP 线上协议**。只借语义（`notice` + `severity` + coalesce）与 Registry（当调研输入）。摄入改**三轨**：HTTP `POST /events`（主）+ per-agent hooks（Claude Code / Codex 优先）+ JSONL tail（P2）。桌宠既不做 ACP client 也不做 ACP agent |
| 17 | 架构师 | 原设计缺「**ACP 是哪一端**」这个前提 | 已在 v2.1 明确：桌宠**哪一端都不是**，只做自己的 HTTP 协议 + hooks 摄入 |
| 18 | 产品经理 | **三版本不靠探测区分，靠显式 `provider_type` 配置**；`/api/user/self` 响应形状在 new-api 新版与 one-api 之间**完全相同**，差异在端点存在性而非字段结构 | `parseUserSelf` **不需要版本分支**；类型识别不能依赖响应形状，要靠 `/api/status` |
| 19 | 产品经理 | **`/api/status` 一个端点三用**：存活探测 + 类型识别 + **读 `data.quota_per_unit` 自动推断换算率**（官方文档明标「鉴权要求:公开」，默认 `500 * 1000.0`） | 换算率**先自动探测**；探测不到才 `rateUnconfirmed`。我此前「探测不到就绝不静默默认」的指令要加前提：**探测是本该走通的第一路径** |
| 20 | 产品经理 | **AT 预检成功后的业务错误 / Turnstile / 结果不确定，绝不回退 Cookie**（`leolulu/newapi-daily-checkin` 的决策链原话：避免重复签到或把验证码误判为认证失败） | 必须写进 `querySiteBalance` 降级链：**凭证类型不自动降级**，只做「端点内三级降级」 |
| 21 | 产品经理 | `New-Api-User` 头**已不参与鉴权**（new-api 官方博客明示），值就是用户数字 ID；`Authorization: Bearer` 与裸值**两者都收** | `authHeaders` 保持 Bearer 默认 + `extraHeaders` 逃生口即可；用户引导里删掉「必须带 New-Api-User」的误导 |
| 22 | 产品经理 | ThendCN 选 Cookie 是**同源 BFF 架构使然，不是站点限制**；AccessToken 才是我们该推的凭证 | 凭证引导顺序定为 **AccessToken → API Key → Cookie(高级逃生) → 手工填写**；Cookie 只在提示里作为高级可选项出现 |
| 23 | 产品经理 | Cloudflare 拦截面判定表（`cf-mitigated` 头 / `server: cloudflare`+403 / `challenge-platform` 标记页 / `x-datadome`） | `classifyResponse` 按此表实现；**分类取决于站点 CF 配置，必须留配置项**；仍待真实站点验证 |

## 8. 工程纪律（踩过的坑，违反即返工）

| # | 坑 | 教训 |
|---|---|---|
| E1 | **改完代码必须复跑 typecheck 再提交**。`e73286b` 的 commit message 声称「typecheck 清零」，但那次修复（补 `{cause:e}`）之后**没有复跑**，实际在 HEAD 上留下一个 ES2020 缺 `ErrorOptions` 的类型错误，由工程师用 `git stash` 在 `52e270b` 上复现才发现 | **「声称完成」之前，必须把上一条命令重跑一遍**。commit message 里的验证声明等于对外承诺，不许凭记忆写 |
| E2 | **`import … from './relays'`（目录导入）在 Node ESM 下直接 `ERR_UNSUPPORTED_DIR_IMPORT`**，而且**只在跑测试时炸**，`tsc` 和 `vite` 都不报。第一版这么写导致 3 个测试文件连带崩溃、**39 个测试静默没跑** | 目录导入一律写成 `./relays/index`（仓库里 `./balance/index` 正是这个写法）。**测试数突然变少就是红色警报，必须先查为什么** |
| E3 | 测试文件数/用例数**只增不减**；任何一轮完成后核对 `# tests` 总数，掉了就是有文件没跑起来 | 见 E2 |
| E4 | 数据目录 `relays` 放在 `userRoot/relays`（与 `pet/`、`main-animation/` 同规矩），**不从 `storage-paths.ts` 拿**——那个模块只做路径推导，`userData` 项本身就是调用方传进去的 `userRoot`，它并不定义 relay 目录 | 已确认的决策，不要反复改 |

## 9. 进度记录

| 轮次 | 内容 | commit |
|---|---|---|
| 0 | 克隆上游、通读 README/API.md/openapi.yaml/src、缺口分析 | — |
| 1 | **R1 中转站契约层**：`types.ts`（站点/凭证/余额/健康契约，复用上游 `MoneyBalance` 使客户端零改动）、`money.ts`（quota↔金额唯一权威，默认 500000=1USD 可按站覆盖）、`providers/newapi.ts`（one-api/new-api 适配器：`/api/user/self` + `/v1/models` + `/api/status` 探测，纯函数可测） | `e604146` |
| 2 | **R2a 持久化与脱敏**：`store.ts`（站点/凭证分文件、原子写、损坏文件改名 `.corrupt-*` 留存后抛错、可选字段条件展开）、`redact.ts`（`maskSecret`/`maskHeaders`/`containsSecret` 唯一脱敏出口） | `304d87c` |
| 3 | **R2b 查询编排**：`index.ts`（注册表、`querySiteBalance` 完整降级链、`checkSiteHealth` 401/403→auth-failed、`queryAllBalances` 信号量并发 4、`selectLowSites` 阈值不猜/手工值不告警、`aggregateBalances` 多币种不混算） | `8f58db0` |
| 4 | **质量清零**：`RelaySiteView.extraHeaders` 类型补齐、错误链 `cause`、typecheck/lint/build 全过；装齐依赖后**全量 `pnpm test` 718 个 717 过 0 失败**（此前 4 个失败经上游基线 worktree 对照确认是缺依赖，非回归） | `e73286b` |
| 5 | **R3 宿主侧接入**：`/relays` 8 端点进 `handleRelayRoute` + `sections.relays` 状态叶 + `refreshRelays` 挂周期刷新（与单服务商链路并存不合流） | `2e7aecb` |
| 6 | **计划修订**：纳入架构师 v2.1 裁决（不实现 ACP 线上协议，三轨摄入）与 PM 接口一手证据（修订 #18-#23）；补工程纪律 E1-E4 | `efe0c8a`/`da3afdf`/`52e270b`/`2cb1e30` |
| 7 | **S0 单实例锁落地**：`instance-lock.ts`（`wx` 原子取锁 + PID 存活判定回收 stale）+ 删除端口顺延（被占即失败）；同 commit 修复主理人定位的 3 个在途缺陷；全量测试恢复到 757 例 1.8s 干净退出（此前 600s 跑不完） | `b88b6e7` |
| 8 | **真站实测**：`docs/10-real-site-verification.md` —— new-api 真站 curl 一手证据 F1-F9（`/api/usage/token/` 升第一优先、unlimited 哨兵、负 available、分 vs quota、200-with-error、识别信号、CF 判定、quota_per_unit 可探测、pricing 带倍率） | 文档（`b520567` 提交） |
| 9 | **T02 适配器真站化重构**（11-plan V1.1）：三级取数链路按凭证分流（api-key→usage/token→billing；AT→user/self→usage/token→billing，凭证类型间不降级）+ 四守卫 + CF/429 归类（`blocked`/`rate-limited`）+ `rateUnconfirmed` 落地（money.ts 拆除静默默认，store 建站显式写默认并标未确认）+ `scope/unlimited/spent` 字段 + `detect.ts` 识别纯函数；relays 测试 70→**117 全绿**，全量 **804/803/0/1skip**；**`/api/status` 活数据复测通过**（识别 new-api + 探测 500000） | 本轮 |

**累计新增单测：55（R1-R3）+ 47（S0/T02 轮）＝ 102 个，全部通过。**

### 尚未闭环（如实记账，对照 11-plan-v1.1.md §5.2 待验证清单）

1. ~~**new-api 适配器未对真实站点跑通过**~~ → **已闭环**（轮 8 真站实测 + 轮 9 按实测重构 + `/api/status` 活数据复测；`/api/usage/token/` 与 billing 链路有待验证项 V1/V2 见下）
2. **V1** `/api/user/self` 账户级余额真实形状 —— 需要一个 **AccessToken**（本站只有 API Key）
3. **V2** 有额度（非无限）Key 的 `hard_limit_usd − total_usage/100` 剩余公式 —— 需要一个**有额度的 Key**
4. **V3** Cloudflare 真拦截响应形态 —— 需要被挑战过的站点（判定表已按修订 #23 实现，未实测）
5. **`/relays/detect`、`/relays/models`、`/relays/focus` 三端点未接路由**（detect.ts 纯函数已就绪，T03）
6. **`sections.relays` 客户端零消费**（T04：桌宠不显示中转站余额）
7. **sub2api / openai-compat 适配器未写**（T05/T09；契约已声明，注册表返回 `unsupported`）
8. **`API.md`/`openapi.yaml` 无 `/relays` 契约**（T08）
9. **凭证明文落盘**：`relay-credentials.json` 明文（Q1 决策 V2 上 keytar/DPAPI；README 显著提示待 T08）
