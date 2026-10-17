# 同类项目调研 · 优化点清单

> 项目：`D:\dev\dsh-pet-agent`（fork 自 `github.com/PC2005-cloud/dsh-pet`）
> 上游基线：`PC2005-cloud/dsh-pet` v0.3.7，MIT 代码 / 素材禁商用 / 二创须附原作者地址
> 调研人：许清楚（Product Manager）｜ 调研日期：**2026-10-16**
> 目标：对照 `docs/PLAN-v1.md` 的两个目标（① 适用于所有 agent 的桌宠 ② 管理各个 API 中转站），找**可借鉴的热门项目**与**具体优化点**

---

## 0. TL;DR

**最有价值的四个发现（按对我们的重要性排序）：**

1. 🔴 **已经有人做了「Agent 联动」，但没人做「中转站管理」** —— `MerZlin/dsh-pet-indesktop`（PySide6 移植版，1085 commits，2026-10-16 仍在提交）与 `ysppwn721/better-dsh-pet`（Electron 桌面独立窗）**都实现了目标 ①**，且两者**都没有任何中转站/余额管理能力**。**目标 ② 至今仍是空白，这正是我们的差异化，必须抓紧。** 但目标 ① 的门槛已被拉平——我们必须比它们做得更通用（见第 3 节 ACP 一条）。
2. 🟠 **`MeteorNOX/DeepSeek-Balance-Whale-Widget`（约 4.8k Star）已经验证了「桌宠盯余额」这个产品形态**：轮询余额 + 数字滚动动画 + 拖拽吸附 + 每轮对话消耗气泡。**它只支持 DeepSeek 单家**，把它扩展成「N 个中转站」就是我们。
3. 🟠 **ACP（Agent Client Protocol）是「适用于所有 agent」的正确答案**：`agentclientprotocol/agent-client-protocol` 4.4k Star、Apache-2.0、官方 5 语言 SDK、40+ 已注册 agent。**我们目前规划的自建 AgentLink 协议，本质上是在重复造 ACP**——应改为「ACP 优先 + 自有 JSONL 兜底」的双轨制。
4. 🟢 **有一批成熟的工程做法可以直接抄**：`better-dsh-pet` 的三个「看门狗」（置顶看门狗 / 全屏自动隐藏 / Helper 看门狗）与「隐藏即零功耗」，`clawd-on-desk` 的会话上限与最小显示时长，`mosliu/newapi_credit_logger` 的采集记录字段设计，`yl0711-coder/newapi-monitor` 的「失败保留最后成功值 + 指数退避」与「不用残缺数据误报」。
5. 🟢 **B1 深挖已产出「一手证据附录」（第 7 节）**：从 one-api / new-api 仓库源码确证了路由表与默认常量，**解掉 PLAN 第 110 行的 4 个待实测项中的 2 个**（`/api/status` 确为免鉴权；`/dashboard/billing/*` 的 `TokenAuth()` 意味着**模型 API Key 就能查余额**，比原估计宽松），并挖出 **7 个必须防的坑**（最致命的一个：`hard_limit_usd` 不是余额、`100000000` 是「无限额度」哨兵而非 1 亿美元、`DisplayTokenStatEnabled` 默认 true 导致返回的是**令牌级**额度而非账户级）。
6. 🟢 **附录 C（第 8 节）已覆盖分支差异**：Veloera / done-hub / VoAPI / one-hub / Super-API 的能力矩阵三方交叉一致；挖出 **7 个分支特有陷阱**，其中最需要注意的是 **done-hub 的 `QuotaPerUnit` 默认值在官方文档里自相矛盾（500 vs 500000，相差 1000 倍）** 与 **VoAPI 查余额需要 JWT 而非 AccessToken**。同时发现 `xc996/API_detect_tools` 的 **「Bot Detection 检测（挑战页也返回 HTTP 200）」** 做法，直接补强了我们的解析守卫。
7. 🟢 **附录 C 8.2 已确证「免鉴权自报身份」端点**：`GET /api/status`（官方文档标注「鉴权要求:公开」，源码路由组无 auth 中间件）返回 **`system_name`**（类型识别核心信号）+ **`quota_per_unit`**（换算率可自动推断，**用户不必手填**）+ **`display_in_currency`**（决定返回值单位）。**一个探针三用**。附录 C 8.3 给出了可直接实现的纯逻辑识别算法。
8. 🟢 **附录 D（第 9 节）已把 `newapi.ts` 4 条待实测项压到 2 关闭 + 1 半关闭 + 1 待真实站点**，并附 6 处源码/官方文档原文摘录。关键收获：**new-api 的 PAT 两种 Authorization 格式都收**（`Bearer` 与裸 token），且**新版 `New-Api-User` 已不参与鉴权**；`ThendCN/newapi-monitor` 选 Cookie 是**同 Origin Web 应用的 BFF 架构选择，不是站点限制，对我们不适用**。
9. 🔵 **ACP 接入成本分析已单独成文**：`docs/06b-acp-integration.md`。结论 **「部分借用」**：桌宠做 ACP 的 **Client** 端（语义完全匹配，约 100–150 行可跑通），但**只作为三条摄入轨道之一**——因为 ACP 的前提是「Client spawn agent 作子进程」，**看不到用户终端里已跑着的 agent**，而那正是最高频场景。推荐 **A. ACP + B. Hooks（agent 原生 hook）+ C. HTTP 推送** 三轨共用一层六态归一化。

---

## 1. 调研方法与范围

### 1.1 使用的搜索词（实际执行）

| # | 搜索词 | 命中 |
|---|---|---|
| S1 | `Live2D 桌宠 开源 github 2026 桌面宠物 Electron 透明窗口` | Live2DPet / OpenDesktop-Pet / charlotty |
| S2 | `MCP server 桌宠 桌面宠物 agent 驱动 开源 github` | **OpenPets**（关键） |
| S3 | `new-api 中转站 余额 监控 多站点 开源 github 2026 告警` | all-api-hub / metapi / OctaFuse |
| S4 | `agent 状态可视化 桌宠 桌面 claude code status pet github 开源` | **Clawd-on-desk / claude-status-pet / AgentPet**（关键） |
| S5 | `ThendCN newapi-monitor stars Live2DPet x380kkm OpenDesktop-Pet HanLoney charlotty oddmeta stars` | **newapi-monitor**（关键） |
| S6 | `moeyui1 claude-status-pet stars Tauri Rust 桌宠` | 详情补齐 |
| S7 | `API 余额 监控 桌面 小组件 github 2026 中转站 提醒 低余额 告警 去重` | **yl0711-coder/newapi-monitor**（关键） |
| S8 | `Agent Client Protocol ACP agent 通用接入 桌宠 开源 github standard` | **ACP**（关键） |
| S9 | `oc-claw rainnoon github 桌宠 Tauri OpenClaw Claude Code 状态聚合` | **OC-Claw**（关键） |
| S10 | `dsh-pet PC2005-cloud github 桌宠 DeepSeek Harness 插件` | 上游自身生态确认 |
| S11 | `ACP agent client protocol client 状态可视化 桌宠 pet desktop any-buddy cpaczek agent events` | **dsh-pet-indesktop 的 AGENT_LINK_PROTOCOL.md**（关键） |
| S12 | `github 余额 趋势 图 快照 历史 sparkline 开源 工具 API quota history chart 2026` | api-quota-watch / limitwatch / copilot-usage |
| S13 | `dsh-pet-indesktop MerZlin 桌宠 中转站 余额 agent 联动` | **dsh-pet-indesktop / better-dsh-pet**（关键） |
| S14 | `MeteorNOX DeepSeek-Balance-Whale-Widget github 余额 桌宠 widget` | **Balance Whale Widget**（关键） |
| S15 | `better-dsh-pet github 仓库 置顶看门狗 全屏自动隐藏 Helper 看门狗 Electron` | 详情补齐 |
| S16 | `"Codex Pet" pet pack 动画包 格式 github 桌宠 主题 制作` | Codex pet 格式规范（关键） |
| S17 | `one-api new-api 余额查询 工具 github "余额" 监控 面板 多账号 2026` | newapi_credit_logger（关键） |

### 1.2 实际打开并核对的仓库页 / 文档页

`github.com/rbyakod/openpets`、`github.com/ninehills/openpets`、`github.com/OpenPetsHQ/openpets`、`github.com/rullerzhou-afk/clawd-on-desk`、`github.com/ThendCN/newapi-monitor`、`github.com/mosliu/newapi_credit_logger`、`github.com/MerZlin/dsh-pet-indesktop`、`github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget`、`github.com/moeyui1/claude-status-pet`、`github.com/ntd4996/agentpet`、`github.com/rainnoon/oc-claw`、`github.com/x380kkm/Live2DPet`、`github.com/HanLoney/OpenDesktop-Pet`、`github.com/liyupi/dsh-kun-like-pet`、`pkg.go.dev/github.com/yl0711-coder/newapi-monitor`、`github.com/zhang-jiazhi/dsh-stats-panel/blob/HEAD/docs/CHANNELS.md`、`agentclientprotocol.com`、`github.com/agentclientprotocol/*`

### 1.3 ⚠️ Star 数可信度声明（重要）

**本次多个仓库的 GitHub 页面在抓取时未返回星标数字**（GitHub 页面 HTML 中星标按钮区域常被服务端裁剪）。凡未从 GitHub 页面直接取得数字的，**均改用第三方快照站并注明来源与日期**；多个来源冲突时**全部列出，不做平均、不估算**。**抓不到就写「未获取」。**

---

## 2. 项目清单表

> 相关度定义：**高** = 与我们的两个目标直接重叠，必须细看；**中** = 有局部可抄的做法；**低** = 仅作背景参照。

### 2.1 桌宠 / 桌面宠物生态（目标 ① 的竞品与参考）

