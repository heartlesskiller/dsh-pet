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

### R1 · 中转站契约层与 new-api 适配器（本轮）
- `src/host/relays/types.ts`：站点 / 凭证 / 余额 / 健康状态的契约
- `src/host/relays/money.ts`：**quota ↔ 金额的唯一权威换算**（默认 500000 quota = 1 USD），禁止其他模块自算
- `src/host/relays/providers/newapi.ts`：one-api / new-api 系适配器（`GET /api/user/self`）
- 纯函数解析 + 单测（不依赖网络）

### R2 · 站点注册表与本地持久化
- `src/host/relays/store.ts`：站点 CRUD、JSON 落盘（独立模式数据目录）
- `src/host/relays/credential-store.ts`：本地凭证存储 + **全链路脱敏**
- `/relays` 系列 HTTP 端点（CRUD / 刷新 / 健康检查 / 切换）

### R3 · 接入余额动画与健康状态
- 把 N 个站点的余额聚合成 `/state` 的 `sections.balance`（沿用 `money` 形态 → 六档动画自动生效）
- 新增 `sections.relays` 状态叶：各站健康、模型数、最近一次抓取时间
- 站点切换：切换后广播 / 右键菜单可选

### R4 · 其余适配器
- `sub2api.ts`（`GET <base>/usage` + sk key）
- `openai-compat.ts`（`GET <base>/dashboard/billing/subscription` 兜底）
- 模型清单抓取（`GET /v1/models`）

### R5 · 文档与打包
- `README.md` 补「中转站管理」章节 + 上游致谢
- `openapi.yaml` 补 `/relays` 契约
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

## 5. 进度记录

| 轮次 | 内容 | commit |
|---|---|---|
| 0 | 克隆上游、通读 README/API.md/openapi.yaml/src、缺口分析 | — |
