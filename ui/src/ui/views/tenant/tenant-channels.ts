/**
 * Tenant channel management view.
 *
 * Create, edit, and delete channels with structured app configs.
 * Each app can be bound to an existing agent from the Agent Management page.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { CHANNEL_TYPES, CHANNEL_ICON_MAP } from "../../../constants/channels.ts";
import { t, I18nController } from "../../../i18n/index.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { pathForTab, inferBasePathFromPathname } from "../../navigation.ts";
import { caretFix } from "../../shared-styles.ts";
import feishuScopes from "./feishu-scopes.json";
import { tenantRpc, quotaErrorKey } from "./rpc.ts";

type ChannelPolicy = "open" | "allowlist" | "disabled";

interface ChannelAppAgent {
  agentId: string;
  name: string | null;
  config: Record<string, unknown>;
  isActive: boolean;
}

interface AgentOption {
  agentId: string;
  name: string;
}

interface AppConnectionStatus {
  state?: "online" | "offline" | "connecting";
  connected: boolean;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastError: string | null;
}

interface ChannelApp {
  id?: string;
  appId: string;
  appSecret: string;
  botName: string;
  groupPolicy: ChannelPolicy;
  isActive?: boolean;
  connectionStatus?: AppConnectionStatus | null;
  agent: ChannelAppAgent | null;
  // Form-only: selected agent binding
  formAgentBinding?: string;
  // Feishu registration form state
  feishuMode?: "scan" | "manual";
  feishuDeviceCode?: string;
  feishuVerificationUrl?: string;
  feishuPolling?: boolean;
  feishuPollTimer?: ReturnType<typeof setInterval>;
  feishuDomain?: string;
  feishuEnv?: string;
  // WeCom registration form state
  wecomMode?: "scan" | "manual";
  wecomScode?: string;
  wecomVerificationUrl?: string;
  wecomQrPageUrl?: string;
  wecomPolling?: boolean;
  wecomPollTimer?: ReturnType<typeof setInterval>;
}

interface TenantChannel {
  id: string;
  channelType: string;
  channelName: string | null;
  channelPolicy: ChannelPolicy;
  isActive: boolean;
  apps: ChannelApp[];
  createdAt: string;
}

@customElement("tenant-channels-view")
export class TenantChannelsView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        padding: 1.5rem;
        color: var(--text, #e5e5e5);
        font-family: var(--font-sans, system-ui, sans-serif);
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .btn {
        padding: 0.45rem 0.9rem;
        border: none;
        border-radius: var(--radius-md, 6px);
        font-size: 0.85rem;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .btn:hover {
        opacity: 0.85;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent, #3b82f6);
        color: white;
      }
      .btn-danger {
        background: var(--bg-destructive, #7f1d1d);
        color: var(--text-destructive, #fca5a5);
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border, #262626);
        color: var(--text, #e5e5e5);
      }
      .btn-sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.8rem;
      }
      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
        gap: 1.25rem;
      }
      .channel-card {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 10px);
        overflow: hidden;
        transition:
          border-color 0.2s,
          box-shadow 0.2s;
      }
      .channel-card:hover {
        border-color: #3b82f6;
        box-shadow: 0 2px 12px rgba(59, 130, 246, 0.08);
      }
      .channel-card-body {
        padding: 1.25rem;
      }
      .channel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.85rem 1.25rem;
        border-bottom: 1px solid var(--border, #262626);
      }
      .channel-name {
        font-size: 1rem;
        font-weight: 600;
        display: flex;
        align-items: center;
      }
      .channel-header-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .channel-logo {
        width: 28px;
        height: 28px;
        object-fit: contain;
        opacity: 0.9;
      }
      .channel-type {
        font-size: 0.72rem;
        padding: 0.18rem 0.55rem;
        border-radius: 4px;
        background: #1d4ed8;
        color: #fff;
        font-weight: 500;
        letter-spacing: 0.02em;
      }
      .policy-badge {
        font-size: 0.68rem;
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
        font-weight: 500;
        letter-spacing: 0.02em;
      }
      .policy-badge.open {
        background: #16a34a;
        color: #fff;
      }
      .policy-badge.allowlist {
        background: #7c3aed;
        color: #fff;
      }
      .policy-badge.disabled {
        background: #dc2626;
        color: #fff;
      }
      .info-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.82rem;
        padding: 0.45rem 0;
        border-bottom: 1px solid var(--border, #262626);
      }
      .info-row:last-of-type {
        border-bottom: none;
      }
      .info-label {
        flex-shrink: 0;
        width: 5.5rem;
        font-size: 0.75rem;
        color: var(--text, #e5e5e5);
        font-weight: 600;
      }
      .info-label::after {
        content: ":";
      }
      .info-value {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
        font-weight: 500;
        min-width: 0;
      }
      .info-value.mono {
        font-family: monospace;
        font-size: 0.78rem;
      }
      .agent-link {
        cursor: pointer;
        color: var(--accent, #3b82f6);
      }
      .agent-link:hover {
        text-decoration: underline;
      }
      .info-muted {
        font-size: 0.72rem;
        color: var(--text-muted, #525252);
        font-weight: 400;
      }
      .info-divider {
        height: 0;
        margin: 0.6rem 0;
        border-top: 1px solid var(--text-muted, #525252);
      }
      .connection-badge {
        font-size: 0.68rem;
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
        font-weight: 500;
        letter-spacing: 0.02em;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .connection-badge.online {
        background: #16a34a;
        color: #fff;
      }
      .connection-badge.offline {
        background: #71717a;
        color: #fff;
      }
      .connection-badge.connecting {
        background: #ca8a04;
        color: #fff;
      }
      .status-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .status-dot.active {
        background: #22c55e;
        box-shadow: 0 0 6px #22c55e88;
      }
      .status-dot.inactive {
        background: #525252;
      }
      .status-dot.pending {
        background: #eab308;
        box-shadow: 0 0 6px #eab30888;
        animation: pulse 1.5s ease-in-out infinite;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
      .channel-actions {
        display: flex;
        gap: 0.5rem;
        padding-top: 0.85rem;
        margin-top: 0.5rem;
      }
      .error-msg {
        background: var(--bg-destructive, #2d1215);
        border: 1px solid var(--border-destructive, #7f1d1d);
        border-radius: var(--radius-md, 6px);
        color: var(--text-destructive, #fca5a5);
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }
      .error-msg a {
        color: inherit;
        text-decoration: underline;
        font-weight: 600;
      }
      .error-msg a:hover {
        opacity: 0.85;
      }
      .success-msg {
        background: #052e16;
        border: 1px solid #166534;
        border-radius: var(--radius-md, 6px);
        color: #86efac;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }
      .form-card {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 8px);
        padding: 1.25rem;
        margin-bottom: 1.5rem;
      }
      .form-card h3 {
        margin: 0 0 1rem;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .form-row {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }
      .form-field {
        width: 100%;
      }
      .form-field label {
        display: block;
        font-size: 0.8rem;
        margin-bottom: 0.3rem;
        color: var(--text-secondary, #a3a3a3);
      }
      .form-field input,
      .form-field select,
      .form-field textarea {
        width: 100%;
        padding: 0.45rem 0.65rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        color: var(--text, #e5e5e5);
        font-size: 0.85rem;
        outline: none;
        box-sizing: border-box;
      }
      .form-field textarea {
        min-height: 60px;
        resize: vertical;
        font-family: inherit;
      }
      .form-field input:focus,
      .form-field select:focus,
      .form-field textarea:focus {
        border-color: var(--accent, #3b82f6);
      }
      .form-hint {
        font-size: 0.72rem;
        color: var(--text-muted, #525252);
        margin-top: 0.25rem;
      }
      .divider {
        display: flex;
        align-items: center;
        margin: 1rem 0;
        font-size: 0.75rem;
        color: var(--text-muted, #525252);
      }
      .divider::before,
      .divider::after {
        content: "";
        flex: 1;
        border-top: 1px solid var(--border, #262626);
      }
      .divider span {
        padding: 0 0.75rem;
      }
      .app-form-card {
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        padding: 0.75rem;
        margin-bottom: 0.5rem;
        position: relative;
      }
      .secret-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      .secret-wrap input {
        flex: 1;
        padding-right: 2rem;
      }
      .eye-btn {
        position: absolute;
        right: 0.4rem;
        background: none;
        border: none;
        color: var(--text-muted, #525252);
        cursor: pointer;
        padding: 0.2rem;
        line-height: 1;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .eye-btn:hover {
        color: var(--text, #e5e5e5);
      }
      .eye-btn svg {
        pointer-events: none;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--text-muted, #525252);
        font-size: 0.85rem;
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--text-muted, #525252);
      }
      .feishu-mode-bar {
        display: inline-flex;
        gap: 2px;
        margin-bottom: 0.75rem;
        background: var(--border, #262626);
        border-radius: 4px;
        padding: 2px;
      }
      .feishu-mode-btn {
        padding: 0.28rem 0.7rem;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-secondary, #a3a3a3);
        cursor: pointer;
        font-size: 0.78rem;
        transition: all 0.12s;
        white-space: nowrap;
      }
      .feishu-mode-btn:hover {
        color: var(--text, #e5e5e5);
      }
      .feishu-mode-btn.active {
        background: var(--accent, #3b82f6);
        color: white;
      }
      .qr-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem;
        margin-bottom: 0.75rem;
        background: white;
        border-radius: var(--radius-md, 6px);
      }
      .qr-container img {
        width: 200px;
        height: 200px;
      }
      .qr-hint {
        font-size: 0.8rem;
        color: var(--text-secondary, #a3a3a3);
        text-align: center;
        margin-top: 0.5rem;
      }
      .qr-polling {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8rem;
        color: var(--accent, #3b82f6);
        justify-content: center;
        margin-top: 0.5rem;
      }
      .qr-polling .dot {
        animation: blink 1.2s infinite;
      }
      @keyframes blink {
        0%,
        100% {
          opacity: 0.2;
        }
        50% {
          opacity: 1;
        }
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal-card {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 8px);
        padding: 1.5rem;
        width: 480px;
        max-width: 90vw;
        max-height: 80vh;
        overflow-y: auto;
      }
      .modal-card h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
      }
      .modal-steps {
        margin: 0.75rem 0;
        font-size: 0.84rem;
        line-height: 1.7;
      }
      .modal-steps li {
        margin-bottom: 0.3rem;
      }
      .modal-link {
        display: block;
        margin: 0.75rem 0;
        padding: 0.55rem 0.75rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        word-break: break-all;
        font-size: 0.82rem;
        color: var(--accent, #3b82f6);
        text-decoration: none;
        cursor: pointer;
      }
      .modal-link:hover {
        border-color: var(--accent, #3b82f6);
      }
      .modal-scopes-label {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.8rem;
        color: var(--text-secondary, #a3a3a3);
        margin: 0.75rem 0 0.35rem;
      }
      .btn-copy {
        padding: 0.25rem 0.55rem;
        border: 1px solid var(--border, #262626);
        border-radius: 4px;
        background: var(--bg, #0a0a0a);
        color: var(--text-secondary, #a3a3a3);
        cursor: pointer;
        font-size: 0.75rem;
        transition: all 0.15s;
      }
      .btn-copy:hover {
        border-color: var(--accent, #3b82f6);
        color: var(--text, #e5e5e5);
      }
      .btn-copy.copied {
        border-color: #22c55e;
        color: #22c55e;
      }
      .modal-scopes-box {
        width: 100%;
        height: 120px;
        padding: 0.5rem;
        box-sizing: border-box;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        color: var(--text-muted, #525252);
        font-size: 0.72rem;
        font-family: monospace;
        resize: vertical;
      }
      .modal-footer {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 1rem;
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private channels: TenantChannel[] = [];
  @state() private loading = false;
  /** Stores i18n key or raw server message; translated at render time. */
  @state() private errorKey = "";
  @state() private successKey = "";
  private msgParams: Record<string, string> = {};
  private msgTimer?: ReturnType<typeof setTimeout>;
  @state() private showForm = false;
  @state() private editingId: string | null = null;
  @state() private saving = false;
  @state() private feishuAuthGuideAppId: string | null = null;
  @state() private scopesCopied = false;

  // Form fields
  @state() private formChannelType = CHANNEL_TYPES[0]?.value ?? "feishu";
  @state() private formChannelName = "";
  @state() private formChannelPolicy: ChannelPolicy = "open";
  @state() private formApps: ChannelApp[] = [];
  @state() private availableAgents: AgentOption[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.loadChannels();
    this.loadAgents();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.clearAllFeishuTimers();
    this.clearAllWecomTimers();
  }

  private showError(key: string, params?: Record<string, string>) {
    this.errorKey = key;
    this.successKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private showSuccess(key: string, params?: Record<string, string>) {
    this.successKey = key;
    this.errorKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.successKey = ""), 5000);
  }

  /** Translate key at render time; map known server errors, pass through others. */
  private tr(key: string): string {
    if (key.includes("频道名称已存在")) {
      return t("tenantChannels.channelNameExists");
    }
    if (key.includes("已存在相同 App ID")) {
      return t("tenantChannels.duplicateAppId");
    }
    if (key.includes("已在其他频道中注册")) {
      return t("tenantChannels.duplicateAppIdAcrossChannels");
    }
    if (key.includes("存在重复的 App ID")) {
      return t("tenantChannels.duplicateAppIdInPayload");
    }
    const result = t(key, this.msgParams);
    return result === key ? key : result;
  }

  private get channelTypes() {
    return CHANNEL_TYPES.map((c) => ({ value: c.value, label: t(c.labelKey) }));
  }

  private get policyOptions(): { value: ChannelPolicy; label: string }[] {
    return [
      { value: "open", label: t("tenantChannels.policyOpen") },
      { value: "allowlist", label: t("tenantChannels.policyAllowlist") },
      { value: "disabled", label: t("tenantChannels.policyDisabled") },
    ];
  }

  private async loadAgents() {
    try {
      const result = (await this.rpc("tenant.agents.list")) as {
        agents: Array<{
          agentId: string;
          name: string | null;
          config?: Record<string, unknown>;
          isActive?: boolean;
        }>;
      };
      this.availableAgents = (result.agents ?? [])
        .filter((a) => a.isActive !== false)
        .map((a) => ({
          agentId: a.agentId,
          name: (a.config?.displayName as string) ?? a.name ?? a.agentId,
        }));
    } catch {
      /* non-critical */
    }
  }

  private async copyScopes() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(feishuScopes, null, 2));
      this.scopesCopied = true;
      setTimeout(() => (this.scopesCopied = false), 2000);
    } catch {
      // Fallback: select textarea content
      const textarea = this.renderRoot.querySelector(".modal-scopes-box");
      if (textarea) {
        textarea.select();
        document.execCommand("copy");
        this.scopesCopied = true;
        setTimeout(() => (this.scopesCopied = false), 2000);
      }
    }
  }

  private clearAllFeishuTimers() {
    for (const app of this.formApps) {
      if (app.feishuPollTimer) {
        clearInterval(app.feishuPollTimer);
        app.feishuPollTimer = undefined;
      }
    }
  }

  private clearAllWecomTimers() {
    for (const app of this.formApps) {
      if (app.wecomPollTimer) {
        clearInterval(app.wecomPollTimer);
        app.wecomPollTimer = undefined;
      }
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private async loadChannels() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = (await this.rpc("tenant.channels.list")) as { channels: TenantChannel[] };
      this.channels = result.channels ?? [];
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantChannels.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private startCreate() {
    this.editingId = null;
    this.formChannelType = CHANNEL_TYPES[0]?.value ?? "feishu";
    this.formChannelName = "";
    this.formChannelPolicy = "open";
    // One channel = one app. Pre-seed a single empty app row so the user
    // never needs an explicit "add app" action.
    this.formApps = [
      {
        appId: "",
        appSecret: "",
        botName: "",
        groupPolicy: "open",
        agent: null,
        formAgentBinding: "",
      },
    ];
    this.showForm = true;
  }

  private handleChannelTypeChange(nextType: string) {
    if (nextType === this.formChannelType) {
      return;
    }
    // Switching type invalidates any in-flight scan state and any credentials
    // the user started typing — reset to a clean single-row form.
    this.clearAllFeishuTimers();
    this.clearAllWecomTimers();
    this.formChannelType = nextType;
    this.formChannelName = "";
    this.formApps = [
      {
        appId: "",
        appSecret: "",
        botName: "",
        groupPolicy: "open",
        agent: null,
        formAgentBinding: "",
      },
    ];
  }

  private startEdit(channel: TenantChannel) {
    this.editingId = channel.id;
    this.formChannelType = channel.channelType;
    this.formChannelName = channel.channelName ?? "";
    this.formChannelPolicy = channel.channelPolicy ?? "open";
    this.formApps = (channel.apps ?? []).map((a) => ({
      ...a,
      formAgentBinding: a.agent?.agentId ?? "",
    }));
    this.showForm = true;
  }

  private setFeishuMode(index: number, mode: "scan" | "manual") {
    const apps = [...this.formApps];
    const app = apps[index];
    // Clear previous polling if switching away from scan
    if (app.feishuPollTimer) {
      clearInterval(app.feishuPollTimer);
      app.feishuPollTimer = undefined;
    }
    app.feishuMode = mode;
    app.feishuPolling = false;
    app.feishuDeviceCode = undefined;
    app.feishuVerificationUrl = undefined;
    this.formApps = apps;
    if (mode === "scan") {
      void this.startFeishuRegister(index);
    }
  }

  private async startFeishuRegister(index: number) {
    try {
      const result = (await this.rpc("tenant.feishu.register.begin", {
        domain: "feishu",
        env: "prod",
      })) as {
        deviceCode: string;
        verificationUrl: string;
        interval: number;
        expireIn: number;
        domain: string;
        env: string;
      };
      const apps = [...this.formApps];
      const app = apps[index];
      app.feishuDeviceCode = result.deviceCode;
      app.feishuVerificationUrl = result.verificationUrl;
      app.feishuDomain = result.domain;
      app.feishuEnv = result.env;
      app.feishuPolling = true;
      this.formApps = apps;
      this.startFeishuPoll(index, result.interval);
    } catch (err) {
      this.showError(
        `${t("tenantChannels.feishuRegisterFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private startFeishuPoll(index: number, intervalSec: number) {
    const app = this.formApps[index];
    if (!app?.feishuDeviceCode) {
      return;
    }
    const deviceCode = app.feishuDeviceCode;
    const domain = app.feishuDomain ?? "feishu";
    const env = app.feishuEnv ?? "prod";
    const timer = setInterval(
      async () => {
        // Find current app by deviceCode (index may shift if apps are added/removed)
        const currentIndex = this.formApps.findIndex((a) => a.feishuDeviceCode === deviceCode);
        if (currentIndex === -1) {
          clearInterval(timer);
          return;
        }
        try {
          const result = (await this.rpc("tenant.feishu.register.poll", {
            deviceCode,
            domain,
            env,
          })) as {
            status: "completed" | "pending" | "error";
            appId?: string;
            appSecret?: string;
            openId?: string;
            domain?: string;
            botName?: string;
            slowDown?: boolean;
            error?: string;
            errorDescription?: string;
          };
          if (result.status === "completed" && result.appId && result.appSecret) {
            clearInterval(timer);
            const apps = [...this.formApps];
            const a = apps[currentIndex];
            a.appId = result.appId;
            a.appSecret = result.appSecret;
            if (result.botName) {
              a.botName = result.botName;
            }
            a.feishuPolling = false;
            a.feishuPollTimer = undefined;
            a.feishuMode = "manual"; // Switch to manual view to show filled fields
            this.formApps = apps;
            this.showSuccess("tenantChannels.feishuBotCreated");
          } else if (result.status === "error") {
            clearInterval(timer);
            const apps = [...this.formApps];
            apps[currentIndex].feishuPolling = false;
            apps[currentIndex].feishuPollTimer = undefined;
            this.formApps = apps;
            this.showError(
              `${t("tenantChannels.feishuRegisterError")}: ${result.errorDescription ?? result.error ?? t("tenantChannels.feishuUnknownError")}`,
            );
          }
          // "pending" → keep polling
        } catch {
          // Ignore transient poll errors
        }
      },
      Math.max(intervalSec, 3) * 1000,
    );
    // Store timer for cleanup
    const apps = [...this.formApps];
    apps[index].feishuPollTimer = timer;
    this.formApps = apps;
  }

  private setWecomMode(index: number, mode: "scan" | "manual") {
    const apps = [...this.formApps];
    const app = apps[index];
    if (app.wecomPollTimer) {
      clearInterval(app.wecomPollTimer);
      app.wecomPollTimer = undefined;
    }
    app.wecomMode = mode;
    app.wecomPolling = false;
    app.wecomScode = undefined;
    app.wecomVerificationUrl = undefined;
    app.wecomQrPageUrl = undefined;
    this.formApps = apps;
    if (mode === "scan") {
      void this.startWecomRegister(index);
    }
  }

  private async startWecomRegister(index: number) {
    try {
      const result = (await this.rpc("tenant.wecom.register.begin")) as {
        scode: string;
        authUrl: string;
        qrPageUrl: string;
        interval: number;
        expireIn: number;
      };
      const apps = [...this.formApps];
      const app = apps[index];
      app.wecomScode = result.scode;
      app.wecomVerificationUrl = result.authUrl;
      app.wecomQrPageUrl = result.qrPageUrl;
      app.wecomPolling = true;
      this.formApps = apps;
      this.startWecomPoll(index, result.interval);
    } catch (err) {
      this.showError(
        `${t("tenantChannels.wecomRegisterFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private startWecomPoll(index: number, intervalSec: number) {
    const app = this.formApps[index];
    if (!app?.wecomScode) {
      return;
    }
    const scode = app.wecomScode;
    const timer = setInterval(
      async () => {
        const currentIndex = this.formApps.findIndex((a) => a.wecomScode === scode);
        if (currentIndex === -1) {
          clearInterval(timer);
          return;
        }
        try {
          const result = (await this.rpc("tenant.wecom.register.poll", { scode })) as {
            status: "completed" | "pending" | "error";
            botId?: string;
            secret?: string;
            error?: string;
          };
          if (result.status === "completed" && result.botId && result.secret) {
            clearInterval(timer);
            const apps = [...this.formApps];
            const a = apps[currentIndex];
            a.appId = result.botId;
            a.appSecret = result.secret;
            a.wecomPolling = false;
            a.wecomPollTimer = undefined;
            a.wecomMode = "manual";
            this.formApps = apps;
            this.showSuccess("tenantChannels.wecomBotCreated");
          } else if (result.status === "error") {
            clearInterval(timer);
            const apps = [...this.formApps];
            apps[currentIndex].wecomPolling = false;
            apps[currentIndex].wecomPollTimer = undefined;
            this.formApps = apps;
            this.showError(
              `${t("tenantChannels.wecomRegisterError")}: ${result.error ?? t("tenantChannels.wecomUnknownError")}`,
            );
          }
        } catch {
          // transient errors ignored
        }
      },
      Math.max(intervalSec, 3) * 1000,
    );
    const apps = [...this.formApps];
    apps[index].wecomPollTimer = timer;
    this.formApps = apps;
  }

  private updateApp(index: number, field: string, value: string) {
    const apps = [...this.formApps];
    (apps[index] as unknown as Record<string, unknown>)[field] = value;
    this.formApps = apps;
  }

  private async handleSave(e: Event) {
    e.preventDefault();
    // Trim whitespace from text inputs before validation
    this.formChannelName = this.formChannelName.trim();
    for (const app of this.formApps) {
      app.appId = app.appId.trim();
      app.appSecret = app.appSecret.trim();
      app.botName = (app.botName ?? "").trim();
    }

    if (this.formApps.length === 0) {
      this.showError("tenantChannels.appRequired");
      return;
    }

    // Validate apps
    const appIds = new Set<string>();
    for (let i = 0; i < this.formApps.length; i++) {
      const app = this.formApps[i];
      if (!app.appId) {
        this.showError("tenantChannels.appIdRequired");
        return;
      }
      if (appIds.has(app.appId)) {
        this.showError("tenantChannels.appIdDuplicate");
        return;
      }
      appIds.add(app.appId);
      // Cross-channel duplicate: check if this appId already exists in another channel of the same type.
      const dupChannel = this.channels.find(
        (ch) =>
          ch.channelType === this.formChannelType &&
          ch.id !== this.editingId &&
          ch.apps.some((a) => a.appId.toLowerCase() === app.appId.toLowerCase()),
      );
      if (dupChannel) {
        this.showError("tenantChannels.duplicateAppIdAcrossChannels");
        return;
      }
      // Also check within the same channel being edited — another app row (not this one) using the same appId.
      if (this.editingId) {
        const currentChannel = this.channels.find((ch) => ch.id === this.editingId);
        const dupInSame = currentChannel?.apps.some(
          (a) => a.id !== app.id && a.appId.toLowerCase() === app.appId.toLowerCase(),
        );
        if (dupInSame) {
          this.showError("tenantChannels.duplicateAppIdAcrossChannels");
          return;
        }
      }
      if (!app.formAgentBinding) {
        this.showError("tenantChannels.agentRequired", { name: app.appId });
        return;
      }
    }

    this.saving = true;
    this.errorKey = "";
    this.successKey = "";

    try {
      if (this.editingId) {
        // Update channel
        await this.rpc("tenant.channels.update", {
          channelId: this.editingId,
          channelName: this.formChannelName,
          channelPolicy: this.formChannelPolicy,
        });

        // Sync apps: delete removed, update existing, add new
        const existing = this.channels.find((c) => c.id === this.editingId);
        const existingApps = existing?.apps ?? [];
        const existingIds = new Set(existingApps.map((a) => a.id));
        const formIds = new Set(this.formApps.filter((a) => a.id).map((a) => a.id));

        // Delete removed apps
        for (const ea of existingApps) {
          if (ea.id && !formIds.has(ea.id)) {
            await this.rpc("tenant.channels.apps.delete", { appDbId: ea.id });
          }
        }

        // Update or add apps (with agent binding)
        for (const app of this.formApps) {
          if (app.id && existingIds.has(app.id)) {
            await this.rpc("tenant.channels.apps.update", {
              appDbId: app.id,
              appId: app.appId,
              appSecret: app.appSecret,
              botName: app.botName,
              groupPolicy: app.groupPolicy,
              agentId: app.formAgentBinding || null,
            });
          } else {
            await this.rpc("tenant.channels.apps.add", {
              channelId: this.editingId,
              appId: app.appId,
              appSecret: app.appSecret,
              botName: app.botName,
              groupPolicy: app.groupPolicy,
              agentId: app.formAgentBinding || null,
            });
          }
        }

        this.showSuccess("tenantChannels.channelUpdated");
      } else {
        // Create channel with apps + agent bindings.
        // channelName is no longer user-editable and the DB column is nullable;
        // passing null avoids colliding with the UNIQUE(tenant, type, name)
        // constraint when adding a second channel of the same type.
        const displayName =
          this.channelTypes.find((ct) => ct.value === this.formChannelType)?.label ??
          this.formChannelType;
        await this.rpc("tenant.channels.create", {
          channelType: this.formChannelType,
          channelName: this.formChannelName || null,
          channelPolicy: this.formChannelPolicy,
          apps: this.formApps.map((a) => ({
            appId: a.appId,
            appSecret: a.appSecret,
            botName: a.botName,
            groupPolicy: a.groupPolicy,
            agentId: a.formAgentBinding || null,
          })),
        });
        this.showSuccess("tenantChannels.channelCreated", { name: displayName });
      }
      // Show auth guide for any new feishu app (scan or manual)
      const scannedAppId =
        this.formChannelType === "feishu"
          ? this.formApps.find((a) => !a.id && a.appId)?.appId
          : null;
      this.clearAllFeishuTimers();
      this.clearAllWecomTimers();
      this.showForm = false;
      await this.loadChannels();
      // Refresh again after delay to pick up connection status from runtime
      setTimeout(() => this.loadChannels(), 3000);
      if (scannedAppId) {
        this.feishuAuthGuideAppId = scannedAppId;
      }
    } catch (err) {
      const q = quotaErrorKey(err);
      if (q) {
        this.showError(q.key, q.params);
      } else {
        this.showError(err instanceof Error ? err.message : "tenantChannels.saveFailed");
      }
    } finally {
      this.saving = false;
    }
  }

  private get agentManagePath() {
    return pathForTab("tenant-agents", inferBasePathFromPathname(window.location.pathname));
  }

  private async handleDelete(channel: TenantChannel) {
    const name = channel.channelName ?? channel.channelType;
    const ok = await showConfirm({
      title: t("tenantChannels.delete"),
      message: t("tenantChannels.confirmDelete").replace("{name}", name),
      confirmText: t("tenantChannels.delete"),
      cancelText: t("tenantChannels.cancel"),
      danger: true,
    });
    if (!ok) {
      return;
    }
    this.errorKey = "";
    try {
      await this.rpc("tenant.channels.delete", { channelId: channel.id });
      this.showSuccess("tenantChannels.channelDeleted", { name });
      await this.loadChannels();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantChannels.deleteFailed");
    }
  }

  render() {
    const noAgents = this.availableAgents.length === 0;
    return html`
      <div class="header">
        <h2>${t("tenantChannels.title")}</h2>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-outline" @click=${() => this.loadChannels()}>${t("tenantChannels.refresh")}</button>
          <button class="btn btn-primary"
            @click=${() => {
              if (this.showForm) {
                this.clearAllFeishuTimers();
                this.clearAllWecomTimers();
                this.showForm = false;
              } else {
                this.startCreate();
              }
            }}>
            ${this.showForm ? t("tenantChannels.cancel") : t("tenantChannels.createChannel")}
          </button>
        </div>
      </div>

      ${
        this.errorKey
          ? html`<div class="error-msg">${
              this.errorKey.startsWith("errors.quotaExceeded.")
                ? unsafeHTML(this.tr(this.errorKey))
                : this.tr(this.errorKey)
            }</div>`
          : nothing
      }
      ${this.successKey ? html`<div class="success-msg">${this.tr(this.successKey)}</div>` : nothing}

      ${this.showForm ? this.renderForm() : nothing}

      ${
        this.loading
          ? html`<div class="loading">${t("tenantChannels.loading")}</div>`
          : this.channels.length === 0
            ? html`<div class="empty">${noAgents ? html`${t("tenantChannels.noAgentsAvailable")} <a href=${this.agentManagePath} style="color:var(--accent,#3b82f6);text-decoration:underline;cursor:pointer">${t("tenantAgents.createAgent")}</a>` : t("tenantChannels.empty")}</div>`
            : html`
        <div class="card-grid">
          ${this.channels.map((ch) => this.renderChannelCard(ch))}
        </div>
      `
      }

      ${this.feishuAuthGuideAppId ? this.renderFeishuAuthGuide(this.feishuAuthGuideAppId) : nothing}
    `;
  }

  private renderFeishuAuthGuide(appId: string) {
    const authUrl = `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth`;
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.feishuAuthGuideAppId = null;
          this.scopesCopied = false;
        }
      }}>
        <div class="modal-card">
          <h3>&#x2705; ${t("tenantChannels.feishuAuthTitle")}</h3>
          <p style="font-size:0.84rem;color:var(--text-secondary,#a3a3a3);margin:0 0 0.5rem">
            ${t("tenantChannels.feishuAuthDesc")}
          </p>
          <ol class="modal-steps">
            <li>${t("tenantChannels.feishuAuthStep1")}</li>
            <li>${t("tenantChannels.feishuAuthStep2")}</li>
            <li>${t("tenantChannels.feishuAuthStep3")}</li>
          </ol>
          <a class="modal-link" href=${authUrl} target="_blank" rel="noopener noreferrer">
            &#x1F517; ${authUrl}
          </a>
          <div class="modal-scopes-label">
            <span>${t("tenantChannels.feishuScopesList")}</span>
            <button type="button" class="btn-copy ${this.scopesCopied ? "copied" : ""}"
              @click=${() => this.copyScopes()}>
              ${this.scopesCopied ? `\u2714 ${t("tenantChannels.feishuCopied")}` : `\uD83D\uDCCB ${t("tenantChannels.feishuCopyScopes")}`}
            </button>
          </div>
          <textarea class="modal-scopes-box" readonly
            .value=${JSON.stringify(feishuScopes, null, 2)}></textarea>
          <p style="font-size:0.75rem;color:var(--text-muted,#525252);margin:0.5rem 0 0">
            ${t("tenantChannels.feishuScopesHint")}
          </p>
          <div class="modal-footer">
            <a class="btn btn-primary" href=${authUrl} target="_blank" rel="noopener noreferrer"
              style="text-decoration:none;text-align:center">${t("tenantChannels.feishuGoAuth")}</a>
            <button class="btn btn-outline" @click=${() => {
              this.feishuAuthGuideAppId = null;
              this.scopesCopied = false;
            }}>${t("tenantChannels.feishuLater")}</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderChannelCard(ch: TenantChannel) {
    const typeName =
      this.channelTypes.find((ct) => ct.value === ch.channelType)?.label ?? ch.channelType;

    return html`
      <div class="channel-card">
        <div class="channel-header">
          <div class="channel-name">
            <span class="status-dot ${ch.isActive ? "active" : "inactive"}"></span>
            ${typeName}
          </div>
          <div class="channel-header-right">
            ${
              CHANNEL_ICON_MAP[ch.channelType]
                ? html`<img class="channel-logo" src=${CHANNEL_ICON_MAP[ch.channelType]} alt=${typeName} />`
                : html`<span class="channel-type">${typeName}</span>`
            }
          </div>
        </div>
        <div class="channel-card-body">
          ${
            ch.apps && ch.apps.length > 0
              ? ch.apps.map(
                  (app, idx) => html`
            ${
              app.botName
                ? html`
              <div class="info-row">
                <span class="info-label">${t("tenantChannels.botName")}</span>
                <span class="info-value">${app.botName}</span>
              </div>
            `
                : nothing
            }
            <div class="info-row">
              <span class="info-label">${ch.channelType === "wecom" ? t("tenantChannels.wecomBotId") : ch.channelType === "dingtalk" ? t("tenantChannels.dingtalkClientId") : t("tenantChannels.appId")}</span>
              <span class="info-value mono">${app.appId}</span>
            </div>
            ${
              app.connectionStatus
                ? (() => {
                    const st =
                      app.connectionStatus.state ??
                      (app.connectionStatus.connected ? "online" : "offline");
                    const badgeLabel =
                      st === "online"
                        ? t("tenantChannels.online")
                        : st === "connecting"
                          ? t("tenantChannels.connecting")
                          : t("tenantChannels.offline");
                    const dotClass =
                      st === "online" ? "active" : st === "connecting" ? "pending" : "inactive";
                    return html`
                <div class="info-row">
                  <span class="info-label">${t("tenantChannels.connectionStatus")}</span>
                  <span class="connection-badge ${st}">
                    <span class="status-dot ${dotClass}"></span>
                    ${badgeLabel}
                  </span>
                </div>
              `;
                  })()
                : nothing
            }
            ${
              app.agent
                ? html`
              <div class="info-row">
                <span class="info-label">${t("tenantChannels.agent")}</span>
                <span class="info-value">
                  <span class="agent-link" @click=${(e: Event) => {
                    e.stopPropagation();
                    this.dispatchEvent(
                      new CustomEvent("navigate-to-agent", {
                        detail: { agentId: app.agent!.agentId },
                        bubbles: true,
                        composed: true,
                      }),
                    );
                  }}>${(app.agent.config?.displayName as string) || app.agent.name || app.agent.agentId}</span>
                  <span class="info-muted">(${app.agent.agentId})</span>
                </span>
              </div>
            `
                : nothing
            }
            ${
              idx < ch.apps.length - 1
                ? html`
                    <div class="info-divider"></div>
                  `
                : nothing
            }
          `,
                )
              : nothing
          }
          <div class="channel-actions">
            <button class="btn btn-outline btn-sm" @click=${() => this.startEdit(ch)}>${t("tenantChannels.edit")}</button>
            <button class="btn btn-danger btn-sm" @click=${() => this.handleDelete(ch)}>${t("tenantChannels.delete")}</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderForm() {
    return html`
      <div class="form-card">
        <h3>${this.editingId ? t("tenantChannels.editChannel") : t("tenantChannels.createChannel")}</h3>
        <form @submit=${this.handleSave}>
          <div class="form-row">
            <div class="form-field">
              <label>${t("tenantChannels.channelType")}</label>
              <select ?disabled=${!!this.editingId}
                @change=${(e: Event) => this.handleChannelTypeChange((e.target as HTMLSelectElement).value)}>
                ${this.channelTypes.map((ct) => html`<option value=${ct.value} ?selected=${ct.value === this.formChannelType}>${ct.label}</option>`)}
              </select>
            </div>
          </div>

          <div class="divider"><span>${t("tenantChannels.appsAndAgents")}</span></div>

          ${this.formApps.map((app, i) => this.renderAppFormCard(app, i))}

          <div style="display:flex;gap:0.5rem">
            <button class="btn btn-primary" type="submit" ?disabled=${this.saving}>
              ${this.saving ? t("tenantChannels.saving") : t("tenantChannels.save")}
            </button>
            <button class="btn btn-outline" type="button" @click=${() => {
              this.clearAllFeishuTimers();
              this.clearAllWecomTimers();
              this.showForm = false;
            }}>${t("tenantChannels.cancel")}</button>
          </div>
        </form>
      </div>
    `;
  }

  private renderAppFormCard(app: ChannelApp, i: number) {
    return html`
      <div class="app-form-card">

        <!-- Feishu mode selector (only for feishu channel without existing app) -->
        ${
          this.formChannelType === "feishu" && !app.id
            ? html`
          <div class="feishu-mode-bar">
            <button type="button" class="feishu-mode-btn ${app.feishuMode === "scan" ? "active" : ""}"
              @click=${() => this.setFeishuMode(i, "scan")}>&#x1F4F1; ${t("tenantChannels.feishuScanCreate")}</button>
            <button type="button" class="feishu-mode-btn ${(app.feishuMode ?? "manual") === "manual" ? "active" : ""}"
              @click=${() => this.setFeishuMode(i, "manual")}>&#x2328;&#xFE0F; ${t("tenantChannels.feishuManualBind")}</button>
          </div>
          ${
            app.feishuMode === "scan"
              ? html`
            ${
              app.feishuVerificationUrl
                ? html`
              <div class="qr-container">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(app.feishuVerificationUrl)}" alt="QR Code" />
              </div>
              <div class="qr-hint">${t("tenantChannels.feishuScanHint")}</div>
              ${
                app.feishuPolling
                  ? html`
                <div class="qr-polling">
                  <span class="dot">&#x25CF;</span> ${t("tenantChannels.feishuPolling")}
                </div>
              `
                  : nothing
              }
            `
                : html`
              <div class="qr-hint">${t("tenantChannels.feishuInitializing")}</div>
            `
            }
          `
              : nothing
          }
        `
            : nothing
        }

        <!-- WeCom mode selector (only for wecom channel without existing app) -->
        ${
          this.formChannelType === "wecom" && !app.id
            ? html`
          <div class="feishu-mode-bar">
            <button type="button" class="feishu-mode-btn ${app.wecomMode === "scan" ? "active" : ""}"
              @click=${() => this.setWecomMode(i, "scan")}>&#x1F4F1; ${t("tenantChannels.wecomScanCreate")}</button>
            <button type="button" class="feishu-mode-btn ${(app.wecomMode ?? "manual") === "manual" ? "active" : ""}"
              @click=${() => this.setWecomMode(i, "manual")}>&#x2328;&#xFE0F; ${t("tenantChannels.wecomManualBind")}</button>
          </div>
          ${
            app.wecomMode === "scan"
              ? html`
            ${
              app.wecomVerificationUrl
                ? html`
              <div class="qr-container">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(app.wecomVerificationUrl)}" alt="QR Code" />
              </div>
              <div class="qr-hint">${t("tenantChannels.wecomScanHint")}</div>
              ${
                app.wecomQrPageUrl
                  ? html`
                <div class="qr-hint"><a href=${app.wecomQrPageUrl} target="_blank" rel="noopener noreferrer" style="color:var(--accent,#3b82f6)">${t("tenantChannels.wecomOpenQrPage")}</a></div>
              `
                  : nothing
              }
              ${
                app.wecomPolling
                  ? html`
                <div class="qr-polling">
                  <span class="dot">&#x25CF;</span> ${t("tenantChannels.wecomPolling")}
                </div>
              `
                  : nothing
              }
            `
                : html`
              <div class="qr-hint">${t("tenantChannels.wecomInitializing")}</div>
            `
            }
          `
              : nothing
          }
        `
            : nothing
        }

        <!-- App config fields -->
        ${
          (this.formChannelType !== "feishu" || app.feishuMode !== "scan" || app.id) &&
          (this.formChannelType !== "wecom" || app.wecomMode !== "scan" || app.id)
            ? html`
        <div class="form-row">
          <div class="form-field">
            <label>${this.formChannelType === "wecom" ? t("tenantChannels.wecomBotId") : this.formChannelType === "dingtalk" ? t("tenantChannels.dingtalkClientId") : t("tenantChannels.appId")}</label>
            <input type="text" .placeholder=${this.formChannelType === "wecom" ? t("tenantChannels.wecomBotIdPlaceholder") : this.formChannelType === "dingtalk" ? t("tenantChannels.dingtalkClientIdPlaceholder") : t("tenantChannels.appIdPlaceholder")}
              .value=${app.appId}
              @input=${(e: InputEvent) => this.updateApp(i, "appId", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-field">
            <label>${this.formChannelType === "wecom" ? t("tenantChannels.wecomSecret") : this.formChannelType === "dingtalk" ? t("tenantChannels.dingtalkClientSecret") : t("tenantChannels.appSecret")}</label>
            <div class="secret-wrap">
              <input type="password" .placeholder=${this.formChannelType === "wecom" ? t("tenantChannels.wecomSecretPlaceholder") : this.formChannelType === "dingtalk" ? t("tenantChannels.dingtalkClientSecretPlaceholder") : t("tenantChannels.appSecretPlaceholder")}
                .value=${app.appSecret}
                @input=${(e: InputEvent) => this.updateApp(i, "appSecret", (e.target as HTMLInputElement).value)} />
              <button type="button" class="eye-btn"
                @mousedown=${(e: Event) => {
                  const wrap = (e.target as HTMLElement).closest(".secret-wrap")!;
                  (wrap.querySelector("input") as HTMLInputElement).type = "text";
                }}
                @mouseup=${(e: Event) => {
                  const wrap = (e.target as HTMLElement).closest(".secret-wrap")!;
                  (wrap.querySelector("input") as HTMLInputElement).type = "password";
                }}
                @mouseleave=${(e: Event) => {
                  const wrap = (e.target as HTMLElement).closest(".secret-wrap")!;
                  (wrap.querySelector("input") as HTMLInputElement).type = "password";
                }}
              ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            </div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>${t("tenantChannels.botName")}</label>
            <input type="text" .placeholder=${t("tenantChannels.botNamePlaceholder")}
              .value=${app.botName ?? ""}
              @input=${(e: InputEvent) => this.updateApp(i, "botName", (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        `
            : nothing
        }
        <!-- Agent binding -->
        <div class="form-row">
          <div class="form-field">
            <label>${t("tenantChannels.agentBinding")}</label>
            ${
              this.availableAgents.length === 0
                ? html`
              <div class="form-hint" style="padding:0.3rem 0">${t("tenantChannels.noAgentsAvailable")} <a href=${this.agentManagePath} style="color:var(--accent,#3b82f6);text-decoration:underline;cursor:pointer">${t("tenantAgents.createAgent")}</a></div>
            `
                : html`
              <select @change=${(e: Event) => this.updateApp(i, "formAgentBinding", (e.target as HTMLSelectElement).value)}>
                <option value="">${t("tenantChannels.selectAgent")}</option>
                ${this.availableAgents.map(
                  (a) => html`
                  <option value=${a.agentId} ?selected=${app.formAgentBinding === a.agentId}>${a.name} (${a.agentId})</option>
                `,
                )}
              </select>
            `
            }
          </div>
        </div>
      </div>
    `;
  }
}
