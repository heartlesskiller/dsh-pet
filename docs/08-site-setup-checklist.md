# 站点配置检查清单（用户侧 · P0）

> 项目：`D:\dev\dsh-pet-agent` ｜ 作者：许清楚（Product Manager）｜ 日期：2026-10-16
> 上游输入：`06-research-optimization.md` **附录 B（B-1…B-7 坑 + B-修1…B-修7）** 与 **附录 C（C-1…C-8 陷阱）**；路由契约取自 `dsh-pet/src/host/index.ts:945-954` 与 `relays/routes.ts`
> 纪律：**只写文档，未改任何代码**。每条结论可追溯到附录 B/C 编号；**未验证的一律标 [未验证]**，不新增说法。

> **⚠️ 这篇是「站点类型 × 坑位」参考手册，不是入门教程。**
> - 第一次用、想直接上手 → 看 `17-user-guide.md`（独立模式）或 `09-onboarding.md`（DSH 插件）
> - 本文的 curl 示例是给工程师自测与排错用的；普通用户请在 `/admin` 页面或 DSH 设置页里点

---

## 0. 怎么用这份文档

| 你的情况 | 直接去看 |
|---|---|
| 我要加一个中转站，不知道填什么 | **§1** 找到你的站点类型 → 照表填 |
| 我担心填错 | **§1** 每张表的「填错了会发生什么」列 |
| 加之前想先确认这个站能不能查 | **§2** 添加前先自查（5 个问题） |
| 加完了，显示不对 / 报错 | **§3** 添加后先验证（分步 + 失败对照） |
| 显示的数字和站点后台对不上 | **§4** 坑 → 用户可执行检查项映射表 |
| 不知道该给哪个凭证 | **§5** 凭证选择决策树 |

**⚠️ 最重要的三条（先看这个）**：
1. 🔴 **换算率填错 1000 倍 → 余额显示为实际值的千分之一 → 低余额告警永不触发**（附录 C-1：done-hub 的 `QuotaPerUnit` 默认值官方文档自相矛盾，`500` vs `500000`）。**添加站点后第一件事：核对显示金额与站点后台是否一致。**
2. 🔴 **显示「无限额度」不是真的有一亿美元**，而是该 Key 被设为无限额度（附录 B-3）。此时**请关闭该站的低余额告警**，否则告警逻辑失效。
3. 🔴 **我们绝不伪造 0 余额**。查不到就是显示「查询失败」或让你手工填，**不会拿 0 冒充成功**——看到 0 以外的错误信息是正常的，按 §3 排查。

---

## 1. 按站点类型的「添加站点检查清单」

> **通用规则**：URL 填**站点根地址**，不要带 `/v1` 后缀——`normalizeBaseUrl` 会去掉末尾斜杠与 `/v1`（`providers/newapi.ts`），所以两种填法**都能被救**。但**不要带路径**（如 `https://xxx.com/api`），那救不了。

### 1.1 new-api 系（new-api / one-api / one-hub / Veloera / Super-API / Neo-API / AnyRouter）

> 这是最常见的类型。当前代码的 `RelayKind` 只有 `new-api` 一种承接这一系（`relays/types.ts:26`）。

| 字段 | 必填 | 填错了会发生什么（最坏后果） | 怎么取到（照着点） |
|---|---|---|---|
| **URL** | ✅ | 填成 `https://xxx.com/v1` → **归一化能救**；填成 `https://xxx.com/api` 或带查询参数 → **所有请求 404**，显示「查询失败」 | 浏览器地址栏里站点首页的域名部分，如 `https://api.example.com` |
| **名称** | ✅ | 填错只是显示难看，**不影响功能**；留空则无法保存 | 随意，建议用你记得住的简称 |
| **凭证类型** | ✅ | 选 `manual`（无凭证）→ 只能手工填余额，**永远查不到实时数据** | 见 **§5 决策树**。**默认选 `api-key`**（附录 B-修1：`/dashboard/billing/*` 中间件是 `TokenAuth()`，API Key 就能用） |
| **凭证值** | ✅（manual 除外） | 填成**账号密码** → **直接 401**（`auth-failed`）；填成别的站的 Key → 401 或查到别人的额度；多复制了空格/换行 → 401 | **API Key**：站点 → **令牌管理 / API Keys** → 新建 → 复制 `sk-` 开头的字符串。<br>**AccessToken**：站点 → **头像 → 个人设置 → 系统访问令牌 / System Access Token → 生成**（newapi-skills 官方文档写「Personal Settings → Account → Security → System Access Token」；one-api 对应 `GET /api/user/token`，需登录态） |
| **用户 ID（`extraHeaders`）** | ⚠️ 视站点而定 | 老版本 new-api / one-api 可能要求 `New-Api-User` 头；**不填 → 401**。<br>新版 new-api **已不参与鉴权**（附录 B Q2 原文：「`New-Api-User` 不再参与鉴权」），**不填也能用** | 站点**个人中心**可见的数字 ID（new-api 的 admin 默认为 `1`，见 newapi-skills 的 `NEWAPI_USER_ID` 说明）。在「附加请求头」里加一条：键 `New-Api-User`，值 `<你的数字ID>` |
| **换算率 `quotaPerUnit`** | ✅ **必填核对** | 🔴 **填错 1000 倍 → 余额显示错 1000 倍 → 告警永不触发或误报**（附录 C-1） | **尽量让它自动探测**：`/api/status` 免鉴权返回 `quota_per_unit`（附录 B-修5、附录 C 8.2）。**若显示「换算率未确认」，必须手工核对**：拿站点后台显示的美元金额，与我们的数字对比，不一致就改 |
| **低余额阈值** | ⚠️ 建议填 | 不填 → **该站永不告警**（`selectLowSites` 阈值不猜）；填成 0 → 永不告警 | 你愿意为这个站补多少钱的金额，如 `5` |
| **备注** | — | 无影响 | 随意 |

