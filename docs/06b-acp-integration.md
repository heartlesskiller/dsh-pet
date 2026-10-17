# ACP 接入成本分析（给架构师）

> 项目：`D:\dev\dsh-pet-agent` ｜ 作者：许清楚（Product Manager）｜ 日期：2026-10-16
> 上游输入：`docs/06-research-optimization.md` 第 3 节 C1、附录 B/C
> 用途：回答「桌宠要不要接 ACP、接哪一端、代价多大」。**只调研与写文档，未改任何代码。**
> 所有结论带 URL；抓不到写「未获取」，不估算不编。

---

## 0. 结论先行（三选一）

# ✅ 部分借用（Partial）

**桌宠做 ACP 的 Client 端，但只作为「三条摄入轨道」中的一条，不是唯一入口。**

| 项 | 结论 |
|---|---|
| **桌宠做哪一端** | **Client**（编辑器那一端）。语义完全匹配：Client 负责「把 agent 的状态呈现给人看」，正是桌宠的职责 |
| **为什么不能只靠 ACP** | 🔴 **ACP 的前提是「Client spawn agent 作为子进程」**。用户**已经在终端里跑着 Claude Code** 时，桌宠**无法**通过 ACP 看到那个已存在的会话 |
| **三条轨道** | **A. ACP**（桌宠 spawn agent，或连已暴露 ACP server 的 agent）→ **B. Hooks**（用 agent 原生 hook 机制推给桌宠）→ **C. HTTP 推送**（任意 agent 一条 curl 即可） |
| **反构（桌宠做 ACP agent）** | ❌ **不建议**，且**未找到任何先例**（见 §4） |
| **ACP 单独使用的代价** | 覆盖不到「终端里已启动的 agent」——而这正是最高频的场景 |
| **不加 ACP 的代价** | 每个 agent 都要手写 hook 适配；无法复用官方 `claude-agent-acp` / `codex-acp` 适配器；「适用于所有 agent」的口号打折 |

---

## 1. ACP 是什么（30 秒）

| 属性 | 值 |
|---|---|
| 全称 | Agent Client Protocol |
| 创建 | Zed Industries，2025-08 首发；仓库 2025-06-23 建 |
| 许可 | **Apache-2.0**（无授权障碍） |
| Star | **4,430**（`git.mafyuh.dev`，2026-10-13）／3.4k（`rywalker.com`，2026-06）——**GitHub 页面本次未返回数字** |
| 传输 | **JSON-RPC 2.0 over stdio**（NDJSON，一行一个消息） |
| 定位 | 「编辑器 ↔ 编码 agent」的开放标准，对标 LSP 对语言服务器的标准化 |
| 生态 | 官方 SDK 5 种语言（Rust/Kotlin/Python/TS/Java）；**ACP Registry 收录 40+ agent** |
| 版本 | **生产用 v1，v2 是 opt-in 草案**（`acpserver.org` 原文：「Use v1 in production. Treat v2 as an opt-in draft.」） |

**ACP vs MCP**（`agentclientprotocol.com`）：MCP 回答「agent 能访问哪些工具和数据」；ACP 回答「agent 住在哪个客户端里」。**两者互补，不是竞争**。我们的桌宠如果要做 ACP Client，同时也可以给 agent 提供 MCP server（让 agent 反向驱动桌宠）——这是**两个独立的方向**，别混为一谈。

---

## 2. 桌宠应该做哪一端？—— **Client**

### 2.1 语义映射（几乎一一对应）

| ACP Client 职责（官方文档列举） | 桌宠对应能力 |
|---|---|
| 创建与管理到 agent 的连接 | 单实例锁 + 发现机制（PLAN 的 S0） |
| 处理用户输入、展示 agent 响应 | 桌宠动画 + 气泡 |
| 管理文件系统访问与安全 | （可选，L2/L3 能力） |
| **请求并展示权限提示** | ⭐ **权限审批气泡**（clawd-on-desk 已有此功能，见调研 OP-18） |
| 代表 agent 运行终端命令 | （可选） |

