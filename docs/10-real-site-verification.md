# 真站验证报告 · new-api 适配器（首个真实站点闭环）

> 验证时间：2026-10-17 16:40–16:50（UTC+8）
> 站点：`https://st.cmjlevi.top`（站长自定义 `system_name = "st-api"`）
> 凭证：**模型 API Key（`sk-…`，已在会话中泄露，建议站长侧重置）**。本文**不记录任何密钥原值**。
> 手法：`curl` 直连；`HTTP` 状态码与响应体原样摘录。**所有结论来自实测，不是文档推断。**

---

## 一、站点身份判定（结论：new-api，且 `system_name` 不可用于识别）

| 探针 | 实测结果 | 判定 |
|---|---|---|
| `GET /api/status` | `HTTP 200`，`Content-Type: application/json`，`Server: cloudflare`，**无 `cf-mitigated` 头**（未被挑战） | 免鉴权可读 ✅ |
| `data.system_name` | **`"st-api"`**（站长自定义，**不是 `"New API"`**） | 🔴 **不能用 `system_name` 判类型** |
| `data.version` | **`""`（空串）** | 🔴 **不能用 `version` 判类型** |
| `data.quota_per_unit` | **`500000`** | ✅ 换算率可自动推断 |
| `data.display_in_currency` | `true` | 返回值以货币计价 |
| `data.usd_exchange_rate` | `7.3` | 该站按 1 USD = 7.3 CNY 换算 |
| `data.price` | `7.3` | 同上 |
| `data.HeaderNavModules` / `SidebarModulesAdmin` | 存在且为 JSON 字符串 | ✅ **这才是可靠的 new-api 特征** |
| `GET /v1/models`（Bearer） | `HTTP 200`，返回 11 个模型，元素含 **`supported_endpoint_types`** | ✅ **`supported_endpoint_types` 是 new-api 的强特征** |

**识别算法修正**：`system_name` / `version` 都不可靠（这个站一个被改、一个为空）。可靠信号是 `/api/status` 的 `HeaderNavModules` / `SidebarModulesAdmin` 字段存在，以及 `/v1/models` 元素里的 `supported_endpoint_types`。

---

## 二、余额/用量端点实测（全部以模型 API Key 调用）

### 2.1 `GET /api/user/self` —— 需要 AccessToken，API Key 不行
```
HTTP 200
{"message":"无权进行此操作，access token 无效","success":false}
```
🔴 **同时验证了两件事**：
1. `/api/user/self` **必须 AccessToken**，模型 API Key 无效
2. **错误以 HTTP 200 + `{"success":false}` 返回** —— PM 说的「200-with-error」坑在真站上确诊

### 2.2 `GET /dashboard/billing/subscription` —— 可用，但撞上「无限额度」哨兵
```
HTTP 200
{"object":"billing_subscription","has_payment_method":true,
 "soft_limit_usd":100000000,"hard_limit_usd":100000000,
 "system_hard_limit_usd":100000000,"access_until":0}
```
🔴 **`hard_limit_usd = 100000000`（1e8）= 无限额度哨兵**，真站确诊（PM 的坑 #3 成立）。
🔴 **响应里根本没有 `total_usage` 字段** —— 所以 `剩余 = hard_limit_usd − total_usage/100` **这个公式在本站无法套用**（缺被减数）。对 unlimited 令牌必须先判哨兵、再走别的端点拿用量。

### 2.3 `GET /v1/dashboard/billing/subscription` —— 与上一条**完全相同**
```
HTTP 200
{"object":"billing_subscription", ..., "hard_limit_usd":100000000, ...}
```
✅ 证实「`/v1` 前缀不是版本分界，两条路径都注册」，与 PM 的结论一致。

### 2.4 🏆 `GET /api/usage/token/` —— **本站在 API-Key-only 场景下的最优端点**
```
HTTP 200
{"code":true,"data":{
  "expires_at":0,
  "model_limits":{},
  "model_limits_enabled":false,
  "name":"code",
  "object":"token_usage",
  "total_available":-17291179,
  "total_granted":0,
  "total_used":17291179,
  "unlimited_quota":true
},"message":"ok"}
```
**四个关键事实**：
1. **`unlimited_quota: true` 是显式布尔字段** —— 比 1e8 哨兵可靠得多，应作为「无限额度」的**首选判据**
2. `total_used = 17291179` quota ÷ 500000 = **$34.582358** ← 真实已用金额
3. 🔴 **`total_available = -17291179` 是负数** —— 因为 `granted = 0` 而 unlimited。**绝不能当余额用**，否则会显示 −$34.58
4. `total_granted = 0`

### 2.5 `GET /v1/dashboard/billing/usage` —— 交叉验算，单位确认为「分」
```
HTTP 200
{"object":"list","total_usage":3458.2358}
```
**交叉验算**：`3458.2358 分 ÷ 100 = $34.582358`，与 2.4 的 `total_used / quota_per_unit` **完全相等**。
✅ 两条独立路径算出同一个数 → **PM 的「`total_usage` 单位是分」在真站确诊**。