**这一系的凭证引导顺序（附录 B-修1/B-修2 + PLAN 修订 #5「API Key 优先」）**：
```
① 先试 api-key（用户最愿意给、权限最小、/dashboard/billing/* 只要它）
        ↓ 查不到 / 401
② 再试 access-token（能查账户级总额，见 /api/user/self）
        ↓ 还不行
③ session-cookie（高级逃生口，易失效）
        ↓ 还不行
④ manual（手工填余额 + 标「手工」）—— 这是降级路径，不是失败
```

### 1.2 one-api 老版本

> 与 1.1 同一张表，但有两处差异：

| 差异点 | 说明 | 依据 |
|---|---|---|
| **`Authorization` 头可能要裸 token** | one-api 老版本有资料称要 `Authorization: <token>`（无 `Bearer`）。**未找到一手证据 [未验证]**。新版 new-api 两种都收（附录 B Q2 官方原文：「继续支持 `Authorization: Bearer`，也兼容原有的单值 `Authorization:`」） | 附录 B Q2、附录 D Q2 |
| **怎么救** | 在「附加请求头」里加一条：键 `Authorization`，值 `<裸token>`（**不要加 `Bearer`**）—— `extraHeaders` 同名键优先覆盖（`providers/newapi.ts:36-44`） | 附录 B 修、`providers/newapi.ts` |

**其余字段与 1.1 完全一致**，照 1.1 的表填。

### 1.3 Sub2API 系

> 契约：`GET <base>/usage` + sk key 自查（`relays/types.ts:24`，来源 `dsh-stats-panel/docs/CHANNELS.md`）。**⚠️ 当前 `sub2api` provider 尚未实现**（PLAN §9 未闭环第 4 条），添加后会返回 `unsupported`。

| 字段 | 必填 | 填错了会发生什么 | 怎么取到 |
|---|---|---|---|
| URL | ✅ | 同 1.1。**注意 `<base>` 通常以 `/v1` 结尾**（`dsh-stats-panel` 原文：「通用兜底 ②：任意 baseURL（通常以 `/v1` 结尾）」）→ 归一化会去掉 `/v1`，再由 provider 自己拼，**填根地址即可** | 站点根地址 |
| 凭证 | ✅ | 需要 **sk key**（不是 AccessToken）。填错 → `unsupported` 或查询失败 | 站点 → 令牌管理 → 新建 `sk-` Key |
| 换算率 | ✅ 核对 | 同 C-1 | Sub2API 的换算率**未验证**（附录 C 8.5），务必手工核对 |
| 阈值 | ⚠️ 建议 | 同 1.1 | 同 1.1 |

**当前状态**：`RelayKind` 已声明 `sub2api`，但 provider 未写 → **添加后请先用「手工填余额」，等 provider 上线再切自动**。

### 1.4 VoAPI

> 🔴 **这是最特殊的类型：查余额需要 JWT Token**（附录 C-3，既不是 AccessToken 也不是 API Key）。

| 字段 | 必填 | 填错了会发生什么 | 怎么取到 |
|---|---|---|---|
| URL | ✅ | 同 1.1 | 站点根地址 |
| **凭证类型** | ✅ | 🔴 **`RelayCredentialKind` 目前还没有 `jwt`**（`relays/types.ts:40` 只有 `access-token / api-key / session-cookie / manual`；PLAN 修订 #12 只说「预留」，**尚未实现**）→ **现在无法配 JWT，只能选手工填余额** | 见下 |
| **JWT 值** | ✅（若支持） | 填成 AccessToken → 401 | ❓ **未找到获取路径**（附录 C 8.5 第 3 条）→ **需查该站自己的文档或联系站长** |
| 换算率 | ✅ 核对 | 同 C-1 | VoAPI 换算率**未验证**，务必手工核对 |
| **余额归零提醒** | — | 🟠 VoAPI 有 `USER_DAILY_QUOTA_CLEAR` 开关（附录 C-4），开启后余额按 DAY/WEEK/MONTH **定期清零**。**余额归零不是 bug** | 若你的 VoAPI 站余额每天/每周归零：**关闭该站低余额告警**，否则会误报 |
| 阈值 | ⚠️ | 同上，归零站建议关闭告警 | — |

**当前状态**：**JWT 凭证尚未支持**。VoAPI 站**请先用手工填余额**（§1.6 通用兜底表的手工行）。

### 1.5 done-hub

> done-hub 与 new-api 接口基本兼容，但**有两个默认值在官方文档里自相矛盾**（附录 C-1 / C-2），**这是全文档最需要人工核对的一节**。

| 字段 | 必填 | 填错了会发生什么 | 怎么取到 |
|---|---|---|---|
| URL | ✅ | 同 1.1 | 站点根地址 |
| 凭证 | ✅ | 同 1.1（done-hub 同样基于 new-api，`/api/user/self` 兼容） | 同 1.1 |
| 🔴 **换算率** | ✅ **必须确认** | 🔴🔴 **done-hub 的 `QuotaPerUnit` 默认值官方文档一处写 `500`、一处写 `500000`，相差 1000 倍**（附录 C-1）。若探测不到而静默用了 500000，而站点实际是 500 → **余额显示为实际值的 1000 倍** → 要么永远不告警（阈值显得永远够），要么一上线就误报 | **先看 detect 给没给建议值**（别手工算）：<br>1. `POST /relays/detect` 的返回里若带 **`suggestedQuotaPerUnit`**，说明已从该站 `/api/status` 读到真实值 → **直接采用**<br>2. 没有该字段（探测不到）→ **才需要人工核对**：<br>　 a. 登录站点后台，记下它显示的余额（如 `$10.00`）<br>　 b. 看我们显示的金额<br>　 c. 不一致 → 手动改换算率直到一致<br>3. 界面显示「⚠ 换算率未确认」＝探测没成功、且你还没确认过（建站默认 `rateConfirmed: false`），**必须手工填**（PLAN 修订 #11：绝不静默用默认值） |
| 🟠 **单位** | — | 🟠 done-hub 的 `DisplayInCurrencyEnabled` 默认值文档同样冲突（附录 C-2）：一处 `false`、一处「Currency Mode (Default)」。若站点关了这个开关，**返回的是 quota 原值而非美元** → 显示 `5000000` 而不是 `$10.00` | 看到**量级荒谬的大数字**（如 `5000000`）就是这种情况 → 检查换算率是否填对 |
| 阈值 | ⚠️ 建议 | 同 1.1 | 同 1.1 |
| 精度预期 | — | 🟠 done-hub 有**预消费机制**（附录 C-5）：请求前按 `PreConsumedQuota`（默认 500 点）预留，响应后结算差额 → **抓取到的余额与真实可用额有微小时间差**，不要当精确值 | 无需动作，知道即可 |

