/**
 * 独立模式 `/admin` 管理页 —— **纯 HTML 渲染器**。
 *
 * ## 为什么是纯函数
 * 这一层被纪律钉死：页面生成必须与 serving 分离，才能无浏览器单测。
 * `renderAdminPage()` 不读任何状态、不接任何参数、不 import 宿主模块 ——
 * 它产出的就是一串 HTML 字符串。数据全部由页面内脚本运行时从
 * `/dsh-pet-7340/relays`（同一端口）现取，**服务端渲染时一个字节的站点/凭证数据都不嵌**。
 *
 * ## 安全底线（评审时按这条查）
 * 1. **零数据嵌入**：HTML 里没有任何站点字段。服务端一旦往页面里塞数据，
 *    就多出一条「脱敏漏判 → 密钥进 HTML」的泄露面；而现在页面拿到的永远是
 *    已经过 `assertNoSecret` 的脱敏视图（`RelaySiteView.credential.masked`）。
 * 2. **不用 innerHTML 渲染任何服务端数据**：页面脚本一律 `createElement` +
 *    `textContent`，服务端返回的名称/URL/message 不可能变成 HTML。
 * 3. **CSP 由 server.ts 单独加在这个响应上**（默认禁外部资源、`connect-src 'self'`），
 *    见 `ADMIN_PAGE_CSP` 的注释。
 *
 * ## 已知技术债
 * - 内联 `<script>` 需要 CSP 放行 `'unsafe-inline'`。页面是**故意零依赖**的
 *   （不引 React、不打包，单文件可直接 `curl` 看），且只监听 127.0.0.1；
 *   换来的是「无需构建产物即可用」。V2 若要收敛 CSP，把它改成同源外链脚本即可。
 * - 这是独立模式的**最小可用**管理页，不是 DSH 设置页那个 2423 行 React 组件
 *   （`relays-admin.ts` 依赖 DSH 的 React/h 注入与 slot 生命周期，明确不搬）。
 */

/** `/admin` 的路径（与 `/health`、`/shutdown` 同级，在 `/dsh-pet-7340` 前缀之外） */
export const ADMIN_PAGE_PATH = '/admin';

/** 页面内脚本用的 API 前缀（相对路径：端口可配，绝不写死 3080） */
const API_PREFIX = '/dsh-pet-7340';