| 项目 | GitHub URL | Star（来源·日期） | 一句话定位 | 技术栈 | 相关度 |
|---|---|---|---|---|---|
| **dsh-pet（我们的上游）** | github.com/PC2005-cloud/dsh-pet | 1512（deepseek-harness-plugin.com，2026-10-16）/ 1347（dshplugin.online，2026-10-14）⚠️ 两站数据不一 | DSH 桌宠插件，100+ 手绘透明 webm 动画链 + Q 弹物理 + 素材生成链 | TypeScript + Electron（桌面模式） | **基线** |
| **dsh-pet-indesktop** ⭐ | github.com/MerZlin/dsh-pet-indesktop | **未获取**（GitHub 页面未返回星标） | dsh-pet 的 Win/Linux/macOS 三平台移植版，**已实现 Agent 联动**，1085 commits，2026-10-16 仍在提交 | **Python + PySide6（Qt 6）** + Kotlin(Android) + JS(桥) | **高** |
| **better-dsh-pet** ⭐ | github.com/ysppwn721/better-dsh-pet | **未获取**（npm 包，MIT） | dsh-pet 的 Electron 二创增强版：**独立透明置顶窗 + 三看门狗 + 91 动画 + 余额 + 语音** | Electron + React | **高** |
| **DeepSeek-Balance-Whale-Widget** ⭐ | github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget | 4.8k（heatdrop.ai，未标日期）/ 2,530（github-star.com，2026-09-16） | 「桌宠盯 DeepSeek 余额」—— **已被 4.8k 用户验证的产品形态** | JavaScript（DSH/Cordis 插件） | **高** |
| **Clawd-on-desk** ⭐ | github.com/rullerzhou-afk/clawd-on-desk | 6,460（kaiyuanbang.cn 本地快照，2026-10-16）/ 6.2k（theinfinity.dev）/ 5.9k（claudewave.com，2026-08-13） | 像素桌宠实时反馈 **26+ AI coding agent** 状态，含权限审批气泡、远程转发、PWA | Electron + JS，AGPL-3.0 | **高** |
| **OpenPets** ⭐ | github.com/OpenPetsHQ/openpets | 1.3k（gittrend.io，2026-10-16，30 天 +100） | 「本地优先的桌宠伴侣平台」：pet pack + **Plugin SDK v3 + MCP** | Electron + TypeScript，MIT | **高** |
| **OC-Claw** | github.com/rainnoon/oc-claw | 340（tool.lu）/ 285（sourcepulse.org，约 2 个月前）⚠️ 快速上涨 | Tauri 桌宠聚合 **7 类 agent** 状态，多源摄入（JSONL/hooks/plugin）+ SSH 远程 | **Tauri v2 + Rust + React**，MIT | **高** |
| **claude-status-pet** | github.com/moeyui1/claude-status-pet | **未获取**（skillselion 显示的 "4 stars" 是 skill 站计数，不可采信） | 最小实现：hook 写 `status-{id}.json`，桌宠只 watch 这个文件 | **Tauri + Rust**，AGPL-3.0-only | **高** |
| **AgentPet** | github.com/ntd4996/agentpet | 358（claudeers.com，2026-09）/ 338（vibed-lab）/ 259（gitgem.org，2026-06-30） | 菜单栏多 agent 监视器 + 桌宠 + 电子宠物养成 | macOS 原生 Swift/SwiftUI + Windows Tauri，MIT | 中 |
| **dsh-kun-like-pet** | github.com/liyupi/dsh-kun-like-pet | **未获取** | DSH 桌宠，**直接复用 Codex 精灵图契约**（8列×9行、每格 192×208），素材零重绘 | DSH 动态插件（cordis_define） | **高** |
| **Live2DPet** | github.com/x380kkm/Live2DPet | **未获取** | Electron + Live2D + VOICEVOX 语音，截屏感知 | Electron + PixiJS + pixi-live2d-display | 中 |
| **OpenDesktop-Pet** | github.com/HanLoney/OpenDesktop-Pet | **未获取** | Electron + Live2D，四引擎 TTS、口型同步、三层记忆 | Electron + Live2D | 中 |
| **charlotty（小美同学）** | github.com/oddmeta/charlotty | **未获取** | Electron + Live2D + PIXI，**圆盘菜单 + MCP 技能系统 + 提醒待办** | Electron | 中 |
| **VPet** | github.com/LorisYounger/VPet | 6,678（getanimate.app，2026-08-21） | Windows 虚拟桌宠模拟器，MOD 生态 | WPF/.NET，Apache-2.0 | 低 |
| **BongoCat** | github.com/ayangweb/BongoCat | 22,714（getanimate.app，2026-08-21） | 跟手打击桌宠，**Tauri 做桌宠的可行性证明**（4–15MB） | Tauri，MIT | 中 |

### 2.2 中转站 / one-api / new-api 管理与监控（目标 ② 的竞品与参考）

| 项目 | URL | Star（来源·日期） | 一句话定位 | 技术栈 | 相关度 |
|---|---|---|---|---|---|
| **all-api-hub** | github.com/qixing-jk/all-api-hub | 4.9k（GitHub 搜索页，2026-10-16）/ 4,505（GitHub stars 页，2026-07-20） | 浏览器扩展，一站式管理 New-API/Sub2API 系中转站：余额/用量看板、签到、比价、健康检查 | TypeScript + WXT，AGPL-3.0 | **高** |
| **newapi-monitor** ⭐ | github.com/ThendCN/newapi-monitor | **未获取** | **Win11 桌面小组件**（透明/置顶/托盘）监控多站点余额与今日用量 | **Tauri v2 + React + Rust**，MIT | **高** |
| **newapi_credit_logger** ⭐ | github.com/mosliu/newapi_credit_logger | **未获取** | FastAPI 多源余额采集器，**区分 newapi / newapi_legacy / oneapi 三种接口版本**，带历史记录与后台 | FastAPI + SQLAlchemy + APScheduler | **高** |
| **newapi-monitor（Go 版）** | github.com/yl0711-coder/newapi-monitor | **未获取** | new-api 上游稳定性旁路监控 + 邮件报警，**动态充值预警 + 三态稳定性** | Go + 内嵌 SQLite | **高** |
| **metapi** | github.com/w286554018/metapi | **未获取** | 「中转站的中转站」：多站聚合成一个 Key，余额看板 + 智能路由 + 自动签到 | Go | 中 |
| **dsh-stats-panel** | github.com/zhang-jiazhi/dsh-stats-panel | **未获取** | 多渠道余额/用量聚合，**适配器清单文档（CHANNELS.md）是最权威的接口证据** | TypeScript | **高** |
| **api-quota-watch** | npm `@gwthm/api-quota-watch` | **未获取**（npm 包） | 多 provider 配额 CLI：**30 天 sparkline + burn rate 预测 + Slack/Discord webhook** | Node CLI | 中 |
| **LimitWatch** | github.com/lucashutch/limitwatch | **未获取** | Rust CLI 多账号配额监视：**SQLite 历史 + 图表 + CSV/Markdown 导出 + 4s 抓取超时** | Rust | 中 |
| **copilot-usage** | github.com/kevingosse/copilot-usage | **未获取** | Rust CLI：**日均消耗 + 月末预测（结余/超支）+ sparkline** | Rust | 中 |
| **RelayScope** | github.com/dante1007108174-droid/relay-scope | **未获取** | 自托管 LLM API 监测面板，支持 New API / SUB2API / OpenAI 兼容 | Windows/Docker | 中 |

### 2.3 Agent 与桌宠/UI 的结合（目标 ① 的核心参考）

| 项目 | URL | Star（来源·日期） | 协议 / 接入方式 | 多 agent 仲裁 | 相关度 |
|---|---|---|---|---|---|
| **ACP（Agent Client Protocol）** ⭐ | github.com/agentclientprotocol/agent-client-protocol | 4,430（git.mafyuh.dev，2026-10-13）/ 3.4k（rywalker.com，2026-06） | **JSON-RPC 2.0 over stdio**，官方 Rust/Kotlin/Python/TS/Java SDK，Apache-2.0，40+ 已注册 agent | 原生多 session 并发 | **高** |
| **OpenPets** | 见 2.1 | 1.3k | **MCP stdio**（`openpets_status` / `openpets_react` / `openpets_say`）+ hooks/plugin 双轨 | pet lease + `--pet` 指定 | **高** |
| **Clawd-on-desk** | 见 2.1 | 6.46k | hooks（Claude Code 15 个 hook 事件）+ 日志轮询 + plugin，另支持 **custom HTTP agent endpoint** | **Session Map 上限 20 + 优先级解析 + 最小显示时长 + pendingState 保护** | **高** |
| **OC-Claw** | 见 2.1 | ~340 | 多源摄入：JSONL session 文件轮询 / hooks / plugin / SSH 远程 | 多 agent 配对不同角色，多桌宠同屏 | **高** |
| **dsh-pet-indesktop** | 见 2.1 | 未获取 | **自有 JSONL 事件总线**（本地文件追加写 + ByteOffsetTailer 增量读）+ ws://127.0.0.1 回环写回 | `AgentLinkManager` + `DshMonitor`（Qt 信号），pending owners 上限 32 | **高** |
| **claude-status-pet** | 见 2.1 | 未获取 | **hook → `status-{id}.json` → 文件 watch**（最薄的一层） | 每 session 一个桌宠窗口 | **高** |
| **AgentPet** | 见 2.1 | ~358 | hooks 一键安装 + **`agentpet run -- <cmd>` 通用 wrapper** | 菜单栏列表 + 每状态计时器 | 中 |
| **wechat-acp** | github.com/formulahendry/wechat-acp | 766（GitHub stars 页，2026-07-20） | **把任意 ACP agent 桥到企业微信** | — | 中 |

---

## 3. 可借鉴点逐条

> 格式：**借鉴什么** → **出处** → **为什么适合我们** → **实现成本**
> 成本口径：**小** = ≤1 天；**中** = 2–5 天；**大** = >5 天或需重构。

### A. 桌宠形态与窗口工程（8 条）

#### A1. 三个「看门狗」+「隐藏即零功耗」
- **借鉴什么**：① **置顶看门狗**——定期重新 `setAlwaysOnTop(true)`，防止被资源管理器/全屏应用顶掉；② **全屏自动隐藏**——仅在全屏游戏/视频时自动隐藏，不影响日常；③ **Helper 看门狗**——桌宠进程意外退出后由宿主自动重新拉起；④ **隐藏即零功耗**——桌宠隐藏时暂停动画解码与全部活动定时器（实测 CPU ≈ 0%），显示时立即恢复；⑤ **启动懒加载**——动画素材按需加载 + 优先级预热。
- **出处**：`github.com/ysppwn721/better-dsh-pet`（npm `better-dsh-pet` README + `runtime/electron-helper/main.js` 注释「托盘 / 看门狗 / 全屏检测」）；「隐藏即零功耗 / 启动懒加载」另见 `github.com/MerZlin/dsh-pet-indesktop` README（PR #7，实测 CPU≈0%）
- **为什么适合我们**：PLAN-v1 未提这四件事，但它们是**桌宠常驻体验的生死线**：用户最大的抱怨就是「桌宠卡/占内存/被窗口盖住/自己挂了」。我们的桌宠还要额外跑 N 个站点的轮询，**「隐藏即零功耗」对我们比对纯桌宠更重要**（不看的时候连轮询都该停）。
- **实现成本**：**小**（置顶看门狗 = 一个定时器；全屏检测 = 一个原生 API；Helper 看门狗 = 进程守护；隐藏暂停 = 已有动画循环加一个开关）

#### A2. 「锁定位置 / SHIFT+拖动 / 不透明度 10–100% / 托盘菜单勾选实时同步」
- **借鉴什么**：四个防误触与个性化开关，且**设置改动后托盘菜单勾选状态实时同步**（不是重启才生效）。
- **出处**：`github.com/MerZlin/dsh-pet-indesktop` README（v4.3.x 功能清单）
- **为什么适合我们**：桌宠要常驻又不许碍事——**误触拖动是最常见的烦躁来源**。托盘勾选不同步会让用户以为设置没保存。这四条都是低成本高感知。
- **实现成本**：**小**

#### A3. 会话/实例上限 + 最小显示时长 + pendingState 保护
- **借鉴什么**：**Session Map 上限 20，溢出淘汰最旧（防内存泄漏）**；状态机带**最小显示时长**（避免动画疯狂抖动）与 **pendingState 保护**（避免同源双弹）。
- **出处**：`github.com/rullerzhou-afk/clawd-on-desk`（README + commit 记录「Session Map 上限 20 个会话，溢出淘汰最旧（防内存泄漏修复）」「状态机：多会话追踪 + 优先级解析 + 最小显示时长 + pendingState 保护」）
- **为什么适合我们**：**我们同时有 N 个站点 + M 个 agent session**，状态源比 clawd-on-desk 更多。「最小显示时长」直接对应 PLAN 里「六档余额动画」的防抖；「上限淘汰」对应我们 `queryAllBalances` 信号量并发 4 时的内存边界。
- **实现成本**：**小**

#### A4. Codex pet 精灵图契约（可直接消费社区生态）
- **借鉴什么**：一个**事实标准格式**：`pet.json` + `spritesheet.webp`，**8 列 × 9 行（部分版本 8×11），每格 192×208，总图 1536×1872（8×11 版为 1536×2288）**，9 个状态行：`idle / running-right / running-left / waving / jumping / failed / waiting / running / review`。**未使用的格子必须完全透明，否则串帧/残影。**
- **出处**：`github.com/liyupi/dsh-kun-like-pet`（「完全沿用 Codex 桌宠精灵图契约（8 列 × 9 行、每格 192×208），素材零重绘」）；格式细节见 `github.com/CraftNobody0505/lulu-dusk-codex-pet` README、`github.com/Zacklinkk/pingtan-digital-ip-codex-pet`（含 SHA-256 校验信息）、`github.com/bxck1234/codexdream-ileina-pet-skin`（`~/.codex/pets/<name>/` + `config.toml` 的 `selected-avatar-id`）
- **为什么适合我们**：**这是「换皮肤」最省事的落地方式**——不用自建素材格式，直接吃社区已经产出的几十个 pet pack。我们已有 100+ webm 动画链，**加一个「导入 Codex pet」的适配层就能白嫖整个社区生态**，且 `liyupi/dsh-kun-like-pet` 证明了同一个仓库里两种素材体系可以共存。
- **实现成本**：**中**（要写 spritesheet 解析 + 9 状态到我们档位的映射 + 尺寸校验）