### 1.6 其他兼容站 / 通用兜底（`openai-compat`）

> 契约：`GET <base>/dashboard/billing/subscription`（附录 B-修1 已证中间件是 `TokenAuth()`，**API Key 就够**）。适用于所有 OpenAI 兼容但叫不出名字的站。

| 字段 | 必填 | 填错了会发生什么 | 怎么取到 |
|---|---|---|---|
| URL | ✅ | 同 1.1 | 站点根地址 |
| 凭证 | ✅ | API Key 即可；填账号密码 → 401 | 站点 → 令牌管理 → `sk-` Key |
| 🔴 **换算率** | ✅ 必填核对 | 同 C-1。**通用站的换算率最可能猜不到** | 若 `/api/status` 拿不到 `quota_per_unit`（附录 C 8.2），**必须手工核对** |
| **无限额度** | — | 🔴 若该 Key 是无限额度令牌，接口返回 `100000000`（附录 B-3）。**这不是 1 亿美元** | 看到「无限额度」标记 → **关闭该站低余额告警** |
| **额度口径** | — | 🟠 该链路返回的可能是**令牌级**额度而非账户总额（附录 B-4：`DisplayTokenStatEnabled` 默认 `true`）| 界面标了「令牌额度」时，请理解这只是这个 Key 的钱；要账户总额 → 改给 AccessToken |
| 阈值 | ⚠️ 建议 | 同 1.1 | 同 1.1 |

### 1.7 手工填余额（万能降级，任何站都能用）

> 当上面所有方式都查不到时（附录 B/C 的核心结论：**「部分站查不到」是必然的**）。

| 字段 | 必填 | 说明 |
|---|---|---|
| 凭证类型 | ✅ | 选 **`manual`**（无凭证） |
| 手工余额 | ✅ | 通过 `POST /relays/{id}/manual-balance` 设置：body `{ "amount": "10.00", "currency": "USD" }`；**传空 `amount` = 清除**（`relays/routes.ts:119-127`） |
| 标记 | 自动 | 界面**必须显示「手工」标签 + 填写时间**，**不得伪装成实时数据**（`relays/types.ts:114-116`） |
| 告警 | 手动 | 🟠 **手工填的值不参与低余额告警**（`selectLowSites` 阈值不猜/手工值不告警）——这是故意的，避免用一个过期手填数误报 |
| 刷新 | 不会覆盖 | 手工值**不被自动刷新覆盖**（`relays/types.ts:73`）；想改回自动就重新配凭证 |

---

## 2. 添加前先自查（5 个启动问题）

> 目的：**在填任何东西之前**，先花 2 分钟确认这个站「有没有得查」。每条都给了「怎么验证」。

### Q1 · 这个站是不是被 Cloudflare 挡着？

| | |
|---|---|
| **为什么要问** | 被 CF 挑战页挡住时，**HTTP 状态码可能还是 200**，但 body 是 HTML（附录 B 坑 6 + 附录 C-3 Bot Detection）→ 我们会归类为 `blocked` 而不是 `unreachable` |
| **怎么验证** | 浏览器**无痕/隐私窗口**打开站点 → 如果出现「正在验证您是否是真人」/ 五秒盾 / Turnstile 打勾 → **大概率被挡** |
| **额外信号** | 访问 `https://<站点>/api/status`（**免鉴权**，附录 B-修5）。若浏览器直接显示 JSON → 没被挡；若显示 CF 挑战页 → 被挡 |
| **被挡了怎么办** | 我们的纯 HTTP 请求会失败 → **先用手工填余额**；「本地浏览器桥」降级是 P1/P2（附录 B 8.7） |
| **站点自报的信号** | `/api/status` 的 `turnstile_check` 字段为 `true` 时，说明站点开了 Cloudflare Turnstile（附录 C 8.2 字段表）|

### Q2 · 这个站的余额接口开放吗？

| | |
|---|---|
| **为什么要问** | **「部分站查不到余额」是必然的**（附录 B/C 贯穿结论）：站长可能关了接口、用了魔改版本、或改了指令 |
| **怎么验证** | 浏览器打开 `https://<站点>/api/status` → **能返回 JSON 就说明站点活着且接口开放**（免鉴权，附录 B-修5）<br>再试 `https://<站点>/api/user/self`（需登录态）→ 能返回你的 `quota`/`used_quota` 就说明余额接口开放 |
| **如果 `/api/user/self` 打不开** | 试 `https://<站点>/dashboard/billing/subscription`（附录 B-修1：只要 API Key） |
| **都不行** | 走 §1.7 手工填余额 |
| **⚠️ 注意** | `https://<站点>/api/models`（后台版）**需要登录态，不是 API Key**（附录 B-修6）→ 拿它测试会误判为「接口没开」 |

### Q3 · 站点关闭了「以货币显示」吗？

| | |
|---|---|
| **为什么要问** | 若站长关了 `DisplayInCurrencyEnabled`，接口返回的是 **quota 原值**而非美元（附录 B 坑 5 / 附录 C-2）|
| **怎么验证** | 看 `/api/status` 的 **`display_in_currency`** 字段（附录 C 8.2）：`true` = 返回美元；`false` = 返回 quota 原值 |
| **表现为** | 我们显示 `5000000` 这种量级荒谬的大数字，而不是 `$10.00` |
| **怎么办** | 手动设置正确的换算率（§1.5 done-hub 那节的核对步骤） |

