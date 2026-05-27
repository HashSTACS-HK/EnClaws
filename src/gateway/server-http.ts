import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import { CANVAS_WS_PATH, handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { type GatewayAuthResult, type ResolvedGatewayAuth } from "./auth.js";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { listTenants } from "../db/models/tenant.js";
import { loadTenantConfig } from "../config/tenant-config.js";
import { listAgentEntries, resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { readCSConfig } from "./server-methods/cs-admin.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  normalizeHookDispatchSessionKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { handleAgentChatHttpRequest } from "./agent-chat-http.js";
import { handleCsApiRequest } from "./cs-api-http.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { isProtectedPluginRoutePath } from "./security-path.js";
import {
  authorizeCanvasRequest,
  enforcePluginRouteGatewayAuth,
  isCanvasPath,
} from "./server/http-auth.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    return normalizeRateLimitClientIp(req.socket?.remoteAddress);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    // Only pathname/search are used here; keep the base host fixed so bind-host
    // representation (e.g. IPv6 wildcards) cannot break request parsing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-EnClaws-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
      const runId = dispatchAgentHook({
        ...normalized.value,
        sessionKey: normalizeHookDispatchSessionKey({
          sessionKey: sessionKey.value,
          targetAgentId,
        }),
        agentId: targetAgentId,
      });
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: "mapping",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            agentId: targetAgentId,
            wakeMode: mapped.action.wakeMode,
            sessionKey: normalizeHookDispatchSessionKey({
              sessionKey: sessionKey.value,
              targetAgentId,
            }),
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  shouldEnforcePluginGatewayAuth?: (requestPath: string) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  tlsOptions?: TlsOptions;
}): HttpServer {
  // Lazily resolve the operator tenant ID for CS widget injection into index.html.
  // Strategy: earliest registered business tenant (created_at ASC, skip the fixed platform tenant)
  // that is ALSO qualified — i.e., has at least one agent with a configured model ref.
  // Unqualified tenants are skipped so the widget bubble hides cleanly on half-configured
  // deployments instead of appearing and then failing on first message.
  // Single-tenant deployments work out of the box; multi-tenant deployments can override
  // via ENCLAWS_CS_WIDGET_TENANT_ID env var (override skips the qualification check).
  // Cached after first successful lookup. Note: cache invalidation on config change is
  // deferred to the future health-check primitive proposal (llm-provider 可用性巡检).
  // 懒加载运营方租户 ID：注册最早且"合格"（至少有一个配置了模型的 agent）的非平台租户。
  // 不合格的租户被跳过——避免气泡出现但点进去报 Model Not Exist 的降级坑。
  // 多租户部署通过 ENCLAWS_CS_WIDGET_TENANT_ID 环境变量显式指定（覆盖合格性检查）。
  const PLATFORM_TENANT_ID_HTTP = "00000000-0000-0000-0000-000000000001";
  // TTL cache: remember both found and not-found results to avoid rescanning
  // all tenants on every page load when no qualified tenant exists. Short TTL
  // ensures config changes (add/remove chatId, model, agent) reflect within
  // CS_TENANT_CACHE_TTL_MS without restart.
  // TTL 缓存：命中和未命中都缓存，避免无合格租户时每次请求全量扫描；
  // 短 TTL 保证配置变更（增删 chatId/model/agent）在 TTL 内自动生效，无需重启。
  const CS_TENANT_CACHE_TTL_MS = 30_000;
  let _csTenantIdCache: { tenantId: string | undefined; expiresAt: number } | null = null;

  /**
   * Check whether a tenant is qualified to host the EC-self-use CS widget.
   *
   * Qualification = minimum "config exists" check (hotfix scope):
   *   1. At least one agent with a non-empty model ref (ensures LLM is callable)
   *   2. CS config has feishu.chatId set (ensures notification path is wired)
   *
   * Anything stricter (reachability ping, balance check, expiry) is deferred to
   * the follow-up "LLM provider 可用性巡检" proposal.
   *
   * 合格性 = 最小"配置存在"判断：
   *   1. 至少一个 agent 配了 model ref
   *   2. CS 配置的 feishu.chatId 已填
   * 更严格的可达性/余额/到期检查留给后续的巡检体系提案。
   */
  async function isTenantCsQualified(tenantId: string): Promise<boolean> {
    try {
      const cfg = await loadTenantConfig(tenantId);
      const agents = listAgentEntries(cfg);
      const hasAgentWithModel = agents.some((a) => {
        const id = a?.id;
        if (!id) return false;
        const modelRef = resolveAgentEffectiveModelPrimary(cfg, id);
        return !!modelRef && modelRef.trim().length > 0;
      });
      if (!hasAgentWithModel) return false;

      const csCfg = await readCSConfig(tenantId);
      const hasChatId = !!csCfg.feishu?.chatId?.trim();
      return hasChatId;
    } catch {
      return false;
    }
  }

  async function getCsTenantIdCached(): Promise<string | undefined> {
    const now = Date.now();
    if (_csTenantIdCache && _csTenantIdCache.expiresAt > now) {
      return _csTenantIdCache.tenantId;
    }
    // Allow explicit override via env for multi-tenant deployments.
    // Override still goes through cache to preserve TTL semantics; qualification
    // check is skipped as operator takes responsibility for env-configured value.
    // 多租户部署时可通过环境变量显式指定；覆盖值跳过合格性检查，由运维负责。
    const envOverride = process.env.ENCLAWS_CS_WIDGET_TENANT_ID;
    if (envOverride) {
      _csTenantIdCache = { tenantId: envOverride, expiresAt: now + CS_TENANT_CACHE_TTL_MS };
      return envOverride;
    }
    let result: string | undefined;
    try {
      const { tenants } = await listTenants({ limit: 50 });
      // Earliest registered business tenants first. Use numeric Date comparison
      // because SQLite returns createdAt as an ISO string while the pg driver
      // returns a Date object — localeCompare on a Date throws at runtime.
      // 业务租户按注册时间升序。SQLite 返回 ISO 字符串，pg 驱动返回 Date 对象，
      // 用 new Date().getTime() 同时兼容两种类型，避免 localeCompare 对 Date 报错。
      const sorted = tenants
        .filter((t) => t.id !== PLATFORM_TENANT_ID_HTTP)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      // Pick the earliest qualified one. Unqualified ones are skipped so the
      // widget bubble hides cleanly instead of appearing and failing on use.
      // 挑最早的合格租户——不合格的跳过，避免气泡出现但点进去报错。
      for (const t of sorted) {
        if (await isTenantCsQualified(t.id)) {
          result = t.id;
          break;
        }
      }
    } catch {
      // DB may not be ready yet; return undefined, widget falls back gracefully.
    }
    // Cache both found and not-found results with TTL.
    // 命中和未命中都缓存，避免每次请求全量扫描。
    _csTenantIdCache = { tenantId: result, expiresAt: now + CS_TENANT_CACHE_TTL_MS };
    return result;
  }

  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
        })
      ) {
        return;
      }
      if (await handleSlackHttpRequest(req, res)) {
        return;
      }
      // Agent Chat API — no auth, direct LLM proxy for tenant agents
      if (await handleAgentChatHttpRequest(req, res)) {
        return;
      }
      // CS API — API Object CRUD + session endpoints for Agenora S2 integration
      if (req.url?.startsWith("/api/cs-api")) {
        if (await handleCsApiRequest(req, res)) { return; }
      }
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (canvasHost) {
        if (isCanvasPath(requestPath)) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            clients,
            canvasCapability: scopedCanvas.capability,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
          });
          if (!ok.ok) {
            sendGatewayAuthFailure(res, ok);
            return;
          }
        }
        if (await handleA2uiHttpRequest(req, res)) {
          return;
        }
        if (await canvasHost.handleHttpRequest(req, res)) {
          return;
        }
      }
      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
            csTenantId: await getCsTenantIdCached(),
          })
        ) {
          return;
        }
      }
      // Plugins run last so built-in gateway routes keep precedence on overlapping paths.
      if (handlePluginRequest) {
        if ((shouldEnforcePluginGatewayAuth ?? isProtectedPluginRoutePath)(requestPath)) {
          const pluginAuthOk = await enforcePluginRouteGatewayAuth({
            req,
            res,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          });
          if (!pluginAuthOk) {
            return;
          }
        }
        if (await handlePluginRequest(req, res)) {
          return;
        }
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const { httpServer, wss, canvasHost, clients, resolvedAuth, rateLimiter } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const configSnapshot = loadConfig();
          const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
          const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            clients,
            canvasCapability: scopedCanvas.capability,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
          });
          if (!ok.ok) {
            writeUpgradeAuthFailure(socket, ok);
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      socket.destroy();
    });
  });
}
