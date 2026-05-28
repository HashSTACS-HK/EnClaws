/**
 * AI Customer Service — Setup & Embed page.
 *
 * Three sections:
 *   1. Parameter guide — explains each config field and how to obtain it
 *   2. Feishu credentials — App ID / App Secret / Chat ID + save + test
 *   3. Channel embed code — one or more channel labels, each with generated HTML + copy
 *
 * AI 客服设置与嵌入页面。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { I18nController } from "../../../i18n/index.ts";
import { tenantRpc } from "./rpc.ts";
import { loadAuth } from "../../auth-store.ts";
import { loadSettings } from "../../storage.ts";
import { caretFix } from "../../shared-styles.ts";

const MAX_CHANNELS = 3;

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

type ChannelMode = "initial" | "locked" | "editing";

interface Channel {
  label: string;
  html: string | null;
  mode: ChannelMode;
  prevLabel: string;
  prevHtml: string | null;
  /** Whether the code block is expanded. Default false (collapsed). */
  expanded: boolean;
}

@customElement("cs-setup-view")
export class CSSetupView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host { display: block; }

      h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
      h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }

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
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        z-index: 9999;
        animation: toastIn 0.2s ease;
        min-width: 160px;
      }
      .toast.ok  { border-left: 4px solid var(--color-success, #1a7f37); }
      .toast.err { border-left: 4px solid var(--color-danger, #cf222e); }
      @keyframes toastIn {
        from { opacity: 0; transform: translateY(-8px); }
        to   { opacity: 1; transform: translateY(0); }
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
      summary.guide::-webkit-details-marker { display: none; }
      summary.guide::before {
        content: "▶";
        font-size: 10px;
        transition: transform 0.15s;
        flex-shrink: 0;
      }
      details[open] > summary.guide::before { transform: rotate(90deg); }
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

      .guide-body th, .guide-body td {
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
      select:focus { border-color: var(--color-accent, #0969da); }

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
        width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; margin-top: 2px;
      }
      .skills-toggle-label { font-size: 12px; font-weight: 500; line-height: 1.4; }
      .skills-toggle-hint { font-size: 11px; color: var(--color-text-secondary, #6a737d); margin-top: 2px; line-height: 1.4; }

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
      textarea:focus { border-color: var(--color-accent, #0969da); }

      .prompt-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
      }

      input[type="text"], input[type="password"] {
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

      input:focus { border-color: var(--color-accent, #0969da); }
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

      .btn-primary:hover { opacity: 0.85; }

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

      .btn-ghost:hover { background: var(--color-bg-hover, #eaeef2); }

      .btn:disabled { opacity: 0.4; cursor: not-allowed; }

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

      .check-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
      .check-name { font-weight: 600; margin-right: 4px; }
      .check-msg { color: var(--color-text-secondary, #6a737d); }

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

      .channel-label-input:focus { border-color: var(--color-accent, #0969da); }

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
        .config-grid { grid-template-columns: 1fr; gap: 0; }
      }

      /* Restriction checkboxes: 2x2 grid */
      .restrictions-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        max-width: 640px;
      }
      @media (max-width: 640px) {
        .restrictions-grid { grid-template-columns: 1fr; }
      }
    `,
  ];

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
    disableSkills: true,
    strictKnowledgeBase: true,
    disableMarkdown: true,
    hideInternals: true,
  };
  @state() private saving = false;
  @state() private testing = false;
  @state() private checkResults: CheckResult[] | null = null;
  @state() private checkResultsAt: string | null = null;
  @state() private loading = true;
  @state() private channels: Channel[] = [
    { label: "default", html: null, mode: "initial", prevLabel: "default", prevHtml: null, expanded: false },
  ];
  @state() private channelErrors: Record<number, string> = {};
  @state() private copiedIdx: number | null = null;
  @state() private toast: { text: string; ok: boolean } | null = null;

  private _toastTimer?: ReturnType<typeof setTimeout>;
  private _i18n = new I18nController(this);

  private get tenantId(): string | undefined {
    return loadAuth()?.user?.tenantId;
  }

  /** True when config has been saved and test can run. */
  private get _canTest(): boolean {
    return !!(this.appId && this.chatId && (this.hasExistingSecret || this.appSecret));
  }

  connectedCallback() {
    super.connectedCallback();
    void this._loadConfig();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._toastTimer);
  }

  private _showToast(text: string, ok: boolean) {
    clearTimeout(this._toastTimer);
    this.toast = { text, ok };
    this._toastTimer = setTimeout(() => { this.toast = null; }, 3000);
  }

  private async _loadConfig() {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    this.loading = true;
    try {
      const result = await tenantRpc("cs.config.get", { tenantId }) as {
        config: {
          notificationChannel?: string;
          feishu: { appId: string; appSecretMasked: string; chatId: string; hasSecret: boolean };
          channels?: Array<{ label: string; html: string }>;
          notifyIntervalMinutes?: number;
          restrictions?: {
            disableSkills?: boolean;
            strictKnowledgeBase?: boolean;
            disableMarkdown?: boolean;
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
        disableSkills:       r?.disableSkills       ?? true,
        strictKnowledgeBase: r?.strictKnowledgeBase ?? true,
        disableMarkdown:     r?.disableMarkdown     ?? true,
        hideInternals:       r?.hideInternals       ?? true,
      };

      // Restore saved channels as locked
      // 从配置恢复已保存的渠道，初始状态为锁定（只读）
      const saved = result.config.channels ?? [];
      if (saved.length > 0) {
        this.channels = saved.map((ch) => ({
          label: ch.label,
          html: ch.html,
          mode: "locked" as ChannelMode,
          prevLabel: ch.label,
          prevHtml: ch.html,
          expanded: false,
        }));
      }
    } catch {
      // config file may not exist yet — that's fine
    } finally {
      this.loading = false;
    }
  }

  /** Persist current locked channels to backend config.
   *  仅保存已生成（locked/editing）状态下有 html 的渠道。
   */
  private async _saveChannels() {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    try {
      const channelsToSave = this.channels
        .filter((ch) => ch.html !== null)
        .map((ch) => ({ label: ch.label, html: ch.html as string }));
      await tenantRpc("cs.config.set", { tenantId, channels: channelsToSave });
    } catch {
      // Best-effort; don't block UX on save error
    }
  }

  private _validateConfig(): string | null {
    if (!this.appId.trim()) {return "请填写飞书 App ID";}
    if (!this.hasExistingSecret && !this.appSecret) {return "请填写飞书 App Secret";}
    if (!this.chatId.trim()) {return "请填写飞书群聊 Chat ID";}
    return null;
  }

  private async _saveConfig() {
    const validationErr = this._validateConfig();
    if (validationErr) {
      this._showToast(validationErr, false);
      return;
    }
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
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
    if (!tenantId) {return;}
    this.testing = true;
    this.checkResults = null;
    this.checkResultsAt = null;
    try {
      const result = await tenantRpc("cs.config.test", { tenantId }) as { checks: CheckResult[] };
      this.checkResults = result.checks;
      this.checkResultsAt = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (err) {
      this.checkResults = [{ name: "测试失败", ok: false, message: err instanceof Error ? err.message : String(err) }];
      this.checkResultsAt = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } finally {
      this.testing = false;
    }
  }

  private _generateHtml(channelIdx: number) {
    const ch = this.channels[channelIdx];
    const label = ch.label.trim();

    if (!label) {
      this.channelErrors = { ...this.channelErrors, [channelIdx]: "渠道标签不能为空" };
      return;
    }
    if (/\s/.test(label)) {
      this.channelErrors = { ...this.channelErrors, [channelIdx]: "渠道标签不能包含空格" };
      return;
    }
    // Uniqueness check
    const duplicate = this.channels.some((c, i) => i !== channelIdx && c.label.trim() === label);
    if (duplicate) {
      this.channelErrors = { ...this.channelErrors, [channelIdx]: "渠道标签已存在，请使用唯一标签" };
      return;
    }

    const tenantId = this.tenantId ?? "YOUR_TENANT_ID";
    const gatewayUrl = loadSettings().gatewayUrl || "wss://YOUR_EC_DOMAIN";
    // Convert ws(s):// to http(s):// for script src
    const baseUrl = gatewayUrl.replace(/^wss?:\/\//, (m) => m.startsWith("wss") ? "https://" : "http://");

    const embedHtml = [
      `<!-- EC AI 客服 Widget · 渠道: ${label} -->`,
      `<!-- 说明: 将以下代码嵌入到目标页面 <body> 末尾 -->`,
      `<script type="module">`,
      `  import '${baseUrl}/ui/cs-widget.js';`,
      `</script>`,
      `<cs-widget`,
      `  tenant-id="${tenantId}"`,
      `  channel="${label}"`,
      `  gateway-url="${gatewayUrl}"`,
      `></cs-widget>`,
    ].join("\n");

    // Clear error, lock channel
    const errs = { ...this.channelErrors };
    delete errs[channelIdx];
    this.channelErrors = errs;

    this.channels = this.channels.map((c, i) =>
      i === channelIdx
        ? { ...c, label, html: embedHtml, mode: "locked", prevLabel: c.label, prevHtml: c.html, expanded: false }
        : c,
    );

    // Persist to backend
    void this._saveChannels();
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
    if (this.channels.length >= MAX_CHANNELS) {return;}
    this.channels = [...this.channels, { label: "", html: null, mode: "initial", prevLabel: "", prevHtml: null, expanded: false }];
  }

  private _removeChannel(idx: number) {
    this.channels = this.channels.filter((_, i) => i !== idx);
    // Re-index errors
    const errs: Record<number, string> = {};
    Object.entries(this.channelErrors).forEach(([k, v]) => {
      const ki = parseInt(k, 10);
      if (ki < idx) {errs[ki] = v;}
      else if (ki > idx) {errs[ki - 1] = v;}
    });
    this.channelErrors = errs;
    // Persist after remove
    void this._saveChannels();
  }

  private _toggleChannelCode(idx: number) {
    this.channels = this.channels.map((c, i) =>
      i === idx ? { ...c, expanded: !c.expanded } : c,
    );
  }

  private _updateChannelLabel(idx: number, value: string) {
    // Strip spaces as user types
    const cleaned = value.replace(/\s/g, "");
    this.channels = this.channels.map((c, i) => i === idx ? { ...c, label: cleaned } : c);
  }

  private async _copyHtml(idx: number) {
    const embedHtml = this.channels[idx].html;
    if (!embedHtml) {return;}
    try {
      await navigator.clipboard.writeText(embedHtml);
      this.copiedIdx = idx;
      setTimeout(() => { this.copiedIdx = null; }, 2000);
    } catch {
      // clipboard API not available
    }
  }

  private _renderGuide() {
    return html`
      <div class="section">
        <details>
          <summary class="guide">📖 配置说明 — 各参数说明与获取方式</summary>
          <div class="guide-body">
            <table>
              <thead>
                <tr><th>参数</th><th>说明</th><th>获取方式</th></tr>
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
                  <td>自定义字符串，不含空格，如 <code>default</code>、<code>website</code>、<code>wechat</code></td>
                </tr>
              </tbody>
            </table>
            <p>生成的 HTML 嵌入代码可以放置在任意网页的 <code>&lt;body&gt;</code> 末尾，
              访客打开页面后右下角即出现 AI 客服悬浮气泡。
              嵌入前请确认 EC 服务可公网访问，否则访客无法连接 Gateway。</p>
          </div>
        </details>
      </div>
    `;
  }

  /** Right column: notification settings */
  private _renderNotifyConfig() {
    return html`
      <div>
        <h3>通知配置</h3>

        <div class="form-group">
          <label>客服 Agent</label>
          <select disabled style="opacity:0.6;cursor:not-allowed">
            <option>默认 Agent（系统自动选择）</option>
          </select>
          <p class="hint">多 Agent 路由将在后续版本支持</p>
        </div>

        <div class="form-group">
          <label>通知渠道</label>
          <select
            .value=${this.notificationChannel}
            @change=${(e: Event) => { this.notificationChannel = (e.target as HTMLSelectElement).value; }}
          >
            <option value="feishu">飞书（Feishu）</option>
          </select>
          <p class="hint">当前仅支持飞书，后续渠道上线后可在此切换</p>
        </div>

        <div class="form-group">
          <label>飞书 App ID <span style="color:var(--color-danger,#cf222e)">*</span></label>
          <input
            type="text"
            placeholder="cli_xxxxxxxxxx"
            .value=${this.appId}
            @input=${(e: Event) => { this.appId = (e.target as HTMLInputElement).value; }}
          />
        </div>
        <div class="form-group">
          <label>飞书 App Secret <span style="color:var(--color-danger,#cf222e)">*</span></label>
          <input
            type="password"
            placeholder=${this.hasExistingSecret ? "已设置（输入新值覆盖）" : "请输入 App Secret"}
            .value=${this.appSecret}
            @input=${(e: Event) => { this.appSecret = (e.target as HTMLInputElement).value; }}
          />
          ${this.hasExistingSecret && !this.appSecret
            ? html`<p class="hint">App Secret 已配置，留空则保留旧值</p>`
            : nothing}
        </div>
        <div class="form-group">
          <label>飞书群聊 Chat ID <span style="color:var(--color-danger,#cf222e)">*</span></label>
          <input
            type="text"
            placeholder="oc_xxxxxxxxxx"
            .value=${this.chatId}
            @input=${(e: Event) => { this.chatId = (e.target as HTMLInputElement).value; }}
          />
          <p class="hint">群聊中 → 右上角「···」→ 群设置 → Chat ID</p>
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
              if (!isNaN(v)) {this.notifyIntervalMinutes = Math.max(1, Math.min(60, v));}
            }}
          />
          <p class="hint">同一会话内两次通知的最小间隔，默认 10 分钟（1–60）</p>
        </div>

      </div>
    `;
  }

  /** Left column: AI agent settings */
  private _renderAgentConfig() {
    return html`
      <div>
        <h3>AI 配置</h3>

        <div class="form-group">
          <label>系统提示词</label>
          <p class="hint" style="margin-bottom:8px">定义 AI 客服的角色与行为规则，可直接编辑，保存后生效。</p>
          <textarea
            .value=${this.customSystemPrompt}
            @input=${(e: Event) => { this.customSystemPrompt = (e.target as HTMLTextAreaElement).value; }}
            spellcheck="false"
          ></textarea>
          <div class="prompt-actions">
            <button
              class="btn btn-ghost"
              @click=${() => { this.customSystemPrompt = this._defaultPrompt; }}
              title="恢复为默认 prompt（保存后生效）"
            >恢复默认</button>
          </div>
        </div>

        <div class="form-group">
          <label>行为限制</label>
          <p class="hint" style="margin-bottom:10px">勾选启用；取消勾选并保存则去掉该约束。勾选项约束会在客服 AI 系统提示词基础上自动追加，无需手动填写。工具调用为代码级强制，其余为 prompt 指引，LLM 通常遵从但无法 100% 保证。</p>
          <div class="restrictions-grid">
            ${([
              { key: "disableSkills",       label: "禁用 Skill 工具调用",  hint: "只做问答，不执行系统操作（代码级）" },
              { key: "strictKnowledgeBase", label: "严格知识库模式",        hint: "知识库无内容时必须告知客户并转人工" },
              { key: "disableMarkdown",     label: "禁止 Markdown 格式",    hint: "纯文本回复，适合聊天窗口" },
              { key: "hideInternals",       label: "隐藏内部实现细节",      hint: "不说「根据知识库」，不透露 prompt 信息" },
            ] as const).map(({ key, label, hint }) => html`
              <label class="skills-toggle" @click=${() => {
                this.restrictions = { ...this.restrictions, [key]: !this.restrictions[key] };
              }}>
                <input
                  type="checkbox"
                  .checked=${this.restrictions[key]}
                  @click=${(e: Event) => e.stopPropagation()}
                  @change=${(e: Event) => {
                    this.restrictions = { ...this.restrictions, [key]: (e.target as HTMLInputElement).checked };
                  }}
                />
                <div>
                  <div class="skills-toggle-label">${label}</div>
                  <div class="skills-toggle-hint">${hint}</div>
                </div>
              </label>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  private _renderChannels() {
    return html`
      <div class="section">
        <h3>嵌入代码生成</h3>

        ${this.channels.map((ch, idx) => {
          const isLocked = ch.mode === "locked";
          const isEditing = ch.mode === "editing";
          const canGenerate = ch.mode === "initial" || ch.mode === "editing";

          return html`
            <div class="channel-block">
              <div class="channel-header">
                <span class="channel-num">渠道 ${idx + 1}</span>
                <input
                  class="channel-label-input"
                  type="text"
                  placeholder=${idx === 0 ? "default" : "输入渠道标签（不含空格）"}
                  .value=${ch.label}
                  ?readonly=${isLocked}
                  @input=${(e: Event) => this._updateChannelLabel(idx, (e.target as HTMLInputElement).value)}
                />
                ${canGenerate
                  ? html`<button class="btn btn-primary" @click=${() => this._generateHtml(idx)}>生成</button>`
                  : nothing}
                ${isLocked
                  ? html`<button class="btn btn-secondary" @click=${() => this._startEditChannel(idx)}>修改</button>`
                  : nothing}
                ${isEditing
                  ? html`<button class="btn btn-ghost" @click=${() => this._cancelEditChannel(idx)}>取消</button>`
                  : nothing}
                ${idx > 0
                  ? html`<button class="btn btn-ghost" @click=${() => this._removeChannel(idx)}>删除</button>`
                  : nothing}
                ${this.channelErrors[idx]
                  ? html`<span class="channel-error">${this.channelErrors[idx]}</span>`
                  : nothing}
              </div>

              ${ch.html && isLocked ? html`
                <div class="code-actions">
                  <button class="btn btn-ghost" @click=${() => this._copyHtml(idx)}>
                    ${this.copiedIdx === idx ? "✓ 已复制" : "复制代码"}
                  </button>
                  <button class="btn btn-ghost" @click=${() => this._toggleChannelCode(idx)}>
                    ${ch.expanded ? "收起 ▲" : "展开代码 ▼"}
                  </button>
                </div>
                ${ch.expanded ? html`<div class="code-block">${ch.html}</div>` : nothing}
              ` : nothing}
            </div>
          `;
        })}

        ${this.channels.length < MAX_CHANNELS
          ? html`
            <div class="add-channel-row">
              <button class="btn btn-ghost" @click=${this._addChannel}>
                + 增加新渠道（最多 ${MAX_CHANNELS} 个）
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div style="padding:32px;text-align:center;color:var(--color-text-secondary,#6a737d)">加载中…</div>`;
    }

    return html`
      ${this.toast
        ? html`<div class="toast ${this.toast.ok ? "ok" : "err"}">${this.toast.text}</div>`
        : nothing}

      <div class="section">
        <h2>客服设置 & 嵌入代码</h2>
      </div>

      ${this._renderGuide()}
      <hr class="divider" />
      <div class="section">
        <div class="config-grid">
          ${this._renderAgentConfig()}
          ${this._renderNotifyConfig()}
        </div>

        <div class="row" style="margin-top:28px">
          <button class="btn btn-primary" ?disabled=${this.saving} @click=${this._saveConfig}>
            ${this.saving ? "保存中…" : "保存配置"}
          </button>
          <button
            class="btn btn-secondary"
            ?disabled=${this.testing || !this._canTest}
            @click=${this._testConfig}
            title=${this._canTest ? "" : "请先保存配置再测试"}
          >
            ${this.testing ? "检测中…" : "连通性测试"}
          </button>
        </div>

        ${this.checkResults
          ? html`
            <div class="check-header">
              <h4>测试结果</h4>
              ${this.checkResultsAt ? html`<span class="check-ts">上次检测：${this.checkResultsAt}</span>` : nothing}
            </div>
            <div class="check-list">
              ${this.checkResults.map((c) => html`
                <div class="check-item">
                  <span class="check-icon">${c.ok ? "✅" : "❌"}</span>
                  <span><span class="check-name">${c.name}</span><span class="check-msg">${c.message}</span></span>
                </div>
              `)}
            </div>`
          : nothing}
      </div>
      <hr class="divider" />
      ${this._renderChannels()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-setup-view": CSSetupView;
  }
}