#### A5. 余额挂件的交互范式：数字滚动 + 拖拽吸附 + 边缘镜像翻转 + 每轮消耗气泡
- **借鉴什么**：余额区域用**滚动数字动画**呈现；**拖拽到四边四分之一处自动吸附，吸附到左侧时整体水平镜像翻转**；按压有 Q 弹玩偶效果；**每轮对话结束弹出本轮实际消耗**（基于真实 usage，非估算）。
- **出处**：`github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget`（README + 第三方博文 blog.yeyupiaoling.cn/article/1787626775875）
- **为什么适合我们**：**这正是我们要做的「桌宠看余额」，但它只支持 DeepSeek 一家。** 这些交互细节（滚动数字 / 吸附 / 镜像）已经被 4.8k 用户验证过，直接抄比我们自己想更稳。「每轮消耗气泡」也直接对应目标 ① 的 agent 联动。
- **实现成本**：**中**

#### A6. 双模式记账：免令牌差值记账 + 令牌精确计价
- **借鉴什么**：**默认零配置模式**——只需 API Key，通过观测**余额差值**在本地记账（`.dshw-usage.json`，跨天自动归零归档），**不需要平台会话令牌**；**可选精确模式**——配置平台 token 后调用平台用量接口，按峰谷定价换算。短时网络抖动**沿用最近一次余额**，避免界面报错刷屏。
- **出处**：`github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget`（第三方博文详述两种模式）
- **为什么适合我们**：**直接命中 PLAN-v1 的 Q3「部分中转站查不到余额」与 Q1「凭证怎么存」**。这个「免令牌差值记账」思路可以推广到我们的中转站：**即使拿不到 `/api/user/self`，只要有任一能反映余额的接口，就能靠本地差值推出「今日已用」**。而「沿用最近一次余额」正是我们 `refreshBalance` 已有降级，应该做成显式契约。
- **实现成本**：**小**

#### A7. Pet pack / 素材目录约定 + 插件 SDK 沙箱
- **借鉴什么**：① **pet pack**：一个目录 = 一个自包含宠物（manifest + 动画池），多实例共享素材，可安装/预览/按 agent 分配；② **Plugin SDK v3**：每个 JS/TS 插件跑在**独立沙箱化 BrowserWindow**，只能声明 actions/HUDs/notifications 由宿主渲染（**插件无法注入原始 HTML/脚本**）；③ **权限清单**在 manifest 声明、安装时由用户批准，敏感能力（`voice:listen` / `clipboard` / `pet:speak:dynamic`）需显式开关；④ CLI 三件套：`plugin new`（模板）/ `plugin validate` / `createTestHarness`（可 mock host、推进时钟）。
- **出处**：`github.com/OpenPetsHQ/openpets`（README「Plugin SDK v3」「Safety and Privacy」）
- **为什么适合我们**：PLAN 的 P2 只想到「皮肤/换装」，**没想「插件」**。但沙箱插件机制是「适用于所有 agent」的自然延伸——**中转站适配器、告警渠道、签到（若做）都可以是插件**，且**沙箱 + 权限清单正好解决「第三方适配器能不能信」的问题**。`createTestHarness` 也印证我们「纯逻辑无 GUI 可测」的纪律。
- **实现成本**：**大**（V2+ 再考虑，但**现在就该把 `SiteProvider` 接口设计成可插拔**，成本为零）

#### A8. 圆盘菜单 + MCP 技能面板 + 提醒待办
- **借鉴什么**：单击桌宠展开**环形菜单**（音效反馈）；菜单内含**技能列表**（图标+描述+参数 Schema 对话框+实时结果）；**提醒待办**支持公历/农历、重复周期、时区。
- **出处**：`github.com/oddmeta/charlotty`
- **为什么适合我们**：**右键菜单已经是我们 P0**。环形菜单在「多站点切换」场景比传统右键列表更顺手（N 个站点时列表会很长，圆盘可分组）。「技能面板」是 A7 插件机制的 UI 出口。**农历/节日**可做 P2 彩蛋（better-dsh-pet 已有节日模式，用户情感价值高）。
- **实现成本**：**中**

---

### B. 中转站管理与余额监控（6 条）

#### B1. 三版本接口适配：newapi / newapi_legacy / oneapi
- **借鉴什么**：**显式区分三种 provider 类型并分别走不同端点**：
  - `newapi`（新版）→ `GET /api/user/self`
  - `newapi_legacy`（旧版）→ **优先** `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`，**回退** `/dashboard/billing/subscription` + `/dashboard/billing/usage`，余额 = 额度 − 使用量
  - `oneapi` → 兼容 `credit_grants` / `subscription` 路径
  并维护一份 `docs/PROVIDER_API_COMPATIBILITY.md`。**金额单位规则**：统一按「元」落库与展示、保留 2 位小数；旧版 `subscription` 按「元」、`usage` 按「分」处理，**代码内自动换算**。
- **出处**：`github.com/mosliu/newapi_credit_logger` README「Provider 说明」「金额规则」
- **为什么适合我们**：**直接补上 PLAN-v1 R4 的 `openai-compat.ts` 兜底路径设计**，且比我们现在的 `providers/newapi.ts` 更细——它明确处理了「**带 `/v1` 前缀与不带前缀**」和「**元 vs 分**」这两个我们没写的坑。PLAN 第 110 行的待实测项「`Bearer` 对 one-api 老版本是否兼容」正好可以借鉴它的双路径回退思路。
- **实现成本**：**小**（契约层已就绪，主要是补一个 provider 分支 + 单测）

#### B2. 采集记录字段设计（含 http_status / latency_ms / response_excerpt）
- **借鉴什么**：每次采集落库字段：`limit_amount / usage_amount / balance / currency / **http_status / latency_ms / error_message / response_excerpt**`。**上游请求日志单独分文件**，记录 URL、状态码、`content-type`、响应片段、非 JSON 响应错误。**已知站点会返回 HTML 错误页/登录页/反代页而非 JSON。**
- **出处**：`github.com/mosliu/newapi_credit_logger` README「数据库说明」「日志说明」
- **为什么适合我们**：**这就是我们「查不到余额」时的排查抓手**。PLAN 的 `error` 分类只有 `unreachable / auth-failed / cloudflare / unsupported`，但**没有 latency 和响应片段**——用户报「查不到」时我们无法判断是 Cloudflare 挑战页还是 JSON 结构变了。补上这两个字段，**排错成本从「复现」降到「看日志」**。
- **实现成本**：**小**

#### B3. 「失败保留最后成功值 + 指数退避」+「余额与账单两个独立状态」+「不用残缺数据误报」
- **借鉴什么**：① 抓取失败时**保留最后一次成功值**并**指数退避**重试；② **余额（balance）与消费账单（billing）是两个独立状态**，不同步失败；③ **动态充值预警**——用最近完整自然日的本地小时汇总 + 双方倍率估算「余额可用天数」，**当余额、倍率或数据覆盖不可靠时停止评估，不用残缺数据误报**；④ **渠道配置留痕**——渠道删除后保留最后快照，倍率更新**追加版本而不覆盖历史**。
- **出处**：`github.com/yl0711-coder/newapi-monitor`（pkg.go.dev 文档页）
- **为什么适合我们**：**第 ③ 条与 PLAN 的 `selectLowSites`（阈值不猜 / 手工值不告警）是同一个设计原则，但对方说得更彻底——「数据覆盖不可靠时停止评估」**。我们应把这条提升为显式规则：**告警需要 ≥N 个有效快照才允许启用**。第 ④ 条「倍率追加版本」则支撑 PLAN 的 `money.ts` 唯一权威换算——换算率变更必须可追溯。
- **实现成本**：**小**（指数退避 + 版本化换算率都是纯逻辑，可单测）

#### B4. 三态稳定性 + P50/P95 + TTFB/TTFT + 四类报警规则
- **借鉴什么**：把「异常」细分为三态：**成功 / 异常（client_gone 等客户端中断）/ 失败（上游错误）**，按 分组×渠道×模型 聚合；延迟指标给 **P50/P95、TTFB/TTFT 首字延迟分布、出字速度 tok/s**；邮件报警四类规则：**错误率 / 错误突发 / 异常成簇 / 采样掉线**，阈值可调。
- **出处**：`github.com/yl0711-coder/newapi-monitor`
- **为什么适合我们**：**「三态」这个区分直接改我们 PLAN 的 `checkSiteHealth` 健康模型**——现在我们只有 401/403→auth-failed，**「客户端中断」和「上游错误」被混为一谈**，会导致误告警。报警四分类中「**异常成簇**」与「**采样掉线**」正好对应 clawd-on-desk 的「告警去重」需求。
- **实现成本**：**中**

#### B5. Burn rate 预测 + sparkline + 「今日预算」进度条
- **借鉴什么**：① **日均消耗 + burn rate 预测**（"At current pace, limit in ~12 days"）；② **30 天 sparkline 趋势图 + 趋势箭头**；③ **今日预算进度条**；④ **月末结余/超支预测**；⑤ **按 provider 配置 webhook 告警（Slack Block Kit / Discord embeds）+ 发送测试告警**。
- **出处**：npm `@gwthm/api-quota-watch`；`github.com/kevingosse/copilot-usage`
- **为什么适合我们**：**PLAN 的 P1「用量统计图表」应该直接升级成这两条**——「余额还能撑几天」比「余额数字」更有决策价值，而且是**桌宠气泡里一行字就能表达的信息**（完美契合桌宠形态）。「今日预算进度条」则给桌宠提供了一个比六档动画更细粒度的表达位。
- **实现成本**：**中**（快照历史我们已有契约，加一个 burn-rate 纯函数 + 一个 sparkline 组件）

#### B6. SQLite 历史 + 原子写 + 4 秒抓取超时 + 凭证明文告警
- **借鉴什么**：① **SQLite 承载配额历史**，支持 tables/charts/calendars/bars/statistics 与 CSV/Markdown 导出；② **文件写入用原子替换**；③ **`--max-age-ms` 全局抓取截止时间（默认 4000ms）+ `--cache-ttl` 缓存生命周期**；④ **账号别名与分组**（`--alias` / `--group`），可过滤；⑤ README **明确声明「账号存储含明文 token，请勿提交/打印/分享，并限制目录权限、脱敏诊断」**。
- **出处**：`github.com/lucashutch/limitwatch`
- **为什么适合我们**：③ 直接补我们 `queryAllBalances` 缺的**全局超时预算**（我们只有并发度 4，没有总 deadline）——**站点一多，串行等待会让「立即刷新」变成 30 秒**。④ 的别名/分组对应我们 P0-14 的分组需求。⑤ 的措辞可以直接抄进我们 README 的凭证明文提示（PLAN Q1 已决定 V1 明文，**必须把话说清楚**）。
- **实现成本**：**小**

---

### C. Agent 驱动 / 协议层（4 条）——目标 ① 的核心