### Q4 · 这个站的模型定价页开着吗？

| | |
|---|---|
| **为什么要问** | **定价接口返回的模型清单（1000+）比 `/v1/models`（只返回当前 Key 有权限的）更全**（附录 C / PLAN 修订 #14）→ 影响「模型清单对比」的完整度 |
| **怎么验证** | 登录站点后台 → 看有没有「模型定价 / Model Pricing」页面 |
| **表现为** | 我们的模型列表明显比站点后台的短 |
| **怎么办** | 我们会**优先试定价接口、失败回落 `/v1/models`**（PLAN 修订 #14）；用户无需动作，知道差异来源即可 |

### Q5 · 你的 Key 有查余额的权限吗？

| | |
|---|---|
| **为什么要问** | 同一个站，不同 Key 的权限/额度可能不同；无限额度 Key 会返回 `100000000` 哨兵（附录 B 坑 3）|
| **怎么验证** | 站点后台 → 令牌管理 → 看这个 Key 的「剩余额度」字段：<br>• 显示**具体数字** → 普通 Key，能查<br>• 显示**「无限额度」/ unlimited** → 该 Key 查出来会是 `100000000`，**请关闭该站告警**<br>• 令牌创建时若可设「Allow querying user quota」开关（new-api 新版，附录 B Q5）→ **保持开启** |
| **⚠️ 另一个权限维度** | `DisplayTokenStatEnabled` 默认 `true`（附录 B 坑 4）→ 我们查到的是**这个 Key 的额度**，不是账户总额。想查账户总额 → 改给 AccessToken |

---

## 3. 添加后先验证（按顺序做，用我们自己的端点）

> 前缀：**`http://127.0.0.1:3080/dsh-pet-7340`**（端口以实际为准；PLAN R0 会加单实例锁与发现机制）。
> 错误口径（`relays/routes.ts:9-14`）：**结构性参数错误 → HTTP 4xx + `{error}`**；**动作类失败 → HTTP 200 + `{ok:false, reason, message}`**。

### 第 0 步 · 先确认服务活着

```bash
curl -s http://127.0.0.1:3080/dsh-pet-7340/relays
```
| 结果 | 含义 | 下一步 |
|---|---|---|
| `{"ok":true,"sites":[...]}` | ✅ 服务正常（空数组 = 还没有站点）| 进入第 1 步 |
| 连接被拒绝 | ❌ 桌宠没起来 / 端口不对 | 先启动应用；端口被占时当前会顺延到 3081（**PLAN R0 的 S0 阻塞项就是要修这个**）|
| `{"error":"..."}` | 结构性错误 | 看 message |

### 第 1 步 · 添加站点

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "我的A鱼站",
    "url": "https://api.example.com",
    "kind": "new-api",
    "credential": { "kind": "api-key", "secret": "sk-xxxx" },
    "lowThreshold": "5.00"
  }'
```

**入参字段**（`store.ts:73-87` 的 `SiteInput`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` / `url` / `kind` | ✅ | 名称、根地址、站点类型 |
| `credential` | ✅（除 `manual`）| `{ kind, secret, extraHeaders? }` |
| `quotaPerUnit?` | — | 换算率。**不传见下方说明** |
| `rateConfirmed?` | — | 换算率是否已确认。**不传 = `false`** |
| `lowThreshold?` | — | 低余额阈值；不传则该站不告警 |
| `enabled?` | — | 是否参与刷新与告警 |
| `manualBalance?` | — | `{ amount, currency }`，手工余额 |
| `note?` | — | 备注 |

> 🔴 **建站时不传 `rateConfirmed` 就是 `false`**——所以你新增站点后看到「**⚠ 换算率未确认**」是**正常的、不是填错了**。
> 它表示：这个站的换算率**还没从 `/api/status` 探测过**（或探测失败）。先跑一次 `POST /relays/detect`，它若返回 `suggestedQuotaPerUnit` 就采用；确认无误后再把 `rateConfirmed` 置 `true`。
> 未确认的站点**余额带 `rateUnconfirmed` 标记、不参与低余额告警**——这是故意的，避免用一个可能差 1000 倍的汇率去告警。

| 结果 | 含义 | 怎么办 |
|---|---|---|
| 返回站点视图（`credential.masked` 形如 `sk-ab****wxyz`）| ✅ 添加成功 | 进入第 2 步 |
| `{"error":"..."}` (4xx) | 结构性错误：URL 不合法 / kind 未知 / 凭证类型不在白名单 / `rateConfirmed` 不是布尔 | 看 message。可用 kind：`new-api` / `sub2api` / `openai-compat`；可用凭证：`access-token` / `api-key` / `session-cookie` / `manual` |
| `{"error":"未知凭证类型：jwt"}` | 🔴 **VoAPI 的 JWT 尚未支持**（附录 C-3 / PLAN 修订 #12 只预留未实现）| 该站先选手工填余额 |

> **🔴 安全设计**：响应体**绝不出现明文凭证**——`assertNoSecret` 会在返回前扫描，一旦发现明文就**让该请求失败**（`relays/routes.ts:93-99`）。看到掩码是正常的。

### 第 2 步 · 识别 + 连通（**同一个 `/api/status` 请求，不拆两次**）

> PLAN 修订 #15：`detect` 与 `health` **合并为一次 `/api/status` 请求**。
> ✅ **`POST /relays/detect` 已实现**（`relays/routes.ts:63` + `relays/handlers.ts:41`）。

**① 先识别类型**（不落库，凭证只用于探测）：

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays/detect \
  -H 'Content-Type: application/json' \
  -d '{ "url": "https://api.example.com", "credential": { "kind": "api-key", "secret": "sk-xxxx" } }'
