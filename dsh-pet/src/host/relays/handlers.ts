/**
 * 中转站管理路由 —— **有副作用的那一层**（S1 抽离，TD-1）。
 *
 * ## 为什么单独一个文件
 * `handleRelayRoute` 原来长在 `src/host/index.ts` 的 `apply()` 闭包里（224 行），
 * 靠着闭包直接摸宿主能力。它已经贴到 PLAN 的 250 行触发线，而 relays 还会长
 * （T09 sub2api、T12 VoAPI 都要加分支），所以趁没超标先抽出来。
 *
 * 抽离的**关键约束**：不能靠闭包，必须把依赖写成显式形状 —— 否则只是把 224 行
 * 换个文件名，耦合一点没少。这里只接三个真正用到的东西（见 {@link RelayHandlerDeps}）。
 *
 * ## 与 `./routes.ts` 的分工（别混）
 * - `routes.ts`：**纯逻辑**（路径解析、入参校验、矩阵聚合、脱敏自检），无 IO、无副作用；
 * - 本文件：**有副作用**（读盘、写盘、发网络请求、写状态叶）。所以不塞进 routes.ts。
 *
 * ## 两条硬口径（与上游既有分支逐条对齐，不新造）
 * 1. **凭证与站点分文件**：`credential` 只进 `relay-credentials.json`，站点文件里
 *    没有任何密钥字段——导出/备份站点不会顺带泄密；
 * 2. **每个响应体返回前过一遍脱敏自检**：检出明文凭证就抛错（该请求 500），
 *    绝不把凭证送出去。宁可端点坏掉，不泄露。
 *
 * 错误口径：结构性参数错误（坏 JSON / 缺字段 / 未知路径 / 站点不存在）→ 4xx + `{ error }`；
 * 动作类失败 → 200 + `{ ok:false, reason }`。与 `/config` `/pet-display` 的
 * `site not found` 同形。
 */

import type { RouteResult } from '../route-result';
import {
  assertNoSecret,
  collectSecrets,
  normalizeManualBalance,
  parseCredential,
  parseDetectInput,
  parseFocusInput,
  parseRelayRoute,
  relayError,
  relayFail,
} from './routes';
import { checkSiteHealth, classifyBalanceError, queryAllBalances, querySiteBalance } from './index';
import { DEFAULT_QUOTA_PER_UNIT } from './money';
import { detectRelayKind } from './detect';
import { fetchSiteModels, probeModels, probeStatus } from './providers/newapi';
import {
  clearCredential,
  clearFocus,
  getCredential,
  loadCredentials,
  loadSites,
  putCredential,
  readModelCache,
  removeSite,
  saveSites,
  setSiteModels,
  siteViews,
  toSiteView,
  upsertSite,
  writeFocus,
  type SiteInput,
} from './store';
import { aggregateModelMatrix } from './routes';
import type { RelayCredential, RelayFetchContext, RelaySite } from './types';

/**
 * 中转站路由的依赖 —— **只列真正用到的**。
 *
 * 为什么不把整个 `ctx` / 整个宿主闭包传进来：那样抽离等于没抽，耦合一点没少，
 * 而且以后谁都能从这里拿到任意宿主能力，边界立刻烂掉。
 */
export interface RelayHandlerDeps {
  /** 中转站数据目录（站点 / 凭证 / 模型缓存 / 每日快照都在它下面） */
  relayDir: string;
  /** 有没有启用中的站点（焦点变更后决定要不要立刻重刷状态叶，省一次空跑） */
  hasEnabledRelaySites: () => boolean;
  /**
   * 立刻重刷 `sections.relays`。
   * 焦点切换是用户操作，等不了一个刷新周期（默认 30 分钟）。
   */
  refreshRelays: () => Promise<void>;
}

/**
 * 处理 `/relays*` 的一次请求。
 *
 * @param deps   宿主能力（见 {@link RelayHandlerDeps}，只接三个）
 * @param rest   已 decode 的路径剩余段（`relays` / `relays/{id}` / `relays/{id}/action`）
 * @param method HTTP 方法
 * @param body   请求体原文（可能为空）
 */
