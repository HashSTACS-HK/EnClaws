import { html, nothing } from "lit";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { t, i18n, isSupportedLocale } from "../i18n/index.ts";
import { refreshChatAvatar } from "./app-chat.ts";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import { renderChatControls, renderTab, renderThemeToggle } from "./app-render.helpers.ts";
import "./components/language-switcher.ts";
import type { AppViewState } from "./app-view-state.ts";
import { isAuthenticated, loadAuth, clearAuth } from "./auth-store.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import {
  deleteAgentKnowledgeFile,
  loadAgentKnowledge,
  loadAgentKnowledgeFileContent,
  loadAgentKnowledgeStatus,
  saveAgentKnowledgeFile,
} from "./controllers/agent-knowledge.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import { loadAgents, loadToolsCatalog } from "./controllers/agents.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config.ts";
import {
  loadCronRuns,
  loadMoreCronJobs,
  loadMoreCronRuns,
  reloadCronJobs,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
  startCronEdit,
  startCronClone,
  cancelCronEdit,
  validateCronForm,
  hasCronFormErrors,
  normalizeCronFormState,
  getVisibleCronJobs,
  updateCronJobsFilter,
  updateCronRunsFilter,
} from "./controllers/cron.ts";
import { loadDebug, callDebugMethod } from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import { loadSandboxTaskPlan } from "./controllers/sandbox.ts";
import { deleteSessionAndRefresh, loadSessions, patchSession } from "./controllers/sessions.ts";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "./external-link.ts";
import { icons } from "./icons.ts";
import { normalizeBasePath, TAB_GROUPS, subtitleForTab, titleForTab } from "./navigation.ts";
import { loadSettings } from "./storage.ts";
import { resolveConfiguredCronModelSuggestions } from "./views/agents-utils.ts";
import { renderAgents } from "./views/agents.ts";
import { renderChannels } from "./views/channels.ts";
import { renderChat } from "./views/chat.ts";
import type { TenantAgentOption } from "./views/chat.ts";
import { renderConfig } from "./views/config.ts";
import { renderCron } from "./views/cron.ts";
import { renderDebug } from "./views/debug.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderInstances } from "./views/instances.ts";
import { renderLogs } from "./views/logs.ts";
import { renderNodes } from "./views/nodes.ts";
import { renderOverview } from "./views/overview.ts";
import { renderSandbox } from "./views/sandbox.ts";
import "./views/login.ts";
import "./views/tenant/tenant-overview.ts";
import "./views/tenant/tenant-settings.ts";
import "./views/tenant/tenant-knowledge.ts";
import "./views/tenant/tenant-users.ts";
import "./views/tenant/tenant-agents.ts";
import "./views/tenant/tenant-channels.ts";
import "./views/tenant/tenant-models.ts";
import "./views/tenant/tenant-skills.ts";
import "./views/tenant/tenant-traces.ts";
import "./views/tenant/tenant-usage.ts";
import "./views/tenant/cs-setup.ts";
import "./views/tenant/cs-sessions.ts";
import "./views/tenant/cs-api-mode.ts";
import "./views/tenant/cs-widget-management.ts";
import "./components/cs-widget.ts";
import "./views/tenant/tenant-cron.ts";
import "./views/platform-overview.ts";
import "./views/platform-tools.ts";
import "./views/platform-models.ts";
import "./views/platform-tenants.ts";
import "./views/onboarding-wizard.ts";
import "./views/auth-phase1.ts";
import "./views/password-expiry-banner.ts";
import "./views/auth-phase3.ts";
import { renderSessions } from "./views/sessions.ts";
import { renderSkills } from "./views/skills.ts";
import { tenantRpc } from "./views/tenant/rpc.ts";

let _cachedTenantAgents: TenantAgentOption[] = [];
let _tenantAgentsLoaded = false;

async function loadTenantAgentsForChat(): Promise<TenantAgentOption[]> {
  if (_tenantAgentsLoaded) {
    return _cachedTenantAgents;
  }
  if (!isAuthenticated()) {
    return [];
  }
  if (loadAuth()?.user?.role === "platform-admin") {
    _tenantAgentsLoaded = true;
    return [];
  }
  try {
    const result = (await tenantRpc("tenant.agents.list")) as {
      agents: Array<{
        agentId: string;
        name: string;
        config?: Record<string, unknown>;
        isActive?: boolean;
      }>;
    };
    _cachedTenantAgents = (result.agents ?? [])
      .filter((a) => a.isActive !== false)
      .map((a) => ({
        agentId: a.agentId,
        name: (a.config?.displayName as string) ?? a.name ?? a.agentId,
      }));
    _tenantAgentsLoaded = true;
  } catch {
    // Not in multi-tenant mode or not authenticated
  }
  return _cachedTenantAgents;
}

/**
 * After tenant agents load for the first time, if the current session key is
 * the default "agent:main:..." (no real agent selected yet), redirect to the
 * first available tenant agent so the browser lands on a real chat session.
 */
function redirectToFirstTenantAgent(state: AppViewState, agents: TenantAgentOption[]) {
  if (agents.length === 0) {
    return;
  }
  const sk = state.sessionKey ?? "";
  const isDefaultSession = !sk || sk === "main" || sk.startsWith("agent:main:");
  // Also redirect if the current session points to an agent that no longer
  // exists (e.g. deleted agent still in localStorage lastActiveSessionKey).
  const agentMatch = sk.match(/^agent:([^:]+):/);
  const currentAgentId = agentMatch?.[1];
  const agentStillExists = currentAgentId && agents.some((a) => a.agentId === currentAgentId);
  if (!isDefaultSession && agentStillExists) {
    return;
  }
  const next = `agent:${agents[0].agentId}:chat`;
  state.sessionKey = next;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.chatQueue = [];
  state.resetToolStream();
  state.resetChatScroll();
  state.sandboxTaskPlan = null;
  state.sandboxTaskPlanLoading = false;
  state.sandboxTaskPlanError = null;
  state.sandboxChatEvents = {};
  state.applySettings({ ...state.settings, sessionKey: next, lastActiveSessionKey: next });
  void state.loadAssistantIdentity();
  void loadChatHistory(state);
  void refreshChatAvatar(state);
}

/** Call when tenant agents change (create/delete) to refresh the cache */
export function invalidateTenantAgentsCache() {
  _tenantAgentsLoaded = false;
  _cachedTenantAgents = [];
}

async function checkTenantNeedsOnboarding(state: AppViewState) {
  try {
    const [agents, models, channels] = await Promise.all([
      tenantRpc("tenant.agents.list") as Promise<{ agents?: unknown[] }>,
      tenantRpc("tenant.models.list") as Promise<{ models?: Array<{ visibility?: string }> }>,
      tenantRpc("tenant.channels.list") as Promise<{ channels?: unknown[] }>,
    ]);
    const privateModels = (models.models ?? []).filter((m) => m.visibility !== "shared");
    const isEmpty = !agents.agents?.length && !privateModels.length && !channels.channels?.length;
    if (isEmpty) {
      state.showOnboarding = true;
    } else {
      state.connect();
    }
  } catch {
    // RPC failed — skip onboarding check, just connect normally
    state.connect();
  }
}

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;
const CRON_THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const CRON_TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeSuggestionValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return identity?.avatarUrl;
}

/** Pending cross-tab navigation target (e.g. from tenant-cron → tenant-agents). */
let _pendingAgentNav: { agentId: string; panel: string } | null = null;
/** Pending cross-tab navigation target (e.g. from tenant-agents → tenant-channels). */
let _pendingChannelNav: { channelType?: string } | null = null;