```

**预期返回（`RelayDetectResult`，`detect.ts:21-30`）**：
```json
{ "kind": "new-api", "confidence": "likely",
  "evidence": ["status:...", "..."],
  "suggestedQuotaPerUnit": 500000,
  "displayInCurrency": true }
```

| 字段 | 含义 | 用户该做什么 |
|---|---|---|
| `kind` | 判定的站点类型，可能是 `unknown` | `unknown` 不阻塞——仍可按通用链路试 |
| `confidence` | 把握程度 | 弱置信度时建议手动确认类型 |
| `evidence` | 判定依据（人话） | 看它「为什么这么判」，不信就手选 |
| **`suggestedQuotaPerUnit`** | ⭐ **从 `/api/status` 探测到的真实换算率** | **有值就直接采用**（§1.5 的换算率核对可以先跳过）；没有该字段才人工核对 |
| `displayInCurrency` | 站点是否以货币计价 | `false` → 返回的是 quota 原值，见附录 B 坑 5 |

**② 再探连通**（同一个 `/api/status`，`detect` 已经打过一次，这里只是取健康态）：

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays/<id>/health
```

**预期返回（`RelayHealthResult`）**：
```json
{
  "ok": true, "siteId": "<id>", "health": "online",
  "endpoint": "https://api.example.com/api/status",
  "status": 200, "latencyMs": 320,
  "checkedAt": "2026-10-16T..."
}
```

| `health` 值 | 含义 | 用户该做什么 |
|---|---|---|
| `online` | ✅ 站点活着，`/api/status` 通 | 进入第 3 步 |
| `blocked` | 🔴 **被 Cloudflare / 反代 / Bot Detection 挡住**（HTTP 200 但 body 是 HTML，附录 B 坑 6）| 见 §2 Q1；先手工填余额 |
| `auth-failed` | 🔴 401/403 | 凭证错。**最常见原因：把账号密码当成 AccessToken 填了** |
| `unreachable` | 🔴 连不上（超时/DNS/拒连）| 检查 URL 是否填错（尤其有没有多带路径）、网络/代理 |
| `unknown` | 未能判定 | 重试；仍不行就手工填余额 |

> ⚠️ **注意**：`/api/status` 返回 401/403 **不代表你的凭证一定错**——`providers/newapi.ts:197-199` 注释明说这是唯一能拿到的信号。

### 第 3 步 · 刷余额

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays/<id>/refresh
```

**预期返回（`RelayBalanceResult`）**：
```json
{ "ok": true, "siteId": "<id>", "provider": "relay:new-api",
  "shape": "money", "source": "auto",
  "data": { "currency": "USD", "total": "42.18",
            "granted": "42.18", "toppedUp": "0.00", "fullBalance": "70.05" } }
```

| `reason` | 含义 | 用户该做什么 |
|---|---|---|
| （成功） | ✅ | **立刻做金额核对**：拿站点后台的余额数字，与 `data.total` 对比 |
| `unsupported` | 该站点类型的 provider 还没写（如 `sub2api`）| 先手工填余额，等 provider 上线 |
| `credential-missing` | 凭证为空或 `kind: manual` | 配凭证，或改用手工余额 |
| `fetch-error` | 其他网络/解析失败（含 200-with-error、字段缺失）| 看 message；按 §2 排查 |
| **`blocked`** | 🔴 **被 Cloudflare / 反代 / Bot Detection 挡住**（`newapi.ts` 的 `isBlockedOrLimited()` 判定；注意**挑战页可能仍是 HTTP 200**）| **先手工填余额**。这不是你的凭证错，重试无用 |
| **`rate-limited`** | 🟠 **被站点限流**（429）| 别反复刷。等几分钟，或调大该站的刷新间隔 |
| `manual` | 降级路径，不是失败 | 用手工余额（§1.7）|

> `blocked` 与 `rate-limited` 是**新拆出来的两个独立原因**（`types.ts:155`）——以前它们都被笼统归到 `fetch-error`，用户分不清「被墙了」「被限流了」「真挂了」。现在分开，**处理动作也不同**：`blocked` → 手工填；`rate-limited` → 等一等。
> 判定细节见 `providers/newapi.test.ts:478/494/501`：403 + `server: cloudflare` → `blocked`；但**200 + `server: cloudflare` 且无 `cf-mitigated` 时不判拦截**（防神经过敏误报）。

**🔴 刷完必须做的核对（最重要的一步）**：
1. 登录站点后台，记下它显示的**剩余额度**
2. 与 `data.total` 对比
3. **不一致 → 99% 是换算率问题**（附录 C-1 / B 坑 5）→ 手动改 `quotaPerUnit`
4. 若界面显示「**换算率未确认**」→ 说明探测失败，**必须手工填**（PLAN 修订 #11）
5. 若显示「**无限额度**」→ 该 Key 是无限额度令牌（附录 B 坑 3）→ **关闭该站低余额告警**
6. 若界面标了「**令牌额度**」→ 这只是这个 Key 的钱，不是账户总额（附录 B 坑 4）

### 第 4 步 · 批量刷新（可选）

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays/refresh-all
```
返回 `RelayBalanceResult[]`（并发，信号量 4）。用来一次性看所有站的状态。

### 第 5 步 · 手工填余额（降级时）

```bash
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/relays/<id>/manual-balance \
  -H 'Content-Type: application/json' \
  -d '{ "amount": "10.00", "currency": "USD" }'
# 清除：{ "amount": "" }
```
| 结果 | 含义 |
|---|---|
| `{ok:true}` | 设置成功；界面会带「手工」标签 + 时间 |
| `{"error":"amount 必须是非负金额（至多两位小数）"}` | 格式错（`relays/routes.ts:113`）|
| `{"error":"缺少 currency"}` | 漏了币种（`relays/routes.ts:125`）|

> ⚠️ **手工填的值不参与低余额告警**（故意的，避免过期手填数误报）。想让它参与告警 → 配上能自动查到的凭证。

