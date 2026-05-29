import { authorizeTenantMethod, type TenantContext } from "../auth/middleware.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import { consumeControlPlaneWriteBudget } from "./control-plane-rate-limit.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "./role-policy.js";
import { agentHandlers } from "./server-methods/agent.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { authHandlers } from "./server-methods/auth-api.js";
import { browserHandlers } from "./server-methods/browser.js";
import { captchaHandlers } from "./server-methods/captcha-api.js";
import { channelsHandlers } from "./server-methods/channels.js";
import { chatHandlers } from "./server-methods/chat.js";
import { configHandlers } from "./server-methods/config.js";
import { connectHandlers } from "./server-methods/connect.js";
import { cronHandlers } from "./server-methods/cron.js";
import { csAdminHandlers } from "./server-methods/cs-admin.js";
import { csWidgetHandlers } from "./server-methods/cs-widget.js";
import { deviceHandlers } from "./server-methods/devices.js";
import { doctorHandlers } from "./server-methods/doctor.js";
import { execApprovalsHandlers } from "./server-methods/exec-approvals.js";
import { feishuRegisterHandlers } from "./server-methods/feishu-register-api.js";
import { healthHandlers } from "./server-methods/health.js";
import { logsHandlers } from "./server-methods/logs.js";
import { memoryHandlers } from "./server-methods/memory.js";
import { modelsHandlers } from "./server-methods/models.js";
import { nodeHandlers } from "./server-methods/nodes.js";
import { platformModelsHandlers } from "./server-methods/platform-models-api.js";
import { platformOverviewHandlers } from "./server-methods/platform-overview-api.js";
import { platformTenantsHandlers } from "./server-methods/platform-tenants-api.js";
import { pushHandlers } from "./server-methods/push.js";
import { sendHandlers } from "./server-methods/send.js";
import { sessionsHandlers } from "./server-methods/sessions.js";
import { skillsHandlers } from "./server-methods/skills.js";
import { sysToolsHandlers } from "./server-methods/sys-tools-api.js";
import { systemHandlers } from "./server-methods/system.js";
import { talkHandlers } from "./server-methods/talk.js";
import { taskPlanHandlers } from "./server-methods/task-plan.js";
import { tenantAgentsHandlers } from "./server-methods/tenant-agents-api.js";
import { tenantHandlers } from "./server-methods/tenant-api.js";
import { tenantChannelsHandlers } from "./server-methods/tenant-channels-api.js";
import { tenantModelsHandlers } from "./server-methods/tenant-models-api.js";
import { tenantOnboardingHandlers } from "./server-methods/tenant-onboarding-api.js";
import { tenantOverviewHandlers } from "./server-methods/tenant-overview-api.js";
import { tenantSessionsHandlers } from "./server-methods/tenant-sessions-api.js";
import { tenantSettingsHandlers } from "./server-methods/tenant-settings-api.js";
import { tenantTracesHandlers } from "./server-methods/tenant-traces-api.js";
import { tenantUsageHandlers } from "./server-methods/tenant-usage-api.js";
import { toolsCatalogHandlers } from "./server-methods/tools-catalog.js";
import { ttsHandlers } from "./server-methods/tts.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "./server-methods/types.js";
import { updateHandlers } from "./server-methods/update.js";
import { usageHandlers } from "./server-methods/usage.js";
import { voicewakeHandlers } from "./server-methods/voicewake.js";
import { webHandlers } from "./server-methods/web.js";
import { wecomRegisterHandlers } from "./server-methods/wecom-register-api.js";
import { wizardHandlers } from "./server-methods/wizard.js";

/** Auth methods that don't require JWT authentication. */
const AUTH_BYPASS_METHODS = new Set([
  "auth.register",
  "auth.login",
  "auth.refresh",
  "health",
  "captcha.challenge",
]);

const CONTROL_PLANE_WRITE_METHODS = new Set(["config.apply", "config.patch", "update.run"]);
function authorizeGatewayMethod(method: string, client: GatewayRequestOptions["client"]) {
  if (!client?.connect) {
    return null;
  }
  if (method === "health") {
    return null;
  }
  // JWT-authenticated tenant users bypass operator scope checks entirely.
  // Their access is governed by the multi-tenant RBAC layer instead.
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (tenant) {
    return null;
  }
  const roleRaw = client.connect.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
  }
  const scopes = client.connect.scopes ?? [];
  if (!isRoleAuthorizedForMethod(role, method)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return null;
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return null;
  }
  const scopeAuth = authorizeOperatorScopesForMethod(method, scopes);
  if (!scopeAuth.allowed) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
  }
  return null;
}

export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...logsHandlers,
  ...voicewakeHandlers,
  ...healthHandlers,
  ...channelsHandlers,
  ...chatHandlers,
  ...cronHandlers,
  ...deviceHandlers,
  ...doctorHandlers,
  ...execApprovalsHandlers,
  ...webHandlers,
  ...modelsHandlers,
  ...configHandlers,
  ...wizardHandlers,
  ...talkHandlers,
  ...toolsCatalogHandlers,
  ...sysToolsHandlers,
  ...ttsHandlers,
  ...skillsHandlers,
  ...sessionsHandlers,
  ...systemHandlers,
  ...updateHandlers,
  ...nodeHandlers,
  ...pushHandlers,
  ...sendHandlers,
  ...usageHandlers,
  ...agentHandlers,
  ...agentsHandlers,
  ...memoryHandlers,
  ...browserHandlers,
  ...taskPlanHandlers,
  ...authHandlers,
  ...captchaHandlers,
  ...tenantHandlers,
  ...tenantAgentsHandlers,
  ...tenantChannelsHandlers,
  ...feishuRegisterHandlers,
  ...wecomRegisterHandlers,
  ...tenantModelsHandlers,
  ...tenantSettingsHandlers,
  ...tenantSessionsHandlers,
  ...tenantTracesHandlers,
  ...tenantUsageHandlers,
  ...platformOverviewHandlers,
  ...platformModelsHandlers,
  ...platformTenantsHandlers,
  ...tenantOverviewHandlers,
  ...tenantOnboardingHandlers,
  ...csWidgetHandlers,
  ...csAdminHandlers,
};

export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;

  // Skip legacy auth for JWT-authenticated auth endpoints
  if (!AUTH_BYPASS_METHODS.has(req.method)) {
    const authError = authorizeGatewayMethod(req.method, client);
    if (authError) {
      respond(false, undefined, authError);
      return;
    }

    // Multi-tenant RBAC check (if tenant context is present on the client)
    const tenantCtx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (tenantCtx) {
      const tenantAuth = authorizeTenantMethod(req.method, tenantCtx);
      if (!tenantAuth.allowed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, tenantAuth.reason));
        return;
      }
    }
  }
  if (CONTROL_PLANE_WRITE_METHODS.has(req.method)) {
    const budget = consumeControlPlaneWriteBudget({ client });
    if (!budget.allowed) {
      const actor = resolveControlPlaneActor(client);
      context.logGateway.warn(
        `control-plane write rate-limited method=${req.method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
      );
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `rate limit exceeded for ${req.method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
          {
            retryable: true,
            retryAfterMs: budget.retryAfterMs,
            details: {
              method: req.method,
              limit: "3 per 60s",
            },
          },
        ),
      );
      return;
    }
  }
  const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }
  await handler({
    req,
    params: (req.params ?? {}) as Record<string, unknown>,
    client,
    isWebchatConnect,
    respond,
    context,
  });
}