**关键映射**：ACP 的 `session/update` 通知就是「agent 状态流」——这正是驱动桌宠动画的东西。ACP 的通知类型（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`）可以直接映射到我们的六态词汇（思考/工作/整理/等待/成功/出错）。

### 2.2 官方最小可用 Client 示例（可直接跑）

来自 GitHub Copilot CLI 官方文档（`docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server`）——**Copilot CLI 自带 ACP server 模式 `copilot --acp --stdio`，这是现成的测试对象**：

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

// 1) spawn agent（stdio 传输）
const p = spawn("copilot", ["--acp", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });

// 2) NDJSON 流
const stream = acp.ndJsonStream(
  Writable.toWeb(p.stdin) as WritableStream,
  Readable.toWeb(p.stdout) as ReadableStream,
);

// 3) 实现 Client 接口 —— 只有两个必需方法
const client: acp.Client = {
  async requestPermission(params) {
    // 弹桌宠气泡让用户 Allow / Deny
    return { outcome: { outcome: "cancelled" } };
  },
  async sessionUpdate(params) {
    const u = params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      // → 驱动桌宠动画/气泡
    }
    // 还有 tool_call / tool_call_update / plan / agent_thought_chunk
  },
  // 可选：readTextFile / writeTextFile
};

// 4) 建连 + 握手 + 开会话 + 发 prompt
const connection = new acp.ClientSideConnection((_agent) => client, stream);
await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] });
```

**成本核算**：
- 依赖：`@agentclientprotocol/sdk`（+ `zod`，SDK 用 Zod 做运行时校验）
- 必需实现：`requestPermission` + `sessionUpdate` **两个方法**
- 可选实现：`readTextFile` / `writeTextFile`（L2/L3 才需要）
- 代码量：**约 100–150 行**即可跑通「spawn agent → 收状态 → 弹权限气泡」

### 2.3 🔴 但有一个绕不过去的限制

> ACP 的模型是：**Client 启动 agent 作为子进程**（`agentclientprotocol.com`：「Local agents run as sub-processes of the code editor」）。

**这意味着：**
- ✅ 桌宠**自己启动**的 agent → ACP 看得到
- ❌ 用户**在终端里已经跑着**的 Claude Code / Codex → **ACP 看不到**

而「用户开着终端跑 agent，桌宠在旁边陪」是**最高频的真实场景**。所以：

> **ACP 单独使用 = 覆盖不到主要场景。这就是「部分借用」而非「ACP 优先到唯一」的根本原因。**

**补充证据**：即便是官方生态内的 agent（Hermes），也明确「ACP Server 和 Gateway 是隔离的，不共享同一个 Agent 实例」（`bytenote.net/article/hermes-user-guide-features-acp`）——**ACP 连不上一个已在别处运行的 agent 实例**。

---

## 3. 三条摄入轨道（推荐架构）

| 轨道 | 机制 | 覆盖场景 | 成本 | 状态 |
|---|---|---|---|---|
| **A. ACP** | 桌宠作 Client，spawn agent 或连其 ACP server | 桌宠启动的 agent；任何暴露 ACP server 的 agent（Copilot CLI / Claude / Codex / Gemini CLI / OpenCode / Qwen / Kimi / Cline / Factory Droid / Goose …） | **中**（2–3 天：SDK 接入 + 进程生命周期 + 状态映射） | 推荐做 |
| **B. Hooks** | 用 agent **原生 hook 系统**把事件 POST 到桌宠本地 HTTP | 终端里已启动的 agent（Claude Code 15 个 hook 事件 / Codex / Cursor / Gemini CLI / opencode …） | **小–中**（每 agent 约 0.5–1 天，hook 脚本多为照抄） | 推荐做 |
| **C. HTTP 推送** | 桌宠开一个本地 HTTP 端点，任意 agent 一条 `curl` 即可推状态 | 一切未集成的 CLI / 自研 agent | **小**（0.5 天） | 必做 |

> **这不是「自建 JSONL 总线」**——B/C 用的是各 agent **原生**的 hook/HTTP 能力 + 桌宠一个普通 HTTP 端点，**不发明新协议**。这比 ACP 更轻，且能覆盖 ACP 覆盖不到的场景。
>
> ⚠️ 与 PLAN 当前表述的差异：PLAN §2 R0 写「摄入双轨：ACP 首选 + HTTP 兜底；**不自建 JSONL 总线**」。**「不自建 JSONL 总线」我完全同意**；但建议把「HTTP 兜底」明确为「**Hooks（用 agent 原生 hook）+ HTTP 推送**」两条，因为纯 HTTP 兜底要求用户手写 curl，而 hook 是 agent 自带的、用户零成本。**请架构师定稿。**

**三轨共用的归一化**：无论哪条轨道进来，都先归一成**同一份六态词汇**再驱动动画——这与 `MerZlin/dsh-pet-indesktop` 的 `normalize_event_state → 六态词汇` 设计一致（见调研 C3），也与 `clawd-on-desk` 的「12 animated states driven by agent hooks and logs」一致。**三轨一归一，客户端零改动。**

---

