/**
 * Onboarding wizard — full-screen step-by-step guide after registration.
 *
 * Steps: Model → Channel → Done. The agent is auto-created server-side
 * with locale-aware defaults (see tenant.onboarding.setup).
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { CHANNEL_TYPES, CHANNEL_ICON_MAP } from "../../constants/channels.ts";
import { PROVIDER_TYPES } from "../../constants/providers.ts";
import { t, i18n, I18nController } from "../../i18n/index.ts";
import { caretFix } from "../shared-styles.ts";
import { tenantRpc, quotaErrorKey } from "./tenant/rpc.ts";

type WizardStep = "welcome" | "channel" | "model" | "done";

const STEPS: WizardStep[] = ["welcome", "model", "channel", "done"];

const CHANNEL_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNEL_ICON_MAP).map(([k, v]) => [
    k,
    `<img src="${v}" width="24" height="24" alt="${k}" style="object-fit:contain;" />`,
  ]),
);

const CHANNEL_OPTIONS = CHANNEL_TYPES.map((c) => ({ type: c.value, labelKey: c.labelKey }));

const MODEL_PROVIDERS = PROVIDER_TYPES.map((p) => ({
  type: p.value,
  label: p.label,
  protocol: p.defaultProtocol,
  placeholder: p.placeholder ?? "...",
  baseUrl: p.defaultBaseUrl,
}));

@customElement("onboarding-wizard")
export class OnboardingWizard extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-sans, system-ui, sans-serif);
        color: var(--text, #e5e5e5);
      }

      .wizard {
        width: 100%;
        max-width: 560px;
        max-height: 90vh;
        overflow-y: auto;
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: 12px;
        padding: 2.5rem;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }

      /* ── Progress bar ── */
      .progress {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 2rem;
      }
      .progress-step {
        flex: 1;
        height: 3px;
        border-radius: 2px;
        background: var(--border, #262626);
        transition: background 0.3s;
      }
      .progress-step.active {
        background: var(--accent, #3b82f6);
      }
      .progress-step.done {
        background: var(--ok);
      }

      /* ── Header ── */
      .wizard-header {
        text-align: center;
        margin-bottom: 2rem;
      }
      .wizard-icon {
        font-size: 2.5rem;
        margin-bottom: 0.75rem;
      }
      .wizard-title {
        font-size: 1.3rem;
        font-weight: 700;
        margin: 0 0 0.5rem;
      }
      .wizard-desc {
        font-size: 0.85rem;
        color: var(--text-secondary, #a3a3a3);
        margin: 0;
        line-height: 1.5;
      }
      .wizard-desc.bright {
        color: var(--text, #e5e5e5);
      }

      /* ── Step indicator ── */
      .step-indicator {
        font-size: 0.75rem;
        color: var(--text-muted, #525252);
        text-align: center;
        margin-bottom: 1.5rem;
      }

      /* ── Options grid ── */
      .options-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.75rem;
        margin-bottom: 1.5rem;
      }
      .option-card {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.85rem 1rem;
        background: var(--bg, #0a0a0a);
        border: 2px solid var(--border, #262626);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s;
        font-size: 0.85rem;
      }
      .option-card:hover {
        border-color: var(--accent, #3b82f6);
      }
      .option-card.selected {
        border-color: var(--accent, #3b82f6);
        background: rgba(59, 130, 246, 0.08);
      }
      .option-icon {
        font-size: 1.3rem;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
      }
      .option-icon img {
        display: block;
      }

      /* ── Form ── */
      .form-group {
        margin-bottom: 1rem;
      }
      .form-group label {
        display: block;
        font-size: 0.8rem;
        font-weight: 500;
        margin-bottom: 0.35rem;
        color: var(--text-secondary, #a3a3a3);
      }
      .required {
        color: var(--danger);
      }
      .form-group input,
      .form-group select,
      .form-group textarea {
        width: 100%;
        padding: 0.6rem 0.75rem 0.7rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: 6px;
        color: var(--text, #e5e5e5);
        font-size: 0.9rem;
        line-height: 1.5;
        outline: none;
        box-sizing: border-box;
        font-family: inherit;
      }
      .form-group input:focus,
      .form-group select:focus,
      .form-group textarea:focus {
        border-color: var(--accent, #3b82f6);
      }
      .form-group input:required:invalid:not(:placeholder-shown) {
        border-color: var(--danger);
      }
      .form-group textarea {
        min-height: 80px;
        resize: vertical;
      }
      .form-hint {
        font-size: 0.72rem;
        color: var(--text-muted, #525252);
        margin-top: 0.25rem;
      }

      /* ── Feishu mode toggle ── */
      .feishu-mode-bar {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      .feishu-mode-btn {
        flex: 1;
        padding: 0.5rem;
        border: 1px solid var(--border, #262626);
        border-radius: 6px;
        background: transparent;
        color: var(--text-secondary, #a3a3a3);
        cursor: pointer;
        font-size: 0.8rem;
        text-align: center;
        transition: all 0.15s;
      }
      .feishu-mode-btn:hover {
        color: var(--text, #e5e5e5);
      }
      .feishu-mode-btn.active {
        background: var(--accent, #3b82f6);
        color: white;
        border-color: var(--accent, #3b82f6);
      }
      .qr-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem;
        margin-bottom: 0.75rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: 8px;
      }
      .qr-container img {
        width: 200px;
        height: 200px;
        border-radius: 6px;
        background: white;
        padding: 8px;
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

      /* ── Secret input with eye toggle ── */
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

      /* ── Buttons ── */
      .wizard-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 2rem;
      }
      .btn {
        padding: 0.55rem 1.25rem;
        border: none;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .btn:hover {
        opacity: 0.85;
      }
      .btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent, #3b82f6);
        color: white;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary, #a3a3a3);
        padding: 0.55rem 0.75rem;
      }
      .btn-ghost:hover {
        color: var(--text, #e5e5e5);
      }
      .btn-success {
        background: var(--ok);
        color: white;
        font-size: 0.95rem;
        padding: 0.65rem 2rem;
      }

      /* ── Error ── */
      .error-msg a {
        color: inherit;
        text-decoration: underline;
        font-weight: 600;
      }
      .error-msg a:hover {
        opacity: 0.85;
      }
      .error-msg {
        background: #2d1215;
        border: 1px solid #7f1d1d;
        border-radius: 6px;
        color: #fca5a5;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }

      /* ── Done checklist ── */
      .checklist {
        list-style: none;
        padding: 0;
        margin: 1.5rem 0;
        display: flex;
        justify-content: center;
        gap: 1.5rem;
      }
      .checklist li {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
      }
      .check-icon {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.7rem;
        flex-shrink: 0;
      }
      .check-icon.done {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .check-icon.skip {
        background: #52525233;
        color: #525252;
      }

      /* ── Skip confirm dialog ── */
      .confirm-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
      }
      .confirm-dialog {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: 10px;
        padding: 2rem;
        max-width: 400px;
        text-align: center;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      }
      .confirm-dialog h3 {
        margin: 0 0 0.75rem;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .confirm-dialog p {
        margin: 0 0 1.5rem;
        font-size: 0.85rem;
        color: var(--text-secondary, #a3a3a3);
        line-height: 1.5;
      }
      .confirm-actions {
        display: flex;
        justify-content: center;
        gap: 0.75rem;
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private step: WizardStep = "welcome";
  @state() private saving = false;
  @state() private error = "";
  /** When true, `this.error` contains HTML and should be rendered with unsafeHTML
   *  (used for quota-exceeded messages that embed an <a> upgrade link). */
  @state() private errorIsHtml = false;
  @state() private showSkipConfirm = false;

  // Channel step
  @state() private selectedChannel = "";
  @state() private feishuMode: "scan" | "manual" = "scan";
  @state() private feishuVerificationUrl = "";
  @state() private feishuPolling = false;
  @state() private feishuInitializing = false;
  private feishuDeviceCode = "";
  private feishuDomain = "feishu";
  private feishuEnv = "prod";
  private feishuPollTimer?: ReturnType<typeof setInterval>;
  @state() private wecomMode: "scan" | "manual" = "scan";
  @state() private wecomVerificationUrl = "";
  @state() private wecomQrPageUrl = "";
  @state() private wecomPolling = false;
  @state() private wecomInitializing = false;
  private wecomScode = "";
  private wecomPollTimer?: ReturnType<typeof setInterval>;
  @state() private channelAppId = "";
  @state() private channelAppSecret = "";
  @state() private channelBotName = "";

  // Model step
  @state() private modelMode: "shared" | "custom" = "shared";
  @state() private sharedModels: Array<{
    id: string;
    providerName: string;
    models: Array<{ id: string; name: string }>;
  }> = [];
  @state() private selectedSharedModelId = ""; // tenant_models.id
  @state() private selectedSharedSubModelId = ""; // model definition id within shared provider
  @state() private selectedProvider = "";
  @state() private modelApiKey = "";
  @state() private modelBaseUrl = "";
  @state() private modelName = "";

  // Track what was completed
  private channelCreated = false;
  private modelCreated = false;
  private agentCreated = false;

  connectedCallback() {
    super.connectedCallback();
    this.loadSharedModels();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopFeishuPoll();
    this.stopWecomPoll();
  }

  private async loadSharedModels() {
    try {
      const result = (await this.rpc("tenant.models.list")) as {
        models: Array<{
          id: string;
          providerName: string;
          visibility?: string;
          isActive: boolean;
          models: Array<{ id: string; name: string }>;
        }>;
      };
      this.sharedModels = (result.models ?? []).filter(
        (m) => m.visibility === "shared" && m.isActive,
      );
      if (this.sharedModels.length === 0) {
        this.modelMode = "custom";
      }
    } catch {
      this.sharedModels = [];
      this.modelMode = "custom";
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private stepIndex(): number {
    return STEPS.indexOf(this.step);
  }

  private goNext() {
    const idx = this.stepIndex();
    if (idx < STEPS.length - 1) {
      this.step = STEPS[idx + 1];
      this.error = "";
    }
  }

  private goBack() {
    const idx = this.stepIndex();
    if (idx > 0) {
      this.step = STEPS[idx - 1];
      this.error = "";
    }
  }

  private skip() {
    this.showSkipConfirm = true;
  }

  private confirmSkip() {
    this.showSkipConfirm = false;
    this.dispatchEvent(new CustomEvent("onboarding-complete", { bubbles: true, composed: true }));
  }

  private cancelSkip() {
    this.showSkipConfirm = false;
  }

  private close() {
    this.dispatchEvent(new CustomEvent("onboarding-complete", { bubbles: true, composed: true }));
  }

  // ── Feishu scan flow ──
  private async startFeishuScan() {
    this.feishuInitializing = true;
    this.feishuVerificationUrl = "";
    this.error = "";
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
      this.feishuDeviceCode = result.deviceCode;
      this.feishuVerificationUrl = result.verificationUrl;
      this.feishuDomain = result.domain;
      this.feishuEnv = result.env;
      this.feishuPolling = true;
      this.feishuInitializing = false;
      this.startFeishuPoll(result.interval);
    } catch (e) {
      this.feishuInitializing = false;
      this.error = e instanceof Error ? e.message : t("onboarding.saveFailed");
    }
  }

  private startFeishuPoll(intervalSec: number) {
    this.stopFeishuPoll();
    this.feishuPollTimer = setInterval(
      async () => {
        try {
          const result = (await this.rpc("tenant.feishu.register.poll", {
            deviceCode: this.feishuDeviceCode,
            domain: this.feishuDomain,
            env: this.feishuEnv,
          })) as {
            status: "completed" | "pending" | "error";
            appId?: string;
            appSecret?: string;
            botName?: string;
            error?: string;
            errorDescription?: string;
          };
          if (result.status === "completed" && result.appId && result.appSecret) {
            this.stopFeishuPoll();
            this.channelAppId = result.appId;
            this.channelAppSecret = result.appSecret;
            if (result.botName) {
              this.channelBotName = result.botName;
            }
            this.feishuPolling = false;
            this.feishuMode = "manual"; // show filled fields
          } else if (result.status === "error") {
            this.stopFeishuPoll();
            this.feishuPolling = false;
            this.error = result.errorDescription ?? result.error ?? t("onboarding.saveFailed");
          }
        } catch {
          /* ignore transient errors */
        }
      },
      Math.max(intervalSec, 3) * 1000,
    );
  }

  private stopFeishuPoll() {
    if (this.feishuPollTimer) {
      clearInterval(this.feishuPollTimer);
      this.feishuPollTimer = undefined;
    }
  }

  private setFeishuMode(mode: "scan" | "manual") {
    this.feishuMode = mode;
    this.stopFeishuPoll();
    this.feishuPolling = false;
    this.feishuVerificationUrl = "";
    this.feishuInitializing = false;
    if (mode === "scan") {
      void this.startFeishuScan();
    }
  }

  // ── WeCom scan flow ──
  private async startWecomScan() {
    this.wecomInitializing = true;
    this.wecomVerificationUrl = "";
    this.wecomQrPageUrl = "";
    this.error = "";
    try {
      const result = (await this.rpc("tenant.wecom.register.begin")) as {
        scode: string;
        authUrl: string;
        qrPageUrl: string;
        interval: number;
        expireIn: number;
      };
      this.wecomScode = result.scode;
      this.wecomVerificationUrl = result.authUrl;
      this.wecomQrPageUrl = result.qrPageUrl;
      this.wecomPolling = true;
      this.wecomInitializing = false;
      this.startWecomPoll(result.interval);
    } catch (e) {
      this.wecomInitializing = false;
      this.error = e instanceof Error ? e.message : t("onboarding.saveFailed");
    }
  }

  private startWecomPoll(intervalSec: number) {
    this.stopWecomPoll();
    this.wecomPollTimer = setInterval(
      async () => {
        try {
          const result = (await this.rpc("tenant.wecom.register.poll", {
            scode: this.wecomScode,
          })) as {
            status: "completed" | "pending" | "error";
            botId?: string;
            secret?: string;
            error?: string;
          };
          if (result.status === "completed" && result.botId && result.secret) {
            this.stopWecomPoll();
            this.channelAppId = result.botId;
            this.channelAppSecret = result.secret;
            this.wecomPolling = false;
            this.wecomMode = "manual";
          } else if (result.status === "error") {
            this.stopWecomPoll();
            this.wecomPolling = false;
            this.error = result.error ?? t("onboarding.saveFailed");
          }
        } catch {
          /* ignore transient errors */
        }
      },
      Math.max(intervalSec, 3) * 1000,
    );
  }

  private stopWecomPoll() {
    if (this.wecomPollTimer) {
      clearInterval(this.wecomPollTimer);
      this.wecomPollTimer = undefined;
    }
  }

  private setWecomMode(mode: "scan" | "manual") {
    this.wecomMode = mode;
    this.stopWecomPoll();
    this.wecomPolling = false;
    this.wecomVerificationUrl = "";
    this.wecomQrPageUrl = "";
    this.wecomInitializing = false;
    if (mode === "scan") {
      void this.startWecomScan();
    }
  }

  // ── Step validation (local only, no API calls) ──
  private validateChannel() {
    if (!this.selectedChannel) {
      this.error = t("onboarding.selectChannel");
      return false;
    }
    this.channelAppId = this.channelAppId.trim();
    this.channelAppSecret = this.channelAppSecret.trim();
    this.channelBotName = this.channelBotName.trim();
    if (!this.channelAppId) {
      this.error = t("onboarding.appIdRequired");
      return false;
    }
    if (!this.channelAppSecret) {
      this.error = t("onboarding.appSecretRequired");
      return false;
    }
    return true;
  }

  private validateModel() {
    if (this.modelMode === "shared") {
      if (!this.selectedSharedModelId || !this.selectedSharedSubModelId) {
        this.error = t("onboarding.selectModel");
        return false;
      }
      return true;
    }
    this.modelApiKey = this.modelApiKey.trim();
    this.modelBaseUrl = this.modelBaseUrl.trim();
    this.modelName = this.modelName.trim();
    if (!this.selectedProvider) {
      this.error = t("onboarding.selectModel");
      return false;
    }
    if (!this.modelApiKey) {
      this.error = t("onboarding.apiKeyRequired");
      return false;
    }
    if (!this.modelBaseUrl) {
      this.error = t("onboarding.baseUrlRequired");
      return false;
    }
    if (!this.modelName) {
      this.error = t("onboarding.modelNameRequired");
      return false;
    }
    return true;
  }

  private nextModel() {
    if (!this.validateModel()) {
      return;
    }
    this.goNext();
  }

  private nextChannel() {
    if (this.selectedChannel && !this.validateChannel()) {
      return;
    }
    this.submitAll();
  }

  // ── Submit all at once via batch API ──
  private async submitAll() {
    this.saving = true;
    this.error = "";

    try {
      const isShared = this.modelMode === "shared";
      const provider = isShared
        ? null
        : MODEL_PROVIDERS.find((p) => p.type === this.selectedProvider)!;

      await this.rpc("tenant.onboarding.setup", {
        channel: this.selectedChannel
          ? {
              channelType: this.selectedChannel,
              channelName: this.selectedChannel,
              config: {
                appId: this.channelAppId || undefined,
                appSecret: this.channelAppSecret || undefined,
                botName: this.channelBotName || undefined,
              },
            }
          : undefined,
        model: isShared
          ? undefined
          : {
              providerType: provider!.type,
              providerName: provider!.label,
              apiProtocol: provider!.protocol,
              apiKeyEncrypted: this.modelApiKey,
              baseUrl: this.modelBaseUrl || undefined,
              models: this.modelName ? [{ id: this.modelName, name: this.modelName }] : [],
            },
        sharedModel: isShared
          ? {
              providerId: this.selectedSharedModelId,
              modelId: this.selectedSharedSubModelId,
            }
          : undefined,
        agent: { name: t("onboarding.defaultAgentName") },
        locale: i18n.getLocale(),
      });

      this.channelCreated = !!this.selectedChannel;
      this.modelCreated = true;
      this.agentCreated = true;
      this.goNext();
    } catch (e) {
      // Show a localized quota-exceeded message when the backend rejects
      // the setup because the tenant's plan limits are reached.
      const q = quotaErrorKey(e);
      if (q) {
        this.error = t(q.key, q.params);
        this.errorIsHtml = true;
      } else {
        this.error = e instanceof Error ? e.message : t("onboarding.saveFailed");
        this.errorIsHtml = false;
      }
    } finally {
      this.saving = false;
    }
  }

  // ── Render ──
  render() {
    return html`
      ${
        this.showSkipConfirm
          ? html`
        <div class="confirm-overlay">
          <div class="confirm-dialog">
            <h3>${t("onboarding.skipConfirmTitle")}</h3>
            <p>${t("onboarding.skipConfirmDesc")}</p>
            <div class="confirm-actions">
              <button class="btn btn-ghost" @click=${() => this.cancelSkip()}>${t("onboarding.continueSetup")}</button>
              <button class="btn btn-primary" @click=${() => this.confirmSkip()}>${t("onboarding.confirmSkip")}</button>
            </div>
          </div>
        </div>
      `
          : nothing
      }
      <div class="wizard">
        ${
          this.step !== "welcome" && this.step !== "done"
            ? html`
          <div class="progress">
            ${["model", "channel"].map((s, i) => {
              const currentIdx = STEPS.indexOf(this.step) - 1;
              const cls = i < currentIdx ? "done" : i === currentIdx ? "active" : "";
              return html`<div class="progress-step ${cls}"></div>`;
            })}
          </div>
        `
            : nothing
        }

        ${this.step === "welcome" ? this.renderWelcome() : nothing}
        ${this.step === "model" ? this.renderModel() : nothing}
        ${this.step === "channel" ? this.renderChannel() : nothing}
        ${this.step === "done" ? this.renderDone() : nothing}
      </div>
    `;
  }

  private renderWelcome() {
    return html`
      <div class="wizard-header">
        <div class="wizard-icon">🎉</div>
        <h2 class="wizard-title">${t("onboarding.welcomeTitle")}</h2>
        <p class="wizard-desc">${t("onboarding.welcomeDesc")}</p>
      </div>
      <div class="wizard-actions" style="justify-content:center; gap:1rem;">
        <button class="btn btn-primary" @click=${() => this.goNext()}>${t("onboarding.startSetup")}</button>
        <button class="btn btn-ghost" @click=${() => this.skip()}>${t("onboarding.skipAll")}</button>
      </div>
    `;
  }

  private renderChannel() {
    const isFeishu = this.selectedChannel === "feishu";
    const isWecom = this.selectedChannel === "wecom";
    const isDingtalk = this.selectedChannel === "dingtalk";
    const showManualForm =
      this.selectedChannel &&
      (!isFeishu || this.feishuMode === "manual") &&
      (!isWecom || this.wecomMode === "manual");
    const appIdLabel = isWecom ? "Bot ID" : isDingtalk ? "Client ID (AppKey)" : "App ID";
    const appSecretLabel = isWecom
      ? "Secret"
      : isDingtalk
        ? "Client Secret (AppSecret)"
        : "App Secret";
    return html`
      <div class="step-indicator">${t("onboarding.step", { current: "2", total: "2" })}</div>
      <div class="wizard-header">
        <h2 class="wizard-title">${t("onboarding.channelTitle")}</h2>
        <p class="wizard-desc">${t("onboarding.channelDesc")}</p>
      </div>

      ${
        this.error
          ? html`<div class="error-msg">${this.errorIsHtml ? unsafeHTML(this.error) : this.error}</div>`
          : nothing
      }

      <div class="options-grid">
        ${CHANNEL_OPTIONS.map(
          (ch) => html`
          <div class="option-card ${this.selectedChannel === ch.type ? "selected" : ""}"
            @click=${() => {
              const prev = this.selectedChannel;
              if (prev === ch.type) {
                return;
              }
              // Switching channel type invalidates any credentials the user
              // started entering (or that were scanned for a different type).
              this.channelAppId = "";
              this.channelAppSecret = "";
              this.channelBotName = "";
              this.selectedChannel = ch.type;
              if (ch.type === "feishu") {
                this.feishuMode = "scan";
                void this.startFeishuScan();
              } else {
                this.stopFeishuPoll();
              }
              if (ch.type === "wecom") {
                this.wecomMode = "scan";
                void this.startWecomScan();
              } else {
                this.stopWecomPoll();
              }
            }}>
            <span class="option-icon">${unsafeHTML(CHANNEL_ICONS[ch.type] ?? "")}</span>
            <span>${t(ch.labelKey)}</span>
          </div>
        `,
        )}
      </div>

      ${
        isFeishu
          ? html`
        <div class="feishu-mode-bar">
          <button type="button" class="feishu-mode-btn ${this.feishuMode === "scan" ? "active" : ""}"
            @click=${() => this.setFeishuMode("scan")}>📱 ${t("onboarding.feishuScan")}</button>
          <button type="button" class="feishu-mode-btn ${this.feishuMode === "manual" ? "active" : ""}"
            @click=${() => this.setFeishuMode("manual")}>⌨️ ${t("onboarding.feishuManual")}</button>
        </div>
        ${
          this.feishuMode === "scan"
            ? html`
          ${
            this.feishuVerificationUrl
              ? html`
            <div class="qr-container">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(this.feishuVerificationUrl)}" alt="QR Code" />
            </div>
            <div class="qr-hint">${t("onboarding.feishuScanHint")}</div>
            ${
              this.feishuPolling
                ? html`
              <div class="qr-polling">
                <span class="dot">●</span> ${t("onboarding.feishuPolling")}
              </div>
            `
                : nothing
            }
          `
              : html`
            <div class="qr-hint">${this.feishuInitializing ? t("onboarding.feishuInitializing") : ""}</div>
          `
          }
        `
            : nothing
        }
      `
          : nothing
      }

      ${
        isWecom
          ? html`
        <div class="feishu-mode-bar">
          <button type="button" class="feishu-mode-btn ${this.wecomMode === "scan" ? "active" : ""}"
            @click=${() => this.setWecomMode("scan")}>📱 ${t("onboarding.wecomScan")}</button>
          <button type="button" class="feishu-mode-btn ${this.wecomMode === "manual" ? "active" : ""}"
            @click=${() => this.setWecomMode("manual")}>⌨️ ${t("onboarding.wecomManual")}</button>
        </div>
        ${
          this.wecomMode === "scan"
            ? html`
          ${
            this.wecomVerificationUrl
              ? html`
            <div class="qr-container">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(this.wecomVerificationUrl)}" alt="QR Code" />
            </div>
            <div class="qr-hint">${t("onboarding.wecomScanHint")}</div>
            ${
              this.wecomQrPageUrl
                ? html`
              <div class="qr-hint"><a href=${this.wecomQrPageUrl} target="_blank" rel="noopener noreferrer" style="color:var(--accent,#3b82f6)">${t("onboarding.wecomOpenQrPage")}</a></div>
            `
                : nothing
            }
            ${
              this.wecomPolling
                ? html`
              <div class="qr-polling">
                <span class="dot">●</span> ${t("onboarding.wecomPolling")}
              </div>
            `
                : nothing
            }
          `
              : html`
            <div class="qr-hint">${this.wecomInitializing ? t("onboarding.wecomInitializing") : ""}</div>
          `
          }
        `
            : nothing
        }
      `
          : nothing
      }

      ${
        showManualForm
          ? html`
        <div class="form-group">
          <label>${appIdLabel} <span class="required">*</span></label>
          <input type="text" .value=${this.channelAppId}
            @input=${(e: InputEvent) => {
              this.channelAppId = (e.target as HTMLInputElement).value;
            }} />
        </div>
        <div class="form-group">
          <label>${appSecretLabel} <span class="required">*</span></label>
          <div class="secret-wrap">
            <input type="password" .value=${this.channelAppSecret}
              @input=${(e: InputEvent) => {
                this.channelAppSecret = (e.target as HTMLInputElement).value;
              }} />
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
        <div class="form-group">
          <label>${t("tenantChannels.botName")}</label>
          <input type="text" .placeholder=${t("tenantChannels.botNamePlaceholder")}
            .value=${this.channelBotName}
            @input=${(e: InputEvent) => {
              this.channelBotName = (e.target as HTMLInputElement).value;
            }} />
        </div>
      `
          : nothing
      }

      <div class="wizard-actions">
        <button class="btn btn-ghost" @click=${() => this.goBack()}>${t("onboarding.back")}</button>
        <div>
          <button class="btn btn-ghost" @click=${() => this.skip()}>${t("onboarding.skip")}</button>
          <button class="btn btn-primary" ?disabled=${this.saving || !this.selectedChannel || !this.channelAppId || !this.channelAppSecret}
            @click=${() => this.nextChannel()}>
            ${this.saving ? t("onboarding.saving") : t("onboarding.complete")}
          </button>
        </div>
      </div>
    `;
  }

  private get modelNextDisabled(): boolean {
    if (this.saving) {
      return true;
    }
    if (this.modelMode === "shared") {
      return !this.selectedSharedModelId || !this.selectedSharedSubModelId;
    }
    return !this.selectedProvider || !this.modelApiKey || !this.modelBaseUrl || !this.modelName;
  }

  private renderModel() {
    const provider = MODEL_PROVIDERS.find((p) => p.type === this.selectedProvider);
    const hasShared = this.sharedModels.length > 0;
    const selectedSharedProvider = this.sharedModels.find(
      (m) => m.id === this.selectedSharedModelId,
    );

    return html`
      <div class="step-indicator">${t("onboarding.step", { current: "1", total: "2" })}</div>
      <div class="wizard-header">
        <h2 class="wizard-title">${t("onboarding.modelTitle")}</h2>
        <p class="wizard-desc">${t("onboarding.modelDesc")}</p>
      </div>

      ${
        this.error
          ? html`<div class="error-msg">${this.errorIsHtml ? unsafeHTML(this.error) : this.error}</div>`
          : nothing
      }

      ${
        hasShared
          ? html`
        <div style="display:flex;gap:1.25rem;margin-bottom:1.25rem;justify-content:center">
          <button class="btn ${this.modelMode === "shared" ? "btn-primary" : ""}"
            style="${this.modelMode !== "shared" ? "background:transparent;border:1px solid var(--border,#404040);color:var(--text,#e5e5e5)" : ""}"
            @click=${() => {
              this.modelMode = "shared";
              this.error = "";
            }}>
            ${t("onboarding.useSharedModel")}
          </button>
          <button class="btn ${this.modelMode === "custom" ? "btn-primary" : ""}"
            style="${this.modelMode !== "custom" ? "background:transparent;border:1px solid var(--border,#404040);color:var(--text,#e5e5e5)" : ""}"
            @click=${() => {
              this.modelMode = "custom";
              this.error = "";
            }}>
            ${t("onboarding.useCustomModel")}
          </button>
        </div>
      `
          : nothing
      }

      ${
        this.modelMode === "shared" && hasShared
          ? html`
        <div class="options-grid">
          ${this.sharedModels.map(
            (sm) => html`
            <div class="option-card ${this.selectedSharedModelId === sm.id ? "selected" : ""}"
              @click=${() => {
                this.selectedSharedModelId = sm.id;
                this.selectedSharedSubModelId = sm.models[0]?.id ?? "";
              }}>
              <span>${sm.providerName}</span>
            </div>
          `,
          )}
        </div>

        ${
          selectedSharedProvider && selectedSharedProvider.models.length > 1
            ? html`
          <div class="form-group">
            <label>${t("onboarding.selectSubModel")}</label>
            <select @change=${(e: Event) => {
              this.selectedSharedSubModelId = (e.target as HTMLSelectElement).value;
            }}>
              ${selectedSharedProvider.models.map(
                (m) => html`
                <option value=${m.id} ?selected=${this.selectedSharedSubModelId === m.id}>${m.name}</option>
              `,
              )}
            </select>
          </div>
        `
            : nothing
        }

        ${
          selectedSharedProvider && selectedSharedProvider.models.length === 1
            ? html`
          <div style="font-size:0.85rem;color:var(--text-secondary,#a3a3a3);margin-top:0.5rem">
            ${t("onboarding.selectedModel")}: <strong>${selectedSharedProvider.models[0].name}</strong>
          </div>
        `
            : nothing
        }
      `
          : html`
        <div class="options-grid">
          ${MODEL_PROVIDERS.map(
            (p) => html`
            <div class="option-card ${this.selectedProvider === p.type ? "selected" : ""}"
              @click=${() => {
                this.selectedProvider = p.type;
                this.modelBaseUrl = p.baseUrl;
              }}>
              <span>${p.label}</span>
            </div>
          `,
          )}
        </div>

        ${
          this.selectedProvider
            ? html`
          <div class="form-group">
            <label>API ${t("onboarding.apiAddress")} <span class="required">*</span></label>
            <input type="text" .value=${this.modelBaseUrl}
              @input=${(e: InputEvent) => {
                this.modelBaseUrl = (e.target as HTMLInputElement).value;
              }}
              placeholder="https://api.openai.com/v1" />
          </div>
          <div class="form-group">
            <label>API Key <span class="required">*</span></label>
            <div class="secret-wrap">
              <input type="password" .value=${this.modelApiKey}
                @input=${(e: InputEvent) => {
                  this.modelApiKey = (e.target as HTMLInputElement).value;
                }}
                placeholder=${provider?.placeholder ?? ""} />
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
          <div class="form-group">
            <label>${t("onboarding.modelId")} <span class="required">*</span></label>
            <input type="text" .value=${this.modelName}
              @input=${(e: InputEvent) => {
                this.modelName = (e.target as HTMLInputElement).value;
              }}
              placeholder="gpt-4o / claude-sonnet-4 / deepseek-chat" />
            <div class="form-hint">${t("onboarding.modelHint")}</div>
          </div>
        `
            : nothing
        }
      `
      }

      <div class="wizard-actions">
        <button class="btn btn-ghost" @click=${() => this.skip()}>${t("onboarding.skip")}</button>
        <button class="btn btn-primary" ?disabled=${this.modelNextDisabled}
          @click=${() => this.nextModel()}>
          ${t("onboarding.next")}
        </button>
      </div>
    `;
  }

  private renderDone() {
    return html`
      <div class="wizard-header">
        <div class="wizard-icon">✅</div>
        <h2 class="wizard-title">${t("onboarding.doneTitle")}</h2>
        <p class="wizard-desc bright">${t("onboarding.doneDesc")}</p>
      </div>

      <ul class="checklist">
        <li>
          <span class="check-icon ${this.modelCreated ? "done" : "skip"}">${this.modelCreated ? "✓" : "—"}</span>
          ${t("onboarding.modelTitle")}
        </li>
        <li>
          <span class="check-icon ${this.agentCreated ? "done" : "skip"}">${this.agentCreated ? "✓" : "—"}</span>
          ${t("onboarding.agentTitle")}
        </li>
        <li>
          <span class="check-icon ${this.channelCreated ? "done" : "skip"}">${this.channelCreated ? "✓" : "—"}</span>
          ${t("onboarding.channelTitle")}
        </li>
      </ul>

      <div class="wizard-actions" style="justify-content:center;">
        <button class="btn btn-success" @click=${() => this.close()}>${t("onboarding.enterConsole")}</button>
      </div>
    `;
  }
}