export async function handleRelayRequest(
  deps: RelayHandlerDeps,
  rest: string,
  method: string,
  body?: string,
): Promise<RouteResult> {
  const { relayDir } = deps;
  // 自检基线：数据目录下全部凭证明文（附加头的值同样算）
  const secrets = collectSecrets(loadCredentials(relayDir));
  /** 统一出口：自检通过才允许返回 */
  const reply = (status: number, obj: unknown): RouteResult => {
    assertNoSecret(obj, secrets);
    return { kind: 'json', status, obj };
  };
  const parseBody = (): unknown => {
    try {
      return JSON.parse(body ?? 'null');
    } catch {
      return undefined;
    }
  };
  const asObject = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  /** body 的 credential 段：缺省 = 不动；显式 null = 清除；对象 = 校验后写入 */
  const readCredential = (
    o: Record<string, unknown>,
  ): { ok: true; value?: RelayCredential; clear: boolean } | { ok: false; message: string } => {
    if (!Object.prototype.hasOwnProperty.call(o, 'credential')) return { ok: true, clear: false };
    const raw = o.credential;
    if (raw === undefined || raw === null) return { ok: true, clear: true };
    const parsed = parseCredential(raw);
    return parsed.ok ? { ok: true, value: parsed.value, clear: false } : parsed;
  };
  /** 站点入参 = body 去掉 credential 段（凭证不走站点实体） */
  const siteInputOf = (o: Record<string, unknown>): SiteInput => {
    const input: Record<string, unknown> = { ...o };
    delete input.credential;
    // 强转是故意的：字段校验在 upsertSite → validateSiteInput 里做（缺 name/url/kind
    // 会 throw，路由层把它翻成 400）。这里只负责把 credential 段摘掉。
    return input as unknown as SiteInput;
  };
  const applyCredential = (siteId: string, value: RelayCredential | undefined, clear: boolean): void => {
    if (value) putCredential(relayDir, siteId, value);
    else if (clear) clearCredential(relayDir, siteId);
  };
  const findSite = (id: string): RelaySite | undefined => loadSites(relayDir).find((s) => s.id === id);

  try {
    const route = parseRelayRoute(rest);
    if (route.action === 'unknown') return reply(404, relayError('unknown relays route: ' + rest));

    // ---- /relays（GET 列表 / POST 新建）----
    if (route.action === 'collection') {
      if (method === 'GET') return reply(200, { ok: true, sites: siteViews(relayDir) });
      if (method === 'POST') {
        const raw = parseBody();
        if (raw === undefined) return reply(400, relayError('invalid JSON body'));
        const o = asObject(raw);
        const cred = readCredential(o);
        if (!cred.ok) return reply(400, relayError(cred.message));
        const input = siteInputOf(o);
        delete input.id; // POST 只新建；更新走 PUT（带 id 会被 upsertSite 当成更新）
        let site: RelaySite;
        try {
          site = upsertSite(relayDir, input);
        } catch (e) {
          return reply(400, relayError(e instanceof Error ? e.message : String(e)));
        }
        applyCredential(site.id, cred.value, cred.clear);
        return reply(200, { ok: true, site: toSiteView(site, getCredential(relayDir, site.id)) });
      }
      return reply(405, relayError('method not allowed'));
    }

    // ---- /relays/{id}（PUT 更新 / DELETE 删除）----
    if (route.action === 'item') {
      if (!findSite(route.id)) return reply(404, relayError('site not found: ' + route.id));
      if (method === 'PUT') {
        const raw = parseBody();
        if (raw === undefined) return reply(400, relayError('invalid JSON body'));
        const o = asObject(raw);
        const cred = readCredential(o);
        if (!cred.ok) return reply(400, relayError(cred.message));
        let updated: RelaySite;
        try {
          updated = upsertSite(relayDir, { ...siteInputOf(o), id: route.id });
        } catch (e) {
          return reply(400, relayError(e instanceof Error ? e.message : String(e)));
        }
        applyCredential(updated.id, cred.value, cred.clear);
        return reply(200, { ok: true, site: toSiteView(updated, getCredential(relayDir, updated.id)) });
      }
      if (method === 'DELETE') {
        removeSite(relayDir, route.id); // 站点与凭证一起删（不留孤儿密钥文件）
        return reply(200, { ok: true, sites: siteViews(relayDir) });
      }
      return reply(405, relayError('method not allowed'));
    }

    // ---- /relays/refresh-all（并发刷新全部启用站点）----
    if (route.action === 'refresh-all') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const enabled = loadSites(relayDir).filter((s) => s.enabled === true);
      return reply(200, await queryAllBalances(relayDir, enabled));
    }

    // ---- /relays/{id}/refresh · /health · /manual-balance ----
    if (route.action === 'refresh') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const site = findSite(route.id);
      if (!site) return reply(404, relayError('site not found: ' + route.id));
      return reply(200, await querySiteBalance(relayDir, site));
    }

    if (route.action === 'health') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const site = findSite(route.id);
      if (!site) return reply(404, relayError('site not found: ' + route.id));
      return reply(200, await checkSiteHealth(relayDir, site));
    }

    // 手工余额：查不到时的降级路径。空 amount = 清除（撤销降级）。
    if (route.action === 'manual-balance') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const raw = parseBody();
      if (raw === undefined) return reply(400, relayError('invalid JSON body'));
      const mb = normalizeManualBalance(raw);
      if (!mb.ok) return reply(400, relayError(mb.message));
      const sites = loadSites(relayDir);
      const idx = sites.findIndex((s) => s.id === route.id);
      if (idx < 0) return reply(404, relayError('site not found: ' + route.id));
      if (mb.clear) {
        delete sites[idx].manualBalance;
      } else {
        sites[idx] = {
          ...sites[idx],
          manualBalance: { amount: mb.amount, currency: mb.currency, updatedAt: new Date().toISOString() },
        };
      }
      saveSites(relayDir, sites);
      return reply(200, { ok: true, site: toSiteView(sites[idx], getCredential(relayDir, route.id)) });
    }

    // ---- /relays/detect（POST，不落库：识别 + 换算率建议）----
    // 凭证只用于本次探测（打 /v1/models 拿强信号），**不写盘**——识别是「添加站点」的
    // 引导步骤，用户还没决定建站。探测失败不是 500：回 unknown + 原因，
    // UI 引导手动选择类型或先手工填余额（P0-3：不静默失败）。
    if (route.action === 'detect') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const raw = parseBody();
      if (raw === undefined) return reply(400, relayError('invalid JSON body'));
      const input = parseDetectInput(raw);
      if (!input.ok) return reply(400, relayError(input.message));
      const cred = input.value.credential;
      const ctx: RelayFetchContext = {
        siteId: '',
        baseUrl: input.value.url,
        secret: cred?.secret ?? '',
        kind: cred?.kind ?? 'api-key',
        extraHeaders: cred?.extraHeaders,
        quotaPerUnit: DEFAULT_QUOTA_PER_UNIT,
      };
      let status: unknown;
      let models: unknown;
      try {
        status = await probeStatus(input.value.url, ctx);
        if (cred) models = await probeModels(input.value.url, ctx);
      } catch (e) {
        return reply(200, {
          ok: true,
          detect: {
            kind: 'unknown',
            confidence: 'unknown',
            evidence: [],
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
      return reply(200, { ok: true, detect: detectRelayKind({ status, ...(models !== undefined ? { models } : {}) }) });
    }

    // ---- /relays/models（GET：只读缓存聚合；**周期刷新不抓模型**，要带凭证外发太重）----
    if (route.action === 'models') {
      if (method !== 'GET') return reply(405, relayError('method not allowed'));
      const { rows, unknownSiteCount } = aggregateModelMatrix(loadSites(relayDir), readModelCache(relayDir));
      return reply(200, { ok: true, rows, unknownSiteCount });
    }

    // ---- /relays/{id}/models（POST：实时抓取 + 写缓存；优先 /api/pricing 回落 /v1/models）----
    if (route.action === 'site-models') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const site = findSite(route.id);
      if (!site) return reply(404, relayError('site not found: ' + route.id));
      const cred = getCredential(relayDir, site.id);
      if (!cred || cred.kind === 'manual') {
        return reply(200, relayFail('credential-missing', '未配置凭证，无法抓取模型清单'));
      }
      try {
        const out = await fetchSiteModels(site.url, {
          siteId: site.id,
          baseUrl: site.url,
          secret: cred.secret,
          kind: cred.kind,
          extraHeaders: cred.extraHeaders,
          quotaPerUnit: site.quotaPerUnit,
        });
        setSiteModels(relayDir, site.id, out.models);
        return reply(200, {
          ok: true,
          siteId: site.id,
          source: out.source,
          models: out.models,
          fetchedAt: new Date().toISOString(),
        });
      } catch (e) {
        return reply(200, relayFail(classifyBalanceError(e), e instanceof Error ? e.message : String(e)));
      }
    }

    // ---- /relays/focus（POST：焦点站点；只影响展示口径，绝不做请求转发 —— Q4）----
    if (route.action === 'focus') {
      if (method !== 'POST') return reply(405, relayError('method not allowed'));
      const raw = parseBody();
      if (raw === undefined) return reply(400, relayError('invalid JSON body'));
      const input = parseFocusInput(raw);
      if (!input.ok) return reply(400, relayError(input.message));
      if (input.siteId !== null && !findSite(input.siteId)) {
        return reply(404, relayError('site not found: ' + input.siteId));
      }
      if (input.siteId === null) clearFocus(relayDir);
      else writeFocus(relayDir, input.siteId);
      // 立即重刷状态叶，让桌宠第一时间按新焦点展示（用户操作，等不了一个刷新周期）
      if (deps.hasEnabledRelaySites()) await deps.refreshRelays();
      return reply(200, { ok: true, focusSiteId: input.siteId });
    }

    return reply(404, relayError('unknown relays route: ' + rest));
  } catch (e) {
    // 脱敏自检失败、store 抛错（文件损坏）等 → 显式 500，不静默
    return reply(500, relayError(e instanceof Error ? e.message : String(e)));
  }
}