## 4. 反构（桌宠做 ACP agent）？—— ❌ 不建议，且未找到先例

| 检查项 | 结论 |
|---|---|
| 有没有项目这么干 | **未找到**。检索了 OpenPets / clawd-on-desk / OC-Claw / claude-status-pet / AgentPet / dsh-pet-indesktop / better-dsh-pet，**无一例把桌宠实现为 ACP agent**；清一色是「桌宠作 Client 或作纯被动展示」 |
| 语义上成立吗 | ❌ 不成立。ACP agent 被期望响应 `prompt` 并产出推理/工具调用；桌宠**不能推理** |
| 硬做会怎样 | 任何 ACP Client（Zed/JetBrains）都会把桌宠当成一个「聊天 agent」列出来——**用户困惑**，且桌宠只能通过 `sessionUpdate` 单方面广播，浪费协议 |
| 有没有可借鉴的部分 | 有一点：`Session Notices` RFD（`agentclientprotocol.com/rfds/session-notices`）提出 `sessionUpdate: "notice"` + `severity: info/warning/error` 的「一次性通知」原语，**明确建议 Client 对重复 notice 做合并（coalesce）**——**这个语义可以直接搬进我们的余额告警设计**（见 §6） |

**结论：不做反构。桌宠只做 Client。**

---

## 5. ACP Registry：对我们要不要用？

### 5.1 Registry 机制（已确证）

| 属性 | 值 |
|---|---|
| 分发 | **CDN**：`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` |
| 源头 | GitHub 仓库 `agentclientprotocol/registry`，**每小时自动同步**（GitHub Action `sync-registry.yml`） |
| 形态 | **静态清单**（curated manifest list），**不是动态发现** |
| 提交方式 | Fork 仓库 → 建以 agent id 命名的目录 → 放 `agent.json` + `icon.svg` → PR → **CI 按 schema 校验** |
| manifest 字段 | `id`（须匹配 `^[a-z][a-z0-9-]*$`）、`name`、`version`（semver）、`description`、`distribution`（`binary`/`npx`/`uvx`）、`icon` |
| 硬性要求 | **`binary` 分发必须同时提供 macOS/Linux/Windows 三平台**；icon 必须 **16×16 单色 SVG 且只用 `currentColor`**（硬编码色会被拒） |
| 本地开发替代 | 不上市集也能用：Zed `agent_servers: { "x": { "type": "custom", "command": "...", "args": ["acp"] } }` |

> 出处：`deepwiki.com/agentclientprotocol/agent-client-protocol/1.2-agent-registry`；实例：Hermes（`acp_registry/agent.json` + `icon.svg`，`uvx --from 'hermes-agent[acp]==' hermes-acp`）、Claurst（`command: claurst args: ["acp"]`）、Clio Coder（`clio-coder acp`）。

### 5.2 对我们的价值判断

| 问题 | 答案 |
|---|---|
| 桌宠要不要**把自己**注册进 Registry | ❌ **不要**。Registry 收录的是 **agent**，桌宠是 **Client**，注册是范畴错误 |
| 桌宠要不要**读** Registry | 🟡 **可选，P2**。价值：用户点「启动 Claude Code」时，桌宠能自动列出可用的 ACP agent 并一键 spawn。代价：一次 CDN fetch + 缓存，**很小** |
| 三平台 binary 要求会影响我们吗 | ❌ 不影响（那是 agent 发布者的事） |

---

## 6. 可复用到「余额告警」的 ACP 语义

`Session Notices` RFD（`agentclientprotocol.com/rfds/session-notices`）虽是为 ACP 提的，但**它的设计原则正好是我们余额告警缺的**：

| RFD 原则 | 搬到我们的告警 |
|---|---|
| notice 是**一次性事件**，**无 ID、无响应、无确认、无删除** | 告警就是「推一次」，不要求 ack |
| **「Repeated notices are independent events, even when their fields are identical」** | 同一条告警重复出现是独立事件——**去重是 Client 的职责，不是协议的** |
| **「A Client … may coalesce repeated notices」** | ⭐ **告警去重应由桌宠做**（这正是调研 OP-14「同源同告警只弹一次」的协议级依据） |
| `severity: info / warning / error` 三档 | 我们的余额告警也应分三档（低余额=warning、将耗尽=error、恢复=info） |
| 「Agents must behave as though the notice may not have been received」 | **告警推送失败不能影响主流程**——必须 best-effort |
| 「Client presentation 自由：toast/banner/inline/notification center」 | 桌宠气泡 / 托盘角标 / 系统通知，**渠道自由** |

---

## 7. 成本汇总与落地建议