---

## 4. 坑 → 用户可执行检查项映射表

> 附录 B 的 7 个坑 + 7 条修订建议，附录 C 的 8 个陷阱，**共 22 条编号项**，逐条翻译成「你在自己站点上能做什么」。
> 翻译不了的（需要站长权限或站点内部状态的）明确写「**无法从外部判断**」。

### 4.1 附录 B 的坑（B-1 … B-7）

| 编号 | 工程含义（一句话） | 用户可执行的检查动作 | 翻译不了的部分 |
|---|---|---|---|
| **B-1** `hard_limit_usd` 不是剩余余额 | 站点接口返回的「限额」是**总额度=剩余+已用**，不是剩余 | ✅ **核对**：拿站点后台显示的「剩余额度」，与我们显示的 `total` 对比。**若我们显示的数字接近后台的「总额度」而非「剩余」，就是 bug，请报 issue** | 无 |
| **B-2** `total_usage` 单位是「分」 | 接口的 `total_usage` 是**分**，要除 100 才是美元 | ✅ **核对「今日已用」量级**：若我们显示今日已用 `601.41` 而你实际只花了约 `$6`，说明单位换算有问题 | 无 |
| **B-3** `100000000` 是「无限额度」哨兵 | 不是 1 亿美元，是该 Key 被设为无限额度 | ✅ **看到「无限额度」标记就关闭该站低余额告警**；并去站点后台确认这个 Key 是否本就该是无限额度 | 无 |
| **B-4** `DisplayTokenStatEnabled` 默认 `true` | 查到的是**这个 Key 的额度**，不是账户总额 | ✅ **看到「令牌额度」标记时，理解这不是账户总余额**。想查账户总额 → 改给 AccessToken | ⚠️ **无法从外部判断站点是否开了这个开关**——只能看我们返回的标记。若想确认，需问站长 |
| **B-5** `DisplayInCurrencyEnabled` 可能被关 | 站点可能返回 quota 原值而非美元 | ✅ **看到量级荒谬的大数字（如 `5000000`）就说明单位不对** → 检查 `/api/status` 的 `display_in_currency` 字段，并手动校正换算率 | ⚠️ 若站点不返回 `/api/status`，**无法从外部判断** |
| **B-6** 错误以 HTTP 200 + `{error}` 返回 | 不能只看状态码，要解析 body | ✅ **看到「查询失败」时，把 message 原文报给我们**（里面通常有站点的真实错误，如「获取配额失败」）| 无 |
| **B-7** `hard_limit` 会累加 | 不能用「站点后台限额变化」推算已用 | ✅ **不要自己用后台限额的变化算消耗**——以我们的余额快照与「今日已用」为准 | 无 |

### 4.2 附录 B 的修订建议（B-修1 … B-修7）

| 编号 | 工程含义 | 用户可执行的检查动作 |
|---|---|---|
| **B-修1** `/dashboard/billing/*` 只要 API Key（`TokenAuth()`）| 「只给 API Key」能覆盖的站点比预期多 | ✅ **默认只给 API Key**（§5 决策树）；不必一上来就交 AccessToken |
| **B-修2** 三级取数链路 | self → billing → usage/token | ✅ **按 §5 决策树的顺序给凭证**，失败再升级 |
| **B-修3** 结果带 `scope` 标记 | `account` vs `token` | ✅ **看到「令牌额度」字样时知道它的含义**（见 B-4）|
| **B-修4** 四个解析守卫 | 200-with-error / 1e8 哨兵 / total_usage÷100 / 非 JSON | ✅ **看到「无限额度」就关告警**（见 B-3）；看到「查询失败」就报 message（见 B-6）|
| **B-修5** `/api/status` 免鉴权 | 可用于存活探测 | ✅ **可随时自己打开 `https://<站点>/api/status` 验证站点活着**（这是最便宜的探针）|
| **B-修6** `/api/models`（后台版）需登录态 | 不能用 API Key 查 | ✅ **不要用 `/api/models` 判断「站点是否开放」**——它要登录态，会误判。改用 `/api/status` |
| **B-修7** `GET /api/user/token` 是生成 AccessToken 的端点 | 需 `UserAuth` | ✅ **知道去哪生成 AccessToken**：登录站点后访问该路径，或在后台「个人设置 → 系统访问令牌」 |

### 4.3 附录 C 的陷阱（C-1 … C-8）

| 编号 | 陷阱 | 用户可执行的检查动作 | 翻译不了的部分 |
|---|---|---|---|
| **C-1** 🔴 done-hub `QuotaPerUnit` 默认值文档自相矛盾（`500` vs `500000`，差 1000 倍）| **必须人工核对换算率** | ✅ **添加 done-hub 站后，立刻做金额核对**（§1.5 的 4 步）。不一致就手改换算率 | ⚠️ **无法从外部判断站点用的是哪个值**——只能靠 `/api/status` 的 `quota_per_unit` 或人工核对 |
| **C-2** 🔴 done-hub `DisplayInCurrencyEnabled` 默认值文档同样冲突 | 可能返回 quota 原值 | ✅ 同 B-5：看到大数字就校正 | ⚠️ 无法从外部判断 |
| **C-3** 🟠 VoAPI 查余额需 **JWT** | 既不是 AccessToken 也不是 API Key | ✅ **VoAPI 站目前只能手工填余额**（`jwt` 凭证尚未实现）；若要自动查，需查该站文档拿 JWT | ❓ **未找到 JWT 的获取路径**（附录 C 8.5）|
| **C-4** 🟠 VoAPI 有 `USER_DAILY_QUOTA_CLEAR` | 余额按 DAY/WEEK/MONTH 定期清零 | ✅ **若余额定期归零，关闭该站低余额告警**；这不是 bug | ⚠️ **无法从外部判断站点是否开了这个开关**——只能观察到「余额定期归零」这个现象 |
| **C-5** 🟠 done-hub 预消费机制 | 抓取值与真实可用额有时间差 | ✅ **不要把余额当精确值**；差异在毫秒级~秒级，无需动作 | 无 |
| **C-6** 🟢 Veloera 空响应不计费 | 健康探测可更激进 | ✅ 无需动作（对我们有利）| 无 |
| **C-7** 🟢 done-hub 内置低配额邮件预警 | 站点会自己发邮件 | ✅ **若站点已发邮件告警，可关闭本地重复提醒**，避免双倍打扰 | ⚠️ **无法从外部判断站点是否开了这个** |
| **C-8** 🟠 new-api 新版 `New-Api-User` 已不参与鉴权 | 老站要、新站不要 | ✅ **先不填「用户 ID」试一次**；若 401 再补 `New-Api-User` 附加头（§1.1 表）| ⚠️ **无法从外部判断站点是新版还是老版**——只能靠试 |

