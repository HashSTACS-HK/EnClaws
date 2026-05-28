import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { listTenantAgentIdsFromDisk } from "../../config/sessions/tenant-paths.js";
import { loadConfig } from "../../config/io.js";
import { isDbInitialized } from "../../db/index.js";
import { getTenantById, resolveEffectiveQuotas } from "../../db/models/tenant.js";
import { getUserDisplayNamesByOpenIds } from "../../db/models/user.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../protocol/index.js";
import { getPlanUpgradeLink } from "../protocol/schema/error-codes.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

/**
 * Resolve the effective cron service and store path for a request.
 * If the client has a tenant context and a tenant-scoped resolver is available,
 * returns the tenant-scoped cron; otherwise falls back to the global cron.
 *
 * When the internal gateway connection does not carry a JWT (e.g. agent tool
 * calls via the local WebSocket), tenant info may be passed as `_tenantId` /
 * `_tenantUserId` inside the request params. This fallback allows the cron
 * tool to reach the correct tenant-scoped store without requiring a full
 * authenticated client context.
 */
function resolveEffectiveCron(
  context: GatewayRequestContext,
  client: GatewayClient | null,
  params?: Record<string, unknown>,
): { cron: typeof context.cron; cronStorePath: string } {
  // Agent-scoped path: when _agentId is provided, route to the agent's cron store.
  if (context.resolveTenantAgentCron && params) {
    const agentId = typeof params._agentId === "string" ? params._agentId.trim() : "";
    const tenantId =
      client?.tenant?.tenantId ??
      (typeof params._tenantId === "string" ? params._tenantId.trim() : "");
    if (agentId && tenantId) {
      context.logGateway.info(`resolveEffectiveCron: agent-scoped tenantId=${tenantId} agentId=${agentId}`);
      const resolved = context.resolveTenantAgentCron(tenantId, agentId);
      if (resolved) {return resolved;}
    }
  }
  // Primary path: client already carries a tenant context (JWT-authenticated).
  if (client?.tenant && context.resolveTenantCron) {
    context.logGateway.info(`resolveEffectiveCron: using client.tenant userId=${client.tenant.userId}`);
    const resolved = context.resolveTenantCron(client.tenant);
    if (resolved) {return resolved;}
  }
  // Fallback: extract tenant info from params (injected by cron-tool.ts).
  if (context.resolveTenantCron && params) {
    const tenantId = typeof params._tenantId === "string" ? params._tenantId.trim() : "";
    const userId = typeof params._tenantUserId === "string" ? params._tenantUserId.trim() : "";
    context.logGateway.info(`resolveEffectiveCron: params._tenantId=${tenantId || "(empty)"} params._tenantUserId=${userId || "(empty)"} hasResolveTenantCron=${!!context.resolveTenantCron}`);
    if (tenantId && userId) {
      const resolved = context.resolveTenantCron({ tenantId, userId });
      if (resolved) {return resolved;}
    }
  } else {
    context.logGateway.info(`resolveEffectiveCron: fallback to global cron (resolveTenantCron=${!!context.resolveTenantCron}, params=${!!params}, paramKeys=${params ? Object.keys(params).join(",") : "none"})`);
  }
  return { cron: context.cron, cronStorePath: context.cronStorePath };
}

/**
 * Strip internal tenant params (`_tenantId`, `_tenantUserId`) from the
 * request params so they don't trip `additionalProperties: false` in the
 * protocol validators.  The original `params` object is returned unmodified
 * (the tenant fields are read from it by `resolveEffectiveCron`).
 */
function stripTenantParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!("_tenantId" in params) && !("_tenantUserId" in params) && !("_agentId" in params) && !("_tenantUserDisplayName" in params)) {
    return params;
  }
  const { _tenantId: _, _tenantUserId: __, _agentId: ___, _tenantUserDisplayName: ____, ...rest } = params;
  return rest;
}

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateWakeParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
    };
    const { cron } = resolveEffectiveCron(context, client, params);
    const result = cron.wake({ mode: p.mode, text: p.text });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateCronListParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      includeDisabled?: boolean;
      limit?: number;
      offset?: number;
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
    };
    const { cron } = resolveEffectiveCron(context, client, params);
    const page = await cron.listPage({
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
  "cron.status": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateCronStatusParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }
    const { cron } = resolveEffectiveCron(context, client, params);
    const status = await cron.status();
    respond(true, status, undefined);
  },
  "cron.add": async ({ params, respond, context, client }) => {
    context.logGateway.info(`cron.add: received params keys=${Object.keys(params).join(",")} _tenantId=${(params as any)._tenantId || "(missing)"} _tenantUserId=${(params as any)._tenantUserId || "(missing)"} hasClient=${!!client} connId=${client?.connId || "(none)"} clientName=${client?.connect?.name || "(none)"} clientTenant=${client?.tenant ? JSON.stringify(client.tenant) : "(none)"}`);
    const cleaned = stripTenantParams(params);
    const normalized = normalizeCronJobCreate(cleaned) ?? cleaned;
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    // Multi-tenant guardrails: hardcoded schedule-kind + min-interval checks,
    // plus platform-allocated per-tenant job-count quota.
    const effectiveTenantId =
      client?.tenant?.tenantId ??
      (typeof params._tenantId === "string" ? params._tenantId.trim() : "");
    if (effectiveTenantId && isDbInitialized()) {
      const cronCfg = loadConfig().cron ?? {};
      const allowedKinds = cronCfg.allowedScheduleKinds ?? ["at", "every", "cron"];
      if (!allowedKinds.includes(jobCreate.schedule.kind)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Schedule kind "${jobCreate.schedule.kind}" is not allowed`,
          ),
        );
        return;
      }
      const minIntervalMs = cronCfg.minIntervalMs ?? 60_000;
      if (jobCreate.schedule.kind === "every" && jobCreate.schedule.everyMs < minIntervalMs) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Schedule interval must be at least ${minIntervalMs}ms`,
          ),
        );
        return;
      }
      try {
        const tenant = await getTenantById(effectiveTenantId);
        const effectiveQuotas = tenant ? await resolveEffectiveQuotas(tenant) : undefined;
        const maxCronJobs = effectiveQuotas?.maxCronJobs ?? -1;
        if (maxCronJobs >= 0 && context.countTenantCronJobs) {
          const current = context.countTenantCronJobs(effectiveTenantId);
          if (current >= maxCronJobs) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.QUOTA_EXCEEDED,
                `Cron job quota reached (${current}/${maxCronJobs}). Upgrade your plan.`,
                {
                  details: {
                    resource: "cronJobs",
                    current,
                    max: maxCronJobs,
                    contactLink: getPlanUpgradeLink(),
                  },
                },
              ),
            );
            return;
          }
        }
      } catch (err) {
        context.logGateway.warn(
          `cron.add: quota check failed for tenant ${effectiveTenantId}: ${String(err)}`,
        );
      }
    }
    // Auto-fill createdBy from tenant context if not already set.
    if (!jobCreate.createdBy && client?.tenant) {
      jobCreate.createdBy = {
        userId: client.tenant.userId,
        displayName: (client.tenant as Record<string, unknown>).displayName as string | undefined,
      };
    }
    // Fallback for internal calls (e.g. cron-tool) that pass _tenantUserId
    // but don't have a JWT client.
    if (!jobCreate.createdBy && typeof params?._tenantUserId === "string" && params._tenantUserId.trim()) {
      const userId = params._tenantUserId.trim();
      const senderId = typeof params._tenantUserDisplayName === "string" ? params._tenantUserDisplayName.trim() : "";
      const tenantId =
        client?.tenant?.tenantId ??
        (typeof params._tenantId === "string" ? params._tenantId.trim() : "");
      // Resolve display name from DB using the sender's external ID (e.g. ou_xxx, liuyu).
      let displayName: string | undefined;
      if (senderId && tenantId && isDbInitialized()) {
        try {
          const nameMap = await getUserDisplayNamesByOpenIds(tenantId, [senderId]);
          displayName = nameMap.get(senderId);
        } catch {
          // Best-effort: DB lookup failure should not block job creation.
        }
      }
      jobCreate.createdBy = { userId, displayName: displayName || senderId || undefined };
    }
    const { cron, cronStorePath } = resolveEffectiveCron(context, client, params);
    const job = await cron.add(jobCreate);
    context.logGateway.info("cron: job created", { jobId: job.id, schedule: jobCreate.schedule, storePath: cronStorePath });
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    const normalizedPatch = normalizeCronJobPatch((cleaned as { patch?: unknown } | null)?.patch);
    const candidate =
      normalizedPatch && typeof cleaned === "object" && cleaned !== null
        ? { ...cleaned, patch: normalizedPatch }
        : cleaned;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    const { cron } = resolveEffectiveCron(context, client, params);
    const job = await cron.update(jobId, patch);
    context.logGateway.info("cron: job updated", { jobId });
    respond(true, job, undefined);
  },
  "cron.remove": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateCronRemoveParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"),
      );
      return;
    }
    const { cron } = resolveEffectiveCron(context, client, params);
    const result = await cron.remove(jobId);
    if (result.removed) {
      context.logGateway.info("cron: job removed", { jobId });
    }
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateCronRunParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; mode?: "due" | "force" };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }
    const { cron } = resolveEffectiveCron(context, client, params);
    const result = await cron.run(jobId, p.mode ?? "force");
    respond(true, result, undefined);
  },
  "cron.runs": async ({ params, respond, context, client }) => {
    const cleaned = stripTenantParams(params);
    if (!validateCronRunsParams(cleaned)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      scope?: "job" | "all";
      id?: string;
      jobId?: string;
      limit?: number;
      offset?: number;
      statuses?: Array<"ok" | "error" | "skipped">;
      status?: "all" | "ok" | "error" | "skipped";
      deliveryStatuses?: Array<"delivered" | "not-delivered" | "unknown" | "not-requested">;
      deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
      query?: string;
      sortDir?: "asc" | "desc";
    };
    const explicitScope = p.scope;
    const jobId = p.id ?? p.jobId;
    const scope: "job" | "all" = explicitScope ?? (jobId ? "job" : "all");
    if (scope === "job" && !jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
      );
      return;
    }
    const { cron, cronStorePath } = resolveEffectiveCron(context, client, params);
    if (scope === "all") {
      const jobs = await cron.list({ includeDisabled: true });
      const jobNameById = Object.fromEntries(
        jobs
          .filter((job) => typeof job.id === "string" && typeof job.name === "string")
          .map((job) => [job.id, job.name]),
      );
      const page = await readCronRunLogEntriesPageAll({
        storePath: cronStorePath,
        limit: p.limit,
        offset: p.offset,
        statuses: p.statuses,
        status: p.status,
        deliveryStatuses: p.deliveryStatuses,
        deliveryStatus: p.deliveryStatus,
        query: p.query,
        sortDir: p.sortDir,
        jobNameById,
      });
      respond(true, page, undefined);
      return;
    }
    let logPath: string;
    try {
      logPath = resolveCronRunLogPath({
        storePath: cronStorePath,
        jobId: jobId as string,
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"),
      );
      return;
    }
    const page = await readCronRunLogEntriesPage(logPath, {
      limit: p.limit,
      offset: p.offset,
      jobId: jobId as string,
      statuses: p.statuses,
      status: p.status,
      deliveryStatuses: p.deliveryStatuses,
      deliveryStatus: p.deliveryStatus,
      query: p.query,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
  /**
   * List all cron jobs across all agents for a tenant (enterprise cross-agent view).
   * Returns jobs annotated with their agentId for the tenant-cron overview.
   */
  "cron.listAll": async ({ params, respond, context, client }) => {
    const tenantId =
      client?.tenant?.tenantId ??
      (typeof params._tenantId === "string" ? params._tenantId.trim() : "");
    if (!tenantId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cron.listAll requires a tenant context"),
      );
      return;
    }
    const agentIds = listTenantAgentIdsFromDisk(tenantId);
    const allJobs: (CronJob & { _agentId: string })[] = [];
    for (const agentId of agentIds) {
      if (!context.resolveTenantAgentCron) {continue;}
      const resolved = context.resolveTenantAgentCron(tenantId, agentId);
      if (!resolved) {continue;}
      try {
        const jobs = await resolved.cron.list({ includeDisabled: true });
        for (const job of jobs) {
          allJobs.push({ ...job, _agentId: agentId });
        }
      } catch {
        // Non-fatal: skip agents whose cron store can't be read.
      }
    }
    const p = params as {
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
    };
    let filtered = allJobs as (CronJob & { _agentId: string })[];
    if (p.enabled === "enabled") {
      filtered = filtered.filter((j) => j.enabled);
    } else if (p.enabled === "disabled") {
      filtered = filtered.filter((j) => !j.enabled);
    }
    if (p.query) {
      const q = p.query.toLowerCase();
      filtered = filtered.filter(
        (j) => j.name.toLowerCase().includes(q) || j._agentId.toLowerCase().includes(q),
      );
    }
    const sortDir = p.sortDir === "desc" ? -1 : 1;
    const sortBy = p.sortBy ?? "updatedAtMs";
    filtered.sort((a, b) => {
      const av = sortBy === "name" ? a.name : (a.state[sortBy] ?? 0);
      const bv = sortBy === "name" ? b.name : (b.state[sortBy] ?? 0);
      if (av < bv) {return -1 * sortDir;}
      if (av > bv) {return 1 * sortDir;}
      return 0;
    });
    respond(true, { jobs: filtered, total: filtered.length }, undefined);
  },
};