| 工作项 | 成本 | 优先级 | 依赖 |
|---|---|---|---|
| **C. HTTP 推送端点**（任意 agent 可 curl） | 小（0.5 天） | **P0** | 无（PLAN 已有 `/dsh-pet-7340` 路由，加一个 prefix 即可） |
| **B. Hooks 接入**（Claude Code 先行，15 个 hook 事件） | 小–中（1–2 天） | **P0** | C |
| **A. ACP Client 接入**（`@agentclientprotocol/sdk`，实现 2 个必需方法） | 中（2–3 天） | **P1** | C（共用归一化层） |
| 六态归一化层（三轨共用） | 小（1 天） | **P0** | 无 |
| 权限审批气泡（复用 `requestPermission`） | 中（1 天） | **P1** | A 或 B |
| Registry 读取（一键启动 ACP agent） | 小（0.5 天） | **P2** | A |
| 反构（桌宠作 ACP agent） | — | ❌ **不做** | — |

### 给架构师的 4 条具体建议

1. **归一化层先做，且三轨共用**：无论 ACP / Hooks / HTTP，进来先归一成六态词汇。这样三条轨道可以**独立排期、独立上线**，互不阻塞——也符合「每一轮必须有实际产出」的纪律。
2. **ACP 只做「只读子集」**：V1 只需 `initialize` + `newSession` + `sessionUpdate` + `requestPermission`。**不要实现 `readTextFile`/`writeTextFile`/终端命令**（那是 L3 能力，V1 不做）。
3. **进程生命周期要防踩坑**：ACP 是 stdio 子进程，**日志必须写 stderr 绝不写 stdout**（否则污染协议——Claurst 官方文档明确警告：「verbose ACP logging to stderr — never stdout, which would corrupt the protocol」）。且**必须与单实例锁（S0）协同**：ACP 子进程若被桌宠复用/重启，不能泄漏僵尸进程。
4. **鉴权不用操心**：ACP 走本地 stdio，**无网络鉴权问题**；这与我们「本地 HTTP 端点要防外网访问」是不同的问题，别混。

---

## 8. 仍未验证的

1. **`@agentclientprotocol/sdk` 的确切 npm 包名有两个**：`@agentclientprotocol/sdk`（现行，`tessl.io` 文档）与 `@zed-industries/agent-client-protocol`（旧名，`noqta.tn` 教程仍在使用）。**接入前需 `npm view` 确认现行包名与版本。**
2. **`claude-agent-acp` 与 `codex-acp` 未实际跑通**——仅从 Registry 收录与 Star 数（2.6k / 452）判断可用。**需要本地实测 spawn + 收 sessionUpdate。**
3. **「attach 到一个已在别处运行的 ACP agent」是否可行未验证**——SDK 有 `loadSession` 能力位（示例里设 `false`），但是否支持「连上外部已运行实例」不明。**这是决定轨道 A 覆盖率的关键，建议架构师花半天实测。**
4. **Copilot CLI 的 `--acp --stdio` 未实测**（官方文档有完整示例，但需本机装有 Copilot CLI 且已认证）。
5. **v1 与 v2 的差异未细读**（官方建议生产用 v1，但 v2 的新特性未评估）。

---

## 9. 证据索引

- 协议与生态：`agentclientprotocol.com`、`acpserver.org`、`agentclientprotocol.com/rfds/session-notices`
- Registry：`deepwiki.com/agentclientprotocol/agent-client-protocol/1.2-agent-registry`、`bytenote.net/article/hermes-user-guide-features-acp`、`gitmemories.com/index.php/Kuberwastaken/claurst`、`github.com/iowarp/clio-coder/blob/main/docs/architecture/acp.md`
- TS SDK 最小示例：`docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server`（Client 示例）、`mintlify.wiki/agentclientprotocol/typescript-sdk/quickstart`（Agent 示例）、`mintlify.wiki/agentclientprotocol/typescript-sdk/clients/overview`、`tessl.io/registry/tessl/npm-agentclientprotocol--sdk/0.5.0`、`noqta.tn/en/tutorials/acp-agent-typescript-custom-ai-coding-agent-2026`
- 仓库：`github.com/agentclientprotocol/agent-client-protocol`（4,430 Star）、`github.com/agentclientprotocol/typescript-sdk`（263）、`github.com/agentclientprotocol/claude-agent-acp`（2,644）、`github.com/agentclientprotocol/codex-acp`（452）、`github.com/agentclientprotocol/registry`
- Star 数来源：`git.mafyuh.dev/agentclientprotocol`（2026-10-13 抓取页面显示的 fork/star 区）
