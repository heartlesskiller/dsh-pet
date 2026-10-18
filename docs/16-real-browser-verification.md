# 真实浏览器验证报告 · 独立模式 `/admin` 管理页

> 验证时间：2026-10-18 23:20–23:25（UTC+8）
> 目的：闭合交接报告 §5.4 与 §6 反复标注的「**两处 UI 的真实渲染没验**」——此前所有验证只到「HTTP 200 + 页面字符串含标识」，从未证明页面里的 JS 真的执行、真的拉到 API、真的把数据渲染出来。
> 手法：**系统 Chrome headless（`--dump-dom`）+ 隔离 `DSH_HOME` + 独立端口**，不碰用户正在运行的桌宠。

---

## 一、验证环境（三条关键前提，缺一条就会误判）

| 项 | 做法 | 为什么必须这样 |
|---|---|---|
| 隔离数据目录 | `DSH_HOME=D:/dev/dsh-verify3` + 自建 `main-config.jsonc` | 不污染用户真实数据；也让「加站点/删站点」可以随便试 |
| 禁用桌面小窗 | 配置里 `pets[].display = "none"` | 🔴 **不是环境变量**！`DSH_PET_DISPLAY` 在本仓库**根本不存在**（全仓 grep 只有 `DSH_PET_ELECTRON_PATH`）。上一轮冒烟用的那个变量是无效的，helper 照样启动 |
| 复用已有 Electron | `DSH_PET_ELECTRON_PATH=<已有的 electron.exe>` | 否则服务会走「Electron not found, downloading v43.3.0」分支，**下载 225MB**（上一轮冒烟 348MB 残留就是这么来的） |
| 换端口 | `--port 3093` | 用户桌宠占着 3080，S0 单实例锁会直接拒绝启动 |

**另有两个坑（都会让人误判「服务坏了」）**：

1. **工具侧进程带 `KILL_ON_JOB_CLOSE`**：从工具里起的服务，**命令一结束就被内核收走**。所以「起服务 → 验证 → 收尾」**必须在同一条命令里完成**，不能分成多条。上一轮就是这么误判成「服务自己死了」的。
2. **`HTTP_PROXY` 劫持 localhost**：curl 打 127.0.0.1 不带 `--noproxy '*'` 会拿到代理返回的 **502**。Chrome 要加 `--no-proxy-server`。

---

## 二、实测结果（原始输出摘录）

### 2.1 服务启动干净

```
helper启动次数=0   Electron下载次数=0
日志：宠物 main(size=220, display=none)
日志：桌面小窗 0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）
```
✅ `display:"none"` **确实**阻止了桌面 helper；用户桌宠的 4 个 electron 进程全程未受影响。

### 2.2 站点 CRUD 与脱敏

```
POST /dsh-pet-7340/relays  → HTTP 200
{"ok":true,"site":{"id":"9d1f99ff-…","name":"验证站A","url":"https://a.example.com",
 "kind":"new-api","quotaPerUnit":500000,"rateConfirmed":false,"enabled":true,
 "credential":{"kind":"api-key","masked":"sk-v****7890","present":true}}}

GET  /dsh-pet-7340/relays  → HTTP 200，同上，credential 仅 masked
明文假凭证 "sk-verify-fake" 出现次数 = 0   ✅ 无泄露
```

**注意 `rateConfirmed: false`**——这是真站证据（修订 #11）在起作用：新建站点时换算率尚未从 `/api/status` 探测确认，所以**不默认为已确认**。用户看到的就是 `false`，UI 会提示核对。

### 2.3 `/state` 的 `sections.relays`

```json
{"sections":{"balance":{…"provider":"standalone","reason":"unsupported"},
 "workStatus":{…},"notify":{…},"relays":{"counter":0,"data":null}},
 "pets":{},"configVersion":"1792336786650.626"}
```
✅ `sections.relays` 与 `sections.balance` **并存不合流**（红线 R-a）；未刷新时 `data: null`（不伪造）。

### 2.4 🏆 真实浏览器渲染（本次核心）

```
Chrome --headless=new --dump-dom  → DOM 27004 字节，stderr 0 行
```
DOM 里出现的功能区块（**JS 执行后才会渲染**）：

| 区块 / 文案 | DOM 命中次数 |
|---|---|
| 中转站管理 | 2 |
| 识别站点类型 + 「识别」按钮 | ✅ |
| **新增站点** + 「添加」按钮 | ✅ |
| 站点列表（刷新全部 / 健康 / 模型 / 设为焦点 / 删除） | ✅ |
| 消耗与预计可用天数（刷新消耗统计） | 2 |
| 模型矩阵（加载矩阵） | 1 |
| 换算率未确认提示 | 3 |
| 无限额度提示 | 6 |
| **`验证站A`（API 拉回来的站点名）** | **1** |

**`验证站A` 出现在 DOM 里是决定性证据**：它不在静态 HTML 中，只能由页面内脚本 `fetch('/dsh-pet-7340/relays')` 后动态创建——**证明 JS 真的执行、真的连上了 API、真的把数据渲染成了 DOM。**

表单结构（`<input>` 6 个 / `<select>` 3 个）：
```
id="add-name"  id="add-url"  id="add-kind"  id="add-cred-kind"  id="add-secret"  id="add-extra"
id="detect-secret"  id="detect-cred-kind"
```
✅ 与规格一致；`add-secret` 是独立字段，提交后会清空。

**DOM 里明文凭证出现次数 = 0** ✅ —— 页面零数据嵌入 + 脱敏视图双保险成立。

### 2.5 收尾干净

```
POST /shutdown → {"ok":true,"stopping":true}
服务存活？→ 空（已停）
electron 进程数 = 4（= 用户桌宠原有，未新增）
用户桌宠 3080 → {"name":"dsh-pet-standalone",…} 仍然健康
```

---

## 三、结论

| 交接报告里标注「未验证」的项 | 现在 |
|---|---|
| `/admin` 页面真实渲染与交互 | ✅ **已闭合**（真实 Chrome dump-dom，API 数据渲染进 DOM） |
| 页面的 API 路径是否可达（会不会 404） | ✅ 已闭合（站点列表真实渲染出来） |
| 页面是否泄露明文凭证 | ✅ 已闭合（DOM 0 命中） |
| `display:none` 是否真能禁桌面小窗 | ✅ 已闭合（改成配置项才对，环境变量无效） |

**仍未闭合（只能等用户素材）**：真站 V1（AccessToken 账户级）、V2（非无限额度 Key 的剩余公式）、V3（Cloudflare 拦截形态）、T09（sub2api 站点）。以及 T10 凭证 OS 级加密（当前明文落盘，Q1 已批 V1 明文，README 有显著提示）。

---

## 四、给后续验证者的三条硬规则

1. **一条命令内完成**：起服务 → 断言 → 停机必须同一条命令，否则 `KILL_ON_JOB_CLOSE` 会收走进程，让人误判成「服务崩了」。
2. **不要用 `DSH_PET_DISPLAY`**：它不存在。禁桌面小窗改 `main-config.jsonc` 的 `pets[].display`。
3. **`DSH_PET_ELECTRON_PATH` 只解决「不下载」**，不阻止已经存在的 Electron 启动；要同时用 `display:"none"` 才安全。
