import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { loadSessionStore } from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveTenantSessionStorePath,
  resolveTenantAgentCronStorePath,
} from "../config/sessions/tenant-paths.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { loadCronStore, resolveCronStorePath, resolveUserCronStorePath } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { findChannelAppByAgent } from "../db/models/tenant-channel-app.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import type { TenantContext } from "../types/tenant-context.js";
import { callGateway } from "./call.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const debugCronLog = createSubsystemLogger("gateway/cron-debug");
const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "legacy";
};

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = params.delivery?.mode?.trim().toLowerCase();
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.ENCLAWS_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      debugCronLog.info(
        `[DEBUG-CRON] single-tenant runHeartbeatOnce fired agentId=${agentId} sessionKey=${sessionKey} reason=${opts?.reason}`,
      );
      // Merge cron-supplied heartbeat overrides (e.g. target: "last") with the
      // fully resolved agent heartbeat config so cron-triggered heartbeats
      // respect agent-specific overrides (agents.list[].heartbeat) before
      // falling back to agents.defaults.heartbeat.
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: heartbeatOverride,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        abortSignal,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    sendCronFailureAlert: async ({ job, text, channel, to }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const target = await resolveDeliveryTarget(runtimeConfig, agentId, {
        channel,
        to,
      });
      if (!target.ok) {
        throw target.error;
      }
      await deliverOutboundPayloads({
        cfg: runtimeConfig,
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text }],
        deps: createOutboundSendDeps(params.deps),
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const webhookToken = params.cfg.cron?.webhookToken?.trim();
        const legacyWebhook = params.cfg.cron?.webhook?.trim();
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              jobId: evt.jobId,
              deliveryTo: job.delivery.to,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (webhookToken) {
            headers.Authorization = `Bearer ${webhookToken}`;
          }
          const abortController = new AbortController();
          const timeout = setTimeout(() => {
            abortController.abort();
          }, CRON_WEBHOOK_TIMEOUT_MS);

          void (async () => {
            try {
              const result = await fetchWithSsrFGuard({
                url: webhookTarget.url,
                init: {
                  method: "POST",
                  headers,
                  body: JSON.stringify(evt),
                  signal: abortController.signal,
                },
              });
              await result.release();
            } catch (err) {
              if (err instanceof SsrFBlockedError) {
                cronLogger.warn(
                  {
                    reason: formatErrorMessage(err),
                    jobId: evt.jobId,
                    webhookUrl: redactWebhookUrl(webhookTarget.url),
                  },
                  "cron: webhook delivery blocked by SSRF guard",
                );
              } else {
                cronLogger.warn(
                  {
                    err: formatErrorMessage(err),
                    jobId: evt.jobId,
                    webhookUrl: redactWebhookUrl(webhookTarget.url),
                  },
                  "cron: webhook delivery failed",
                );
              }
            } finally {
              clearTimeout(timeout);
            }
          })();
        }
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(
          logPath,
          {
            ts: Date.now(),
            jobId: evt.jobId,
            action: "finished",
            status: evt.status,
            error: evt.error,
            summary: evt.summary,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            deliveryError: evt.deliveryError,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            runAtMs: evt.runAtMs,
            durationMs: evt.durationMs,
            nextRunAtMs: evt.nextRunAtMs,
            model: evt.model,
            provider: evt.provider,
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}

/**
 * Resolve the best-effort Feishu delivery target (lastChannel + lastTo) for a
 * tenant user by scanning their tenant-scoped session store.  Returns the most
 * recently updated session entry that has both fields set.
 */
function resolveTenantLastDeliveryTarget(
  tenantId: string,
  userId: string,
): { channel: string; to: string; accountId?: string } | undefined {
  try {
    const storePath = resolveTenantSessionStorePath(tenantId, undefined, userId);
    const store = loadSessionStore(storePath);
    let bestChannel: string | undefined;
    let bestTo: string | undefined;
    let bestAccountId: string | undefined;
    let latestUpdatedAt = 0;
    for (const entry of Object.values(store)) {
      if (!entry?.lastChannel || !entry?.lastTo) {
        continue;
      }
      const updatedAt = entry.updatedAt ?? 0;
      if (updatedAt >= latestUpdatedAt) {
        latestUpdatedAt = updatedAt;
        bestChannel = entry.lastChannel.trim().toLowerCase();
        bestTo = entry.lastTo.trim();
        bestAccountId =
          typeof entry.lastAccountId === "string" ? entry.lastAccountId.trim() : undefined;
      }
    }
    return bestChannel && bestTo
      ? { channel: bestChannel, to: bestTo, accountId: bestAccountId }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a tenant-scoped CronService with real job execution and run logging.
 * Unlike the stub in server.impl.ts, this starts the timer and executes jobs.
 */
export function buildTenantCronService(params: {
  tenantId: string;
  userId: string;
  storePath: string;
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  cronEnabled: boolean;
}): GatewayCronState {
  const cronLogger = getChildLogger({
    module: "cron",
    tenantId: params.tenantId,
    userId: params.userId,
  });
  const storePath = params.storePath;
  const cronEnabled = params.cronEnabled;
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  // Buffer for systemEvent text that will be delivered by runHeartbeatOnce.
  let pendingSystemEventText: string | undefined;
  let pendingSystemEventSessionKey: string | undefined;

  /**
   * Parse a Feishu group session key and extract the group chat ID and sender
   * open ID for delivery with @mention.
   *
   * Session key format: agent:<agentId>:feishu:group:<chatId>:sender:<openId>
   */
  function parseFeishuGroupFromSessionKey(sessionKey: string): {
    chatId?: string;
    senderOpenId?: string;
  } {
    const match = sessionKey.match(/:feishu:group:([^:]+):sender:(ou_[^:]+)/);
    return { chatId: match?.[1], senderOpenId: match?.[2] };
  }

  /**
   * Run agent via gateway (deliver:false) then deliver the response directly
   * to the Feishu group chat with @mention of the original sender.
   *
   * This mirrors the global heartbeat runner flow (getReplyFromConfig +
   * deliverOutboundPayloads) but routes through the gateway for the agent run
   * and uses the tenant session store for the delivery target.
   */
  async function tenantRunHeartbeat(opts: { sessionKey: string; text: string }): Promise<void> {
    const { sessionKey, text } = opts;
    debugCronLog.info(
      `[DEBUG-CRON] tenantRunHeartbeat fired tenantId=${params.tenantId} userId=${params.userId} sessionKey=${sessionKey}`,
    );
    const idempotencyKey = `cron-tenant-announce:${params.tenantId}:${Date.now()}`;

    // Step 1: Run agent via gateway WITHOUT delivery so we can control delivery.
    const gatewayResult = await callGateway<{
      status?: string;
      result?: { payloads?: Array<{ text?: string }> };
    }>({
      method: "agent",
      params: {
        sessionKey,
        message: text,
        deliver: false,
        bestEffortDeliver: true,
        idempotencyKey,
        _tenantId: params.tenantId,
        _tenantUserId: params.userId,
      },
      expectFinal: true,
      timeoutMs: 30_000,
    });

    const responseText = gatewayResult?.result?.payloads?.[0]?.text?.trim() ?? "";
    if (!responseText) {
      cronLogger.warn({ sessionKey }, "cron: tenant heartbeat: agent returned no text");
      return;
    }

    // Step 2: Resolve delivery target.
    // Prefer chat ID from session key (most reliable for Feishu groups); fall
    // back to the last known target from the tenant session store.
    const { chatId, senderOpenId } = parseFeishuGroupFromSessionKey(sessionKey);
    const deliveryTarget = resolveTenantLastDeliveryTarget(params.tenantId, params.userId);

    const channel = chatId ? "feishu" : deliveryTarget?.channel;
    const to = chatId ?? deliveryTarget?.to;
    const accountId = deliveryTarget?.accountId;

    if (!channel || !to) {
      cronLogger.warn(
        { sessionKey, chatId, deliveryTarget },
        "cron: tenant heartbeat: no delivery target",
      );
      return;
    }

    // Step 3: For Feishu group sessions, prepend @mention of the original sender.
    const mentionPrefix =
      senderOpenId && channel === "feishu" ? `<at id=${senderOpenId}></at> ` : "";
    const deliveryText = (mentionPrefix + responseText).trim();

    debugCronLog.info(
      `[DEBUG-CRON] tenant heartbeat: delivering tenantId=${params.tenantId} userId=${params.userId} sessionKey=${sessionKey} channel=${channel} to=${to} accountId=${accountId}`,
    );

    // Step 4: Deliver directly — bypasses the gateway's agent delivery path
    // which reads from the global session store and cannot resolve tenant sessions.
    const cfg = loadConfig();
    await deliverOutboundPayloads({
      cfg,
      channel,
      to,
      accountId,
      payloads: [{ text: deliveryText }],
      deps: createOutboundSendDeps(params.deps),
    });
  }

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    enqueueSystemEvent: (text, opts) => {
      // Capture text + session key; tenantRunHeartbeat delivers them.
      pendingSystemEventText = text;
      pendingSystemEventSessionKey = opts?.sessionKey?.trim() || undefined;
    },
    requestHeartbeatNow: (opts) => {
      // Fire-and-forget: deliver pending system event text if available.
      const sessionKey = opts?.sessionKey?.trim() || pendingSystemEventSessionKey;
      const text = pendingSystemEventText;
      if (text && sessionKey) {
        pendingSystemEventText = undefined;
        pendingSystemEventSessionKey = undefined;
        void tenantRunHeartbeat({ sessionKey, text }).catch((err) => {
          cronLogger.warn(
            { err: String(err), sessionKey },
            "cron: tenant requestHeartbeatNow failed",
          );
        });
      }
    },
    runHeartbeatOnce: async (opts) => {
      const sessionKey = opts?.sessionKey?.trim() || pendingSystemEventSessionKey;
      const text = pendingSystemEventText;
      if (!text || !sessionKey) {
        return { status: "skipped" as const, reason: "no-pending-event" };
      }
      pendingSystemEventText = undefined;
      pendingSystemEventSessionKey = undefined;
      try {
        await tenantRunHeartbeat({ sessionKey, text });
        return { status: "ran" as const };
      } catch (err) {
        cronLogger.warn({ err: String(err), sessionKey }, "cron: tenant runHeartbeatOnce failed");
        return { status: "error" as const, reason: String(err) };
      }
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      // Auto-resolve credentials from the agent's bound channel app in tenant DB
      // and inject them into the config so the delivery layer can find them.
      let effectiveCfg = runtimeConfig;
      // Always try to resolve tenant channel credentials for agent-scoped cron,
      // not just for "announce" mode — the delivery mode in the job config may
      // differ from how the dispatch actually resolves delivery.
      try {
        const channelApp = await findChannelAppByAgent(params.tenantId, agentId);
        cronLogger.info(
          {
            tenantId: params.tenantId,
            agentId,
            channelApp: channelApp
              ? {
                  channelType: channelApp.channelType,
                  appId: channelApp.appId?.slice(0, 8) + "...",
                }
              : null,
          },
          "cron: resolved agent channel app",
        );
        if (channelApp?.appId && channelApp.appSecret) {
          const channelKey = channelApp.channelType; // e.g. "feishu"
          const existingChannel = (
            runtimeConfig.channels as Record<string, Record<string, unknown>> | undefined
          )?.[channelKey];
          effectiveCfg = {
            ...runtimeConfig,
            channels: {
              ...runtimeConfig.channels,
              [channelKey]: {
                ...existingChannel,
                appId: channelApp.appId,
                appSecret: channelApp.appSecret,
              },
            },
          } as typeof runtimeConfig;
        }
      } catch (err) {
        cronLogger.warn(
          { err: String(err) },
          "cron: failed to resolve agent channel app for delivery",
        );
      }
      return await runCronIsolatedAgentTurn({
        cfg: effectiveCfg,
        deps: params.deps,
        job,
        message,
        abortSignal,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
        tenantId: params.tenantId,
        userId: params.userId,
      });
    },
    log: cronLogger,
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(
          logPath,
          {
            ts: Date.now(),
            jobId: evt.jobId,
            action: "finished",
            status: evt.status,
            error: evt.error,
            summary: evt.summary,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            deliveryError: evt.deliveryError,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            runAtMs: evt.runAtMs,
            durationMs: evt.durationMs,
            nextRunAtMs: evt.nextRunAtMs,
            model: evt.model,
            provider: evt.provider,
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}

// ============================================================
// Multi-tenant Cron Scheduler
// ============================================================

export interface RegisteredCronUser extends TenantContext {
  storePath: string;
}

export interface RegisteredCronAgent {
  tenantId: string;
  agentId: string;
  storePath: string;
}

export type MultiTenantCronState = {
  scheduler: MultiTenantCronScheduler;
};

/**
 * Multi-tenant cron scheduler that manages per-user cron stores.
 *
 * Uses a single timer to poll all registered users' jobs.json files,
 * executing due jobs via the provided runner function.
 */
export class MultiTenantCronScheduler {
  private users = new Map<string, RegisteredCronUser>();
  private agents = new Map<string, RegisteredCronAgent>();
  private agentCache = new Map<string, { store: any; loadedAtMs: number }>();
  private readonly agentCacheTtlMs = 60_000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly log;
  private readonly executeJob: (job: CronJob, user: RegisteredCronUser) => Promise<void>;

  constructor(params: {
    pollIntervalMs?: number;
    log: ReturnType<typeof getChildLogger>;
    executeJob: (job: CronJob, user: RegisteredCronUser) => Promise<void>;
  }) {
    this.pollIntervalMs = params.pollIntervalMs ?? 60_000;
    this.log = params.log;
    this.executeJob = params.executeJob;
  }

  /** Register a user for cron scheduling. */
  registerUser(tenantId: string, userId: string): void {
    const key = `${tenantId}:${userId}`;
    if (this.users.has(key)) {
      return;
    }
    this.users.set(key, {
      tenantId,
      userId,
      storePath: resolveUserCronStorePath(tenantId, userId),
    });
    this.log.info({ tenantId, userId }, "cron: registered user");
  }

  /** Unregister a user from cron scheduling. */
  unregisterUser(tenantId: string, userId: string): void {
    const key = `${tenantId}:${userId}`;
    if (this.users.delete(key)) {
      this.log.info({ tenantId, userId }, "cron: unregistered user");
    }
  }

  /** Check if a user is registered. */
  hasUser(tenantId: string, userId: string): boolean {
    return this.users.has(`${tenantId}:${userId}`);
  }

  /** Get the number of registered users. */
  get userCount(): number {
    return this.users.size;
  }

  /** Register an agent for cron scheduling. */
  registerAgent(tenantId: string, agentId: string): void {
    const key = `${tenantId}:${agentId}`;
    if (this.agents.has(key)) {
      return;
    }
    this.agents.set(key, {
      tenantId,
      agentId,
      storePath: resolveTenantAgentCronStorePath(tenantId, agentId),
    });
    this.log.info({ tenantId, agentId }, "cron: registered agent");
  }

  /** Unregister an agent from cron scheduling. */
  unregisterAgent(tenantId: string, agentId: string): void {
    const key = `${tenantId}:${agentId}`;
    if (this.agents.delete(key)) {
      this.agentCache.delete(key);
      this.log.info({ tenantId, agentId }, "cron: unregistered agent");
    }
  }

  /** Invalidate cached agent store so it is re-read on next tick. */
  invalidateAgentCache(tenantId: string, agentId: string): void {
    this.agentCache.delete(`${tenantId}:${agentId}`);
  }

  /** Load an agent's cron store with TTL-based caching. */
  private async loadAgentStore(agent: RegisteredCronAgent): Promise<any> {
    const key = `${agent.tenantId}:${agent.agentId}`;
    const cached = this.agentCache.get(key);
    const now = Date.now();
    if (cached && now - cached.loadedAtMs < this.agentCacheTtlMs) {
      return cached.store;
    }
    const store = await loadCronStore(agent.storePath);
    this.agentCache.set(key, { store, loadedAtMs: now });
    return store;
  }

  /** Start the scheduler. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    // Execute immediately on start.
    void this.tick();
    this.log.info({ pollIntervalMs: this.pollIntervalMs }, "cron: multi-tenant scheduler started");
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info({}, "cron: multi-tenant scheduler stopped");
    }
  }

  /** Main tick: iterate all registered users and execute due jobs. */
  private async tick(): Promise<void> {
    if (this.running) {
      return;
    } // skip if previous tick still running
    this.running = true;
    const startTime = Date.now();
    let executedCount = 0;
    let errorCount = 0;

    try {
      // Iterate user-based cron stores (backward compat)
      for (const [key, user] of this.users) {
        try {
          const store = await loadCronStore(user.storePath);
          for (const job of store.jobs) {
            if (!job.enabled) {
              continue;
            }
            if (!this.isJobDue(job, startTime)) {
              continue;
            }
            try {
              await this.executeJob(job, user);
              executedCount++;
            } catch (err) {
              errorCount++;
              this.log.warn(
                {
                  err: formatErrorMessage(err),
                  jobId: job.id,
                  tenantId: user.tenantId,
                  userId: user.userId,
                },
                "cron: job execution failed",
              );
            }
          }
        } catch (err) {
          // Individual user store read failure should not block others.
          errorCount++;
          this.log.warn(
            { err: formatErrorMessage(err), key },
            "cron: failed to read user cron store",
          );
        }
      }

      // Iterate agent-based cron stores (concurrent loading)
      if (this.agents.size > 0) {
        const agentEntries = Array.from(this.agents.entries());
        const agentStores = await Promise.all(
          agentEntries.map(async ([key, agent]) => {
            try {
              const store = await this.loadAgentStore(agent);
              return { key, agent, store };
            } catch (err) {
              errorCount++;
              this.log.warn(
                { err: formatErrorMessage(err), key },
                "cron: failed to read agent cron store",
              );
              return null;
            }
          }),
        );
        for (const entry of agentStores) {
          if (!entry) {
            continue;
          }
          for (const job of entry.store.jobs) {
            if (!job.enabled) {
              continue;
            }
            if (!this.isJobDue(job, startTime)) {
              continue;
            }
            try {
              // Wrap agent as a RegisteredCronUser for backward compat with executeJob
              await this.executeJob(job, {
                tenantId: entry.agent.tenantId,
                userId: entry.agent.agentId,
                storePath: entry.agent.storePath,
              });
              executedCount++;
            } catch (err) {
              errorCount++;
              this.log.warn(
                {
                  err: formatErrorMessage(err),
                  jobId: job.id,
                  tenantId: entry.agent.tenantId,
                  agentId: entry.agent.agentId,
                },
                "cron: agent job execution failed",
              );
            }
          }
        }
      }
    } finally {
      this.running = false;
    }

    const elapsed = Date.now() - startTime;
    if (executedCount > 0 || errorCount > 0) {
      this.log.info(
        { users: this.users.size, executed: executedCount, errors: errorCount, elapsedMs: elapsed },
        "cron: multi-tenant tick complete",
      );
    }
  }

  /** Check if a cron job is due for execution. */
  private isJobDue(job: CronJob, nowMs: number): boolean {
    const nextRunAtMs = job.state?.nextRunAtMs;
    if (typeof nextRunAtMs !== "number") {
      return false;
    }
    if (job.state?.runningAtMs) {
      return false;
    } // already running
    return nextRunAtMs <= nowMs;
  }
}

/**
 * Build and start a multi-tenant cron scheduler.
 *
 * This is the multi-tenant counterpart to `buildGatewayCronService`.
 * It creates a single scheduler that polls all registered users' cron stores.
 */
export function buildMultiTenantCronService(params: {
  pollIntervalMs?: number;
  executeJob: (job: CronJob, user: RegisteredCronUser) => Promise<void>;
}): MultiTenantCronState {
  const log = getChildLogger({ module: "cron-mt" });

  const scheduler = new MultiTenantCronScheduler({
    pollIntervalMs: params.pollIntervalMs,
    log,
    executeJob: params.executeJob,
  });

  scheduler.start();
  return { scheduler };
}