### 4.4 无法从外部判断的汇总（需联系站长）

1. 站点是否开了 `DisplayTokenStatEnabled`（B-4）→ 决定查到的是令牌级还是账户级
2. 站点是否关了 `DisplayInCurrencyEnabled`（B-5 / C-2）→ 决定返回美元还是 quota 原值
3. done-hub 的 `QuotaPerUnit` 实际是 500 还是 500000（C-1）→ **只能靠金额核对**
4. VoAPI 是否开了 `USER_DAILY_QUOTA_CLEAR`（C-4）→ 只能观察到现象
5. VoAPI 的 JWT 从哪拿（C-3）→ **未找到任何公开资料**
6. 站点是否开了低配额邮件预警（C-7）
7. 站点是新版还是老版 new-api（C-8）→ 决定要不要 `New-Api-User` 头
8. **Cloudflare 挑战页的确切表现**（附录 B 8.7 第 2 条）→ 未实测

---

## 5. 凭证选择决策树

> **分叉依据是「能查到什么」，不是「权限大小」**——这是附录 B-修1 的直接结论（`/dashboard/billing/*` 的中间件是 `TokenAuth()`，**API Key 就能查**）。

```
                    ┌─────────────────────────────────────┐
                    │ 你的站点是什么类型？                 │
                    └──────────────┬──────────────────────┘
              ┌──────────────┬─────┴──────┬───────────────┐
              ▼              ▼            ▼               ▼
        【new-api 系】  【one-api 老版】 【VoAPI】     【其他/未知】
              │              │            │               │
              ▼              ▼            ▼               ▼
      ┌───────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
      │ 第 1 步        │  │ 第 1 步   │  │ 只能     │  │ 第 1 步       │
      │ 给 API Key     │  │ 给 API Key│  │ 手工填   │  │ 给 API Key    │
      │ (sk-…)        │  │ (sk-…)   │  │ 余额     │  │ (sk-…)       │
      └───────┬───────┘  └────┬─────┘  └──────────┘  └──────┬───────┘
              │               │                              │
      查到令牌级额度      查到令牌级额度                查到余额？
              │               │                              │
        ┌────┴────┐     ┌────┴────┐                    ┌─────┴─────┐
        ▼         ▼     ▼         ▼                    ▼           ▼
     成功 ✅   401/   成功 ✅   401/                 成功 ✅    失败 ❌
               查不到            查不到
        │         │     │         │                    │           │
        ▼         ▼     ▼         ▼                    ▼           ▼
     用它   第 2 步   用它   第 2 步                  用它    第 2 步
             │                │                             │
             ▼                ▼                             ▼
      ┌──────────────┐  ┌──────────────┐            ┌──────────────────┐
      │ 给 AccessToken│  │ 给 AccessToken│            │ 给 AccessToken   │
      │ （个人设置→   │  │ （登录后访问  │            │ （个人设置→      │
      │  系统访问令牌）│  │  /api/user/   │            │  系统访问令牌）  │
      └──────┬───────┘  │  token）     │            └────────┬─────────┘
             │          └──────┬───────┘                     │
        ┌────┴────┐           │                        ┌─────┴─────┐
        ▼         ▼           ▼                        ▼           ▼
     成功 ✅   401/        成功 ✅  401/              成功 ✅    失败 ❌
               失败              失败
        │         │           │      │                  │           │
        ▼         ▼           ▼      ▼                  ▼           ▼
     用它   第 3 步      用它  第 3 步                用它    第 3 步
             │                 │                            │
             ▼                 ▼                            ▼
      ┌──────────────┐  ┌──────────────┐            ┌──────────────────┐
      │ 浏览器会话    │  │ 同左          │            │ 同左             │
      │ Cookie       │  │               │            │                  │
      │ (开发者工具→ │  │               │            │                  │
      │  网络→       │  │               │            │                  │
      │  api/user/   │  │               │            │                  │
      │  self 请求)  │  │               │            │                  │
      └──────┬───────┘  └──────┬──────┘            └────────┬─────────┘
             │                 │                            │
        ┌────┴────┐       ┌────┴────┐                  ┌─────┴─────┐
        ▼         ▼       ▼         ▼                  ▼           ▼
     成功 ✅   失败 ❌  成功 ✅   失败 ❌              成功 ✅    失败 ❌
        │         │       │         │                  │           │
        ▼         ▼       ▼         ▼                  ▼           ▼
     用它   ┌─────────┐ 用它   ┌─────────┐           用它   ┌─────────┐
            │ 第 4 步  │        │ 第 4 步  │                  │ 第 4 步  │
            │ 手工填   │        │ 手工填   │                  │ 手工填   │
            │ 余额     │        │ 余额     │                  │ 余额     │
            └─────────┘        └─────────┘                  └─────────┘
```

### 5.1 四种凭证「能查到什么」对照表