#### C1. ⭐ 改用 ACP 作为 agent 接入的首选协议（双轨制）
- **借鉴什么**：**ACP = JSON-RPC 2.0 over stdio 的「编辑器↔agent」开放标准**（Zed 2025-08 创建，Apache-2.0）。特性：`initialize` 能力协商、`session/new` 会话管理、`session/prompt` 回合 + `session/update` 流式进度、**权限请求（agent 可向 client 请求授权）**、client 介质的文件系统/终端访问。**官方 Rust / Kotlin / Python / TypeScript / Java 五个 SDK**，**ACP Agent Registry 已收录 40+ agent**（Claude Code、Codex CLI、Gemini CLI、Copilot CLI、OpenCode、Qwen Code、Kimi CLI、Cline、Factory Droid、Goose 等），`claude-agent-acp`（2.6k）与 `codex-acp`（452）是官方适配器。**Session Notices RFD** 提出 `sessionUpdate: "notice"` + `severity: info|warning|error` 的「一次性通知」原语，**明确建议 client 对重复 notice 做合并（coalesce）**。
- **出处**：`agentclientprotocol.com`；`github.com/agentclientprotocol/agent-client-protocol`（4,430 Star，Apache-2.0）；`github.com/agentclientprotocol/claude-agent-acp`；`github.com/agentclientprotocol/registry`；RFD：`agentclientprotocol.com/rfds/session-notices`
- **为什么适合我们**：**这是本次调研最重要的结论。** PLAN 的 AgentLink 是自建 JSONL 总线——**那等于把 ACP 已经解决的问题（N×M 集成、session 管理、权限气泡）重做一遍，且只覆盖我们手动适配的几个 agent**。改为 **「ACP 优先（覆盖 Registry 40+ agent，零适配成本）+ 自有 JSONL 兜底（覆盖 Registry 之外的 CLI）」**，**目标 ① 才能从「支持 DSH + Claude Code」跃升到「支持所有 agent」**。另外 **Session Notices 的 notice/severity 语义正好就是我们「余额告警气泡」的协议层原型**，coalesce 建议正好对应告警去重。
- **实现成本**：**大**（但**这是唯一能让目标 ① 真正成立的路径**；建议 V1 先只接 ACP 的 `session/update` 只读子集，不实现 agent 侧的 client 能力）

#### C2. 多源摄入范式：JSONL 轮询 / hooks / plugin / 自定义 HTTP endpoint 四路归一
- **借鉴什么**：同一个桌宠用**四种方式**拿 agent 状态，最后**统一归一成一份六态词汇**再驱动动画：① **JSONL session 文件 + 健康轮询**（OpenClaw）；② **hooks 安装 + 事件解析**（Claude Code / Codex / Cursor / Gemini CLI，Claude Code 覆盖 15 个 hook 事件）；③ **plugin**（opencode / Hermes）；④ **custom HTTP agent endpoint** 兜底任何未集成本地工具。
- **出处**：`github.com/rainnoon/oc-claw`（README「How it works」）；`github.com/rullerzhou-afk/clawd-on-desk`（`docs/guides/custom-agent-http.md`）
- **为什么适合我们**：**我们的 `dsh-pet-bridge` 应该按这四条腿设计**，而不是只接 DSH。第 ④ 条「自定义 HTTP endpoint」成本极低却能覆盖任意 agent——**一个 curl 就能把状态推进来**，这是「适用于所有 agent」最便宜的兜底。
- **实现成本**：**中**

#### C3. 读方保证：byte-offset 增量 tail + 不回放历史 + 有界单次读
- **借鉴什么**：桌宠侧读事件总线时：**ByteOffsetTailer 字节偏移增量 tail**（1.5s QTimer，**不回放历史**）；**文件不存在时静默空转**；**半行缓冲不丢事件**；**单次读取有界（64KB）**；**pending owners 集合有界（上限 32）**，仅可信 `session-end`（同 owner 同 session）解除。**联动默认全关；桌宠隐藏时监视器全线 pause，显示时 resume。**
- **出处**：`github.com/MerZlin/dsh-pet-indesktop` `docs/AGENT_LINK_PROTOCOL.md`
- **为什么适合我们**：**这份文档是我们自建 JSONL 总线时最该抄的规格书**——它把「增量 tail / 半行缓冲 / 有界读 / 有界 pending / 隐藏即停」这些**容易漏且会导致内存泄漏或重复触发**的点全列了。**「不回放历史」尤其重要：重启桌宠时不能把昨天的 agent 事件全部重放一遍。**
- **实现成本**：**小**（纯逻辑，可单测——正好符合我们的纪律）

#### C4. 权限审批气泡 + 远程转发（SSH/WSL）+ 只读 PWA
- **借鉴什么**：① **权限审批气泡**——agent 请求工具权限时桌面弹浮动卡片 Allow/Deny，支持**全局热键**与**三档自动化**（每次询问 / 仅问题提示 / 自动批准）；② **远程转发**——远程服务器上的 agent 状态与权限气泡经 SSH/WSL 转发到本地，支持 Telegram/Feishu/Slack 通知；③ **只读 Mobile/PWA**——手机访问配对链接查看 agent 会话状态。
- **出处**：`github.com/rullerzhou-afk/clawd-on-desk`（README + docs/guides）
- **为什么适合我们**：① **「权限审批气泡」是 agent 联动最高频的真需求**——「不用一直盯着终端等确认」，且**它与我们的余额告警气泡可以共用同一套气泡组件**。③ 的 PWA 是**低成本加分项**（我们的 `/relays` HTTP 端点已存在，加一个只读 H5 页面即可）。② 的 SSH 转发对个人开发者价值中等，**建议 P2**。
- **实现成本**：**中**（气泡 1 天；PWA 1 天；SSH 转发 3+ 天）

---

### D. 前端工程细节（4 条）

#### D1. 「复制新增」监控源 + 后台登录保护 + Key 片段脱敏查询
- **借鉴什么**：后台支持**「复制新增」监控源**（复制除 `api_key` 外的全部配置）；后台 `/admin` 有登录保护；`/ui/key-search` **按 key 前缀/后缀片段匹配，结果仅展示脱敏 key**。
- **出处**：`github.com/mosliu/newapi_credit_logger`
- **为什么适合我们**：**「复制新增」直接命中我们的 P0 站点 CRUD**——同一站点的多个 Key（或同配置不同 URL）是常态，逐个重填很痛。**「Key 片段脱敏查询」则给出了一种「既能搜到又不泄露」的凭证展示范式**，可用于我们 P0-2 的掩码显示。
- **实现成本**：**小**

#### D2. 多语言 + 全局快捷键 + 极简模式 + DND + 单实例锁 + 位置记忆
- **借鉴什么**：clawd-on-desk 的 **7 种 UI 语言**、**眼球追踪**、**睡眠序列（yawning → dozing → collapsing → sleeping）**、**双击戳戳**、**极简模式（从屏幕边缘探头）**、**DND 模式**、**单实例锁**、**位置记忆**；AgentPet 的 **4 种语言 + macOS/Windows 自动更新 + 设置窗「不抢焦点」**；OC-Claw 的 **macOS 刘海 / Windows 任务栏停靠 + 岛形背景裁剪工具**。
- **出处**：`github.com/rullerzhou-afk/clawd-on-desk`；`github.com/ntd4996/agentpet`；`github.com/rainnoon/oc-claw`
- **为什么适合我们**：**「设置窗不抢焦点」和「单实例锁」是我们 P0 桌宠质量的重要组成但 PLAN 未提**；「极简模式（边缘探头）」是**比「隐藏」更好的折中**——用户既想看余额又不想被挡；「DND 模式」直接对应我们「告警不打扰」的设计原则（P0-10 要求「已读前不重复弹气泡」，DND 是它的全局开关）。
- **实现成本**：**小**

#### D3. 「性能与主动陪伴」的门控设计
- **借鉴什么**：主动识屏陪伴带**白名单应用切换 + 停留时长门限 + 每日上限与冷却 + dry-run 验证模式**，且**截图不落盘**。
- **出处**：`github.com/MerZlin/dsh-pet-indesktop` README（PR #7）
- **为什么适合我们**：**这套「白名单 + 门限 + 上限 + 冷却 + dry-run」五件套应该成为我们所有「主动行为」的标配模板**——不只是识屏，**余额刷新、agent 联动轮询、告警推送全都该有这五个门控**。这是把「常驻」做成「不扰民」的关键。
- **实现成本**：**小**

#### D4. 备份/同步与「正向合并」
- **借鉴什么**：AgentPet 的可选 web profile + **跨设备恢复「progress merges forward only, so it's never undone on either machine」**（只向前合并，不丢数据）；all-api-hub 的 **JSON 导入导出 + 可选 WebDAV 加密同步 + 兼容 One API Hub 一键导入**。
- **出处**：`github.com/ntd4996/agentpet`；`github.com/qixing-jk/all-api-hub`
- **为什么适合我们**：**「只向前合并」是我们 P2 多设备同步的冲突解决策略蓝本**（PLAN 第 3 节 Non-Goal 说「不做多用户/云同步」，但 WebDAV 是用户自己的，值得 V2 做）。**all-api-hub 的「兼容导入」则印证了我们 P0-13「一键导入 all-api-hub 数据」的路线是对的**——生态互操作是冷启动的钥匙。
- **实现成本**：**中**

---

## 4. 明确不借鉴的（以及为什么）

| 不借鉴 | 出处 | 理由 |
|---|---|---|
| **签到自动化（多站定时签到领额度）** | all-api-hub / metapi / better-dsh-pet 均有 | **与 PLAN 第 81 行 Non-Goal「不自动签到」直接冲突**；且涉及对第三方站点的自动化操作，有风控与条款风险。**保持不做。** |
| **智能路由 / 统一代理入口 / 自动故障转移** | metapi / LiteLLM / Portkey | **Non-Goal「不做请求转发网关」**。那是网关的活。我们只做「资产盘点与常驻提醒」。 |
| **LLM 聊天窗口 / 300+ 助手 / 知识库** | Cherry Studio / Live2DPet / OpenDesktop-Pet | **Non-Goal「不做 LLM 聊天客户端」**。会稀释产品定位，且与上游「纯粹的桌宠」哲学冲突。 |
| **Tamagotchi 养成 / XP / 等级 / 成就 / 排行榜** | AgentPet / OpenPets Virtual Pet 插件 | 与「资产管理工具」定位不符；**且排行榜需要联网账号，直接违反「数据不外传」**。P2 可考虑纯本地的「心情值」，不做成长体系。 |
| **在线 Web 档案 / 排行榜 / 跨设备云同步（官方托管）** | AgentPet | **违反「数据不外传」红线**。只接受「用户自己的 WebDAV」。 |
| **全局键盘监听 / 唤醒词语音控制** | BongoCat（22.7k Star，需全局监听键盘，社区有 keylogger 疑虑）；better-dsh-pet（SenseVoice 唤醒词） | **全局钩子 + 麦克风的权限面太大**，与「凭证安全存储」的产品基调冲突。better-dsh-pet 的「识别为任务时不自动发送、需手动确认」是个好设计，但整体仍建议 **P2 且默认关闭**。 |
| **Android / Kotlin 独立客户端** | dsh-pet-indesktop（android/ 目录，0.1.0→0.2.x，复用 2651 帧动画） | 工作量巨大且偏离「桌面桌宠」定位。**明确不做**（可在 README 提一句「有意适配」）。 |
| **截图 / OCR / 摄像头视觉 / 主动识屏** | dsh-pet-indesktop（P0 采集闭环 + 本地 OCR）/ OpenDesktop-Pet | 隐私敏感度最高（会把屏幕内容发给 LLM），且与两个目标无关。**不做**。 |
| **Live2D 渲染引擎** | Live2DPet / OpenDesktop-Pet / charlotty / Project AIRI | **引入 Cubism SDK 的授权与打包复杂度**，而 Codex pet 精灵图契约（A4）零依赖且生态更大。**优先 A4，不上 Live2D。** |
| **PySide6/Qt 重写** | dsh-pet-indesktop | 我们 fork 的上游是 Electron 体系（webm 动画链 + 共享纯逻辑），**换框架等于丢掉上游资产**。仅借鉴其协议文档（C3）与工程做法（A1/A2）。 |
| **八手站/号池/逆向流量相关的一切** | 行业背景资料 | 与产品无关，且是别人的合规风险。**仅在 README 做中性风险提示。** |