### 2.6 `GET /api/pricing` —— **免鉴权**，且带价格信息
```
HTTP 200（无 Authorization 头）
{"auto_groups":["default"],"data":[
  {"model_name":"gpt-image-2.5-flare","vendor_id":4,"quota_type":1,
   "model_ratio":0,"model_price":12,"enable_groups":["svip","vip","default"],
   "supported_endpoint_types":["openai"]}, ...]}
```
- 免鉴权可读 ✅
- **但模型数与 `/v1/models` 一样都是 11 个** → 🔴 **PM 说的「pricing 返回 1000+ 完整目录」在本站不成立**（该说法依赖站点规模，不能当通用结论）
- **额外价值**：`model_ratio` / `model_price` 是**价格倍率**，`/v1/models` 没有。想做「哪家更便宜」必须用这个端点

### 2.7 `GET /api/models/display` —— **需要鉴权，PM 说的「匿名可见」不成立**
```
HTTP 401
{"message":"无权进行此操作，未登录且未提供 access token","success":false}
```

### 2.8 `GET /api/uptime/status` —— 存在但返回空
```
HTTP 200
{"data":[],"message":"","success":true}
```

---

## 三、对适配器的实现结论（按优先级重排）

### 3.1 取数链路（**用真站结果重排，不再是文档推测**）
| 优先级 | 端点 | 凭证 | 能拿到什么 | 本站实测 |
|---|---|---|---|---|
| ① | `/api/usage/token/` | **API Key** | `unlimited_quota` 布尔 + `total_used`(quota) + `total_granted`(quota) | ✅ 最优 |
| ② | `/api/user/self` | **仅 AccessToken** | 账户级剩余 quota + used_quota | ⚠️ API Key 会 200+success:false |
| ③ | `/dashboard/billing/subscription` + `/v1/dashboard/billing/usage` | API Key | `hard_limit_usd`(含 1e8 哨兵) + `total_usage`(分) | ✅ 可算「已用」，剩余不可算（本站） |
| ④ | 手工填写 | — | — | 兜底 |

**关键改动**：原规格把 `/api/usage/token/` 排第三，真站证明它**才应该是 API-Key-only 场景的第一优先**——因为它直接给 `unlimited_quota` 布尔，不用猜哨兵。

### 3.2 必须实现的守卫（全部在真站上有对应证据）
1. `unlimited_quota === true` **或** `hard_limit_usd >= 1e8` → `unlimited: true`，**不显示为余额、不参与告警**
2. `total_available` 为负 → **绝不作为余额**（本站实测 −17291179）
3. `total_usage` 单位是**分**，`total_used`/`total_granted` 单位是 **quota** —— 三者不可混用
4. HTTP 200 + `{"success":false}` 必须判失败（`/api/user/self` 实测）
5. 无 `cf-mitigated` 头不等于不在 Cloudflare 后面（本站 `Server: cloudflare` 但未挑战）——**CF 判定只在真被拦时生效，不能见 `server: cloudflare` 就报 blocked**
6. `system_name` / `version` 不可用于类型识别

### 3.3 「无限额度」在 UI 上到底该显示什么（产品决策）
本站 Key 是 unlimited 且有 `$34.58` 已用。**用户真正关心的是「我用了多少钱」**，而不是一个不存在的余额。
→ 建议：`unlimited: true` 时，`data.total` 放**已用金额**，另加 `spent` 字段与 `unlimited` 标记，客户端渲染成「**无限额度 · 已用 $34.58**」。
→ **绝不能**把它渲染成「余额 $34.58」（语义反了）。

---

## 四、仍未闭环（诚实记账）

| # | 项 | 原因 |
|---|---|---|
| 1 | `/api/user/self` 的**账户级余额**真实形状 | 需要 **AccessToken**（本站只给了 API Key）。**请提供系统访问令牌**才能验 |
| 2 | 有余额（非无限）令牌的 `hard_limit_usd − total_usage/100` 公式 | 本站令牌是 unlimited，**公式无法实测**。需要一个**有额度的** Key |
| 3 | Cloudflare **真拦截**时的响应形态 | 本站未被挑战。需要被拦的站点 |
| 4 | `display_in_currency = false` 的站点行为 | 本站为 `true` |
| 5 | done-hub / VoAPI / Veloera 等分支 | 本站是标准 new-api |
| 6 | 多币种（CNY）显示 | 本站美元计价，只有汇率 7.3 未实际用于展示 |

---

## 五、给用户的下一步（需要你提供）

1. **一个「有额度」的站点或 Key**（非无限额度）→ 才能验证剩余余额公式与低余额告警
2. **一个「系统访问令牌」（AccessToken）** → 才能验证账户级 `/api/user/self`
3. 如需验 Cloudflare 拦截，给我一个被挑战过的站点

**当前这一个站已经足够让我把适配器改成「真站可跑」**，剩下的属于「覆盖更多站点类型」，不再是「能不能跑」的问题。