| 凭证 | 能查到什么 | 走哪条链路 | 什么时候用它 | 风险 |
|---|---|---|---|---|
| **API Key**（`sk-…`）| **令牌级额度**（这个 Key 自己的余额/已用）；模型清单 | `/dashboard/billing/subscription`（附录 B-修1，**只要它**）；`/api/usage/token/`（new-api 新版，附录 B Q5）| ⭐ **默认首选**。用户最愿意给、权限最小 | 低——泄露了也只是这一个 Key 的额度 |
| **AccessToken**（系统访问令牌）| **账户级总额**（`/api/user/self` 的 `quota`/`used_quota`）；令牌列表；分组信息 | `/api/user/self` | 想看**账户总余额**而不只是某个 Key 的钱；或 API Key 查不到时 | 🟠 中——**这是账户级权限**，泄露风险高于 API Key |
| **Session Cookie** | 同 AccessToken（登录态等价）| `/api/user/self` | 前两者都不行的老站；或临时应急 | 🔴 高——**易失效**（重新登录就废）、且**等于把账号交出来**。**不建议长期使用** |
| **JWT** | VoAPI 的余额 | VoAPI 专有链路 | 🔴 **目前代码还不支持**（`relays/types.ts:40` 无 `jwt`）| — |
| **manual**（无凭证）| 只能看你手工填的数字 | — | 万能降级：查不到时、或你根本不想交凭证 | 无——**但不参与告警、不会被自动刷新覆盖** |

### 5.2 「API Key 优先」这个结论的依据

> 附录 B-修1（源码确证）：`/dashboard/billing/*` 的中间件是 **`TokenAuth()`** —— **模型 API Key 就能用，不需要 AccessToken**。
> 出处：`router/dashboard.go`（`gitee.com/hutu88/one-api/blob/main/router/dashboard.go`、`cnb.cool/uqilin/tools/newapi/-/blob/main/router/dashboard.go`）。
> PLAN 修订 #5 已采纳：「凭证引导改为 API Key 优先」。

**这意味着**：你以为「必须交出系统访问令牌才能查余额」——**其实不必**。先用 API Key 试，能查到就用它。

---

## 6. 已知不一致与缺口（给 team-lead / 工程师，非用户内容）

> 这些是本文档写作过程中发现的**代码/文档与结论不一致**，请转交。

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| 1 | ✅ **已闭环**：`types.ts` 凭证注释**已改为「API Key 优先」**，与 PLAN 修订 #5/#22 一致 | `dsh-pet/src/host/relays/types.ts:33-40` | 现文为「`api-key`：模型 API Key。**推荐优先引导**」「`access-token`：……可查账户级余额」——本文档 §5 决策树与之一致 |
| 2 | 🔴 `RelayCredentialKind` 无 `jwt`，VoAPI 无法配置 | `relays/types.ts:44` | PLAN 修订 #12 只「预留」未实现；VoAPI 站目前只能手工填余额 |
| 3 | 🟠 `RelayKind` 只有 `new-api / sub2api / openai-compat`，**没有 `voapi` / `done-hub` / `veloera` / `one-hub`** | `relays/types.ts:26` | done-hub / veloera 等接口与 new-api 兼容，可先归入 `new-api`；但 **VoAPI 因 JWT 差异必须独立 kind**（附录 C-3）|
| 4 | ✅ **已闭环**：`POST /relays/detect` **已实现** | `relays/routes.ts:63`、`relays/handlers.ts:41`；返回形状 `detect.ts:21-30` | 本文档 §3 第 2 步已改为「先 detect、再 health」，并补了 `kind/confidence/evidence/suggestedQuotaPerUnit/displayInCurrency` 的说明 |
| 5 | ✅ **已闭环**：CF 判定表**已实现**（附录 B 坑 6 的 `blocked` 归类已接上）| `providers/newapi.ts` 的 `isBlockedOrLimited()`；专项测试 `providers/newapi.test.ts:478`（403+`server:cloudflare`→`blocked`）、`:494`（200+`server:cloudflare` 但无 `cf-mitigated` → **不判拦截**）、`:501`（断言正常出数 `spent === '34.58'`） | 本文档 §3 第 3 步已补 `blocked` / `rate-limited` 两个独立原因。**注意 `:494` 那条是防误报的关键**：见到 `server: cloudflare` 不能神经过敏 |
| 6 | ✅ **已闭环**：`API.md` / `openapi.yaml` **已补 `/relays` 契约** | 仓库根目录 `API.md` §五「中转站管理（`/relays`）」（19 处命中，含「数据直返」子域例外说明）；`openapi.yaml` 23 处 | **注意路径是仓库根，不在 `dsh-pet/` 下**。文档里的 curl 示例与之一致 |

---

## 7. 证据索引

- 附录 B（7 坑 + 7 修订 + 6 条 Q&A）：`06-research-optimization.md` 第 7 节；源码 `router/dashboard.go`、`controller/billing.go`、`router/api-router.go`、`common/constants.go`、`controller/misc.go`；官方文档 `doc.newapi.pro/api/fei-user/`、`doc.newapi.pro/api/fei-account-billing-panel/`、`doc.newapi.pro/api/fei-system-initialization`、`docs.laozhang.ai/en/api-capabilities/balance-query`、`doczh.dataeyes.ai/doc-8651891`、`docs.ezlinkai.com/8322330m0`
- 附录 C（分支矩阵 + 自报身份 + 识别算法 + 8 陷阱）：`06-research-optimization.md` 第 8 节
- 附录 D（5 问 + 待实测项压降）：`06-research-optimization.md` 第 9 节
- 路由契约：`dsh-pet/src/host/index.ts:945-954`、`dsh-pet/src/host/relays/routes.ts`、`dsh-pet/src/host/relays/types.ts`
- PLAN 修订记录 #5 / #9 / #11 / #12 / #14 / #15：`docs/PLAN-v1.md` §6

> **⚠️ 全文档最重要的一句话**：**「部分中转站查不到余额」是技术上必然的**（附录 B/C 贯穿结论）。这不是 bug，是降级路径——**手工填余额 + 「手工」标签**，绝不伪造 0。
