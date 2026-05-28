import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { isDbInitialized } from "../db/index.js";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";

const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTART_ATTEMPTS = 10;

export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

type ChannelManagerOptions = {
  loadConfig: () => OpenClawConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
};

type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  reloadDbChannels: () => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const { loadConfig, channelLogs, channelRuntimeEnvs } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  // Tracks restart attempts per channel:account. Reset on successful start.
  const restartAttempts = new Map<string, number>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
    const cfg = loadConfigWithDb();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    // Align accountId with plugin's canonical form. Plugins (e.g. WeCom) may
    // normalize account ids (lowercase), while the caller (tenant API) passes
    // the original-case DB appId. Without this, startChannelInternal would
    // write runtime state under the original-case key while the snapshot
    // iterates canonical ids — leaving running:false in the visible snapshot.
    const canonicalIds = plugin.config.listAccountIds(cfg);
    let accountIds: string[];
    if (accountId) {
      const match = canonicalIds.find(
        (cid) => cid === accountId || cid.toLowerCase() === accountId.toLowerCase(),
      );
      accountIds = [match ?? accountId];
    } else {
      accountIds = canonicalIds;
    }
    if (accountIds.length === 0) {
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
        }
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        if (!enabled) {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: false,
            configured: true,
            running: false,
            lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
          });
          return;
        }

        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (!configured) {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: false,
            running: false,
            lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
          });
          return;
        }

        const rKey = restartKey(channelId, id);
        if (!preserveManualStop) {
          manuallyStopped.delete(rKey);
        }

        const abort = new AbortController();
        store.aborts.set(id, abort);
        if (!preserveRestartAttempts) {
          restartAttempts.delete(rKey);
        }
        setRuntime(channelId, id, {
          accountId: id,
          enabled: true,
          configured: true,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
          reconnectAttempts: preserveRestartAttempts ? (restartAttempts.get(rKey) ?? 0) : 0,
        });

        const log = channelLogs[channelId];
        const task = startAccount({
          cfg,
          accountId: id,
          account,
          runtime: channelRuntimeEnvs[channelId],
          abortSignal: abort.signal,
          log,
          getStatus: () => getRuntime(channelId, id),
          setStatus: (next) => setRuntime(channelId, id, next),
          getConfig: loadConfigWithDb,
        });
        const trackedPromise = Promise.resolve(task)
          .catch((err) => {
            const message = formatErrorMessage(err);
            setRuntime(channelId, id, { accountId: id, running: false, lastError: message });
            log.error?.(`[${id}] channel exited: ${message}`);
          })
          .finally(() => {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              lastStopAt: Date.now(),
            });
          })
          .then(async () => {
            if (manuallyStopped.has(rKey)) {
              return;
            }
            const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
            restartAttempts.set(rKey, attempt);
            if (attempt > MAX_RESTART_ATTEMPTS) {
              log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
              return;
            }
            const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
            log.info?.(
              `[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
            );
            setRuntime(channelId, id, {
              accountId: id,
              reconnectAttempts: attempt,
            });
            try {
              await sleepWithAbort(delayMs, abort.signal);
              if (manuallyStopped.has(rKey)) {
                return;
              }
              if (store.tasks.get(id) === trackedPromise) {
                store.tasks.delete(id);
              }
              if (store.aborts.get(id) === abort) {
                store.aborts.delete(id);
              }
              await startChannelInternal(channelId, id, {
                preserveRestartAttempts: true,
                preserveManualStop: true,
              });
            } catch {
              // abort or startup failure — next crash will retry
            }
          })
          .finally(() => {
            if (store.tasks.get(id) === trackedPromise) {
              store.tasks.delete(id);
            }
            if (store.aborts.get(id) === abort) {
              store.aborts.delete(id);
            }
          });
        store.tasks.set(id, trackedPromise);
      }),
    );
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    await startChannelInternal(channelId, accountId);
  };

  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) {
      return;
    }
    const cfg = loadConfigWithDb();
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      // Align to plugin's canonical form so we match the key used by
      // startChannelInternal and the plugin's setStatus updates.
      const canonicalIds = plugin ? plugin.config.listAccountIds(cfg) : [];
      const match = canonicalIds.find(
        (cid) => cid === accountId || cid.toLowerCase() === accountId.toLowerCase(),
      );
      knownIds.clear();
      knownIds.add(match ?? accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          return;
        }
        manuallyStopped.add(restartKey(channelId, id));
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  /**
   * Load DB channel apps and merge into config.
   *
   * Reads all active tenant_channels + their active tenant_channel_apps,
   * and merges them into cfg.channels so existing channel plugins can
   * pick them up without modification.
   *
   * Each app becomes a plugin "account":
   *   channels.<type>.accounts[<appId>] = { appId, appSecret, name, ... }
   */
  let dbChannelsCache: OpenClawConfig | null = null;

  const loadConfigWithDb = (): OpenClawConfig => {
    // Return cached enriched config if available (set by startChannels)
    if (dbChannelsCache) {return dbChannelsCache;}
    return loadConfig();
  };

  const loadDbChannels = async (): Promise<void> => {
    if (!isDbInitialized()) {return;}

    try {
      const { listTenantChannels } = await import("../db/models/tenant-channel.js");
      const { listChannelApps } = await import("../db/models/tenant-channel-app.js");
      const { listTenantAgents } = await import("../db/models/tenant-agent.js");
      const { query } = await import("../db/index.js");

      // Start from base config but wipe all channels — only DB channels are used
      const baseCfg = loadConfig();
      const merged = { ...baseCfg, channels: {} } as OpenClawConfig & {
        channels: Record<string, unknown>;
      };
      // Start with empty bindings — they are rebuilt entirely from DB each time.
      // Do NOT inherit from baseCfg.bindings (which may contain stale entries from previous reload).
      const bindings: Array<{ agentId: string; match: Record<string, unknown> }> = [];

      // Build a map from channel_app DB id → { channelType, appId } for binding resolution
      const channelAppIdToInfo = new Map<string, { channelType: string; appId: string }>();

      // Get all active tenants
      const tenantsResult = await query(
        "SELECT id FROM tenants WHERE status = 'active'",
      );

      const allTenantAgents: Awaited<ReturnType<typeof listTenantAgents>> = [];

      for (const tenantRow of tenantsResult.rows) {
        const tenantId = tenantRow.id as string;
        const [channels, agents] = await Promise.all([
          listTenantChannels(tenantId),
          listTenantAgents(tenantId),
        ]);
        allTenantAgents.push(...agents);

        const allTenantApps = new Map<string, import("../db/types.js").TenantChannelApp>();

        for (const ch of channels) {
          if (!ch.isActive || ch.channelPolicy === "disabled") {continue;}

          const apps = await listChannelApps(ch.id);
          const enabledApps = apps.filter((a) => a.isActive && a.groupPolicy !== "disabled");
          if (enabledApps.length === 0) {continue;}

          for (const app of enabledApps) {
            allTenantApps.set(app.id, app);
          }

          const channelType = ch.channelType;
          const existing = (merged.channels[channelType] ?? {}) as Record<string, unknown>;
          const existingAccounts = (existing.accounts ?? {}) as Record<string, unknown>;

          const newAccounts: Record<string, unknown> = { ...existingAccounts };
          for (const app of enabledApps) {
            // Remember the mapping from DB id to channel info for binding generation
            channelAppIdToInfo.set(app.id, { channelType, appId: app.appId });

            newAccounts[app.appId] = {
              enabled: true,
              appId: app.appId,
              appSecret: app.appSecret,
              name: app.appId,
              groupPolicy: app.groupPolicy,
              tenantId,
              // Map channelPolicy → dmPolicy for feishu (openclaw-lark plugin reads dmPolicy)
              ...(channelType === "feishu" && {
                dmPolicy: ch.channelPolicy,
                ...(ch.channelPolicy === "open" && { allowFrom: ["*"] }),
              }),
              // WeCom plugin reads botId/secret (not appId/appSecret) for its Bot WebSocket connection
              ...(channelType === "wecom" && {
                botId: app.appId,
                secret: app.appSecret,
              }),
              // DingTalk plugin reads clientId/clientSecret for its Stream SDK
              ...(channelType === "dingtalk" && {
                clientId: app.appId,
                clientSecret: app.appSecret,
              }),
            };
          }

          // Merge channel-level config from tenant_channels.config.
          // Exclude account-level fields (appId/appSecret) — they belong in accounts, not at channel top level.
          // Having them here would cause the plugin to create a phantom "default" account.
          if (ch.config && typeof ch.config === "object") {
            const { appId: _a, appSecret: _s, ...channelLevelConfig } = ch.config as Record<string, unknown>;
            Object.assign(existing, channelLevelConfig);
          }

          merged.channels[channelType] = {
            ...existing,
            enabled: true,
            accounts: newAccounts,
          };
          // console.log(`[loadDbChannels] merged after ${channelType}:`, JSON.stringify(merged, null, 2));
        }

        // Track which apps already have bindings via app.agentId (new one-to-many)
        const appBoundByAppAgentId = new Set<string>();

        // Generate bindings from app.agentId (new: one-to-many, app points to agent)
        for (const [appDbId, appInfo] of channelAppIdToInfo) {
          const app = allTenantApps.get(appDbId);
          if (!app?.agentId) {continue;}
          const agent = agents.find((a) => a.agentId === app.agentId && a.isActive);
          if (!agent) {continue;}

          appBoundByAppAgentId.add(appDbId);

          bindings.push({
            agentId: agent.agentId,
            match: {
              channel: appInfo.channelType,
              accountId: appInfo.appId,
            },
          });

          // Inject per-agent tenantUserId mapping
          const channelAccounts = (
            (merged.channels[appInfo.channelType] ?? {}) as Record<string, unknown>
          ).accounts as Record<string, Record<string, unknown>> | undefined;
          if (channelAccounts?.[appInfo.appId]) {
            const acct = channelAccounts[appInfo.appId];
            const userMap = (acct.tenantUserByAgent ?? {}) as Record<string, string>;
            if (agent.createdBy) {
              userMap[agent.agentId] = agent.createdBy;
            }
            acct.tenantUserByAgent = userMap;
            acct.tenantUserId = agent.createdBy ?? acct.tenantUserId;

            const agentConfig = agent.config;
            const feishuOpenId = (agentConfig?.feishuOpenId as string)?.trim();
            if (feishuOpenId) {
              const senderMap = (acct.senderToAgent ?? {}) as Record<string, string>;
              senderMap[feishuOpenId] = agent.agentId;
              acct.senderToAgent = senderMap;
            }
          }
        }

      }

      merged.bindings = bindings as OpenClawConfig["bindings"];

      // Load all tenant models and build a lookup map for model_id FK resolution.
      const { listTenantModels } = await import("../db/models/tenant-model.js");
      const { toConfigAgentsList, buildTenantModelProviderKey } = await import("../db/models/tenant-agent.js");
      const allTenantModelsMap = new Map<string, import("../db/types.js").TenantModel>();
      // Start with a CLEAN providers map — only non-tenant providers are inherited.
      // Tenant model providers (keyed "tm-{id}") are rebuilt entirely from DB each
      // time so that deleted/updated models are not carried over from stale snapshots.
      const baseProviders = (merged as any).models?.providers ?? {};
      const tenantProviders: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(baseProviders)) {
        if (!key.startsWith("tm-")) {
          tenantProviders[key] = value;
        }
      }

      for (const tenantRow of tenantsResult.rows) {
        const tId = tenantRow.id as string;
        const tenantModels = await listTenantModels(tId, { activeOnly: true });
        for (const tm of tenantModels) {
          allTenantModelsMap.set(tm.id, tm);
          // Register each tenant_models record as a provider using a unique key "tm-{id}".
          // This avoids collisions when multiple records share the same provider_type
          // (e.g. multiple "custom" providers) and ensures model_id FK resolution works.
          const providerKey = buildTenantModelProviderKey(tm);
          tenantProviders[providerKey] = {
            baseUrl: tm.baseUrl ?? "",
            apiKey: tm.apiKeyEncrypted ?? undefined,
            api: tm.apiProtocol ?? "openai-completions",
            headers: tm.extraHeaders ?? {},
            models: (tm.models ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              reasoning: m.reasoning ?? false,
              input: m.input ?? ["text"],
              contextWindow: m.contextWindow ?? 128000,
              maxTokens: m.maxTokens ?? 4096,
              cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          };
        }
      }

      if (Object.keys(tenantProviders).length > 0) {
        merged.models = {
          ...(merged as any).models,
          providers: tenantProviders,
        };
      }

      // Merge all tenant agents into config.agents.list.
      // Pass tenantModelsMap so that agents with model_id FK can resolve their
      // model reference via the tenant_models record instead of legacy config fields.
      if (allTenantAgents.length > 0) {
        merged.agents = {
          ...(merged as any).agents,
          list: toConfigAgentsList(allTenantAgents, allTenantModelsMap) as any,
        };
      }

      dbChannelsCache = merged;
      // Propagate DB-enriched config to the global loadConfig() singleton so that
      // all code paths (e.g. gateway send handler) resolve channel credentials from
      // the database rather than falling back to the base enclaws.json config.
      setRuntimeConfigSnapshot(merged);
    } catch (err) {
      console.error("[server-channels] failed to load DB channels:", err);
    }
  };

  const startChannels = async () => {
    // Load DB channels into cache before starting plugins
    await loadDbChannels();

    for (const plugin of listChannelPlugins()) {
      await startChannel(plugin.id);
    }
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = loadConfigWithDb();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = loadConfigWithDb();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured;
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        next.enabled = enabled;
        next.configured = typeof configured === "boolean" ? configured : (next.configured ?? true);
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  const isManuallyStopped_ = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts_ = (channelId: ChannelId, accountId: string): void => {
    restartAttempts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    reloadDbChannels: loadDbChannels,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStopped_,
    resetRestartAttempts: resetRestartAttempts_,
  };
}