/**
 * 产出管理页 HTML。
 *
 * 无参数、无副作用、可反复调用结果一致 —— 单测直接对它做字符串断言。
 */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>中转站管理 · dsh-pet</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 16px; background: #f5f6f8; color: #1f2430; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #6b7280; font-size: 12px; margin-bottom: 14px; }
  section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { color: #6b7280; font-weight: 500; white-space: nowrap; }
  label { display: inline-block; margin: 2px 8px 2px 0; }
  input, select { font: inherit; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; color: inherit; }
  button { font: inherit; padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; color: inherit; border-radius: 4px; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; padding: 8px 10px; border-radius: 6px; margin: 6px 0; font-size: 13px; }
  .err { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; padding: 8px 10px; border-radius: 6px; margin: 6px 0; font-size: 13px; white-space: pre-wrap; }
  .note { color: #047857; font-size: 12px; }
  .muted { color: #9ca3af; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  /* 模型矩阵三态：必须视觉可区分 —— 未知（琥珀底）≠ 无（灰、无底） */
  .mx { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .mx th, .mx td { padding: 5px 8px; border-bottom: 1px solid #eef0f3; text-align: left; vertical-align: middle; }
  .mx th { color: #6b7280; font-weight: 500; white-space: nowrap; }
  .cell { display: inline-block; min-width: 24px; padding: 1px 8px; border-radius: 6px; text-align: center; font-weight: 600; }
  .cell-yes { color: #047857; background: #ecfdf5; }
  .cell-no { color: #9ca3af; background: transparent; font-weight: 400; }
  .cell-unknown { color: #b45309; background: #fffbeb; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>中转站管理</h1>
<div class="sub">dsh-pet 独立模式 · 数据只存本机 · 凭证一律脱敏展示（原值永不离开凭证文件）</div>

<div id="global-error" class="err" hidden></div>

<section id="detect-section">
  <h2>识别站点类型</h2>
  <div class="row">
    <label>URL <input id="detect-url" size="38" placeholder="https://your-site.com"></label>
    <label>凭证类型
      <select id="detect-cred-kind">
        <option value="api-key">api-key</option>
        <option value="access-token">access-token</option>
        <option value="session-cookie">session-cookie</option>
      </select>
    </label>
    <label>凭证值 <input id="detect-secret" size="26" placeholder="sk-...（可选，仅本次探测用）"></label>
    <button id="detect-btn" type="button">识别</button>
  </div>
  <div id="detect-result" class="muted">识别结果会显示在这里：kind / confidence / evidence。识别不了会明说缺什么证据，不猜。</div>
</section>

<section id="add-section">
  <h2>新增站点</h2>
  <form id="add-form">
    <div class="row">
      <label>名称 <input id="add-name" size="14" required></label>
      <label>URL <input id="add-url" size="32" placeholder="https://your-site.com" required></label>
      <label>类型
        <select id="add-kind">
          <option value="new-api">new-api</option>
          <option value="sub2api">sub2api</option>
          <option value="openai-compat">openai-compat</option>
        </select>
      </label>
    </div>
    <div class="row">
      <label>凭证类型
        <select id="add-cred-kind">
          <option value="api-key">api-key</option>
          <option value="access-token">access-token</option>
          <option value="session-cookie">session-cookie</option>
          <option value="manual">manual（无凭证，手填余额）</option>
        </select>
      </label>
      <label>凭证值 <input id="add-secret" size="26" placeholder="sk-..."></label>
      <label>附加头 <input id="add-extra" size="20" placeholder="New-Api-User:1"></label>
      <button class="primary" type="submit">添加</button>
    </div>
  </form>
</section>

<section id="list-section">
  <h2>站点列表</h2>
  <div class="row">
    <button id="refresh-all" type="button">刷新全部</button>
    <span id="summary" class="muted"></span>
    <span id="focus-now" class="muted"></span>
  </div>
  <div id="rate-unconfirmed-banner" class="warn" hidden>⚠ 有站点的换算率未确认（quota_per_unit 没探到），余额可能差 1000 倍。请到该站点核对后再用它的余额/告警。</div>
  <table>
    <thead>
      <tr><th>名称</th><th>类型</th><th>URL</th><th>凭证（脱敏）</th><th>健康</th><th>余额</th><th>操作</th></tr>
    </thead>
    <tbody id="site-rows"></tbody>
  </table>
  <div id="empty-hint" class="muted">还没有站点。先用上面「识别站点类型」确认类型，再「新增站点」。</div>
</section>

<section id="matrix-section">
  <h2>模型矩阵</h2>
  <div class="row">
    <button id="matrix-load" type="button">加载矩阵</button>
    <span id="matrix-summary" class="muted"></span>
  </div>
  <div id="matrix-hint" class="muted">行 = 全部站点的模型并集。「有」= 该站有；「无」= 抓过、确认没有；<b>「未知」= 没抓过（不是没有）</b>。想补哪列就在该站点行上点「模型」。</div>
  <div id="matrix-error" class="err" hidden></div>
  <table id="matrix-table" class="mx" hidden>
    <thead><tr id="matrix-head-row"><th>模型</th></tr></thead>
    <tbody id="matrix-rows"></tbody>
  </table>
</section>

<script>
(function () {
  'use strict';
  var API = '${API_PREFIX}';
  function $(id) { return document.getElementById(id); }
  var rows = $('site-rows');
  var globalError = $('global-error');

  function setError(el, text) {
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
  }

  /** 失败回执的统一文案：reason + message，绝不吞 */
  function failText(body, fallback) {
    if (body && body.ok === false) {
      var reason = body.reason || body.error || 'error';
      return body.message ? reason + '：' + body.message : reason;
    }
    return fallback || '未知错误';
  }

  function api(path, method, body) {
    var opt = { method: method || 'GET', headers: {} };
    if (body !== undefined) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(API + path, opt).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (json === null) throw new Error('HTTP ' + res.status + '（非 JSON 响应）：' + text.slice(0, 200));
        return json;
      });
    });
  }

  function td(text, cls) {
    var cell = document.createElement('td');
    if (cls) cell.className = cls;
    cell.textContent = text === null || text === undefined ? '' : String(text);
    return cell;
  }

  function btn(label, action, id) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('data-action', action);
    if (id) b.setAttribute('data-id', id);
    return b;
  }

  /** 余额单元格：unlimited 绝不渲染成余额（语义反了），rateUnconfirmed 必须显式警告 */
  function balanceText(r) {
    if (!r) return '未刷新';
    if (r.ok !== true) return '查不到（' + (r.reason || 'error') + '）';
    if (r.unlimited === true) return '无限额度 · 已用 $' + (r.spent || (r.data && r.data.total) || '0');
    var d = r.data || {};
    var s = (d.currency || 'USD') + ' ' + d.total;
    if (r.source === 'manual') s += '（手工）';
    if (r.scope === 'token') s += '（令牌级）';
    if (r.rateUnconfirmed === true) s += ' ⚠换算率未确认';
    return s;
  }

  function healthText(h) {
    if (!h) return '未探测';
    var map = { online: '在线', unreachable: '不可达', 'auth-failed': '鉴权失败', blocked: '被拦截', unknown: '未知' };
    var s = map[h.health] || h.health || '未知';
    if (h.message) s += '（' + h.message + '）';
    return s;
  }

  function render(sites, relaysData) {
    rows.textContent = '';
    var balanceById = {};
    var healthById = {};
    var focusSiteId = null;
    if (relaysData) {
      focusSiteId = relaysData.focusSiteId || null;
      (relaysData.sites || []).forEach(function (r) { balanceById[r.siteId] = r; });
      (relaysData.health || []).forEach(function (h) { healthById[h.siteId] = h; });
    }

    $('empty-hint').hidden = sites.length > 0;

    var unconfirmed = 0;
    sites.forEach(function (s) {
      var tr = document.createElement('tr');
      var name = s.name + (s.id === focusSiteId ? ' ★焦点' : '');
      if (s.enabled === false) name += '（已停用）';
      tr.appendChild(td(name));
      tr.appendChild(td(s.kind));
      var url = td(s.url, 'mono');
      url.title = s.url;
      tr.appendChild(url);
      var cred = s.credential || {};
      tr.appendChild(td(cred.present ? (cred.kind + ' · ' + (cred.masked || '')) : '未配置', 'mono'));
      tr.appendChild(td(healthText(healthById[s.id])));
      tr.appendChild(td(balanceText(balanceById[s.id])));
      var ops = document.createElement('td');
      ops.appendChild(btn('刷新', 'refresh', s.id));
      ops.appendChild(btn('健康', 'health', s.id));
      ops.appendChild(btn('模型', 'models', s.id));
      ops.appendChild(btn(s.id === focusSiteId ? '取消焦点' : '设为焦点', 'focus', s.id));
      ops.appendChild(btn('删除', 'delete', s.id));
      tr.appendChild(ops);
      rows.appendChild(tr);
      if (s.rateConfirmed !== true) unconfirmed += 1;
    });

    $('rate-unconfirmed-banner').hidden = unconfirmed === 0;
    if (relaysData && relaysData.summary) {
      var sm = relaysData.summary;
      var txt = '合计 ' + (sm.currency || 'USD') + ' ' + sm.total + ' · 可查 ' + sm.siteCount + ' 站';
      if (sm.unlimitedCount) txt += ' · 无限额度 ' + sm.unlimitedCount + ' 站（不计入合计）';
      if (sm.failedCount) txt += ' · 查不到 ' + sm.failedCount + ' 站';
      $('summary').textContent = txt;
    } else {
      $('summary').textContent = '';
    }
    $('focus-now').textContent = focusSiteId ? '焦点站点已设置' : '';
  }

  function load() {
    return Promise.all([
      api('/relays', 'GET'),
      api('/state', 'GET').catch(function () { return null; })
    ]).then(function (out) {
      var list = out[0] || {};
      var state = out[1] || {};
      var relaysData = state && state.sections ? state.sections.relays : null;
      render((list.sites || []), relaysData && relaysData.data ? relaysData.data : null);
    }).catch(function (e) {
      setError(globalError, '加载失败：' + (e && e.message ? e.message : String(e)));
    });
  }

  function parseExtra(text) {
    var out = {};
    String(text || '').split(';').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i <= 0) return;
      var k = pair.slice(0, i).trim();
      var v = pair.slice(i + 1).trim();
      if (k && v) out[k] = v;
    });
    return out;
  }

  // ---- 事件 ----
  rows.addEventListener('click', function (ev) {
    var target = ev.target;
    var action = target && target.getAttribute && target.getAttribute('data-action');
    var id = target && target.getAttribute && target.getAttribute('data-id');
    if (!action || !id) return;
    if (action === 'delete') {
      if (!window.confirm('确认删除该站点？它的凭证会一起删掉，不可恢复。')) return;
      api('/relays/' + encodeURIComponent(id), 'DELETE').then(load).catch(function (e) {
        setError(globalError, '删除失败：' + e.message);
      });
      return;
    }
    if (action === 'refresh') {
      api('/relays/' + encodeURIComponent(id) + '/refresh', 'POST').then(function (r) {
        if (r && r.ok === true) { setError(globalError, ''); load(); }
        else setError(globalError, '刷新失败：' + failText(r));
      }).catch(function (e) { setError(globalError, '刷新失败：' + e.message); });
      return;
    }
    if (action === 'health') {
      api('/relays/' + encodeURIComponent(id) + '/health', 'POST').then(function (r) {
        var h = r || {};
        setError(globalError, h.health === 'online' ? '' : '健康探测：' + (h.health || 'unknown') + (h.message ? '：' + h.message : ''));
        load();
      }).catch(function (e) { setError(globalError, '健康探测失败：' + e.message); });
      return;
    }
    if (action === 'models') {
      api('/relays/' + encodeURIComponent(id) + '/models', 'POST').then(function (r) {
        if (r && r.ok === true) {
          var n = (r.models || []).length;
          setError(globalError, '');
          window.alert('抓到 ' + n + ' 个模型（source=' + (r.source || '?') + '）。source=catalog 表示站点全部模型，available 表示你的 Key 能用哪些。');
        } else {
          setError(globalError, '抓模型失败：' + failText(r));
        }
      }).catch(function (e) { setError(globalError, '抓模型失败：' + e.message); });
      return;
    }
    if (action === 'focus') {
      api('/relays/focus', 'POST', { siteId: id }).then(load).catch(function (e) {
        setError(globalError, '切换焦点失败：' + e.message);
      });
    }
  });

  $('add-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var extra = parseExtra($('add-extra').value);
    var credKind = $('add-cred-kind').value;
    var body = {
      name: $('add-name').value.trim(),
      url: $('add-url').value.trim(),
      kind: $('add-kind').value,
      credential: { kind: credKind, secret: $('add-secret').value }
    };
    if (Object.keys(extra).length > 0) body.credential.extraHeaders = extra;
    api('/relays', 'POST', body).then(function (r) {
      if (r && r.ok === true) {
        $('add-secret').value = ''; // 明文输入框立即清空
        $('add-name').value = '';
        $('add-url').value = '';
        $('add-extra').value = '';
        setError(globalError, '');
        load();
      } else {
        setError(globalError, '添加失败：' + failText(r));
      }
    }).catch(function (e) { setError(globalError, '添加失败：' + e.message); });
  });

  $('refresh-all').addEventListener('click', function () {
    api('/relays/refresh-all', 'POST').then(load).catch(function (e) {
      setError(globalError, '刷新全部失败：' + e.message);
    });
  });

  $('detect-btn').addEventListener('click', function () {
    var url = $('detect-url').value.trim();
    if (!url) { setError(globalError, '请先填要识别的 URL'); return; }
    var cred = { kind: $('detect-cred-kind').value, secret: $('detect-secret').value };
    api('/relays/detect', 'POST', { url: url, credential: cred }).then(function (r) {
      var d = (r && r.detect) || null;
      var box = $('detect-result');
      if (!d) { box.textContent = '识别失败：' + failText(r); return; }
      var lines = ['kind=' + (d.kind || 'unknown'), 'confidence=' + (d.confidence || 'unknown')];
      if (d.evidence && d.evidence.length) lines.push('evidence: ' + d.evidence.join('；'));
      if (d.message) lines.push('说明: ' + d.message);
      if (d.needManualConfirm) lines.push('需要你手动确认类型（识别不了就不猜）');
      box.textContent = lines.join(' | ');
    }).catch(function (e) { $('detect-result').textContent = '识别失败：' + e.message; });
  });

  // ---- 模型矩阵（三态：有 / 无 / 未知；未知 ≠ 无）----
  // 与 src/shared/relays.ts 的 matrixCellState 保持一致：该处是唯一权威实现，并有
  // 「null 必须与 false 区分」的专项单测；本页是纯字符串、无法 import，分类表达式由
  // admin-page.test.ts 钉住，改坏会红。
  var CELL_TEXT = { yes: '有', no: '无', unknown: '未知' };
  function cellState(v) { return v === true ? 'yes' : v === false ? 'no' : 'unknown'; }

  function renderMatrix(payload) {
    var headRow = $('matrix-head-row');
    var rowsBox = $('matrix-rows');
    var table = $('matrix-table');
    // 清掉旧列（保留第一个「模型」列头）
    while (headRow.children.length > 1) headRow.removeChild(headRow.lastChild);
    rowsBox.textContent = '';
    setError($('matrix-error'), '');

    if (!payload || payload.ok !== true || !Array.isArray(payload.rows)) {
      setError($('matrix-error'), '矩阵数据形状不符（host 返回异常）');
      table.hidden = true;
      return;
    }
    var rows = payload.rows;
    // 站点列：从矩阵行里收集（host 已按站点名排序，这里只去重保序，不重算）
    var columns = [];
    rows.forEach(function (r) {
      (r.sites || []).forEach(function (c) {
        if (!columns.some(function (x) { return x.siteId === c.siteId; })) {
          columns.push({ siteId: c.siteId, name: c.name || c.siteId });
        }
      });
    });
    columns.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.name;
      headRow.appendChild(th);
    });

    var unknown = payload.unknownSiteCount || 0;
    $('matrix-summary').textContent =
      rows.length + ' 个模型 × ' + columns.length + ' 个站点' +
      (unknown > 0 ? '；' + unknown + ' 个站未抓取（未知 ≠ 没有）' : '');

    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var name = document.createElement('td');
      name.className = 'mono';
      name.textContent = r.id;
      tr.appendChild(name);
      columns.forEach(function (c) {
        var cell = (r.sites || []).filter(function (x) { return x.siteId === c.siteId; })[0];
        var td = document.createElement('td');
        var st = cellState(cell ? cell.available : null);
        td.textContent = CELL_TEXT[st];
        td.className = 'cell cell-' + st;
        td.title = st === 'yes' ? '该站有这个模型' : st === 'no' ? '抓过，确认没有' : '没抓过 = 未知（不是没有）';
        tr.appendChild(td);
      });
      rowsBox.appendChild(tr);
    });
    table.hidden = rows.length === 0;
    if (rows.length === 0) $('matrix-hint').textContent = '还没有抓过任何模型：先在站点行上点「模型」。';
  }

  $('matrix-load').addEventListener('click', function () {
    api('/relays/models', 'GET').then(renderMatrix).catch(function (e) {
      setError($('matrix-error'), '矩阵加载失败：' + (e && e.message ? e.message : String(e)));
      $('matrix-table').hidden = true;
    });
  });

  load();
})();
</script>
</body>
</html>
`;
}