---

## 5. 推荐的优化优先级 Backlog

> 每条一行验收标准。**P0 = 本轮/下一轮必做；P1 = V1 内；P2 = V1 之后。**
> 已与 `docs/PLAN-v1.md` 对齐：不重复列 R1–R5 已有条目，只列**新增或需升级**的。

### P0（本轮或下一轮，直接提升可行性/体验）

| # | 优化点 | 验收标准 | 出处 |
|---|---|---|---|
| OP-1 | **隐藏即零功耗**：桌宠隐藏时暂停动画解码 + 全部活动定时器（含余额轮询） | 隐藏态实测 CPU ≈ 0%；显示后 1 个刷新周期内恢复 | A1 |
| OP-2 | **置顶看门狗 + 全屏自动隐藏 + Helper 看门狗** | 被资源管理器/全屏应用顶掉后 ≤10s 自动恢复置顶；全屏时自动隐藏、退出全屏 3s 内恢复；进程被 kill 后 ≤30s 自动拉起 | A1 |
| OP-3 | **`providers/newapi.ts` 增加 legacy 双路径回退**（`/v1/dashboard/billing/subscription`+`/usage` → 无 `/v1` 前缀回退）+ **元/分单位换算** | 对一个 old-one-api 站点可查到余额；单测覆盖三种路径优先级 | B1 |
| OP-4 | **采集记录补 `latency_ms` / `httpStatus` / `responseExcerpt` 三字段 + 上游请求日志分文件** | 「查不到余额」时不复现即可从日志判定原因（Cloudflare 挑战页 / JSON 结构变化 / 401）；三个字段均有单测 | B2 |
| OP-5 | **健康模型改三态**：`success` / `aborted`(客户端中断) / `failed`(上游错误)，**不再把两者混为 auth-failed** | 单测覆盖三态分类；`checkSiteHealth` 返回值新增 `aborted` | B4 |
| OP-6 | **告警启用门槛**：需 ≥N 个有效快照（默认 5）才允许触发低余额告警；快照不足或换算率被覆盖时**显式提示「数据不足，未评估」** | 手工填写的站点永不告警；快照 <5 的站点状态文案为「数据不足」而非告警 | B3 |
| OP-7 | **`queryAllBalances` 增加全局抓取 deadline**（默认 4000ms）+ 失败**指数退避** | 10 站点「立即刷新」总耗时 ≤5s；单站失败后第 2 次间隔翻倍 | B6/B3 |
| OP-8 | **会话/实例上限 + 最小显示时长 + pendingState 保护** | 同时 20+ 个 agent session 不内存泄漏；六档余额动画切换有最小停留时长，不抖动 | A3 |
| OP-9 | **JSONL 读方四保证**：byte-offset 增量 tail 不回放历史 / 文件不存在静默空转 / 半行缓冲不丢事件 / 单次读有界 64KB | 重启桌宠不重放历史事件；并发写入下半行不丢；单次读不超过 64KB | C3 |
| OP-10 | **锁定位置 / SHIFT+左键拖动 / 不透明度 10–100% / 托盘勾选实时同步** | 四个开关在设置页改动后托盘菜单勾选状态 ≤1s 同步，无需重启 | A2 |
| OP-11 | **设置窗不抢焦点 + 单实例锁 + 位置记忆** | 打开设置不抢当前窗口焦点；二次启动唤起已有实例；重启后桌宠位置/大小/透明度完整恢复 | D2 |
| OP-12 | **「复制新增」站点 + 凭证掩码展示（可点击显示/一键复制/60s 自动清空剪贴板）** | 同站点第二个 Key 的新增 ≤2 次交互；全盘搜索无明文凭证 | D1 |
| OP-13 | **主动行为五门控模板**：白名单 + 门限 + 每日上限 + 冷却 + dry-run，套用到余额刷新/联动轮询/告警推送 | 每个主动行为均有这五个可配置项；dry-run 模式下不产生真实请求 | D3 |
| OP-14 | **DND 模式 + 告警去重（同源同告警只弹一次，已读/恢复后才可再弹）** | 开启 DND 后 0 气泡；同一站点同一告警在用户已读前不重复弹出 | D2/B4 |

### P1（V1 内）

| # | 优化点 | 验收标准 | 出处 |
|---|---|---|---|
| OP-15 | **ACP 只读接入（双轨制第一步）**：接 ACP `session/update` 只读子集，支持 Registry 内 agent | 对 `claude-agent-acp` 与 `codex-acp` 均能驱动六态动画；不实现 agent 侧 client 能力 | C1 |
| OP-16 | **自定义 HTTP agent endpoint 兜底** | 一条 `curl` 即可把任意 CLI 的状态推进来并驱动动画 | C2 |
| OP-17 | **burn rate 预测 + sparkline + 「还能撑 N 天」气泡文案** | 桌宠气泡能显示「按近期速度预计还可使用 N 天」；快照不足时不显示 | B5 |
| OP-18 | **权限审批气泡（Allow/Deny + 全局热键 + 三档自动化）** | agent 请求权限时桌面弹卡，可热键响应；气泡组件与余额告警气泡复用 | C4 |
| OP-19 | **导入 Codex pet 精灵图**（8×9/8×11、192×208、9 状态） | 导入一个社区 pet pack 后 9 状态全部可播；尺寸/透明格校验失败给出明确报错 | A4 |
| OP-20 | **余额挂件交互**：滚动数字 + 四边四分之一吸附 + 左吸附镜像翻转 | 拖到边缘自动吸附；吸附左侧时整体水平镜像；余额变化有滚动动画 | A5 |
| OP-21 | **免令牌差值记账**（可选精确模式）：仅有 API Key 也能推「今日已用」 | 无平台 token 时能显示今日已用；跨天自动归零；网络抖动沿用上次值不报错刷屏 | A6 |
| OP-22 | **多语言（中/英）** | 全部 UI 文案走 i18n；切换无需重启 | D2 |
| OP-23 | **极简模式（屏幕边缘探头）** | 开启后桌宠缩为边缘小条，悬停展开预览 | D2 |
| OP-24 | **轮次消耗气泡**（每轮对话结束弹本轮实际消耗） | 基于真实 usage 非估算；可在菜单开关 | A5 |
| OP-25 | **倍率/换算率版本化留痕**（追加版本，不覆盖历史） | `money.ts` 的换算率变更有历史可查；告警评估使用当时生效的版本 | B3 |
| OP-26 | **只读 PWA 视图**（复用 `/relays` 端点） | 手机访问配对链接可看各站余额与健康；只读、无凭证暴露 | C4 |

### P2（V1 之后）

| # | 优化点 | 验收标准 | 出处 |
|---|---|---|---|
| OP-27 | **插件 SDK v3 沙箱 + 权限清单 + CLI（new/validate/test harness）** | 第三方适配器以插件形式运行，无法注入原始 HTML/脚本；敏感能力需显式授权 | A7 |
| OP-28 | **SiteProvider 接口现在就按可插拔设计**（成本为零，为 OP-27 铺路） | 新增一个 provider 只需一个自包含文件 + 注册表一行 | A7 |
| OP-29 | **环形菜单（圆盘）+ 站点分组** | 单击桌宠展开圆盘；N 个站点按分组折叠，不出现超长列表 | A8 |
| OP-30 | **SSH/WSL 远程 agent 状态转发 + Telegram/Feishu 通知** | 远程服务器 agent 状态与权限气泡可转发到本地桌面 | C4 |
| OP-31 | **WebDAV 加密同步 + 「只向前合并」冲突策略** | 双设备同步不丢数据；冲突时只向前合并并留备份 | D4 |
| OP-32 | **节日模式（阳历+农历）+ 彩蛋入口** | 内置节日自动播放对应动画；可一键关闭 | A8/D2 |
| OP-33 | **语音唤醒（默认关闭）** | 默认关闭；开启后需麦克风权限明示；「识别为任务不自动发送」 | §4（有条件借鉴） |
| OP-34 | **导入 all-api-hub 数据 / One API Hub 兼容导入** | 导入 ≥20 站点一条真实数据全部正确；逐条失败原因可读 | D4 |

---

## 6. 对 PLAN-v1 的修订建议（供 team-lead / 架构师参考）

1. **【重要】AgentLink 协议改为「ACP 优先 + 自有 JSONL 兜底」双轨制。** 目前规划的纯自建 JSONL 总线会把我们锁死在「手动适配的那几个 agent」上，与目标 ①「适用于所有 agent」相悖。ACP 已有官方 5 语言 SDK 与 40+ agent Registry，接入成本远低于自建。**建议 R 系列里插入一个 R2.5：ACP 只读接入。**
2. **【重要】「隐藏即零功耗」应从 P1 提升为 P0，且范围包含余额轮询。** 我们的常驻负担比纯桌宠重（N 个站点轮询），不做到「隐藏即全停」会被用户当成资源怪兽卸载。
3. **【建议】`docs/PROVIDER_API_COMPATIBILITY.md` 应成为一等公民文档**，与 `CHANNELS.md`（dsh-stats-panel）对标，逐条记录端点/认证/单位/已知坑。这是把 PLAN 第 110 行「未对真实站点跑通」转成「可排查」的关键。
4. **【建议】凭证 `kind` 枚举需预留 `jwt`**（VoAPI 查余额走 JWT，见附录 C 8.2 陷阱 3）；**`money.ts` 的「按站覆盖换算率」应从「可选」提升为「必填」**（done-hub 默认值文档自相矛盾，相差 1000 倍，见附录 C 8.2 陷阱 1）。
5. **【建议】解析守卫增加「Bot Detection」一类**：挑战页/反代页/登录页也可能返回 HTTP 200 且 body 为 HTML（见附录 C 8.3），必须按内容特征而非状态码判错，并触发「本地浏览器桥」降级。
6. **【建议】`/api/status` 一个探针两用**：同时承担「存活探测」与「站点类型识别」（已确证免鉴权），不要把两者拆成两次请求。

---

## 7. 附录 B：one-api / new-api 接口一手证据（B1 深挖，回应 PLAN 第 110 行待实测项）

> 本附录所有内容均来自**仓库源码与官方文档原文**（非二手转述），来源见 8.6。**未对任何真实站点发起请求**（无真实站点），因此「站点实际行为」仍未闭环，但**路由表与默认常量已可确证**。

### 8.1 路由表与鉴权要求（一手）

来自 `router/api-router.go`（songquanpeng/one-api main）：

```go
apiRouter := router.Group("/api")
apiRouter.Use(gzip.Gzip(...))
apiRouter.Use(middleware.GlobalAPIRateLimit())
{
    apiRouter.GET("/status",  controller.GetStatus)        // ← 无鉴权中间件
    apiRouter.GET("/notice",  controller.GetNotice)
    apiRouter.GET("/about",   controller.GetAbout)
    apiRouter.GET("/home_page_content", controller.GetHomePageContent)
    ...
    selfRoute := userRoute.Group("/")
    selfRoute.Use(middleware.UserAuth())                   // ← UserAuth
    {
        selfRoute.GET("/dashboard", controller.GetUserDashboard)
        selfRoute.GET("/self",      controller.GetSelf)    // ← UserAuth
        selfRoute.GET("/token",     controller.GenerateAccessToken)  // ← 生成系统访问令牌
        selfRoute.GET("/available_models", controller.GetUserAvailableModels)
        selfRoute.POST("/topup",    controller.TopUp)
    }
    tokenRoute := apiRouter.Group("/token")
    tokenRoute.Use(middleware.UserAuth())                  // ← UserAuth
    { ... }
    optionRoute := apiRouter.Group("/option")
    optionRoute.Use(middleware.RootAuth())                 // ← 仅 root
    { ... }
}
```