export function renderApp(state: AppViewState) {
  const enClawsVersion =
    (typeof state.hello?.server?.version === "string" && state.hello.server.version.trim()) ||
    state.updateAvailable?.currentVersion ||
    t("common.na");
  const availableUpdate =
    state.updateAvailable &&
    state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion
      ? state.updateAvailable
      : null;
  const versionStatusClass = availableUpdate ? "warn" : "ok";
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const noAgents = isAuthenticated() && _tenantAgentsLoaded && _cachedTenantAgents.length === 0;
  const agentsLoading = isAuthenticated() && !_tenantAgentsLoaded;
  const chatDisabledReason = noAgents
    ? "请先在【代理管理】中创建并启用一个 Agent，才能开始对话"
    : agentsLoading
      ? "正在加载 Agent 列表…"
      : state.connected
        ? null
        : t("chat.disconnected");
  const COMING_SOON_TABS = new Set([
    "sandbox",
    "nodes",
    "usage",
    "instances",
    "cron",
    "config",
    "debug",
    "scheduler-placeholder",
    "tenant-audit",
    "tenant-workshop",
  ]);
  const isComingSoon = COMING_SOON_TABS.has(state.tab);
  const isChat = state.tab === "chat";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;
  const configValue = state.configForm ?? state.configSnapshot?.config ?? null;
  const basePath = normalizeBasePath(state.basePath ?? "");
  const resolvedAgentId =
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const cronAgentSuggestions = Array.from(
    new Set(
      [
        ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
        ...state.cronJobs
          .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
          .filter(Boolean),
      ].filter(Boolean),
    ),
  ).toSorted((a, b) => a.localeCompare(b));
  const cronModelSuggestions = Array.from(
    new Set(
      [
        ...state.cronModelSuggestions,
        ...resolveConfiguredCronModelSuggestions(configValue),
        ...state.cronJobs
          .map((job) => {
            if (job.payload.kind !== "agentTurn" || typeof job.payload.model !== "string") {
              return "";
            }
            return job.payload.model.trim();
          })
          .filter(Boolean),
      ].filter(Boolean),
    ),
  ).toSorted((a, b) => a.localeCompare(b));
  const visibleCronJobs = getVisibleCronJobs(state);
  const selectedDeliveryChannel =
    state.cronForm.deliveryChannel && state.cronForm.deliveryChannel.trim()
      ? state.cronForm.deliveryChannel.trim()
      : "last";
  const jobToSuggestions = state.cronJobs
    .map((job) => normalizeSuggestionValue(job.delivery?.to))
    .filter(Boolean);
  const accountToSuggestions = (
    selectedDeliveryChannel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[selectedDeliveryChannel] ?? [])
  )
    .flatMap((account) => [
      normalizeSuggestionValue(account.accountId),
      normalizeSuggestionValue(account.name),
    ])
    .filter(Boolean);
  const rawDeliveryToSuggestions = uniquePreserveOrder([
    ...jobToSuggestions,
    ...accountToSuggestions,
  ]);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? rawDeliveryToSuggestions.filter((value) => isHttpUrl(value))
      : rawDeliveryToSuggestions;

  // ---- Global auth gate: require login before accessing the console ----
  // If the user navigates to /login explicitly, clear any stale auth and force re-login.
  if (typeof window !== "undefined" && window.location.pathname === "/login") {
    clearAuth();
  }
  if (!isAuthenticated()) {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      // Preserve the hash (for email reset / temp-password landing pages) and
      // the search string (for session params). A naive replaceState(null, "", "/login")
      // would strip them and break new-tab landings like /#/auth/reset-password?token=xxx.
      const preserved = `/login${window.location.search}${window.location.hash}`;
      window.history.replaceState(null, "", preserved);
    }
    // Phase 1: route to forgot-password / reset-password / temp-password views
    // based on the URL hash. These flows are unauthenticated by design.
    if (typeof window !== "undefined") {
      const hash = window.location.hash || "";
      if (hash.startsWith("#/auth/forgot-password")) {
        return html`<enclaws-forgot-password .gatewayUrl=${state.settings.gatewayUrl}></enclaws-forgot-password>`;
      }
      if (hash.startsWith("#/auth/reset-password")) {
        return html`<enclaws-reset-password .gatewayUrl=${state.settings.gatewayUrl}></enclaws-reset-password>`;
      }
      if (hash.startsWith("#/auth/temp-password")) {
        return html`<enclaws-temp-password-view .gatewayUrl=${state.settings.gatewayUrl}></enclaws-temp-password-view>`;
      }
      if (hash.startsWith("#/auth/verify-email")) {
        return html`<enclaws-verify-email .gatewayUrl=${state.settings.gatewayUrl}></enclaws-verify-email>`;
      }
    }
    return html`<enclaws-login
      .gatewayUrl=${state.settings.gatewayUrl}
      @auth-success=${(e: CustomEvent) => {
        state.applySettings(loadSettings());
        const loc = state.settings.locale;
        if (isSupportedLocale(loc)) {
          void i18n.setLocale(loc);
        }
        // Phase 1: if the user must change their password, force-render the
        // change-password overlay before doing anything else.  Setting any
        // tab triggers a re-render; the next pass hits the fcp branch.
        if (e.detail?.forceChangePassword) {
          state.setTab("tenant-overview");
          return;
        }
        const role = loadAuth()?.user?.role;
        state.setTab(role === "platform-admin" ? "overview" : "tenant-overview");
        if (e.detail?.isNewRegistration) {
          state.showOnboarding = true;
        } else if (role === "platform-admin") {
          state.connect();
        } else {
          // Check if tenant has no resources configured — show onboarding if empty
          checkTenantNeedsOnboarding(state);
        }
      }}
    ></enclaws-login>
    ${(() => {
      if (typeof document === "undefined") {
        return nothing;
      }
      const tid = document.querySelector<HTMLMetaElement>('meta[name="ec-cs-tenant-id"]')?.content;
      return tid ? html`<cs-widget tenant-id=${tid}></cs-widget>` : nothing;
    })()}`;
  }

  // Phase 1: post-login force-change-password overlay (covers invite + admin reset)
  const _auth = loadAuth();
  if (_auth?.user?.forceChangePassword) {
    return html`
      <enclaws-force-change-password></enclaws-force-change-password>
    `;
  }

  // Phase 2: authenticated /change-password route
  if (
    typeof window !== "undefined" &&
    (window.location.hash || "").startsWith("#/auth/change-password")
  ) {
    return html`
      <enclaws-change-password></enclaws-change-password>
    `;
  }
  // Phase 3: authenticated session/security routes
  if (typeof window !== "undefined") {
    const authHash = window.location.hash || "";
    if (authHash.startsWith("#/auth/sessions")) {
      return html`
        <enclaws-sessions-list></enclaws-sessions-list>
      `;
    }
    if (authHash.startsWith("#/auth/mfa-setup")) {
      return html`
        <enclaws-mfa-setup></enclaws-mfa-setup>
      `;
    }
  }

  return html`
      <enclaws-password-expiry-banner></enclaws-password-expiry-banner>
      ${
        state.showOnboarding
          ? html`
        <onboarding-wizard
          .gatewayUrl=${state.settings.gatewayUrl}
          @onboarding-complete=${() => {
            state.showOnboarding = false;
            state.connect();
            // Invalidate tenant agents cache so the chat tab render will
            // reload the list and auto-select the first agent via
            // redirectToFirstTenantAgent.  Do NOT call loadTenantAgentsForChat()
            // here — that would set _tenantAgentsLoaded=true without redirecting,
            // leaving the chat dropdown on "please select agent".
            _tenantAgentsLoaded = false;
            _cachedTenantAgents = [];
            // Delay reload to let channels connect, then remount overview
            setTimeout(() => {
              if (state.tab === "tenant-overview" || state.tab === "overview") {
                const tab = state.tab;
                state.setTab(null as any);
                requestAnimationFrame(() => state.setTab(tab));
              }
            }, 3000);
          }}
        ></onboarding-wizard>
      `
          : nothing
      }
      <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}">
          <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">

              <div class="nav-brand-header">
                  <div class="brand">
                      <div class="brand-logo">
                          <img src="/favicon.svg" alt="EnClaws" />
                      </div>
                      ${
                        !state.settings.navCollapsed
                          ? html`
                                          <div class="brand-text">
                                              <div class="brand-title">EnClaws</div>
                                          </div>
                                          <span class="brand-version-badge">${enClawsVersion !== t("common.na") ? enClawsVersion : "v2"}</span>
                                      `
                          : nothing
                      }
                  </div>
              </div>
              <div class="nav-scroll-area">
              ${TAB_GROUPS.map((group) => {
                // Filter tabs by user role
                const authState = loadAuth();
                const userRole = authState?.user?.role;
                const isPlatformAdmin = userRole === "platform-admin";
                const isTenantAdmin = userRole === "owner" || userRole === "admin";
                const tenantOnlyTabs = new Set([
                  "tenant-settings",
                  "tenant-knowledge",
                  "tenant-users",
                  "tenant-agents",
                  "tenant-channels",
                  "tenant-models",
                  "tenant-skills",
                  "tenant-traces",
                  "tenant-usage",
                  "tenant-cron",
                  "cs-setup",
                  "cs-sessions",
                  "scheduler-placeholder",
                  "tenant-audit",
                  "tenant-workshop",
                  "cs-api-management",
                  "cs-widget-management",
                ]);
                const platformOnlyTabs = new Set([
                  "overview",
                  "platform-models",
                  "platform-tools",
                  "platform-tenants",
                  "logs",
                ]);
                const visibleTabs = group.tabs.filter((tab) => {
                  if (platformOnlyTabs.has(tab)) {
                    return isPlatformAdmin;
                  }
                  if (tenantOnlyTabs.has(tab)) {
                    return isTenantAdmin;
                  }
                  return !isPlatformAdmin; // platform-admin only sees overview
                });
                if (visibleTabs.length === 0) {
                  return nothing;
                }
                if (!group.label) {
                  return html`
                      <div class="nav-group">
                          <div class="nav-group__items">
                              ${visibleTabs.map((tab) => renderTab(state, tab))}
                          </div>
                      </div>
                    `;
                }
                const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                const hasActiveTab = visibleTabs.some((tab) => tab === state.tab);
                return html`
                      <div class="nav-group ${isGroupCollapsed && !hasActiveTab ? "nav-group--collapsed" : ""}">
                          <button
                                  class="nav-label"
                                  @click=${() => {
                                    const next = { ...state.settings.navGroupsCollapsed };
                                    next[group.label] = !isGroupCollapsed;
                                    state.applySettings({
                                      ...state.settings,
                                      navGroupsCollapsed: next,
                                    });
                                  }}
                                  aria-expanded=${!isGroupCollapsed}
                          >
                              <span class="nav-label__text">${t(`nav.${group.label}`)}</span>
                              <span class="nav-label__chevron">${isGroupCollapsed ? "+" : "−"}</span>
                          </button>
                          <div class="nav-group__items">
                              ${visibleTabs.map((tab) => renderTab(state, tab))}
                          </div>
                      </div>
                  `;
              })}
              </div>
              ${(() => {
                const authState = loadAuth();
                if (!authState?.user) {
                  return nothing;
                }
                const goChangePassword = () => {
                  window.location.hash = "#/auth/change-password";
                };
                const doLogout = () => {
                  clearAuth();
                  window.location.reload();
                };
                const displayName = authState.user.displayName || authState.user.email || "";
                const initials = displayName.slice(0, 2).toUpperCase();
                const roleLabel =
                  authState.user.role === "platform-admin"
                    ? "Platform Admin"
                    : authState.user.role === "owner"
                      ? "Owner"
                      : authState.user.role === "admin"
                        ? "Admin"
                        : "Member";
                return html`
                      <div class="nav-user-footer">
                          ${
                            state.settings.navCollapsed
                              ? html`
                                  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
                                      <div class="user-avatar" title=${authState.user.email}>${initials}</div>
                                      <button class="user-action-btn" title=${t("nav.changePasswordTitle")} @click=${goChangePassword}>
                                          <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                      </button>
                                      <button class="user-action-btn" title=${t("nav.logoutTitle")} @click=${doLogout}>
                                          <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                                      </button>
                                  </div>`
                              : html`
                                  <div class="user-row">
                                      <div class="user-avatar" title=${authState.user.email}>${initials}</div>
                                      <div class="user-info">
                                          <div class="user-name">${displayName}</div>
                                          <div class="user-role">${roleLabel}</div>
                                      </div>
                                      <div class="user-actions">
                                          <button class="user-action-btn" title=${t("nav.changePasswordTitle")} @click=${goChangePassword}>
                                              <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                          </button>
                                          <button class="user-action-btn" title=${t("nav.logoutTitle")} @click=${doLogout}>
                                              <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                                          </button>
                                      </div>
                                  </div>`
                          }
                      </div>
                  `;
              })()}
          </aside>
          <div class="page-container">
              <header class="page-header">
                  <div class="header-left">
                      <button
                              type="button"
                              class="nav-collapse-toggle"
                              @click=${() => {
                                if (isChat && state.settings.chatFocusMode) {
                                  state.applySettings({
                                    ...state.settings,
                                    chatFocusMode: false,
                                    navCollapsed: false,
                                  });
                                } else {
                                  state.applySettings({
                                    ...state.settings,
                                    navCollapsed: !state.settings.navCollapsed,
                                  });
                                }
                              }}
                              title="${state.settings.navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                              aria-label="${state.settings.navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                      >
                          <span class="nav-collapse-toggle__icon">${icons.menu}</span>
                      </button>
                      <span class="header-title">${state.tab === "usage" ? "" : titleForTab(state.tab)}</span>
                  </div>
                  <div class="header-right">
                      <language-switcher
                              .locale=${state.settings.locale || i18n.getLocale()}
                              @locale-change=${(e: CustomEvent) => {
                                const loc = e.detail.locale;
                                state.applySettings({ ...state.settings, locale: loc });
                                void i18n.setLocale(loc);
                              }}
                      ></language-switcher>
                      <div class="pill">
                          <span class="statusDot ${versionStatusClass}"></span>
                          <span>${t("common.version")}</span>
                          <span class="mono">${enClawsVersion}</span>
                      </div>
                      <div class="pill">
                          <span class="statusDot ${state.connected ? "ok" : ""}"></span>
                          <span>${t("common.health")}</span>
                          <span class="mono">${state.connected ? t("common.ok") : t("common.offline")}</span>
                      </div>
                      ${renderThemeToggle(state)}
                  </div>
              </header>

              <main class="content ${isChat ? "content--chat" : ""}">
                  ${
                    isChat
                      ? nothing
                      : state.updateMessage || state.updateRunning
                        ? html`
                                      <div class="update-banner callout success" role="alert">
                                          <strong>${state.updateMessage || t("update.updating")}</strong>
                                      </div>`
                        : availableUpdate
                          ? html`
                                      <div class="update-banner callout danger" role="alert">
                                          <strong>${t("update.available")}</strong>
                                          ${
                                            availableUpdate.channel === "git"
                                              ? html`${t("update.commitsBehind", { count: availableUpdate.latestVersion })}`
                                              : html`${t("update.versionInfo", { latest: availableUpdate.latestVersion, current: availableUpdate.currentVersion })}`
                                          }
                                          ${
                                            availableUpdate.downloadUrl
                                              ? html`<a
                                                          class="btn btn--sm update-banner__btn"
                                                          href=${availableUpdate.downloadUrl}
                                                          target="_blank"
                                                          rel="noopener noreferrer"
                                                          style="text-decoration:none"
                                                  >${t("update.downloadInstall")}</a>`
                                              : html`<button
                                                          class="btn btn--sm update-banner__btn"
                                                          ?disabled=${state.updateRunning || !state.connected}
                                                          @click=${() => runUpdate(state)}
                                                  >${state.updateRunning ? t("update.updating") : t("update.updateNow")}
                                                  </button>`
                                          }
                                      </div>`
                          : nothing
                  }
                  <section class="content-header">
                      <div>
                          ${
                            state.tab === "usage"
                              ? nothing
                              : html`
                              <div class="page-sub">${subtitleForTab(state.tab)}</div>`
                          }
                      </div>
                      <div class="page-meta">
                          ${
                            state.lastError
                              ? html`
                              <div class="pill danger">${state.lastError}</div>`
                              : nothing
                          }
                          ${isChat && !isComingSoon ? renderChatControls(state, _cachedTenantAgents.length > 0 ? _cachedTenantAgents : undefined) : nothing}
                      </div>
                  </section>

                  ${
                    isComingSoon
                      ? html`<section class="card"><div style="text-align:center;padding:4rem 2rem;color:var(--text-muted,#525252);font-family:var(--font-sans,system-ui,sans-serif);"><img src="/coming-soon.svg" alt="" style="width:64px;height:64px;margin-bottom:0.75rem;opacity:0.5;" /><p style="font-size:0.85rem;margin:0;">${t("common.comingSoon")}</p></div></section>`
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "overview"
                      ? html`
                                      <platform-overview-view
                                              .gatewayUrl=${state.settings.gatewayUrl}></platform-overview-view>`
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "platform-models"
                      ? html`
                                      <platform-models-view
                                              .gatewayUrl=${state.settings.gatewayUrl}></platform-models-view>`
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "platform-tenants"
                      ? html`
                                      <platform-tenants-view
                                              .gatewayUrl=${state.settings.gatewayUrl}></platform-tenants-view>`
                      : nothing
                  }

                  ${
                    state.tab === "channels"
                      ? renderChannels({
                          connected: state.connected,
                          loading: state.channelsLoading,
                          snapshot: state.channelsSnapshot,
                          lastError: state.channelsError,
                          lastSuccessAt: state.channelsLastSuccess,
                          whatsappMessage: state.whatsappLoginMessage,
                          whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
                          whatsappConnected: state.whatsappLoginConnected,
                          whatsappBusy: state.whatsappBusy,
                          configSchema: state.configSchema,
                          configSchemaLoading: state.configSchemaLoading,
                          configForm: state.configForm,
                          configUiHints: state.configUiHints,
                          configSaving: state.configSaving,
                          configFormDirty: state.configFormDirty,
                          nostrProfileFormState: state.nostrProfileFormState,
                          nostrProfileAccountId: state.nostrProfileAccountId,
                          onRefresh: (probe) => loadChannels(state, probe),
                          onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
                          onWhatsAppWait: () => state.handleWhatsAppWait(),
                          onWhatsAppLogout: () => state.handleWhatsAppLogout(),
                          onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                          onConfigSave: () => state.handleChannelConfigSave(),
                          onConfigReload: () => state.handleChannelConfigReload(),
                          onNostrProfileEdit: (accountId, profile) =>
                            state.handleNostrProfileEdit(accountId, profile),
                          onNostrProfileCancel: () => state.handleNostrProfileCancel(),
                          onNostrProfileFieldChange: (field, value) =>
                            state.handleNostrProfileFieldChange(field, value),
                          onNostrProfileSave: () => state.handleNostrProfileSave(),
                          onNostrProfileImport: () => state.handleNostrProfileImport(),
                          onNostrProfileToggleAdvanced: () =>
                            state.handleNostrProfileToggleAdvanced(),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "instances"
                      ? renderInstances({
                          loading: state.presenceLoading,
                          entries: state.presenceEntries,
                          lastError: state.presenceError,
                          statusMessage: state.presenceStatus,
                          onRefresh: () => loadPresence(state),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "sessions"
                      ? renderSessions({
                          loading: state.sessionsLoading,
                          result: state.sessionsResult,
                          error: state.sessionsError,
                          activeMinutes: state.sessionsFilterActive,
                          limit: state.sessionsFilterLimit,
                          includeGlobal: state.sessionsIncludeGlobal,
                          includeUnknown: state.sessionsIncludeUnknown,
                          basePath: state.basePath,
                          onFiltersChange: (next) => {
                            state.sessionsFilterActive = next.activeMinutes;
                            state.sessionsFilterLimit = next.limit;
                            state.sessionsIncludeGlobal = next.includeGlobal;
                            state.sessionsIncludeUnknown = next.includeUnknown;
                          },
                          onRefresh: () => loadSessions(state),
                          onPatch: (key, patch) => patchSession(state, key, patch),
                          onDelete: (key) => deleteSessionAndRefresh(state, key),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "sandbox"
                      ? renderSandbox({
                          sessionKey: state.sessionKey,
                          loading: state.sessionsLoading,
                          result: state.sessionsResult,
                          error: state.sessionsError,
                          sandboxChatEvents: state.sandboxChatEvents,
                          taskPlan: state.sandboxTaskPlan ?? null,
                          onRefresh: async () => {
                            await loadSessions(state);
                            await loadSandboxTaskPlan(state);
                          },
                          onForceRestart: () => {
                            void state.handleSendChat("/new", { restoreDraft: true });
                          },
                        })
                      : nothing
                  }

                  ${!isComingSoon ? renderUsageTab(state) : nothing}

                  ${
                    !isComingSoon && state.tab === "cron"
                      ? renderCron({
                          basePath: state.basePath,
                          loading: state.cronLoading,
                          jobsLoadingMore: state.cronJobsLoadingMore,
                          status: state.cronStatus,
                          jobs: visibleCronJobs,
                          jobsTotal: state.cronJobsTotal,
                          jobsHasMore: state.cronJobsHasMore,
                          jobsQuery: state.cronJobsQuery,
                          jobsEnabledFilter: state.cronJobsEnabledFilter,
                          jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
                          jobsLastStatusFilter: state.cronJobsLastStatusFilter,
                          jobsSortBy: state.cronJobsSortBy,
                          jobsSortDir: state.cronJobsSortDir,
                          error: state.cronError,
                          busy: state.cronBusy,
                          form: state.cronForm,
                          fieldErrors: state.cronFieldErrors,
                          canSubmit: !hasCronFormErrors(state.cronFieldErrors),
                          editingJobId: state.cronEditingJobId,
                          channels: state.channelsSnapshot?.channelMeta?.length
                            ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                            : (state.channelsSnapshot?.channelOrder ?? []),
                          channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                          channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                          runsJobId: state.cronRunsJobId,
                          runs: state.cronRuns,
                          runsTotal: state.cronRunsTotal,
                          runsHasMore: state.cronRunsHasMore,
                          runsLoadingMore: state.cronRunsLoadingMore,
                          runsScope: state.cronRunsScope,
                          runsStatuses: state.cronRunsStatuses,
                          runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
                          runsStatusFilter: state.cronRunsStatusFilter,
                          runsQuery: state.cronRunsQuery,
                          runsSortDir: state.cronRunsSortDir,
                          agentSuggestions: cronAgentSuggestions,
                          modelSuggestions: cronModelSuggestions,
                          thinkingSuggestions: CRON_THINKING_SUGGESTIONS,
                          timezoneSuggestions: CRON_TIMEZONE_SUGGESTIONS,
                          deliveryToSuggestions,
                          onFormChange: (patch) => {
                            state.cronForm = normalizeCronFormState({
                              ...state.cronForm,
                              ...patch,
                            });
                            state.cronFieldErrors = validateCronForm(state.cronForm);
                          },
                          onRefresh: () => state.loadCron(),
                          onAdd: () => addCronJob(state),
                          onEdit: (job) => startCronEdit(state, job),
                          onClone: (job) => startCronClone(state, job),
                          onCancelEdit: () => cancelCronEdit(state),
                          onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
                          onRun: (job) => runCronJob(state, job),
                          onRemove: (job) => removeCronJob(state, job),
                          onLoadRuns: async (jobId) => {
                            updateCronRunsFilter(state, { cronRunsScope: "job" });
                            await loadCronRuns(state, jobId);
                          },
                          onLoadMoreJobs: () => loadMoreCronJobs(state),
                          onJobsFiltersChange: async (patch) => {
                            updateCronJobsFilter(state, patch);
                            const shouldReload =
                              typeof patch.cronJobsQuery === "string" ||
                              Boolean(patch.cronJobsEnabledFilter) ||
                              Boolean(patch.cronJobsSortBy) ||
                              Boolean(patch.cronJobsSortDir);
                            if (shouldReload) {
                              await reloadCronJobs(state);
                            }
                          },
                          onJobsFiltersReset: async () => {
                            updateCronJobsFilter(state, {
                              cronJobsQuery: "",
                              cronJobsEnabledFilter: "all",
                              cronJobsScheduleKindFilter: "all",
                              cronJobsLastStatusFilter: "all",
                              cronJobsSortBy: "nextRunAtMs",
                              cronJobsSortDir: "asc",
                            });
                            await reloadCronJobs(state);
                          },
                          onLoadMoreRuns: () => loadMoreCronRuns(state),
                          onRunsFiltersChange: async (patch) => {
                            updateCronRunsFilter(state, patch);
                            if (state.cronRunsScope === "all") {
                              await loadCronRuns(state, null);
                              return;
                            }
                            await loadCronRuns(state, state.cronRunsJobId);
                          },
                        })
                      : nothing
                  }

                  ${
                    state.tab === "agents"
                      ? renderAgents({
                          loading: state.agentsLoading,
                          error: state.agentsError,
                          agentsList: state.agentsList,
                          selectedAgentId: resolvedAgentId,
                          activePanel: state.agentsPanel,
                          configForm: configValue,
                          configLoading: state.configLoading,
                          configSaving: state.configSaving,
                          configDirty: state.configFormDirty,
                          channelsLoading: state.channelsLoading,
                          channelsError: state.channelsError,
                          channelsSnapshot: state.channelsSnapshot,
                          channelsLastSuccess: state.channelsLastSuccess,
                          cronLoading: state.cronLoading,
                          cronStatus: state.cronStatus,
                          cronJobs: state.cronJobs,
                          cronError: state.cronError,
                          agentFilesLoading: state.agentFilesLoading,
                          agentFilesError: state.agentFilesError,
                          agentFilesList: state.agentFilesList,
                          agentFileActive: state.agentFileActive,
                          agentFileContents: state.agentFileContents,
                          agentFileDrafts: state.agentFileDrafts,
                          agentFileSaving: state.agentFileSaving,
                          agentKnowledgeLoading: state.agentKnowledgeLoading,
                          agentKnowledgeError: state.agentKnowledgeError,
                          agentKnowledgeList: state.agentKnowledgeList,
                          agentKnowledgeStatus: state.agentKnowledgeStatus,
                          agentKnowledgeFileContents: state.agentKnowledgeFileContents,
                          agentKnowledgeFileDrafts: state.agentKnowledgeFileDrafts,
                          agentKnowledgeFileActive: state.agentKnowledgeFileActive,
                          agentKnowledgeSaving: state.agentKnowledgeSaving,
                          agentIdentityLoading: state.agentIdentityLoading,
                          agentIdentityError: state.agentIdentityError,
                          agentIdentityById: state.agentIdentityById,
                          agentSkillsLoading: state.agentSkillsLoading,
                          agentSkillsReport: state.agentSkillsReport,
                          agentSkillsError: state.agentSkillsError,
                          agentSkillsAgentId: state.agentSkillsAgentId,
                          toolsCatalogLoading: state.toolsCatalogLoading,
                          toolsCatalogError: state.toolsCatalogError,
                          toolsCatalogResult: state.toolsCatalogResult,
                          skillsFilter: state.skillsFilter,
                          onRefresh: async () => {
                            await loadAgents(state);
                            const nextSelected =
                              state.agentsSelectedId ??
                              state.agentsList?.defaultId ??
                              state.agentsList?.agents?.[0]?.id ??
                              null;
                            await loadToolsCatalog(state, nextSelected);
                            const agentIds =
                              state.agentsList?.agents?.map((entry) => entry.id) ?? [];
                            if (agentIds.length > 0) {
                              void loadAgentIdentities(state, agentIds);
                            }
                          },
                          onSelectAgent: (agentId) => {
                            if (state.agentsSelectedId === agentId) {
                              return;
                            }
                            state.agentsSelectedId = agentId;
                            state.agentFilesList = null;
                            state.agentFilesError = null;
                            state.agentFilesLoading = false;
                            state.agentFileActive = null;
                            state.agentFileContents = {};
                            state.agentFileDrafts = {};
                            state.agentKnowledgeList = null;
                            state.agentKnowledgeStatus = null;
                            state.agentKnowledgeError = null;
                            state.agentKnowledgeLoading = false;
                            state.agentKnowledgeFileActive = null;
                            state.agentKnowledgeFileContents = {};
                            state.agentKnowledgeFileDrafts = {};
                            state.agentSkillsReport = null;
                            state.agentSkillsError = null;
                            state.agentSkillsAgentId = null;
                            void loadAgentIdentity(state, agentId);
                            if (state.agentsPanel === "tools") {
                              void loadToolsCatalog(state, agentId);
                            }
                            if (state.agentsPanel === "files") {
                              void loadAgentFiles(state, agentId);
                            }
                            if (state.agentsPanel === "knowledge") {
                              void loadAgentKnowledge(state, agentId);
                              void loadAgentKnowledgeStatus(state, agentId);
                            }
                            if (state.agentsPanel === "skills") {
                              void loadAgentSkills(state, agentId);
                            }
                          },
                          onSelectPanel: (panel) => {
                            state.agentsPanel = panel;
                            if ((panel === "files" || panel === "persona") && resolvedAgentId) {
                              if (state.agentFilesList?.agentId !== resolvedAgentId) {
                                state.agentFilesList = null;
                                state.agentFilesError = null;
                                state.agentFileActive = null;
                                state.agentFileContents = {};
                                state.agentFileDrafts = {};
                                void loadAgentFiles(state, resolvedAgentId);
                              }
                            }
                            if (panel === "knowledge" && resolvedAgentId) {
                              if (state.agentKnowledgeList?.agentId !== resolvedAgentId) {
                                state.agentKnowledgeList = null;
                                state.agentKnowledgeStatus = null;
                                state.agentKnowledgeError = null;
                                state.agentKnowledgeFileActive = null;
                                state.agentKnowledgeFileContents = {};
                                state.agentKnowledgeFileDrafts = {};
                                void loadAgentKnowledge(state, resolvedAgentId);
                                void loadAgentKnowledgeStatus(state, resolvedAgentId);
                              }
                            }
                            if (panel === "tools") {
                              void loadToolsCatalog(state, resolvedAgentId);
                            }
                            if (panel === "skills") {
                              if (resolvedAgentId) {
                                void loadAgentSkills(state, resolvedAgentId);
                              }
                            }
                            if (panel === "channels") {
                              void loadChannels(state, false);
                            }
                            if (panel === "cron") {
                              void state.loadCron();
                            }
                          },
                          onLoadFiles: (agentId) => loadAgentFiles(state, agentId),
                          onSelectFile: (name) => {
                            state.agentFileActive = name || null;
                            if (!resolvedAgentId || !name) {
                              return;
                            }
                            void loadAgentFileContent(state, resolvedAgentId, name);
                          },
                          onFileDraftChange: (name, content) => {
                            state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
                          },
                          onFileReset: (name) => {
                            const base = state.agentFileContents[name] ?? "";
                            state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
                          },
                          onFileSave: (name) => {
                            if (!resolvedAgentId) {
                              return;
                            }
                            const content =
                              state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
                            void saveAgentFile(state, resolvedAgentId, name, content);
                          },
                          onKnowledgeLoadFiles: (agentId) => {
                            void loadAgentKnowledge(state, agentId);
                            void loadAgentKnowledgeStatus(state, agentId);
                          },
                          onKnowledgeSelectFile: (name) => {
                            state.agentKnowledgeFileActive = name;
                            if (!resolvedAgentId) {
                              return;
                            }
                            void loadAgentKnowledgeFileContent(state, resolvedAgentId, name);
                          },
                          onKnowledgeFileDraftChange: (name, content) => {
                            state.agentKnowledgeFileDrafts = {
                              ...state.agentKnowledgeFileDrafts,
                              [name]: content,
                            };
                          },
                          onKnowledgeFileReset: (name) => {
                            const base = state.agentKnowledgeFileContents[name] ?? "";
                            state.agentKnowledgeFileDrafts = {
                              ...state.agentKnowledgeFileDrafts,
                              [name]: base,
                            };
                          },
                          onKnowledgeFileSave: (name) => {
                            if (!resolvedAgentId) {
                              return;
                            }
                            const content =
                              state.agentKnowledgeFileDrafts[name] ??
                              state.agentKnowledgeFileContents[name] ??
                              "";
                            void saveAgentKnowledgeFile(state, resolvedAgentId, name, content);
                          },
                          onKnowledgeFileDelete: (name) => {
                            if (!resolvedAgentId) {
                              return;
                            }
                            void deleteAgentKnowledgeFile(state, resolvedAgentId, name);
                          },
                          onToolsProfileChange: (agentId, profile, clearAllow) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            const basePath = ["agents", "list", index, "tools"];
                            if (profile) {
                              updateConfigFormValue(state, [...basePath, "profile"], profile);
                            } else {
                              removeConfigFormValue(state, [...basePath, "profile"]);
                            }
                            if (clearAllow) {
                              removeConfigFormValue(state, [...basePath, "allow"]);
                            }
                          },
                          onToolsOverridesChange: (agentId, alsoAllow, deny) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            const basePath = ["agents", "list", index, "tools"];
                            if (alsoAllow.length > 0) {
                              updateConfigFormValue(state, [...basePath, "alsoAllow"], alsoAllow);
                            } else {
                              removeConfigFormValue(state, [...basePath, "alsoAllow"]);
                            }
                            if (deny.length > 0) {
                              updateConfigFormValue(state, [...basePath, "deny"], deny);
                            } else {
                              removeConfigFormValue(state, [...basePath, "deny"]);
                            }
                          },
                          onConfigReload: () => loadConfig(state),
                          onConfigSave: () => saveConfig(state),
                          onChannelsRefresh: () => loadChannels(state, false),
                          onCronRefresh: () => state.loadCron(),
                          onSkillsFilterChange: (next) => (state.skillsFilter = next),
                          onSkillsRefresh: () => {
                            if (resolvedAgentId) {
                              void loadAgentSkills(state, resolvedAgentId);
                            }
                          },
                          onAgentSkillToggle: (agentId, skillName, enabled) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            const entry = list[index] as { skills?: unknown };
                            const normalizedSkill = skillName.trim();
                            if (!normalizedSkill) {
                              return;
                            }
                            const allSkills =
                              state.agentSkillsReport?.skills
                                ?.map((skill) => skill.name)
                                .filter(Boolean) ?? [];
                            const existing = Array.isArray(entry.skills)
                              ? entry.skills.map((name) => String(name).trim()).filter(Boolean)
                              : undefined;
                            const base = existing ?? allSkills;
                            const next = new Set(base);
                            if (enabled) {
                              next.add(normalizedSkill);
                            } else {
                              next.delete(normalizedSkill);
                            }
                            updateConfigFormValue(
                              state,
                              ["agents", "list", index, "skills"],
                              [...next],
                            );
                          },
                          onAgentSkillsClear: (agentId) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            removeConfigFormValue(state, ["agents", "list", index, "skills"]);
                          },
                          onAgentSkillsDisableAll: (agentId) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
                          },
                          onModelChange: (agentId, modelId) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            const basePath = ["agents", "list", index, "model"];
                            if (!modelId) {
                              removeConfigFormValue(state, basePath);
                              return;
                            }
                            const entry = list[index] as { model?: unknown };
                            const existing = entry?.model;
                            if (
                              existing &&
                              typeof existing === "object" &&
                              !Array.isArray(existing)
                            ) {
                              const fallbacks = (existing as { fallbacks?: unknown }).fallbacks;
                              const next = {
                                primary: modelId,
                                ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
                              };
                              updateConfigFormValue(state, basePath, next);
                            } else {
                              updateConfigFormValue(state, basePath, modelId);
                            }
                          },
                          onModelFallbacksChange: (agentId, fallbacks) => {
                            if (!configValue) {
                              return;
                            }
                            const list = (configValue as { agents?: { list?: unknown[] } }).agents
                              ?.list;
                            if (!Array.isArray(list)) {
                              return;
                            }
                            const index = list.findIndex(
                              (entry) =>
                                entry &&
                                typeof entry === "object" &&
                                "id" in entry &&
                                (entry as { id?: string }).id === agentId,
                            );
                            if (index < 0) {
                              return;
                            }
                            const basePath = ["agents", "list", index, "model"];
                            const entry = list[index] as { model?: unknown };
                            const normalized = fallbacks.map((name) => name.trim()).filter(Boolean);
                            const existing = entry.model;
                            const resolvePrimary = () => {
                              if (typeof existing === "string") {
                                return existing.trim() || null;
                              }
                              if (
                                existing &&
                                typeof existing === "object" &&
                                !Array.isArray(existing)
                              ) {
                                const primary = (existing as { primary?: unknown }).primary;
                                if (typeof primary === "string") {
                                  const trimmed = primary.trim();
                                  return trimmed || null;
                                }
                              }
                              return null;
                            };
                            const primary = resolvePrimary();
                            if (normalized.length === 0) {
                              if (primary) {
                                updateConfigFormValue(state, basePath, primary);
                              } else {
                                removeConfigFormValue(state, basePath);
                              }
                              return;
                            }
                            const next = primary
                              ? { primary, fallbacks: normalized }
                              : { fallbacks: normalized };
                            updateConfigFormValue(state, basePath, next);
                          },
                        })
                      : nothing
                  }

                  ${
                    state.tab === "skills"
                      ? renderSkills({
                          loading: state.skillsLoading,
                          report: state.skillsReport,
                          error: state.skillsError,
                          filter: state.skillsFilter,
                          edits: state.skillEdits,
                          messages: state.skillMessages,
                          busyKey: state.skillsBusyKey,
                          onFilterChange: (next) => (state.skillsFilter = next),
                          onRefresh: () => loadSkills(state, { clearMessages: true }),
                          onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
                          onEdit: (key, value) => updateSkillEdit(state, key, value),
                          onSaveKey: (key) => saveSkillApiKey(state, key),
                          onInstall: (skillKey, name, installId) =>
                            installSkill(state, skillKey, name, installId),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "nodes"
                      ? renderNodes({
                          loading: state.nodesLoading,
                          nodes: state.nodes,
                          devicesLoading: state.devicesLoading,
                          devicesError: state.devicesError,
                          devicesList: state.devicesList,
                          configForm: state.configForm ?? state.configSnapshot?.config ?? null,
                          configLoading: state.configLoading,
                          configSaving: state.configSaving,
                          configDirty: state.configFormDirty,
                          configFormMode: state.configFormMode,
                          execApprovalsLoading: state.execApprovalsLoading,
                          execApprovalsSaving: state.execApprovalsSaving,
                          execApprovalsDirty: state.execApprovalsDirty,
                          execApprovalsSnapshot: state.execApprovalsSnapshot,
                          execApprovalsForm: state.execApprovalsForm,
                          execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                          execApprovalsTarget: state.execApprovalsTarget,
                          execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                          onRefresh: () => loadNodes(state),
                          onDevicesRefresh: () => loadDevices(state),
                          onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
                          onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
                          onDeviceRotate: (deviceId, role, scopes) =>
                            rotateDeviceToken(state, { deviceId, role, scopes }),
                          onDeviceRevoke: (deviceId, role) =>
                            revokeDeviceToken(state, { deviceId, role }),
                          onLoadConfig: () => loadConfig(state),
                          onLoadExecApprovals: () => {
                            const target =
                              state.execApprovalsTarget === "node" &&
                              state.execApprovalsTargetNodeId
                                ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                                : { kind: "gateway" as const };
                            return loadExecApprovals(state, target);
                          },
                          onBindDefault: (nodeId) => {
                            if (nodeId) {
                              updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                            } else {
                              removeConfigFormValue(state, ["tools", "exec", "node"]);
                            }
                          },
                          onBindAgent: (agentIndex, nodeId) => {
                            const basePath = [
                              "agents",
                              "list",
                              agentIndex,
                              "tools",
                              "exec",
                              "node",
                            ];
                            if (nodeId) {
                              updateConfigFormValue(state, basePath, nodeId);
                            } else {
                              removeConfigFormValue(state, basePath);
                            }
                          },
                          onSaveBindings: () => saveConfig(state),
                          onExecApprovalsTargetChange: (kind, nodeId) => {
                            state.execApprovalsTarget = kind;
                            state.execApprovalsTargetNodeId = nodeId;
                            state.execApprovalsSnapshot = null;
                            state.execApprovalsForm = null;
                            state.execApprovalsDirty = false;
                            state.execApprovalsSelectedAgent = null;
                          },
                          onExecApprovalsSelectAgent: (agentId) => {
                            state.execApprovalsSelectedAgent = agentId;
                          },
                          onExecApprovalsPatch: (path, value) =>
                            updateExecApprovalsFormValue(state, path, value),
                          onExecApprovalsRemove: (path) =>
                            removeExecApprovalsFormValue(state, path),
                          onSaveExecApprovals: () => {
                            const target =
                              state.execApprovalsTarget === "node" &&
                              state.execApprovalsTargetNodeId
                                ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                                : { kind: "gateway" as const };
                            return saveExecApprovals(state, target);
                          },
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "chat"
                      ? (isAuthenticated() &&
                          !_tenantAgentsLoaded &&
                          void loadTenantAgentsForChat().then((agents) =>
                            redirectToFirstTenantAgent(state, agents),
                          ),
                        renderChat({
                          sessionKey: state.sessionKey,
                          tenantAgents:
                            _cachedTenantAgents.length > 0 ? _cachedTenantAgents : undefined,
                          onSessionKeyChange: (next) => {
                            state.sessionKey = next;
                            state.chatMessage = "";
                            state.chatAttachments = [];
                            state.chatStream = null;
                            state.chatStreamStartedAt = null;
                            state.chatRunId = null;
                            state.chatQueue = [];
                            state.resetToolStream();
                            state.resetChatScroll();
                            state.sandboxTaskPlan = null;
                            state.sandboxTaskPlanLoading = false;
                            state.sandboxTaskPlanError = null;
                            state.sandboxChatEvents = {};
                            state.applySettings({
                              ...state.settings,
                              sessionKey: next,
                              lastActiveSessionKey: next,
                            });
                            void state.loadAssistantIdentity();
                            void loadChatHistory(state);
                            void refreshChatAvatar(state);
                          },
                          thinkingLevel: state.chatThinkingLevel,
                          showThinking,
                          loading: state.chatLoading,
                          sending: state.chatSending,
                          compactionStatus: state.compactionStatus,
                          fallbackStatus: state.fallbackStatus,
                          assistantAvatarUrl: chatAvatarUrl,
                          messages: state.chatMessages,
                          toolMessages: state.chatToolMessages,
                          stream: state.chatStream,
                          streamThinking: state.chatStreamThinking,
                          streamStartedAt: state.chatStreamStartedAt,
                          draft: state.chatMessage,
                          queue: state.chatQueue,
                          connected: state.connected && !noAgents && !agentsLoading,
                          canSend: state.connected && !noAgents && !agentsLoading,
                          disabledReason: chatDisabledReason,
                          error: state.lastError,
                          sessions: state.sessionsResult,
                          focusMode: chatFocus,
                          taskPlan: state.sandboxTaskPlan ?? null,
                          onRefresh: () => {
                            state.resetToolStream();
                            return Promise.all([loadChatHistory(state), refreshChatAvatar(state)]);
                          },
                          onToggleFocusMode: () => {
                            if (state.onboarding) {
                              return;
                            }
                            state.applySettings({
                              ...state.settings,
                              chatFocusMode: !state.settings.chatFocusMode,
                            });
                          },
                          onChatScroll: (event) => state.handleChatScroll(event),
                          onDraftChange: (next) => (state.chatMessage = next),
                          attachments: state.chatAttachments,
                          onAttachmentsChange: (next) => (state.chatAttachments = next),
                          onSend: () => state.handleSendChat(),
                          canAbort: Boolean(state.chatRunId),
                          onAbort: () => void state.handleAbortChat(),
                          onQueueRemove: (id) => state.removeQueuedMessage(id),
                          onNewSession: () => state.handleSendChat("/new", { restoreDraft: true }),
                          showNewMessages:
                            state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
                          onScrollToBottom: () => state.scrollToBottom(),
                          // Sidebar props for tool output viewing
                          sidebarOpen: state.sidebarOpen,
                          sidebarContent: state.sidebarContent,
                          sidebarError: state.sidebarError,
                          splitRatio: state.splitRatio,
                          onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
                          onCloseSidebar: () => state.handleCloseSidebar(),
                          onSplitRatioChange: (ratio: number) =>
                            state.handleSplitRatioChange(ratio),
                          assistantName: state.assistantName,
                          assistantAvatar: state.assistantAvatar,
                          webSearchEnabled: state.chatWebSearchEnabled,
                          onToggleWebSearch: (enabled: boolean) =>
                            state.handleToggleWebSearch(enabled),
                          onApprovePlan: () => {
                            state.chatMessage = "已批准计划，请开始执行";
                            void state.handleSendChat();
                          },
                          sandboxChatEvents: state.sandboxChatEvents,
                          sandboxSessions: state.sessionsResult?.sessions?.filter(
                            (r) => r.kind !== "global" && !r.systemSent,
                          ),
                        }))
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "config"
                      ? renderConfig({
                          raw: state.configRaw,
                          originalRaw: state.configRawOriginal,
                          valid: state.configValid,
                          issues: state.configIssues,
                          loading: state.configLoading,
                          saving: state.configSaving,
                          applying: state.configApplying,
                          updating: state.updateRunning,
                          connected: state.connected,
                          schema: state.configSchema,
                          schemaLoading: state.configSchemaLoading,
                          uiHints: state.configUiHints,
                          formMode: state.configFormMode,
                          formValue: state.configForm,
                          originalValue: state.configFormOriginal,
                          searchQuery: state.configSearchQuery,
                          activeSection: state.configActiveSection,
                          activeSubsection: state.configActiveSubsection,
                          onRawChange: (next) => {
                            state.configRaw = next;
                          },
                          onFormModeChange: (mode) => (state.configFormMode = mode),
                          onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                          onSearchChange: (query) => (state.configSearchQuery = query),
                          onSectionChange: (section) => {
                            state.configActiveSection = section;
                            state.configActiveSubsection = null;
                          },
                          onSubsectionChange: (section) => (state.configActiveSubsection = section),
                          onReload: () => loadConfig(state),
                          onSave: () => saveConfig(state),
                          onApply: () => applyConfig(state),
                          onUpdate: () => runUpdate(state),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon && state.tab === "debug"
                      ? renderDebug({
                          loading: state.debugLoading,
                          status: state.debugStatus,
                          health: state.debugHealth,
                          models: state.debugModels,
                          heartbeat: state.debugHeartbeat,
                          eventLog: state.eventLog,
                          callMethod: state.debugCallMethod,
                          callParams: state.debugCallParams,
                          callResult: state.debugCallResult,
                          callError: state.debugCallError,
                          onCallMethodChange: (next) => (state.debugCallMethod = next),
                          onCallParamsChange: (next) => (state.debugCallParams = next),
                          onRefresh: () => loadDebug(state),
                          onCall: () => callDebugMethod(state),
                        })
                      : nothing
                  }

                  ${
                    !isComingSoon &&
                    (state.tab === "tenant-overview" ||
                      state.tab === "tenant-settings" ||
                      state.tab === "tenant-knowledge" ||
                      state.tab === "tenant-users" ||
                      state.tab === "tenant-agents" ||
                      state.tab === "tenant-channels" ||
                      state.tab === "tenant-models" ||
                      state.tab === "tenant-skills" ||
                      state.tab === "tenant-traces" ||
                      state.tab === "tenant-usage" ||
                      state.tab === "tenant-cron" ||
                      state.tab === "cs-setup" ||
                      state.tab === "cs-sessions" ||
                      state.tab === "cs-api-management" ||
                      state.tab === "cs-widget-management")
                      ? html`
                                      <section class="card">
                                          ${
                                            state.tab === "tenant-overview"
                                              ? html`
                                              <tenant-overview-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-overview-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-settings"
                                              ? html`
                                              <tenant-settings-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-settings-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-knowledge"
                                              ? html`
                                                  <tenant-knowledge-view></tenant-knowledge-view>
                                                `
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-users"
                                              ? html`
                                              <tenant-users-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-users-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-agents"
                                              ? (() => {
                                                  const nav = _pendingAgentNav;
                                                  if (nav) {
                                                    _pendingAgentNav = null;
                                                  }
                                                  return html`
                                              <tenant-agents-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}
                                                      .initialAgentId=${nav?.agentId ?? null}
                                                      .initialPanel=${nav?.panel ?? null}
                                                      @navigate-to-channel=${(
                                                        e: CustomEvent<{ channelType: string }>,
                                                      ) => {
                                                        _pendingChannelNav = {
                                                          channelType: e.detail.channelType,
                                                        };
                                                        state.setTab("tenant-channels" as any);
                                                      }}></tenant-agents-view>`;
                                                })()
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-channels"
                                              ? (() => {
                                                  _pendingChannelNav = null;
                                                  return html`
                                              <tenant-channels-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}
                                                      @navigate-to-agent=${(
                                                        e: CustomEvent<{ agentId: string }>,
                                                      ) => {
                                                        _pendingAgentNav = {
                                                          agentId: e.detail.agentId,
                                                          panel: "channels",
                                                        };
                                                        state.setTab("tenant-agents" as any);
                                                      }}></tenant-channels-view>`;
                                                })()
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-models"
                                              ? html`
                                              <tenant-models-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-models-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-skills"
                                              ? html`
                                              <tenant-skills-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-skills-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-traces"
                                              ? html`
                                              <tenant-traces-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-traces-view>`
                                              : nothing
                                          }
                                          ${
                                            !isComingSoon && state.tab === "tenant-usage"
                                              ? html`
                                              <tenant-usage-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}></tenant-usage-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "tenant-cron"
                                              ? html`
                                              <tenant-cron-view
                                                      .gatewayUrl=${state.settings.gatewayUrl}
                                                      @navigate-to-agent-cron=${(
                                                        e: CustomEvent<{ agentId: string }>,
                                                      ) => {
                                                        _pendingAgentNav = {
                                                          agentId: e.detail.agentId,
                                                          panel: "cron",
                                                        };
                                                        state.setTab("tenant-agents" as any);
                                                      }}></tenant-cron-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "cs-setup"
                                              ? html`
                                              <cs-setup-view .gatewayUrl=${state.settings.gatewayUrl}></cs-setup-view>`
                                              : nothing
                                          }
                                          ${
                                            state.tab === "cs-sessions"
                                              ? html`
                                                  <cs-sessions-view></cs-sessions-view>
                                                `
                                              : nothing
                                          }
                                          ${
                                            state.tab === "cs-api-management"
                                              ? html`
                                                  <cs-api-mode-view
                                                    .gatewayUrl=${state.settings.gatewayUrl}
                                                  ></cs-api-mode-view>
                                                `
                                              : nothing
                                          }
                                          ${
                                            state.tab === "cs-widget-management"
                                              ? html`
                                                  <cs-widget-management-view
                                                    .gatewayUrl=${state.settings.gatewayUrl}
                                                  ></cs-widget-management-view>
                                                `
                                              : nothing
                                          }
                                      </section>`
                      : nothing
                  }

                  ${
                    state.tab === "platform-tools"
                      ? html`
                          <section class="card"><platform-tools-view></platform-tools-view></section>
                        `
                      : nothing
                  }

                  ${
                    state.tab === "logs"
                      ? renderLogs({
                          loading: state.logsLoading,
                          error: state.logsError,
                          file: state.logsFile,
                          entries: state.logsEntries,
                          filterText: state.logsFilterText,
                          levelFilters: state.logsLevelFilters,
                          autoFollow: state.logsAutoFollow,
                          truncated: state.logsTruncated,
                          onFilterTextChange: (next) => (state.logsFilterText = next),
                          onLevelToggle: (level, enabled) => {
                            state.logsLevelFilters = {
                              ...state.logsLevelFilters,
                              [level]: enabled,
                            };
                          },
                          onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                          onRefresh: () => loadLogs(state, { reset: true }),
                          onExport: (lines, label) => state.exportLogs(lines, label),
                          onScroll: (event) => state.handleLogsScroll(event),
                        })
                      : nothing
                  }
              </main>
          </div>
          ${renderExecApprovalPrompt(state)}
          ${renderGatewayUrlConfirmation(state)}
          ${(() => {
            if (typeof document === "undefined") {
              return nothing;
            }
            const tid = document.querySelector<HTMLMetaElement>(
              'meta[name="ec-cs-tenant-id"]',
            )?.content;
            return tid ? html`<cs-widget tenant-id=${tid}></cs-widget>` : nothing;
          })()}
      </div>
  `;
}
