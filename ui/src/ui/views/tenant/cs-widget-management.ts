/**
 * Widget Management standalone view — extracted from cs-setup.ts (ST-C3).
 *
 * Provides full widget management for the cs-widget-management tab:
 *   - Multi-instance widget list (up to MAX_CHANNELS = 3)
 *   - Per-widget: agent select, enabled/disabled toggle, embed code with data-widget-id
 *   - Create / edit / delete widgets (cap 3)
 *   - Shared 飞书 notification config (all widgets share one config)
 *   - 2 restriction checkboxes (strictKnowledgeBase + hideInternals)
 *   - AI config (system prompt + restrictions)
 *
 * Widget 管理独立视图（ST-C3 从 cs-setup.ts 抽取）。
 * 包含完整 widget 管理能力：多实例列表、per-widget agent/启用状态/嵌入代码、
 * 飞书共用通知配置、行为限制勾选。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { I18nController, t } from "../../../i18n/index.ts";
import { loadAuth } from "../../auth-store.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { applyRecommendedPersona } from "../../lib/apply-recommended-persona.ts";
import { caretFix } from "../../shared-styles.ts";
import { loadSettings } from "../../storage.ts";
import { tenantRpc } from "./rpc.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_CHANNELS = 3;

// ── Types ──────────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

/** A tenant agent that can be bound to a widget. 可绑定到 widget 的租户 agent。 */
interface TenantAgent {
  agentId: string;
  name: string | null;
}

type ChannelMode = "initial" | "locked" | "editing";

/**
 * A widget instance (a "渠道") managed on this page.
 * Mirrors the persisted CSConfig.channels[] shape (id/label/html/agentId/enabled)
 * plus local-only UI state (mode/prevLabel/prevHtml/expanded) for the edit lifecycle.
 *
 * Widget（渠道）实例，与持久化的 channels[] 字段一一对应，额外携带编辑生命周期的本地 UI 状态。
 */