来自 `router/dashboard.go`（one-api main 与 new-api main **结构一致**）：

```go
apiRouter.Use(middleware.TokenAuth())                      // ← API Key 即可！
{
    apiRouter.GET("/dashboard/billing/subscription", controller.GetSubscription)
    apiRouter.GET("/v1/dashboard/billing/subscription", controller.GetSubscription)
    apiRouter.GET("/dashboard/billing/usage", controller.GetUsage)
    apiRouter.GET("/v1/dashboard/billing/usage", controller.GetUsage)
}
```

**结论表：**

| 端点 | 鉴权中间件 | 我们能否用 |
|---|---|---|
| `GET /api/status` | **无**（仅全局限流） | ✅ **公开，可做存活探测**（**已证实 PLAN 待实测项 #2**） |
| `GET /api/notice` / `/api/about` / `/api/home_page_content` | **无** | ✅ 公开，可读站点公告 |
| `GET /api/user/self` | `UserAuth()` | ✅ 需会话 Cookie 或 `Bearer <AccessToken>` |
| `GET /api/user/dashboard` | `UserAuth()` | ✅ 同 self |
| `GET /api/user/token` | `UserAuth()` | ✅ **生成 AccessToken 的端点**（需已登录） |
| `GET /api/token/` | `UserAuth()` | ✅ 令牌列表 |
| `GET /api/models`（DashboardListModels） | **`UserAuth()`** | ⚠️ **需要登录态，不是 API Key！** |
| `GET /v1/models`（OpenAI 兼容） | TokenAuth | ✅ 模型清单首选 |
| `GET /dashboard/billing/subscription`（含 `/v1/` 变体） | **`TokenAuth()`** | ✅ **模型 API Key 即可** |
| `GET /dashboard/billing/usage`（含 `/v1/` 变体） | **`TokenAuth()`** | ✅ 模型 API Key 即可 |
| `GET /api/option/` | `RootAuth()` | ❌ 不可用 |

### 8.2 默认配置常量（一手，`common/constants.go`）

```go
var QuotaPerUnit = 500 * 1000.0   // 500000
var DisplayInCurrencyEnabled = true
var DisplayTokenStatEnabled = true
```

> ⚠️ 该文件取自 **one-api main**；new-api 的 `DisplayInCurrencyEnabled` 默认值经 DeepWiki 确认为 `true`，但 **new-api 的 `DisplayTokenStatEnabled` 默认值未单独验证 [未验证]**。

### 8.3 七个必须防的坑（每条都有源码/官方文档依据）

| # | 坑 | 依据 | 我们的对策 |
|---|---|---|---|
| 1 | **`hard_limit_usd` 不是剩余余额**。源码：`quota := remainQuota + usedQuota`，三个 limit 字段全部 = `quota / QuotaPerUnit`。官方文档原话：「hard_limit_usd is the total credit (available balance + usage to date), **not the remaining balance**」 | `controller/billing.go` + 清波API 官方 API 文档 | **剩余余额必须算：`hard_limit_usd − total_usage / 100`** |
| 2 | **`total_usage` 单位是「分」**。源码：`amount` 已是美元，`TotalUsage = amount * 100` | `controller/billing.go` | 换算时**除 100** |
| 3 | **`100000000` 是「无限额度」哨兵，不是 1 亿美元**。源码：`if token.UnlimitedQuota { amount = 100000000 }`。官方文档警告原文：「密钥设置为无限额度时,三个限额字段均返回 100000000。**该值表示密钥额度不受限制,不代表账号余额为 1 亿美元**」 | `controller/billing.go` + DataEyesAI 官方文档 | **命中该值必须标记「无限额度」，绝不展示为余额、绝不参与告警** |
| 4 | **`DisplayTokenStatEnabled` 默认 `true` → 返回的是「令牌级」额度而非「账户级」**。源码分支：`if DisplayTokenStatEnabled { 用 token.RemainQuota / token.UsedQuota } else { 用 user quota }` | `controller/billing.go` + `common/constants.go` | **默认情况下 billing 端点反映的是当前 API Key 的额度**。要账户余额必须走 `/api/user/self`，或在 UI 明示「此为令牌额度」 |
| 5 | **`DisplayInCurrencyEnabled` 若被站长关掉 → 返回值是 quota 单位而非美元** | `controller/billing.go` | 必须允许用户**按站覆盖换算率**（PLAN 的 `money.ts` 已支持，保持） |
| 6 | **错误以 HTTP 200 + `{"error": {...}}` 返回**。源码：`c.JSON(200, gin.H{"error": Error})` | `controller/billing.go` | **必须解析 body 判错，不能只看 HTTP 状态码** |
| 7 | **`hard_limit` 会累加，不能用于差分推算已用**。官方文档：「令牌的授权额度一旦修改之后,授权额度(限制额度)将会在上次额度之上进行不断累加」 | EZLINK AI 官方文档 | 「今日已用」必须来自 `total_usage` 或本地快照差分，**不能用 `hard_limit` 差分** |

### 8.4 `/v1` 前缀的真相（纠正一个可能的误解）

`/dashboard/billing/*` 与 `/v1/dashboard/billing/*` 在 **one-api main 与 new-api main 的分支里都注册了**。

→ **`newapi_legacy` 的「优先 `/v1/` 回退无 `/v1/`」不是版本差异，而是防御性编码**（部分反代 / CDN / 路径重写只放行其中一条）。我们应保留双路径，但**不要把它理解为「新旧版本分界」**。

### 8.5 对 `providers/newapi.ts` 的具体修订建议

1. **`/dashboard/billing/subscription` 的凭证要求比预期宽松**：中间件是 `TokenAuth()`，**模型 API Key 就能用**。→ **P0-2 的凭证方案里，「仅填模型 API Key」可覆盖的站点数比原估计多**，应作为**优先尝试**的路径（成本最低、用户最愿意给）。
2. **补齐三条链路，按此优先级**：
   `① /api/user/self`（AccessToken/Cookie，账户级）→
   `② /dashboard/billing/subscription`（API Key，令牌级）→
   `③ /api/usage/token/`（new-api 新版，API Key，返回 `user_quota`）
3. **结果必须带 `scope` 标记**：`account`（来自 self）/ `token`（来自 billing 或 usage/token）。**UI 要显示「令牌额度」还是「账户额度」**——这是坑 4 的直接对策。
4. **解析时必须做四个守卫**：HTTP 200 但 body 有 `error`；`hard_limit_usd === 100000000` → `unlimited`；`total_usage` 除 100；结果非 JSON（HTML 挑战页/登录页）→ 归入 `cloudflare`/`html-response` 错误类。
5. **`/api/status` 确认可用于存活探测**（无鉴权）——PLAN 的 `providers/newapi.ts` 里对 `/api/status` 的用法是**正确的**，可去掉该待实测项。
6. **`/api/models`（dashboard 版）需要 `UserAuth()`，不能用 API Key** → 模型清单抓取应优先 `/v1/models`；`/api/user/dashboard` 作为登录态兜底。
7. **`GET /api/user/token` 是生成 AccessToken 的端点**（需 `UserAuth`）——如果未来做「引导用户一键取令牌」，这是入口。

### 8.6 证据索引（本附录）

- `router/dashboard.go`：`gitee.com/hutu88/one-api/blob/main/router/dashboard.go`、`cnb.cool/uqilin/tools/newapi/-/blob/main/router/dashboard.go`
- `controller/billing.go`：`github.com/qinguoyi/one-api/blob/refs/heads/main/controller/billing.go`、`cnb.cool/testpeng/newapi/-/blob/main/controller/billing.go`
- `router/api-router.go`：`github.com/chikasaki/one-api/blob/main/router/api-router.go`、`github.com/renovate-bot/ckt1031-_-one-api/blob/main/router/api-router.go`、`cnb.cool/codeLong1024/one-api-pro/-/blob/master/router/api.go`、`github.com/cubeofcube-dev/one-api/blob/v0.0.1/router/api.go`
- `common/constants.go`：`deepwiki.com/songquanpeng/one-api/2.3-configuration-and-constants`
- 官方文档：`doc.newapi.pro/api/fei-account-billing-panel/`、`docs.qingbo.dev/en/api-reference/account/subscription`、`doczh.dataeyes.ai/doc-8651891`、`docs.ezlinkai.com/8322330m0`

### 8.7 仍未验证的（如实记账）

1. **未对任何真实站点发起请求**——无真实站点，全部结论基于源码与文档推断「站点行为」。
2. **Cloudflare 挑战页的确切表现**（状态码、body 形态）未实测。
3. **各分支是否改动这些端点未逐一核对**：Veloera / done-hub / one-hub / VoAPI / Super-API / Neo-API / AnyRouter。all-api-hub 的支持清单说明它们大多兼容，但**端点可能被改**。
4. **new-api 的 `DisplayTokenStatEnabled` 默认值**未单独验证（只验证了 one-api）。
5. **new-api `GET /api/usage/token/` 的 `user_quota` 语义**仅有 commit message 与 `new-api-key-tool` 佐证，未见响应样例。
6. **`/api/cost/request/:request_id`**（one-api  README 提到的按请求计费查询）未核对源码。

---

## 8. 附录 C：分支端点差异 + 免鉴权自报身份 + 站点类型自动识别算法

> 直接影响 **P0-3「站点类型自动识别」的准确率上限**。分级：**源码确证**（读过仓库源码）/ **官方文档**（读过官方 API 文档）/ **多源一致**（≥2 个独立第三方工具交叉）/ **未验证**。
> **结论先行：`/api/status` 是免鉴权的，且返回 `system_name` 与 `quota_per_unit` —— 这一个端点同时解决了「类型识别」和「换算率自动推断」两个问题。**

### 8.1 分支兼容性矩阵（分支 × 端点）

图例：✅ 完全兼容 ｜ ⚠️ 兼容但有差异 ｜ ❌ 不支持/需额外配置 ｜ ❓ 未验证

| 端点 | New API | One API | OneHub | DoneHub | Veloera | VoAPI | Super-API / Neo-API / AnyRouter |
|---|---|---|---|---|---|---|---|
| `GET /api/status`（免鉴权） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ |
| `GET /api/user/self` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ **需 JWT** | ❓ |
| `GET /dashboard/billing/subscription` | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ | ❓ |
| `GET /v1/models` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /api/user/dashboard` | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ | ❓ |
| 模型价格接口 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 令牌管理接口 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 自动签到 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `New-Api-User` 头是否参与鉴权 | ⚠️ **新版已不参与**（见附录 D Q2） | ⚠️ 老版需要 | ❓ | ❓ | ❓ | ❓ | ❓ |
| `quota_per_unit` 默认值 | 500000 | 500000 | ❓ | ⚠️ **文档自相矛盾（500 vs 500000）** | ❓ | ❓ | ❓ |

> 出处（多源一致）：`github.es/xc996/API_detect_tools`（自述兼容 7 种站点类型）、`mckzonedaily.com/Ruawd/api-manager`（功能矩阵）、`github.com/qixing-jk/all-api-hub`（支持站点清单）。**三方交叉一致**，但**均非一手源码确证**（除 New API / One API 外，未逐一回源分支仓库）。

### 8.2 免鉴权自报身份字段清单（★ 本节是「类型识别」的抓手）

**`GET /api/status` —— 已确证免鉴权，返回以下字段**（源码：one-api `controller/misc.go`；官方文档：`doc.newapi.pro/api/fei-system-initialization`，原文标注「鉴权要求:公开」）：

| 字段名 | 类型 | 样例值 | 用途 |
|---|---|---|---|
| `system_name` | string | `"New API"`（new-api 默认）/ `"One API"`（one-api 默认） | ⭐ **站点类型识别的核心信号** |
| `version` | string | `"v1.0.0"` | 版本号；one-api 源码里硬编码 `"v0.0.0"`，构建时替换 |
| `quota_per_unit` | number | `500000` | ⭐ **换算率自动推断**（见附录 D Q5） |
| `display_in_currency` | bool | `true` | ⭐ **决定返回值是美元还是 quota 原值**（见附录 B 坑 5） |
| `start_time` | number | `1640995200` | 启动时间戳 → 可算 uptime |
| `setup` | bool | `true` | 系统是否已完成初始化 |
| `enable_drawing` / `enable_task` | bool | `true` | 功能开关（new-api 有，one-api 无此二字段） |
| `github_oauth` / `email_verification` / `turnstile_check` | bool | — | 登录方式；`turnstile_check: true` 预示可能有 CF 风控 |
| `github_client_id` / `turnstile_site_key` | string | — | 公开信息 |
| `logo` / `footer_html` / `system_name` | string | — | 站点品牌信息 |

**源码原文**（one-api `controller/misc.go`，`github.com/tennc/one-api/blob/main/controller/misc.go`）：

```go
func GetStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"success": true, "message": "",
		"data": gin.H{
			"version": common.Version,
			"start_time": common.StartTime,
			"system_name": common.SystemName,
			"quota_per_unit": common.QuotaPerUnit,
			"display_in_currency": common.DisplayInCurrencyEnabled,
			...
		},
	})
}
```

**`GET /api/uptime/status`** —— new-api 另有一个 **Uptime-Kuma 兼容状态探针，同样免鉴权**（`doc.newapi.pro/api/fei-system-initialization`）。**适合做纯存活探测**（不返回身份信息，但可区分「站点在」与「站点不在」）。

> ⚠️ **注意**：`system_name` 是**站长可改的品牌字段**（one-api `OptionMap["SystemName"] = config.SystemName`，可在后台改）。所以：
> - `"New API"` → **强证据**是 new-api 系
> - `"One API"` → **强证据**是 one-api 系
> - 其他自定义名 → **弱证据**，需结合 `enable_drawing`/`enable_task` 等 new-api 独有字段判断
> - **绝不能把 `system_name` 当唯一判据**

### 8.3 站点类型自动识别的推荐算法（纯逻辑，可直接实现）

```
输入：baseUrl（已 normalizeBaseUrl 去尾斜杠与 /v1）
输出：{ siteType, confidence, evidence[] }  —— confidence ∈ {certain, strong, weak, unknown}

Step 1  GET {base}/api/status          # 免鉴权，10s 超时
        ├─ 非 JSON（HTML/挑战页）      → { unknown, evidence:['status-non-json'] }   # 触发浏览器桥降级
        ├─ HTTP 401/403                → { unknown, evidence:['status-auth-required'] }
        └─ JSON 成功 → 取 status.data

Step 2  从 status.data 提取信号：
        systemName    = data.system_name ?? ''
        hasDrawing    = data.enable_drawing === true
        hasTask       = data.enable_task === true
        qpu           = Number(data.quota_per_unit)   # 换算率，无论类型识别成败都要存
        inCurrency    = data.display_in_currency === true

Step 3  判定（**按优先级，命中即返回**）：
        (a) hasDrawing || hasTask                    → { 'new-api',  'strong', ['status:newapi-only-fields'] }
        (b) systemName 含 'New API'（大小写不敏感）    → { 'new-api',  'strong', ['status:system_name'] }
        (c) systemName 含 'One API'                   → { 'one-api',  'strong', ['status:system_name'] }
        (d) systemName 含 'DoneHub' / 'Done Hub'      → { 'done-hub', 'strong', [...] }
        (e) systemName 含 'Veloera'                   → { 'veloera',  'strong', [...] }
        (f) systemName 非空且不在上列                  → { 'unknown',  'weak',   ['status:custom_system_name=<值>'] }
        (g) systemName 缺失                           → { 'unknown',  'weak',   ['status:no_system_name'] }

Step 4  若 Step 3 得 unknown 或 weak，追加一次低成本探测（可选，按需开启）：
        GET {base}/v1/models
        ├─ 200 且形状为 OpenAI 兼容 → 追加 'models:openai-shape'（**不据此定类型**，各分支都兼容）
        └─ 其他                    → 追加 'models:unavailable'

Step 5  产出附带两条与类型无关的**必存信息**：
        quotaPerUnit     = qpu        （若缺失则回落到站点配置/默认 500000）
        displayInCurrency = inCurrency （决定后续解析按美元还是按 quota）

Step 6  无论置信度如何，都允许用户手动覆盖；
        覆盖值按 URL 持久化，下次同 URL 直接用覆盖值，跳过 Step 1–4。