interface Channel {
  /** Stable widget id. Empty for a not-yet-saved new widget; server assigns on save. 稳定 id；新建未保存时为空，保存时服务端分配。 */
  id: string;
  label: string;
  html: string | null;
  /** Per-widget bound AI 员工; undefined → use tenant default. 绑定的 AI 员工，未设置则用租户默认。 */
  agentId?: string;
  /** Widget status. 启用状态。 */
  enabled: boolean;
  mode: ChannelMode;
  prevLabel: string;
  prevHtml: string | null;
  /** Whether the code block is expanded. Default false (collapsed). 嵌入代码是否展开，默认折叠。 */
  expanded: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

@customElement("cs-widget-management-view")
export class CSWidgetManagementView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }

      h2 {
        margin: 0 0 4px;
        font-size: 16px;
        font-weight: 600;
      }
      h3 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
      }

      .section {
        margin-bottom: 28px;
      }

      /* Toast — fixed top-right */
      .toast {
        position: fixed;
        top: 24px;
        right: 24px;
        background: var(--color-bg, #fff);
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 8px;
        padding: 10px 18px;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        z-index: 9999;
        animation: toastIn 0.2s ease;
        min-width: 160px;
      }
      .toast.ok {
        border-left: 4px solid var(--color-success, #1a7f37);
      }
      .toast.err {
        border-left: 4px solid var(--color-danger, #cf222e);
      }
      @keyframes toastIn {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* Guide section — summary IS the .guide element */
      summary.guide {
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        user-select: none;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--color-bg-secondary, #f6f8fa);
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 8px;
        padding: 12px 16px;
      }
      summary.guide::marker,
      summary.guide::-webkit-details-marker {
        display: none;
      }
      summary.guide::before {
        content: "▶";
        font-size: 10px;
        transition: transform 0.15s;
        flex-shrink: 0;
      }
      details[open] > summary.guide::before {
        transform: rotate(90deg);
      }
      details[open] > summary.guide {
        border-radius: 8px 8px 0 0;
        border-bottom: none;
      }

      .guide-body {
        font-size: 13px;
        line-height: 1.6;
        color: var(--color-text, #1c1c1e);
        background: var(--color-bg-secondary, #f6f8fa);
        border: 1px solid var(--color-border, #e1e4e8);
        border-top: none;
        border-radius: 0 0 8px 8px;
        padding: 16px 20px;
        margin-bottom: 0;
      }

      .guide-body table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 12px;
      }

      .guide-body th,
      .guide-body td {
        text-align: left;
        padding: 6px 10px;
        border-bottom: 1px solid var(--color-border, #e1e4e8);
        font-size: 13px;
      }

      .guide-body th {
        font-weight: 600;
        color: var(--color-text-secondary, #6a737d);
        font-size: 12px;
        background: var(--color-bg, #fff);
      }

      .guide-body code {
        background: var(--color-bg, #fff);
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 3px;
        padding: 1px 5px;
        font-family: monospace;
        font-size: 12px;
      }

      /* Form fields */
      .form-group {
        margin-bottom: 18px;
      }

      .form-group label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 5px;
        color: var(--color-text, #1c1c1e);
      }

      .form-group .hint {
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
        margin-top: 3px;
      }

      select {
        width: 100%;
        max-width: 480px;
        padding: 8px 10px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
        box-sizing: border-box;
        cursor: pointer;
      }
      select:focus {
        border-color: var(--color-accent, #0969da);
      }

      .skills-toggle {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 7px 10px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        background: var(--color-bg-secondary, #f6f8fa);
        cursor: pointer;
        user-select: none;
      }
      .skills-toggle input[type="checkbox"] {
        width: 14px;
        height: 14px;
        cursor: pointer;
        flex-shrink: 0;
        margin-top: 2px;
      }
      .skills-toggle-label {
        font-size: 12px;
        font-weight: 500;
        line-height: 1.4;
      }
      .skills-toggle-hint {
        font-size: 11px;
        color: var(--color-text-secondary, #6a737d);
        margin-top: 2px;
        line-height: 1.4;
      }

      textarea {
        width: 100%;
        max-width: 640px;
        padding: 10px 12px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        line-height: 1.6;
        resize: vertical;
        outline: none;
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
        box-sizing: border-box;
        min-height: 220px;
      }
      textarea:focus {
        border-color: var(--color-accent, #0969da);
      }

      .prompt-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
      }

      input[type="text"],
      input[type="password"] {
        width: 100%;
        max-width: 480px;
        padding: 8px 10px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
        box-sizing: border-box;
      }

      input:focus {
        border-color: var(--color-accent, #0969da);
      }
      input[readonly] {
        background: var(--color-bg-secondary, #f6f8fa);
        color: var(--color-text-secondary, #6a737d);
        cursor: default;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 16px;
      }

      .btn {
        padding: 7px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid transparent;
        font-weight: 500;
        white-space: nowrap;
      }

      .btn-primary {
        background: var(--color-accent, #0969da);
        color: #fff;
        border-color: var(--color-accent, #0969da);
      }

      .btn-primary:hover {
        opacity: 0.85;
      }

      .btn-secondary {
        background: transparent;
        color: var(--color-accent, #0969da);
        border-color: var(--color-accent, #0969da);
      }

      .btn-secondary:hover {
        background: var(--color-accent-muted, #ddf4ff);
      }

      .btn-ghost {
        background: var(--color-bg-secondary, #f6f8fa);
        color: var(--color-text, #1c1c1e);
        border-color: var(--color-border, #e1e4e8);
      }

      .btn-ghost:hover {
        background: var(--color-bg-hover, #eaeef2);
      }

      .btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Check results */
      .check-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 14px;
        margin-bottom: 8px;
      }

      .check-header h4 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }

      .check-ts {
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
      }

      .check-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .check-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 13px;
      }

      .check-icon {
        font-size: 14px;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .check-name {
        font-weight: 600;
        margin-right: 4px;
      }
      .check-msg {
        color: var(--color-text-secondary, #6a737d);
      }

      /* Channel rows */
      .channel-block {
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 8px;
        padding: 14px 16px;
        margin-bottom: 12px;
        background: var(--color-bg, #fff);
      }

      .channel-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }

      .channel-label-input {
        width: 200px;
        padding: 6px 10px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
      }

      .channel-label-input:focus {
        border-color: var(--color-accent, #0969da);
      }

      .channel-label-input[readonly] {
        background: var(--color-bg-secondary, #f6f8fa);
        color: var(--color-text-secondary, #6a737d);
        cursor: default;
      }

      .channel-num {
        font-weight: 600;
        font-size: 13px;
        color: var(--color-text-secondary, #6a737d);
        min-width: 48px;
      }

      .channel-error {
        font-size: 12px;
        color: var(--color-danger, #cf222e);
      }

      /* Disabled widget — dim the card to signal inactive state */
      .channel-block.disabled {
        opacity: 0.6;
      }

      /* Page-level widget error banner */
      .widget-error-banner {
        font-size: 13px;
        color: var(--color-danger, #cf222e);
        background: var(--color-danger-muted, #ffebe9);
        border: 1px solid var(--color-danger, #cf222e);
        border-radius: 6px;
        padding: 8px 12px;
        margin-bottom: 12px;
      }

      /* Per-widget controls row: agent select + status toggle */
      .widget-controls {
        display: flex;
        gap: 24px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .widget-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .widget-field-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text-secondary, #6a737d);
      }

      .widget-field select {
        width: 240px;
        max-width: 240px;
      }

      .status-toggle {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 14px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        border: 1px solid var(--color-border, #e1e4e8);
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
      }

      .status-toggle .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-toggle.on {
        border-color: var(--color-success, #1a7f37);
        color: var(--color-success, #1a7f37);
      }
      .status-toggle.on .status-dot {
        background: var(--color-success, #1a7f37);
      }
      .status-toggle.off {
        color: var(--color-text-secondary, #6a737d);
      }
      .status-toggle.off .status-dot {
        background: var(--color-text-secondary, #6a737d);
      }
      .status-toggle:hover {
        background: var(--color-bg-hover, #eaeef2);
      }

      /* Generated HTML code */
      .code-block {
        background: var(--color-bg-secondary, #f6f8fa);
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        padding: 12px 14px;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--color-text, #1c1c1e);
        margin: 10px 0 8px;
        max-height: 160px;
        overflow-y: auto;
      }

      .code-actions {
        display: flex;
        gap: 8px;
      }

      .add-channel-row {
        margin-top: 4px;
      }

      .divider {
        border: none;
        border-top: 1px solid var(--color-border, #e1e4e8);
        margin: 24px 0;
      }

      /* Two-column config grid */
      .config-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 32px;
        align-items: start;
      }
      @media (max-width: 860px) {
        .config-grid {
          grid-template-columns: 1fr;
          gap: 0;
        }
      }

      /* Restriction checkboxes: 2x2 grid */
      .restrictions-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        max-width: 640px;
      }
      @media (max-width: 640px) {
        .restrictions-grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];

  // ── Properties ───────────────────────────────────────────────────────────────

  /** Gateway URL passed in from app-render; used to mirror cs-setup prop pattern. 从 app-render 传入的 Gateway 地址。 */
  @property({ type: String }) gatewayUrl = "";

  // ── Widget-only state ─────────────────────────────────────────────────────────

  @state() private channels: Channel[] = [
    {
      id: "",
      label: "default",
      html: null,
      agentId: undefined,
      enabled: true,
      mode: "initial",
      prevLabel: "default",
      prevHtml: null,
      expanded: false,
    },
  ];
  @state() private channelErrors: Record<number, string> = {};
  @state() private copiedIdx: number | null = null;
  /** Page-level widget error banner (save/delete/toggle failures). 组件管理区错误提示。 */
  @state() private widgetError = "";
  /** Tenant agents for the per-widget agent dropdown. 用于 widget 关联 AI 员工下拉。 */
  @state() private _agents: TenantAgent[] = [];
  /** Per-widget persona applying flag. 各 widget 启用推荐配置的加载状态。 */
  @state() private _personaApplying: Record<number, boolean> = {};
  /** Per-widget persona error. 各 widget 启用推荐配置的错误信息。 */
  @state() private _personaErrors: Record<number, string> = {};
  @state() private _widgetRecommended: Record<number, boolean> = {};

  // ── Shared config state (notification + restrictions + AI config) ─────────────

  @state() private customSystemPrompt = "";
  @state() private companyName = "EC";
  /** The rendered default prompt (company name substituted). Used by "restore default". */
  private _defaultPrompt = "";
  @state() private notificationChannel = "feishu";
  @state() private appId = "";
  @state() private appSecret = "";
  @state() private appSecretPlaceholder = "";
  @state() private hasExistingSecret = false;
  @state() private chatId = "";
  @state() private notifyIntervalMinutes = 10;
  @state() private restrictions = {
    strictKnowledgeBase: true,
    hideInternals: true,
  };
  @state() private saving = false;
  @state() private testing = false;
  @state() private checkResults: CheckResult[] | null = null;
  @state() private checkResultsAt: string | null = null;
  @state() private loading = true;
  @state() private toast: { text: string; ok: boolean } | null = null;

  private _toastTimer?: ReturnType<typeof setTimeout>;
  private _i18n = new I18nController(this);

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    void this._loadConfig();
    void this._fetchAgents();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._toastTimer);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private get tenantId(): string | undefined {
    return loadAuth()?.user?.tenantId;
  }

  /** True when config has been saved and test can run. */
  private get _canTest(): boolean {
    return !!(this.appId && this.chatId && (this.hasExistingSecret || this.appSecret));
  }

  private _showToast(text: string, ok: boolean) {
    clearTimeout(this._toastTimer);
    this.toast = { text, ok };
    this._toastTimer = setTimeout(() => {
      this.toast = null;
    }, 3000);
  }

  /**
   * Fetch tenant agents for the per-widget agent dropdown.
   * Best-effort: on failure the select just shows the "default" option only.
   * 拉取租户 agent 列表用于 widget 关联下拉；失败时下拉仅保留"默认"项，不阻塞页面。
   */
  private async _fetchAgents() {
    try {
      const result = (await tenantRpc("tenant.agents.list", {})) as { agents: TenantAgent[] };
      this._agents = result.agents ?? [];
    } catch {
      this._agents = [];
    }
  }

  /** Resolve an agentId to its display name; falls back to the id, then "default". 将 agentId 解析为名称。 */
  private _agentName(agentId: string | undefined): string {
    if (!agentId) {
      return t("cs.widget.agentDefault");
    }
    const agent = this._agents.find((a) => a.agentId === agentId);
    return agent?.name ?? agentId;
  }

  // ── Persona shortcuts ──────────────────────────────────────────────────────────

  /**
   * Apply recommended CS persona to the agent bound to the widget at the given index.
   * 将推荐客服人设写入指定索引 widget 绑定的 agent。
   */
  private async _applyPersonaForWidget(idx: number): Promise<boolean> {
    const agentId = this.channels[idx]?.agentId;
    if (!agentId || this._personaApplying[idx]) {
      return false;
    }
    this._personaApplying = { ...this._personaApplying, [idx]: true };
    this._personaErrors = { ...this._personaErrors, [idx]: "" };
    try {
      const agentName = this._agentName(agentId);
      const confirmed = await showConfirm({
        title: t("agents.persona.recommended.btn"),
        message: `将为${agentName}覆盖当前“人设与规范”为系统推荐配置。`,
        confirmText: t("agents.persona.recommended.btn"),
        cancelText: "取消",
      });
      if (!confirmed) {
        return false;
      }
      const rpc = (method: string, params?: Record<string, unknown>) =>
        tenantRpc(method, params ?? {}, this.gatewayUrl || undefined);
      const result = await applyRecommendedPersona(agentId, rpc);
      if (!result.ok && result.error) {
        this._personaErrors = { ...this._personaErrors, [idx]: result.error };
        return false;
      }
      return true;
    } finally {
      this._personaApplying = { ...this._personaApplying, [idx]: false };
    }
  }

  /**
   * Navigate to the persona tab of the agent bound to the widget at the given index.
   * 派发 navigate-to-agent 事件，跳转到指定索引 widget 绑定 agent 的人设与规范标签页。
   */
  private async _navigateToPersonaForWidget(idx: number) {
    const agentId = this.channels[idx]?.agentId;
    if (!agentId) {
      return;
    }
    const agentName = this._agentName(agentId);
    const confirmed = await showConfirm({
      title: t("agents.persona.recommended.manualEditBtn"),
      message: `手动修改，将前往${agentName}配置页面手动修改“人设与规范”。`,
      confirmText: t("agents.persona.recommended.manualEditBtn"),
      cancelText: "取消",
    });
    if (!confirmed) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("navigate-to-agent", {
        bubbles: true,
        composed: true,
        detail: { agentId, panel: "persona" },
      }),
    );
  }

  private async _loadConfig() {
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }
    this.loading = true;
    try {
      const result = (await tenantRpc("cs.config.get", { tenantId })) as {
        config: {
          notificationChannel?: string;
          feishu: { appId: string; appSecretMasked: string; chatId: string; hasSecret: boolean };
          channels?: Array<{
            id: string;
            label: string;
            html: string;
            agentId?: string;
            enabled: boolean;
          }>;
          notifyIntervalMinutes?: number;
          restrictions?: {
            strictKnowledgeBase?: boolean;
            hideInternals?: boolean;
          };
          companyName?: string;
          customSystemPrompt?: string;
        };
      };
      const cfg = result.config;
      this.companyName = cfg.companyName ?? "EC";
      this.customSystemPrompt = cfg.customSystemPrompt ?? "";
      // Store as the "default" to restore to (server already rendered {companyName}).
      // 服务端已替换企业名，存为"恢复默认"的目标值。
      if (!this._defaultPrompt) {
        this._defaultPrompt = cfg.customSystemPrompt ?? "";
      }
      this.notificationChannel = cfg.notificationChannel ?? "feishu";
      const f = cfg.feishu;
      this.appId = f.appId;
      this.appSecretPlaceholder = f.appSecretMasked;
      this.hasExistingSecret = f.hasSecret;
      this.chatId = f.chatId;
      this.notifyIntervalMinutes = cfg.notifyIntervalMinutes ?? 10;
      const r = cfg.restrictions;
      this.restrictions = {
        strictKnowledgeBase: r?.strictKnowledgeBase ?? true,
        hideInternals: r?.hideInternals ?? true,
      };

      // Restore saved widgets as locked. Carry the new id/agentId/enabled fields.
      // 从配置恢复已保存的 widget，初始锁定（只读），携带 id/agentId/enabled 新字段。
      const saved = result.config.channels ?? [];
      if (saved.length > 0) {
        this.channels = saved.map((ch) => ({
          id: ch.id,
          label: ch.label,
          html: ch.html,
          agentId: ch.agentId,
          enabled: ch.enabled,
          mode: "locked" as ChannelMode,
          prevLabel: ch.label,
          prevHtml: ch.html,
          expanded: false,
        }));
      }
    } catch {
      // config file may not exist yet — that is fine
    } finally {
      this.loading = false;
    }
  }

  /**
   * Persist current widgets to backend config and re-sync from the saved result so
   * that server-assigned ids land back in local state. Only widgets that have a
   * generated embed (html !== null) are saved. Throws on RPC failure so callers
   * can surface an explicit error — no silent swallow.
   *
   * 持久化当前 widget 到后端，并从保存结果回读，使服务端分配的 id 写回本地状态。
   * 仅保存已生成嵌入代码（html !== null）的 widget。RPC 失败时抛出，由调用方显式提示，不静默吞错。
   */
  private async _saveChannels() {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new Error(t("cs.widget.noTenant"));
    }
    const channelsToSave = this.channels
      .filter((ch) => ch.html !== null)
      .map((ch) => ({
        // Omit empty id so the server assigns a fresh one on create.
        // 新建时 id 为空，省略字段让服务端分配。
        ...(ch.id ? { id: ch.id } : {}),
        label: ch.label,
        html: ch.html as string,
        // Omit agentId entirely when unset → falls back to tenant default.
        // 未绑定时省略 agentId → 回退到租户默认 agent。
        ...(ch.agentId ? { agentId: ch.agentId } : {}),
        enabled: ch.enabled,
      }));
    await tenantRpc("cs.config.set", { tenantId, channels: channelsToSave });
    // Re-read so server-assigned ids/normalization flow back into local state,
    // preserving any in-progress (html === null) draft widget that wasn't saved.
    // 回读，使服务端分配的 id / 规范化结果写回本地；保留未保存的草稿 widget（html === null）。
    await this._reloadChannels();
  }

  /**
   * Reload only the widget list from backend, merging server ids/fields back while
   * preserving any local draft widget (one being created, html still null).
   * 仅从后端重载 widget 列表，回填服务端 id/字段，同时保留本地正在创建的草稿 widget。
   */
  private async _reloadChannels() {
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }
    const result = (await tenantRpc("cs.config.get", { tenantId })) as {
      config: {
        channels?: Array<{
          id: string;
          label: string;
          html: string;
          agentId?: string;
          enabled: boolean;
        }>;
      };
    };
    const saved = result.config.channels ?? [];
    const drafts = this.channels.filter((ch) => ch.html === null);
    this.channels = [
      ...saved.map((ch) => ({
        id: ch.id,
        label: ch.label,
        html: ch.html,
        agentId: ch.agentId,
        enabled: ch.enabled,
        mode: "locked" as ChannelMode,
        prevLabel: ch.label,
        prevHtml: ch.html,
        expanded: false,
      })),
      ...drafts,
    ];
  }

  private _validateConfig(): string | null {
    if (!this.appId.trim()) {
      return "请填写飞书 App ID";
    }
    if (!this.hasExistingSecret && !this.appSecret) {
      return "请填写飞书 App Secret";
    }
    if (!this.chatId.trim()) {
      return "请填写飞书群聊 Chat ID";
    }
    return null;
  }

  private async _saveConfig() {
    const validationErr = this._validateConfig();
    if (validationErr) {
      this._showToast(validationErr, false);
      return;
    }
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }
    this.saving = true;
    try {
      await tenantRpc("cs.config.set", {
        tenantId,
        notificationChannel: this.notificationChannel,
        feishu: {
          appId: this.appId,
          // Only send appSecret if user actually typed a new value
          ...(this.appSecret ? { appSecret: this.appSecret } : {}),
          chatId: this.chatId,
        },
        notifyIntervalMinutes: this.notifyIntervalMinutes,
        restrictions: this.restrictions,
        customSystemPrompt: this.customSystemPrompt,
      });
      this._showToast("配置已保存", true);
      this.appSecret = "";
      this.hasExistingSecret = true;
      // Reload to get masked value
      await this._loadConfig();
    } catch (err) {
      this._showToast(err instanceof Error ? err.message : "保存失败", false);
    } finally {
      this.saving = false;
    }
  }

  private async _testConfig() {
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }
    this.testing = true;
    this.checkResults = null;
    this.checkResultsAt = null;
    try {
      const result = (await tenantRpc("cs.config.test", { tenantId })) as { checks: CheckResult[] };
      this.checkResults = result.checks;
      this.checkResultsAt = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (err) {
      this.checkResults = [
        { name: "测试失败", ok: false, message: err instanceof Error ? err.message : String(err) },
      ];
      this.checkResultsAt = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } finally {
      this.testing = false;
    }
  }

  /**
   * Generate a client-side widget id. The id is embedded into the snippet
   * (data-widget-id) so the runtime (T3b) can resolve the widget; it is also sent
   * to the backend, which preserves existing ids during normalization.
   * 生成客户端 widget id，写入嵌入代码（data-widget-id）供运行时（T3b）识别；
   * 同时发往后端，规范化时服务端保留已有 id。
   */
  private _newWidgetId(): string {
    const rnd =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    return `ch_${rnd}`;
  }

  /**
   * Build the embed snippet for a widget. The snippet carries `data-widget-id`
   * (the stable widget id) so the runtime can later identify which widget a visitor
   * connected through (T3b), alongside the existing tenant-id / channel / gateway-url.
   * 构建 widget 嵌入代码，携带 data-widget-id（稳定 id）供运行时识别（T3b），
   * 以及既有 tenant-id / channel / gateway-url。
   */
  private _buildEmbedHtml(widgetId: string, label: string): string {
    const tenantId = this.tenantId ?? "YOUR_TENANT_ID";
    const gatewayUrl = loadSettings().gatewayUrl || "wss://YOUR_EC_DOMAIN";
    // Convert ws(s):// to http(s):// for script src
    const baseUrl = gatewayUrl.replace(/^wss?:\/\//, (m) =>
      m.startsWith("wss") ? "https://" : "http://",
    );
    return [
      `<!-- EC AI 客服 Widget · 渠道: ${label} -->`,
      `<!-- 说明: 将以下代码嵌入到目标页面 <body> 末尾 -->`,
      `<script type="module">`,
      `  import '${baseUrl}/ui/cs-widget.js';`,
      `</script>`,
      `<cs-widget`,
      `  tenant-id="${tenantId}"`,
      `  channel="${label}"`,
      `  data-widget-id="${widgetId}"`,
      `  gateway-url="${gatewayUrl}"`,
      `></cs-widget>`,
    ].join("\n");
  }

  private async _generateHtml(channelIdx: number) {
    const ch = this.channels[channelIdx];
    const label = ch.label.trim();

    if (!label) {
      this.channelErrors = { ...this.channelErrors, [channelIdx]: t("cs.widget.errLabelEmpty") };
      return;
    }
    if (/\s/.test(label)) {
      this.channelErrors = { ...this.channelErrors, [channelIdx]: t("cs.widget.errLabelSpace") };
      return;
    }
    // Uniqueness check
    const duplicate = this.channels.some((c, i) => i !== channelIdx && c.label.trim() === label);
    if (duplicate) {
      this.channelErrors = {
        ...this.channelErrors,
        [channelIdx]: t("cs.widget.errLabelDup"),
      };
      return;
    }
    if (!ch.agentId) {
      this.channelErrors = {
        ...this.channelErrors,
        [channelIdx]: "请选择关联AI员工",
      };
      return;
    }
    if (this._widgetRecommended[channelIdx] ?? true) {
      const applied = await this._applyPersonaForWidget(channelIdx);
      if (!applied) {
        return;
      }
    }

    // Reuse an existing id (edit) or mint one (create). The embed snippet must
    // carry this id so the runtime can identify the widget (T3b).
    // 编辑时复用已有 id，新建时生成；嵌入代码必须携带该 id 供运行时识别（T3b）。
    const widgetId = ch.id || this._newWidgetId();
    const embedHtml = this._buildEmbedHtml(widgetId, label);

    // Clear error, lock widget
    const errs = { ...this.channelErrors };
    delete errs[channelIdx];
    this.channelErrors = errs;

    this.channels = this.channels.map((c, i) =>
      i === channelIdx
        ? {
            ...c,
            id: widgetId,
            label,
            html: embedHtml,
            mode: "locked",
            prevLabel: c.label,
            prevHtml: c.html,
            expanded: false,
          }
        : c,
    );

    // Persist to backend; surface failures explicitly.
    // 持久化到后端；失败显式提示。
    this.widgetError = "";
    try {
      await this._saveChannels();
    } catch (err) {
      this.widgetError = err instanceof Error ? err.message : t("cs.widget.saveError");
    }
  }

  private _startEditChannel(idx: number) {
    this.channels = this.channels.map((c, i) =>
      i === idx
        ? { ...c, mode: "editing", prevLabel: c.label, prevHtml: c.html, expanded: false }
        : c,
    );
  }

  private _cancelEditChannel(idx: number) {
    const ch = this.channels[idx];
    this.channels = this.channels.map((c, i) =>
      i === idx
        ? { ...c, label: ch.prevLabel, html: ch.prevHtml, mode: "locked", expanded: false }
        : c,
    );
    // Clear any error
    const errs = { ...this.channelErrors };
    delete errs[idx];
    this.channelErrors = errs;
  }

  private _addChannel() {
    if (this.channels.length >= MAX_CHANNELS) {
      return;
    }
    this.channels = [
      ...this.channels,
      {
        id: "",
        label: "",
        html: null,
        agentId: undefined,
        enabled: true,
        mode: "initial",
        prevLabel: "",
        prevHtml: null,
        expanded: false,
      },
    ];
  }

  private async _removeChannel(idx: number) {
    this.channels = this.channels.filter((_, i) => i !== idx);
    // Re-index errors
    const errs: Record<number, string> = {};
    Object.entries(this.channelErrors).forEach(([k, v]) => {
      const ki = parseInt(k, 10);
      if (ki < idx) {
        errs[ki] = v;
      } else if (ki > idx) {
        errs[ki - 1] = v;
      }
    });
    this.channelErrors = errs;
    // Persist after remove; surface failures explicitly.
    // 删除后持久化；失败显式提示。
    this.widgetError = "";
    try {
      await this._saveChannels();
    } catch (err) {
      this.widgetError = err instanceof Error ? err.message : t("cs.widget.saveError");
    }
  }

  /**
   * Change a widget's bound AI 员工. Empty string → undefined (use tenant default).
   * Persists immediately for a locked widget; for a draft (not yet generated) it just
   * updates local state and is saved on generate.
   * 修改 widget 绑定的 AI 员工；空串 → undefined（用租户默认）。已锁定 widget 立即持久化，
   * 草稿（未生成）仅更新本地状态，生成时再保存。
   */
  private async _updateChannelAgent(idx: number, value: string) {
    const agentId = value || undefined;
    const ch = this.channels[idx];
    this.channels = this.channels.map((c, i) => (i === idx ? { ...c, agentId } : c));
    // Only persist if the widget has been generated (has an id/html).
    // 仅当 widget 已生成（有 id/html）时才持久化。
    if (ch.html === null) {
      return;
    }
    this.widgetError = "";
    try {
      await this._saveChannels();
    } catch (err) {
      // Revert optimistic change on failure.
      // 失败时回滚乐观更新。
      this.channels = this.channels.map((c, i) => (i === idx ? { ...c, agentId: ch.agentId } : c));
      this.widgetError = err instanceof Error ? err.message : t("cs.widget.saveError");
    }
  }

  /**
   * Toggle a widget's enabled status. Persists immediately; reverts on failure.
   * Only meaningful for a generated widget. 切换 widget 启用状态，立即持久化，失败回滚。
   */
  private async _toggleChannelEnabled(idx: number) {
    const ch = this.channels[idx];
    const next = !ch.enabled;
    this.channels = this.channels.map((c, i) => (i === idx ? { ...c, enabled: next } : c));
    if (ch.html === null) {
      return;
    }
    this.widgetError = "";
    try {
      await this._saveChannels();
    } catch (err) {
      this.channels = this.channels.map((c, i) => (i === idx ? { ...c, enabled: ch.enabled } : c));
      this.widgetError = err instanceof Error ? err.message : t("cs.widget.saveError");
    }
  }

  private _toggleChannelCode(idx: number) {
    this.channels = this.channels.map((c, i) => (i === idx ? { ...c, expanded: !c.expanded } : c));
  }

  private _updateChannelLabel(idx: number, value: string) {
    // Strip spaces as user types
    const cleaned = value.replace(/\s/g, "");
    this.channels = this.channels.map((c, i) => (i === idx ? { ...c, label: cleaned } : c));
  }

  private async _copyHtml(idx: number) {
    const embedHtml = this.channels[idx].html;
    if (!embedHtml) {
      return;
    }
    try {
      await navigator.clipboard.writeText(embedHtml);
      this.copiedIdx = idx;
      setTimeout(() => {
        this.copiedIdx = null;
      }, 2000);
    } catch {
      // clipboard API not available
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────────

  private _renderGuide() {
    return html`
      <div class="section">
        <details>
          <summary class="guide">📖 配置说明 — 各参数说明与获取方式</summary>
          <div class="guide-body">
            <table>
              <thead>
                <tr>
                  <th>参数</th>
                  <th>说明</th>
                  <th>获取方式</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>飞书 App ID</strong></td>
                  <td>飞书应用的唯一标识</td>
                  <td>飞书开放平台 → 企业自建应用 → 凭证与基础信息 → App ID</td>
                </tr>
                <tr>
                  <td><strong>飞书 App Secret</strong></td>
                  <td>应用密钥，用于获取 access token</td>
                  <td>同上页面 → App Secret（点击显示）</td>
                </tr>
                <tr>
                  <td><strong>飞书群聊 Chat ID</strong></td>
                  <td>接收客服通知的群聊 ID</td>
                  <td>在飞书群聊中 → 点右上角「···」→ 群设置 → 查看 Chat ID</td>
                </tr>
                <tr>
                  <td><strong>渠道标签</strong></td>
                  <td>标识来源渠道，出现在会话记录和飞书通知中</td>
                  <td>
                    自定义字符串，不含空格，如 <code>default</code>、<code>website</code>、<code
                      >wechat</code
                    >
                  </td>
                </tr>
              </tbody>
            </table>
            <p>
              生成的 HTML 嵌入代码可以放置在任意网页的 <code>&lt;body&gt;</code> 末尾，
              访客打开页面后右下角即出现 AI 客服悬浮气泡。 嵌入前请确认 EC
              服务可公网访问，否则访客无法连接 Gateway。
            </p>
          </div>
        </details>
      </div>
    `;
  }

  /** Right column: notification settings — shared across all widgets. 通知配置，所有 widget 共用。 */
  private _renderNotifyConfig() {
    return html`
      <div>
        <h3>通知配置</h3>
        <p class="hint" style="margin-bottom:10px">${t("cs.setup.notifSharedHint")}</p>

        <div class="form-group">
          <label>通知渠道</label>
          <select
            .value=${this.notificationChannel}
            @change=${(e: Event) => {
              this.notificationChannel = (e.target as HTMLSelectElement).value;
            }}
          >
            <option value="feishu">飞书通知频道</option>
          </select>
          <p class="hint">当前仅支持飞书,后续渠道上线后可在此切换</p>
        </div>

        <div class="form-group">
          <label>APP ID</label>
          <input
            type="text"
            placeholder="cli_xxxxxxxxxx"
            .value=${this.appId}
            readonly
          />
        </div>
        <div class="form-group">
          <label>APP Secret</label>
          <input
            type="text"
            placeholder=${this.hasExistingSecret ? "已设置" : "未设置"}
            .value=${this.appSecretPlaceholder || (this.hasExistingSecret ? "已设置" : "")}
            readonly
          />
        </div>
        <div class="form-group">
          <label>群聊 Chat ID <span style="color:var(--color-danger,#cf222e)">*</span></label>
          <input
            type="text"
            placeholder="oc_xxxxxxxxxx"
            .value=${this.chatId}
            @input=${(e: Event) => {
              this.chatId = (e.target as HTMLInputElement).value;
            }}
          />
        </div>

        <div class="form-group">
          <label>通知间隔（分钟）</label>
          <input
            type="number"
            min="1"
            max="60"
            style="max-width:100px"
            .value=${String(this.notifyIntervalMinutes)}
            @input=${(e: Event) => {
              const v = parseInt((e.target as HTMLInputElement).value, 10);
              if (!isNaN(v)) {
                this.notifyIntervalMinutes = Math.max(1, Math.min(60, v));
              }
            }}
          />
        </div>

      </div>
    `;
  }

  /** Left column: AI agent settings. AI 配置（系统提示词 + 行为限制）。 */
  private _renderAgentConfig() {
    return html`
      <div>
        <h3>AI 配置</h3>

        <div class="form-group">
          <label>系统提示词</label>
          <p class="hint" style="margin-bottom:8px">定义 AI 客服的角色与行为规则，可直接编辑，保存后生效。</p>
          <textarea
            .value=${this.customSystemPrompt}
            @input=${(e: Event) => {
              this.customSystemPrompt = (e.target as HTMLTextAreaElement).value;
            }}
            spellcheck="false"
          ></textarea>
          <div class="prompt-actions">
            <button
              class="btn btn-ghost"
              @click=${() => {
                this.customSystemPrompt = this._defaultPrompt;
              }}
              title="恢复为默认 prompt（保存后生效）"
            >恢复默认</button>
          </div>
        </div>

        <div class="form-group">
          <label>行为限制</label>
          <p class="hint" style="margin-bottom:10px">勾选启用；取消勾选并保存则去掉该约束。勾选项约束会在客服 AI 系统提示词基础上自动追加，无需手动填写。工具调用为代码级强制，其余为 prompt 指引，LLM 通常遵从但无法 100% 保证。</p>
          <div class="restrictions-grid">
            ${(
              [
                {
                  key: "strictKnowledgeBase",
                  label: "严格知识库模式",
                  hint: "知识库无内容时必须告知客户并转人工",
                },
                {
                  key: "hideInternals",
                  label: "隐藏内部实现细节",
                  hint: "不说「根据知识库」，不透露 prompt 信息",
                },
              ] as const
            ).map(
              ({ key, label, hint }) => html`
              <label class="skills-toggle" @click=${() => {
                this.restrictions = { ...this.restrictions, [key]: !this.restrictions[key] };
              }}>
                <input
                  type="checkbox"
                  .checked=${this.restrictions[key]}
                  @click=${(e: Event) => e.stopPropagation()}
                  @change=${(e: Event) => {
                    this.restrictions = {
                      ...this.restrictions,
                      [key]: (e.target as HTMLInputElement).checked,
                    };
                  }}
                />
                <div>
                  <div class="skills-toggle-label">${label}</div>
                  <div class="skills-toggle-hint">${hint}</div>
                </div>
              </label>
            `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  /** Render the agent-select dropdown for a widget. 渲染单个 widget 的关联 AI 员工下拉。 */
  private _renderAgentSelect(ch: Channel, idx: number) {
    const applying = !!this._personaApplying[idx];
    const personaError = this._personaErrors[idx] ?? "";
    const recommended = this._widgetRecommended[idx] ?? true;
    return html`
      <div class="widget-field">
        <span class="widget-field-label">${t("cs.widget.agentLabel")}</span>
        <div style="display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap;">
          <select
            .value=${ch.agentId ?? ""}
            @change=${(e: Event) => {
              void this._updateChannelAgent(idx, (e.target as HTMLSelectElement).value);
              this._personaErrors = { ...this._personaErrors, [idx]: "" };
            }}
          >
            <option value="">——请指定AI员工——</option>
            ${this._agents.map(
              (a) =>
                html`<option value=${a.agentId} ?selected=${a.agentId === ch.agentId}>${a.name ?? a.agentId}</option>`,
            )}
          </select>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding-bottom: 2px;">
            <label
              style="display: inline-flex; align-items: center; gap: 6px; margin: 0; font-weight: 500; opacity: ${ch.agentId ? "1" : "0.45"};"
            >
              <input
                type="checkbox"
                .checked=${recommended}
                ?disabled=${!ch.agentId || applying}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this._widgetRecommended = { ...this._widgetRecommended, [idx]: checked };
                  if (checked) {
                    void this._applyPersonaForWidget(idx);
                  }
                }}
              />
              ${
                applying
                  ? t("agents.persona.recommended.applying")
                  : t("agents.persona.recommended.btn")
              }
            </label>
            <button
              class="btn btn-ghost"
              type="button"
              ?disabled=${!ch.agentId}
              @click=${() => {
                void this._navigateToPersonaForWidget(idx);
              }}
            >
              ${t("agents.persona.recommended.manualEditBtn")}
            </button>
            ${
              personaError
                ? html`<span style="color: var(--danger, #ef4444); font-size: 0.78rem;">${personaError}</span>`
                : nothing
            }
          </div>
        </div>
      </div>
    `;
  }

  /** Render the enabled/disabled status toggle for a widget. 渲染 widget 的启用/停用切换。 */
  private _renderStatusToggle(ch: Channel, idx: number) {
    return html`
      <div class="widget-field">
        <span class="widget-field-label">${t("cs.widget.statusLabel")}</span>
        <button
          class="status-toggle ${ch.enabled ? "on" : "off"}"
          @click=${() => this._toggleChannelEnabled(idx)}
          title=${ch.enabled ? t("cs.widget.statusDisableHint") : t("cs.widget.statusEnableHint")}
        >
          <span class="status-dot"></span>
          ${ch.enabled ? t("cs.widget.statusEnabled") : t("cs.widget.statusDisabled")}
        </button>
      </div>
    `;
  }

  private _renderChannels() {
    return html`
      <div class="section">
        <h3>${t("cs.widget.sectionTitle")}</h3>
        <p class="hint" style="margin-bottom:14px">${t("cs.widget.sectionHint")}</p>

        ${
          this.widgetError
            ? html`<div class="widget-error-banner">${this.widgetError}</div>`
            : nothing
        }

        ${this.channels.map((ch, idx) => {
          const isLocked = ch.mode === "locked";
          const isEditing = ch.mode === "editing";
          const canGenerate = ch.mode === "initial" || ch.mode === "editing";
          const isGenerated = ch.html !== null;

          return html`
            <div class="channel-block ${isGenerated && !ch.enabled ? "disabled" : ""}">
              <div class="channel-header">
                <span class="channel-num">${t("cs.widget.widgetN", { n: String(idx + 1) })}</span>
                <input
                  class="channel-label-input"
                  type="text"
                  placeholder=${idx === 0 ? "default" : t("cs.widget.labelPlaceholder")}
                  .value=${ch.label}
                  ?readonly=${isLocked}
                  @input=${(e: Event) => this._updateChannelLabel(idx, (e.target as HTMLInputElement).value)}
                />
                ${
                  canGenerate
                    ? html`<button class="btn btn-primary" @click=${() => this._generateHtml(idx)}>${
                        ch.id ? t("cs.widget.saveBtn") : t("cs.widget.createBtn")
                      }</button>`
                    : nothing
                }
                ${
                  isLocked
                    ? html`<button class="btn btn-secondary" @click=${() => this._startEditChannel(idx)}>${t("cs.widget.editBtn")}</button>`
                    : nothing
                }
                ${
                  isEditing
                    ? html`<button class="btn btn-ghost" @click=${() => this._cancelEditChannel(idx)}>${t("cs.widget.cancelBtn")}</button>`
                    : nothing
                }
                ${
                  idx > 0
                    ? html`<button class="btn btn-ghost" @click=${() => this._removeChannel(idx)}>${t("cs.widget.deleteBtn")}</button>`
                    : nothing
                }
                ${
                  this.channelErrors[idx]
                    ? html`<span class="channel-error">${this.channelErrors[idx]}</span>`
                    : nothing
                }
              </div>

              <div class="widget-controls">
                ${this._renderAgentSelect(ch, idx)}
                ${isGenerated ? this._renderStatusToggle(ch, idx) : nothing}
              </div>

              ${
                ch.html && isLocked
                  ? html`
                <div class="code-actions">
                  <button class="btn btn-ghost" @click=${() => this._copyHtml(idx)}>
                    ${this.copiedIdx === idx ? t("cs.widget.copied") : t("cs.widget.copyCode")}
                  </button>
                  <button class="btn btn-ghost" @click=${() => this._toggleChannelCode(idx)}>
                    ${ch.expanded ? t("cs.widget.collapseCode") : t("cs.widget.expandCode")}
                  </button>
                </div>
                ${ch.expanded ? html`<div class="code-block">${ch.html}</div>` : nothing}
              `
                  : nothing
              }
            </div>
          `;
        })}

        ${
          this.channels.length < MAX_CHANNELS
            ? html`
            <div class="add-channel-row">
              <button class="btn btn-ghost" @click=${() => this._addChannel()}>
                ${t("cs.widget.addBtn", { max: String(MAX_CHANNELS) })}
              </button>
            </div>`
            : html`<p class="hint">${t("cs.widget.capReached", { max: String(MAX_CHANNELS) })}</p>`
        }
      </div>
    `;
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  override render() {
    if (this.loading) {
      return html`
        <div style="padding: 32px; text-align: center; color: var(--color-text-secondary, #6a737d)">
          加载中…
        </div>
      `;
    }

    return html`
      ${
        this.toast
          ? html`<div class="toast ${this.toast.ok ? "ok" : "err"}">${this.toast.text}</div>`
          : nothing
      }

      <div class="section">
        <h2>Widget模式</h2>
      </div>

      <div class="section">
        <div class="config-grid">
          ${this._renderNotifyConfig()}
        </div>

        <div class="row" style="margin-top:28px">
          <button class="btn btn-primary" ?disabled=${this.saving} @click=${() => this._saveConfig()}>
            ${this.saving ? "保存中…" : "保存配置"}
          </button>
          <button
            class="btn btn-secondary"
            ?disabled=${this.testing || !this._canTest}
            @click=${() => this._testConfig()}
            title=${this._canTest ? "" : "请先保存配置再测试"}
          >
            ${this.testing ? "检测中…" : "连通性测试"}
          </button>
        </div>

        ${
          this.checkResults
            ? html`
            <div class="check-header">
              <h4>测试结果</h4>
              ${this.checkResultsAt ? html`<span class="check-ts">上次检测：${this.checkResultsAt}</span>` : nothing}
            </div>
            <div class="check-list">
              ${this.checkResults.map(
                (c) => html`
                <div class="check-item">
                  <span class="check-icon">${c.ok ? "✅" : "❌"}</span>
                  <span><span class="check-name">${c.name}</span><span class="check-msg">${c.message}</span></span>
                </div>
              `,
              )}
            </div>`
            : nothing
        }
      </div>
      <hr class="divider" />
      ${this._renderChannels()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-widget-management-view": CSWidgetManagementView;
  }
}