```

**设计要点**：
1. **`/api/status` 一个探针三用**：存活探测 + 类型识别 + 换算率/单位推断。**三次信息一次请求拿到**，这是零成本高收益。
2. **`quota_per_unit` 与 `display_in_currency` 的获取不依赖类型识别成功**——即使 `siteType = unknown`，这两个值也该存下来，它们直接决定解析正确性。
3. **识别失败不等于不可用**：`unknown` 类型仍可按「通用 OpenAI 兼容」走 `/dashboard/billing/*` 链路（附录 B 已证该链路只要 API Key）。
4. **VoAPI 必须单独分流**：一旦识别为 VoAPI，凭证引导应立即切到 JWT（附录 C 8.4 陷阱 3）。

### 8.4 分支特有陷阱（保留，压编为表）

| # | 陷阱 | 对策 |
|---|---|---|
| 1 | 🔴 done-hub `QuotaPerUnit` 默认值文档自相矛盾（`500` vs `500000`，差 1000 倍） | 按站覆盖换算率设为**必填**；`/api/status` 的 `quota_per_unit` 可自动推断 |
| 2 | 🔴 done-hub `DisplayInCurrencyEnabled` 默认值同样文档冲突 | 解析同时兼容美元与 quota 两种形态；用 `/api/status` 的 `display_in_currency` 决定 |
| 3 | 🟠 VoAPI 查余额需 JWT（非 AccessToken/API Key） | 凭证 `kind` 预留 `jwt`；识别为 VoAPI 即引导填 JWT |
| 4 | 🟠 VoAPI 有 `USER_DAILY_QUOTA_CLEAR`（DAY/WEEK/MONTH 清零） | 余额归零不一律当异常，UI 提示可能开启了定期清零 |
| 5 | 🟠 done-hub 预消费机制（默认 500 点预留，>100 倍跳过） | 抓取值非强一致，不当精确余额 |
| 6 | 🟢 Veloera 空响应不计费 | 健康探测可更激进 |
| 7 | 🟢 done-hub 内置低配额邮件预警 | 允许「该站已自带告警，关本地重复提醒」 |
| 8 | 🟠 new-api 新版 `New-Api-User` **已不参与鉴权**（见附录 D Q2） | 不要把它当必需头；仅在老站点上作 `extraHeaders` 逃生口 |

### 8.5 仍未知的（转为用户待确认项）

1. **未回源各分支仓库源码逐一核对端点**（Veloera / done-hub / one-hub / VoAPI / Super-API / Neo-API / AnyRouter）——8.1 矩阵为多源一致的强推断，**非一手源码确证**。
2. **done-hub 的 `QuotaPerUnit` / `DisplayInCurrencyEnabled` 默认值冲突未能判定**（需读其 `common/constants.go` 或部署实例）。
3. **VoAPI 的 JWT 从哪个端点取、有效期多久**未确认。
4. **Super-API / Neo-API / AnyRouter 的接口细节**几乎无公开资料。
5. **`system_name` 被站长改成自定义值时的分布情况**未统计——这决定 8.3 算法 Step 3(f) 的命中频率。
6. **Cloudflare 挑战页的确切状态码与 body 特征**未实测（见附录 D Q6）。

---

## 9. 附录 D：`newapi.ts` 4 条待实测项的二手证据压降（逐条给 URL + 原文摘录）

> 目标：把「未实测」压到最小。**以下全部有源码或官方文档依据，但均未对真实站点验证**——结论性质是「协议层面已确证，站点行为待实测」。

### Q1 · `newapi_credit_logger` 到底靠什么区分三种接口版本？

**答案：靠用户在后台显式配置 `provider_type`，不探测、不猜。**

- 原文摘录（`github.com/mosliu/newapi_credit_logger` README「Provider 说明」）：
  > `newapi`：新版 NewAPI，走 `/api/user/self`
  > `newapi_legacy`：旧版 NewAPI，优先走 `subscription + usage`
  > `oneapi`：OneAPI 兼容 billing 接口
- 其「已知说明」原文：
  > **「旧版 NewAPI 与兼容系统接口差异较大，新增站点时请正确选择 `provider_type`」**

→ **对我们的启示**：**不要做自动版本探测**（那正是我们要避开的猜）。做法是：**默认按新版走，失败后按 legacy 双路径重试，再失败落 `unsupported` 并提示用户手选**。三者的端点差异：

| 类型 | 端点 | 余额算法 |
|---|---|---|
| `newapi`（新版） | `GET /api/user/self` | 直接读 `data.quota` |
| `newapi_legacy`（旧版） | **优先** `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`，**回退** `/dashboard/billing/subscription` + `/dashboard/billing/usage` | `额度 − 使用量` |
| `oneapi` | 兼容 `credit_grants` / `subscription` 路径 | 同 legacy |

**`/api/user/self` 的响应差异**（官方文档，`doc.newapi.pro/api/fei-user/`）：新版 new-api 与 one-api 的 `/api/user/self` **响应形状一致**（`{success, message, data:{id, username, display_name, role, status, email, ...}}`），**没有字段名或嵌套层级的差异**；差异在**哪些端点存在**，不在响应结构。→ **我们的 `parseUserSelf` 无需按版本分支。**

### Q2 · one-api 老版本要不要裸 `Authorization: <token>`？new-api 是否两者都收？

**答案：new-api 两者都收（有代码级证据）；one-api 老版本的情况未找到直接证据，但逃生口必须留。**

**代码级证据 ①**（new-api 官方 GitCode 技术博客，讲 new-api 的 PAT 调用契约）：
> 「User.AccessToken(面板 PAT)继续支持 `Authorization: Bearer`，**也兼容原有的单值 `Authorization:`**。**`New-Api-User` 不再参与鉴权，外部脚本不需要再发送 Bearer 与用户 ID 双请求头**——这是有意的调用契约简化，旧 PAT 本身无需重新生成。」

**代码级证据 ②**（`github.com/mucsbr/newapi-usage` README，另一个 new-api 生态工具）：
> 「The three GET endpoints accept the key in **`Authorization: Bearer sk-...` or `X-API-Key`**」

**代码级证据 ③**（`github.com/leolulu/newapi-daily-checkin` README，AT 优先 + Cookie 兜底的完整决策链）：
> 「已配置 AT:创建与浏览器完全隔离、初始 Cookie 为空的 API 请求上下文; **使用 AT 和 New-Api-User 请求 GET /api/user/self**; AT 无效、用户不匹配、预检网络失败或独立上下文无法创建:记录具体原因,回退 Cookie/user-data; AT 预检成功:本轮固定使用 AT 完成状态查询和签到,不再混入 Cookie; **AT 预检成功后的业务错误、Turnstile 要求或 POST 结果不确定:不回退 Cookie，避免重复签到或把验证码误判为认证失败**。」

→ **对我们的启示（3 条）**：
1. **`Authorization: Bearer <token>` 是安全的默认值**——new-api 两种都收，one-api 新版本同样收 Bearer。
2. **`extraHeaders` 逃生口必须保留**（one-api 老版本要裸 token 的说法未找到一手证据，但多个第三方工具都保留了覆盖能力）。
3. **直接抄 ③ 的「AT 预检 + 不回退」模式**：预检失败才回退；预检成功后的业务错误**不回退**（避免把 Turnstile/429 误判成认证失败）。**这条要写进 `index.ts` 的降级链。**

### Q3 · `ThendCN/newapi-monitor` 为什么选 Cookie 而不是 AccessToken？

**答案：是作者的架构选择（服务端 BFF 复用浏览器会话），不是站点限制。对我们不适用。**

**原文摘录**（`github.com/li0on3/newapi-monitor/blob/main/docs/CUSTOMER_CONSOLE.md`——ThendCN 项目的分支文档，讲得最清楚）：
> 「浏览器携带 New API 的 session Cookie 和 `New-Api-User`。监控平台通过 New API `/api/user/self` 校验 Session、账号状态和用户 ID 一致性。BFF 只向代码内固定的 New API API 转发当前 Session 与已校验用户 ID。」
> 「**为复用浏览器中的 New API Session 与 uid，生产环境应把监控平台挂载在 New API 的同一 Origin 下**，例如 `https://api.example.com/monitor/`。**独立域名或不同端口默认无法共享这两项浏览器状态，不应通过复制 Cookie 或管理 Token 冒充用户来绕过。**」

**原文摘录**（ThendCN 原版 README，说明 Cookie 怎么取）：
> 「**Cookie**：你的登录 cookie（从浏览器的开发者工具 -> 网络 -> `api/user/self` 请求中获取）。**用户 ID**：你的数字用户 ID（通常在同一请求头中找到，名为 `new-api-user`）。」

→ **结论**：
1. **Cookie 方案的前提是「同 Origin 的 Web 应用」**——它的动机是**免登录复用**（不让用户再管一个 token），并明确警告**跨 Origin 复制 Cookie 是 hack**。
2. **我们是桌面客户端，不是同 Origin Web 应用**——**AccessToken/PAT 才是正确选择**（用户给一个 token，权限可控、可撤销、不绑浏览器会话）。
3. **`New-Api-User` 头的值就是「用户数字 ID」**（new-api 后台个人中心可见；newapi-skills 官方文档的 `NEWAPI_USER_ID` 示例值为 `1`，注明「admin default is 1」）。**且新版 new-api 已不要求它**（见 Q2）。
4. **对 `types.ts` 的 `extraHeaders` 逃生口是否够用：够用，且应该保留**。但**引导顺序应反过来**：先 AccessToken → 失败再提示 Cookie（作为高级逃生口），而不是反过来。

### Q4 · 有没有免鉴权端点能判断站点类型？

**答案：有，就是 `/api/status`（+ `/api/uptime/status`）。完整字段清单与识别算法见附录 C 8.2 / 8.3。**

- **免鉴权已确证**：new-api 官方文档 `doc.newapi.pro/api/fei-system-initialization` 对 `/api/status` 明确标注「**鉴权要求:公开**」；one-api 源码 `router/api-router.go` 中 `/api/status` 所在路由组**无 auth 中间件**（仅 `gzip` + `GlobalAPIRateLimit`）。
- **`/api/uptime/status`**（new-api，Uptime-Kuma 兼容探针）同样免鉴权，可作纯存活探测。
- ⚠️ **未找到 sub2api 的免鉴权身份端点**——sub2api 系需靠 `GET <base>/usage` 的响应形状反推（**未验证**）。

### Q5 · `quota_per_unit` 在哪个端点、什么形状？可否免鉴权读到？

**答案：就在 `/api/status` 的 `data.quota_per_unit`，免鉴权可读。这意味着换算率可以自动推断，不必用户手填。**

- **源码确证**（one-api `controller/misc.go`）：`"quota_per_unit": common.QuotaPerUnit` —— **就在 `/api/status` 里**。
- **官方文档样例**（`doc.newapi.pro/api/fei-system-initialization`）：`"quota_per_unit": 500000`，字段说明「每单位配额数量」。
- **默认值**（one-api `common/constants.go`，`gitee.com/leegine/one-api/blob/main/common/constants.go`）：`var QuotaPerUnit = 500 * 1000.0 // $0.002 / 1K tokens`；DeepWiki 亦确认 new-api 为「1 美元 = 500,000 配额点数」。
- **另一处可读**（需 Root 权限，不适用）：`GET /api/option/` 返回 `{"key":"QuotaPerUnit","value":"500000"}`（`github.com/modelbus/one-api-pro/blob/main/docs/API.md`），且官方注明「敏感选项(如 Token、SMTP 密码等)的值会被过滤或脱敏」——one-api `constants.go` 注释亦写「**Any options with "Secret", "Token" in its key won't be return by GetOptions**」。

→ **对我们的启示（重要）**：
1. **`parseQuotaPerUnit()` 现有的 `data.quota_per_unit` 取法是正确的**（附录 B 已证 `/api/status` 免鉴权）——**这条待实测项可以关闭**。
2. **应把「自动推断换算率」提为默认行为**：`/api/status` 拿到 `quota_per_unit` → 写入站点配置 → 用户无需手填。**仅当 `/api/status` 不可用或字段缺失时才让用户手填。**
3. **同一响应里的 `display_in_currency` 决定返回值单位**——这两个字段应一起读、一起存。

### Q6 · Cloudflare 挑战页怎么判定「被拦了」而不是「站点挂了」？

**答案：未找到可直接抄的成熟实现代码，但找到了正确的判定思路与两个可借鉴点。**

- **可借鉴 ①**（`github.es/xc996/API_detect_tools`）：「**Bot Detection 智能检测**：自动识别返回 Bot Detection HTML 页面的情况（**即使 HTTP 状态码为 200**），自动切换到浏览器模式绕过检测。」
  → **判定依据是「内容特征」而非状态码**：200 + HTML body = 被拦。
- **可借鉴 ②**（`github.com/yl0711-coder/newapi-monitor`，Go 版）：用**独立的只读账号 + 只读 DSN** 做旁路监控，公开面「绝不输出渠道名/ID/IP、成本/配额、令牌/用户、请求量/QPS、错误详情」；登录「复用 new-api 用户身份（仅调用其 `/api/user/login` 验证）」。
  → **把「探测」与「业务请求」用不同凭证隔离**，探测失败不污染业务凭证状态。
- **可借鉴 ③**（one-api 配置，`deepwiki.com/sunqb/one-api/4-configuration`）：站点可开启 `TurnstileCheckEnabled`（Cloudflare Turnstile）与 `GlobalApiRateLimitNum = 480 / 180s`、`GlobalWebRateLimitNum = 240 / 180s`。`/api/status` 的 `turnstile_check` 字段会暴露这一点。
  → **可在探测阶段就预判「该站有 CF 风控」**，提前告知用户。

→ **判定建议（写进 `checkSiteHealth`）**：
```
非 JSON + HTTP 200            → blocked（Bot Detection / CF 挑战页）
非 JSON + HTTP 403/503        → blocked（CF 拦截特征状态码）
HTTP 401/403 + JSON error     → auth-failed
连接超时 / DNS 失败 / 拒连     → unreachable
JSON 但 success:false         → site-error（带 message）
```
**⚠️ 仍未实测**：CF 挑战页的确切状态码与 body 特征未验证——**这是唯一需要真实站点才能闭环的项**。

### 待实测项状态汇总（4 条 → 关闭 2 条，半关闭 1 条，剩 1 条）

| 原待实测项 | 状态 |
|---|---|
| 1. `Bearer` 对 one-api 老版本是否兼容 | 🟡 **半关闭**：new-api 两种都收（有代码级证据）；one-api 老版本未找到一手证据，**逃生口已留** |
| 2. `/api/status` 是否免鉴权、`quota_per_unit` 字段名 | ✅ **关闭**（源码 + 官方文档双证） |
| 3. `data.quota` 语义是剩余还是总额 | ✅ **关闭**（附录 B 已证：`quota` = 剩余，`quota + used_quota` = 总额） |
| 4. CF 挑战页归类 | 🔴 **仍需真实站点**（判定思路已定，特征未实测） |

---

## 10. 证据索引

- 桌宠：`github.com/PC2005-cloud/dsh-pet`、`github.com/MerZlin/dsh-pet-indesktop`（`docs/AGENT_LINK_PROTOCOL.md`）、`github.com/ysppwn721/better-dsh-pet`、`github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget`、`github.com/rullerzhou-afk/clawd-on-desk`、`github.com/OpenPetsHQ/openpets`、`github.com/rainnoon/oc-claw`、`github.com/moeyui1/claude-status-pet`、`github.com/ntd4996/agentpet`、`github.com/liyupi/dsh-kun-like-pet`、`github.com/oddmeta/charlotty`
- 中转站监控：`github.com/ThendCN/newapi-monitor`、`github.com/mosliu/newapi_credit_logger`、`pkg.go.dev/github.com/yl0711-coder/newapi-monitor`、`github.com/qixing-jk/all-api-hub`、`github.com/w286554018/metapi`、`github.com/zhang-jiazhi/dsh-stats-panel/blob/HEAD/docs/CHANNELS.md`、`github.com/lucashutch/limitwatch`、`github.com/kevingosse/copilot-usage`、`github.com/dante1007108174-droid/relay-scope`
- 协议：`agentclientprotocol.com`、`github.com/agentclientprotocol/agent-client-protocol`、`github.com/agentclientprotocol/registry`、`github.com/agentclientprotocol/claude-agent-acp`、`agentclientprotocol.com/rfds/session-notices`
- Codex pet 格式：`github.com/CraftNobody0505/lulu-dusk-codex-pet`、`github.com/Zacklinkk/pingtan-digital-ip-codex-pet`、`github.com/bxck1234/codexdream-ileina-pet-skin`、`github.com/ymhlap/codex-pet-dyt`
- **附录 B（one-api / new-api 一手源码）**：`gitee.com/hutu88/one-api/blob/main/router/dashboard.go`、`cnb.cool/uqilin/tools/newapi/-/blob/main/router/dashboard.go`、`github.com/qinguoyi/one-api/blob/refs/heads/main/controller/billing.go`、`cnb.cool/testpeng/newapi/-/blob/main/controller/billing.go`、`github.com/chikasaki/one-api/blob/main/router/api-router.go`、`github.com/renovate-bot/ckt1031-_-one-api/blob/main/router/api-router.go`、`cnb.cool/codeLong1024/one-api-pro/-/blob/master/router/api.go`、`github.com/cubeofcube-dev/one-api/blob/v0.0.1/router/api.go`、`deepwiki.com/songquanpeng/one-api/2.3-configuration-and-constants`
- **附录 B（官方文档）**：`doc.newapi.pro/api/fei-account-billing-panel/`、`docs.qingbo.dev/en/api-reference/account/subscription`、`doczh.dataeyes.ai/doc-8651891`、`docs.ezlinkai.com/8322330m0`、`docs.laozhang.ai/en/api-capabilities/balance-query`
- **附录 C（分支差异）**：`deepwiki.com/deanxv/done-hub/7-data-management`、`deepwiki.com/deanxv/done-hub/9-advanced-topics`、`deepwiki.com/deanxv/done-hub/7.1-user-management`、`zread.ai/deanxv/done-hub/13-quota-and-usage-tracking`、`pkg.go.dev/github.com/voapi/voapi@v0.2.0`、`topselfhost.com/posts/blog-1266`、`github.es/xc996/API_detect_tools`、`mckzonedaily.com/Ruawd/api-manager`、`www.gitcc.com/quyuan/all-api-hub-cn/-/tree/main`

> **免责**：所有 Star 数均注明来源与日期；GitHub 页面未返回数字的一律标「未获取」，未做任何估算。第三方快照站的数字可能与 GitHub 实时值有偏差，**以 GitHub 实时页面为准**。
