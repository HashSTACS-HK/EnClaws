/**
 * AI Customer Service floating chat widget.
 *
 * A Lit Web Component that renders a floating chat bubble in the bottom-right
 * corner of the page. Clicking opens a chat panel that connects to the CS
 * backend via cs.widget.connect / cs.widget.send RPC.
 *
 * Visitor identity: anonymous UUID stored in localStorage (key: ec_cs_visitor_id).
 * Tenant: derived from the currently logged-in admin user's tenantId.
 *
 * AI 客服悬浮聊天 Widget。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { loadAuth } from "../auth-store.ts";
import { generateUUID } from "../uuid.ts";
import { tenantRpc } from "../views/tenant/rpc.ts";

const VISITOR_ID_KEY = "ec_cs_visitor_id";

interface CSMsg {
  id: string;
  role: "customer" | "ai" | "boss" | "system";
  text: string;
  roleLabel: string;
  pending?: boolean;
}

function getOrCreateVisitorId(): string {
  let id = localStorage.getItem(VISITOR_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(VISITOR_ID_KEY, id);
  }
  return id;
}

@customElement("cs-widget")
export class CSWidget extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    /* Bubble button */
    .bubble {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: var(--cs-bubble-bg, #0969da);
      color: #fff;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      transition:
        transform 0.15s,
        box-shadow 0.15s;
      outline: none;
    }

    .bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
    }

    /* Unread badge */
    .unread-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      background: #cf222e;
      color: #fff;
      border-radius: 50%;
      width: 18px;
      height: 18px;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    /* Chat panel */
    .panel {
      position: absolute;
      bottom: 64px;
      right: 0;
      width: 340px;
      height: 480px;
      background: var(--cs-panel-bg, #fff);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--color-border, #e1e4e8);
      animation: slideUp 0.18s ease-out;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .panel-header {
      background: var(--cs-header-bg, #0969da);
      color: #fff;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .panel-header .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .panel-header .title {
      font-weight: 600;
      font-size: 14px;
      flex: 1;
    }
    .panel-header .subtitle {
      font-size: 11px;
      opacity: 0.8;
    }

    .close-btn {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.8);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 4px;
    }

    .close-btn:hover {
      color: #fff;
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .msg-wrap {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .msg-wrap.customer {
      align-items: flex-end;
    }
    .msg-wrap.ai,
    .msg-wrap.boss,
    .msg-wrap.system {
      align-items: flex-start;
    }

    .msg-role {
      font-size: 11px;
      color: var(--color-text-secondary, #6a737d);
      font-weight: 500;
      padding: 0 4px;
    }

    .msg-bubble {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
    }

    .msg-wrap.customer .msg-bubble {
      background: var(--cs-header-bg, #0969da);
      color: #fff;
      border-bottom-right-radius: 4px;
    }

    .msg-wrap.ai .msg-bubble,
    .msg-wrap.boss .msg-bubble {
      background: var(--color-bg-secondary, #f6f8fa);
      color: var(--color-text, #1c1c1e);
      border: 1px solid var(--color-border, #e1e4e8);
      border-bottom-left-radius: 4px;
    }

    .msg-wrap.system .msg-bubble {
      background: none;
      color: var(--color-text-secondary, #6a737d);
      font-size: 12px;
      text-align: center;
      border: none;
    }

    .msg-bubble.pending {
      opacity: 0.6;
    }

    /* Typing indicator */
    .typing-dot {
      display: inline-flex;
      gap: 4px;
      padding: 8px 12px;
      background: var(--color-bg-secondary, #f6f8fa);
      border: 1px solid var(--color-border, #e1e4e8);
      border-radius: 12px;
      border-bottom-left-radius: 4px;
    }

    .typing-dot span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--color-text-secondary, #6a737d);
      animation: typing 1.2s infinite;
    }

    .typing-dot span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .typing-dot span:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes typing {
      0%,
      60%,
      100% {
        opacity: 0.3;
        transform: scale(0.85);
      }
      30% {
        opacity: 1;
        transform: scale(1);
      }
    }

    /* Input area */
    .input-area {
      border-top: 1px solid var(--color-border, #e1e4e8);
      padding: 10px 12px;
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
      background: var(--cs-panel-bg, #fff);
    }

    .input-area textarea {
      flex: 1;
      border: 1px solid var(--color-border, #e1e4e8);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      max-height: 96px;
      min-height: 36px;
      line-height: 1.4;
      outline: none;
      background: var(--color-bg, #fff);
      color: var(--color-text, #1c1c1e);
    }

    .input-area textarea:focus {
      border-color: var(--cs-header-bg, #0969da);
    }

    .send-btn {
      background: var(--cs-header-bg, #0969da);
      color: #fff;
      border: none;
      border-radius: 8px;
      width: 36px;
      height: 36px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 16px;
      transition: opacity 0.15s;
    }

    .send-btn:hover {
      opacity: 0.85;
    }
    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .connect-error {
      margin: 12px 14px;
      padding: 10px 12px;
      background: #fff0f0;
      border: 1px solid #ffc1c1;
      border-radius: 6px;
      font-size: 12px;
      color: #cf222e;
      text-align: center;
    }

    .connecting {
      margin: auto;
      text-align: center;
      color: var(--color-text-secondary, #6a737d);
      font-size: 13px;
    }
  `;

  @property({ type: Boolean }) open = false;

  /** For external embed: override tenantId instead of reading from loadAuth(). */
  @property({ attribute: "tenant-id" }) tenantIdOverride?: string;

  /** Channel label, forwarded to cs.widget.connect. Default: "default". */
  @property() channel = "default";

  /**
   * Stable widget instance id from the embed snippet (`data-widget-id`).
   * Forwarded to cs.widget.send so the gateway can resolve the per-widget bound
   * agent (P5-T3b). Absent for legacy embeds → gateway falls back to the default
   * agent (S1 unchanged).
   * 嵌入代码中的稳定 widget id（data-widget-id），随 cs.widget.send 上送，供 gateway
   * 解析每 widget 绑定 agent（P5-T3b）。旧嵌入代码无此属性时 gateway 回退默认 agent。
   */
  @property({ attribute: "data-widget-id" }) widgetId?: string;

  /** For external embed: WebSocket gateway URL override. */
  @property({ attribute: "gateway-url" }) gatewayUrlOverride?: string;

  @state() private messages: CSMsg[] = [];
  @state() private inputText = "";
  @state() private sending = false;
  @state() private connecting = false;
  @state() private connectError: string | null = null;
  @state() private sessionId: string | null = null;
  @state() private unread = 0;

  private _visitorId = getOrCreateVisitorId();

  private get tenantId(): string | undefined {
    return this.tenantIdOverride ?? loadAuth()?.user?.tenantId;
  }

  private async _connect() {
    const tenantId = this.tenantId;
    if (!tenantId) {
      this.connectError = "未检测到租户，请先登录";
      return;
    }
    this.connecting = true;
    this.connectError = null;
    try {
      const result = (await tenantRpc("cs.widget.connect", {
        tenantId,
        visitorId: this._visitorId,
        channel: this.channel,
      })) as { sessionId: string; messages: Array<{ id: string; role: string; content: string }> };

      this.sessionId = result.sessionId;
      // Load history
      this.messages = (result.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role as CSMsg["role"],
        text: m.content,
        roleLabel: this._roleLabel(m.role as CSMsg["role"]),
      }));
      this._scrollToBottom();
    } catch (_err) {
      this.connectError = "客服服务暂时不可用，请稍后再试";
    } finally {
      this.connecting = false;
    }
  }

  private _roleLabel(role: CSMsg["role"]): string {
    const labels: Record<string, string> = {
      customer: "我",
      ai: "🤖 AI 助手",
      boss: "👔 人工客服",
      system: "系统",
    };
    return labels[role] ?? role;
  }

  private async _togglePanel() {
    this.open = !this.open;
    if (this.open) {
      this.unread = 0;
      if (!this.sessionId && !this.connecting) {
        await this._connect();
      }
      await this.updateComplete;
      this._scrollToBottom();
    }
  }

  private async _sendMessage() {
    const text = this.inputText.trim();
    // Allow sending even without sessionId — session is created lazily on first message.
    // 允许在 sessionId 为空时发送，session 由后端在首条消息时按需创建。
    if (!text || this.sending) {
      return;
    }
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }

    const tempId = `tmp-${Date.now()}`;
    this.messages = [
      ...this.messages,
      { id: tempId, role: "customer", text, roleLabel: "我", pending: false },
    ];
    this.inputText = "";
    this.sending = true;
    this._scrollToBottom();

    // Pending AI typing indicator
    const typingId = `typing-${Date.now()}`;
    this.messages = [
      ...this.messages,
      { id: typingId, role: "ai", text: "", roleLabel: "🤖 AI 助手", pending: true },
    ];
    this._scrollToBottom();

    try {
      const result = (await tenantRpc("cs.widget.send", {
        tenantId,
        visitorId: this._visitorId,
        text,
        // Forward the embed widget id so the gateway resolves the bound agent
        // (P5-T3b). Omitted when absent → gateway falls back to default agent.
        // 上送嵌入 widget id 供 gateway 解析绑定 agent（P5-T3b）；缺省时 gateway 回退默认。
        ...(this.widgetId ? { widgetId: this.widgetId } : {}),
      })) as {
        sessionId?: string;
        messageId: string;
        role: string;
        text: string;
        roleLabel: string;
      };

      // Capture sessionId from first response (lazy session creation).
      // 从首次响应中捕获 sessionId（懒加载 session）。
      if (result.sessionId && !this.sessionId) {
        this.sessionId = result.sessionId;
      }

      // Replace typing indicator with real reply
      this.messages = [
        ...this.messages.filter((m) => m.id !== typingId),
        {
          id: result.messageId,
          role: result.role as CSMsg["role"],
          text: result.text,
          roleLabel: result.roleLabel,
        },
      ];

      if (!this.open) {
        this.unread++;
      }
    } catch (_err) {
      this.messages = this.messages.filter((m) => m.id !== typingId);
      this.messages = [
        ...this.messages,
        { id: `err-${Date.now()}`, role: "system", text: "发送失败，请重试", roleLabel: "系统" },
      ];
    } finally {
      this.sending = false;
      this._scrollToBottom();
    }
  }

  private _onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this._sendMessage();
    }
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      const el = this.shadowRoot?.querySelector(".messages");
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  private _renderMessage(msg: CSMsg) {
    if (msg.pending) {
      return html`
        <div class="msg-wrap ai">
          <div class="msg-role">${msg.roleLabel}</div>
          <div class="typing-dot">
            <span></span><span></span><span></span>
          </div>
        </div>
      `;
    }
    if (msg.role === "system" && !msg.text) {
      return nothing;
    }
    return html`
      <div class="msg-wrap ${msg.role}">
        ${msg.role !== "customer" ? html`<div class="msg-role">${msg.roleLabel}</div>` : nothing}
        <div class="msg-bubble ${msg.pending ? "pending" : ""}">${msg.text}</div>
        ${msg.role === "customer" ? html`<div class="msg-role">${msg.roleLabel}</div>` : nothing}
      </div>
    `;
  }

  render() {
    return html`
      <div style="position:relative">
        <!-- Bubble toggle button -->
        <button class="bubble" @click=${this._togglePanel} title="AI 客服">
          ${this.open ? "✕" : "💬"}
        </button>
        ${
          this.unread > 0 && !this.open
            ? html`<div class="unread-badge">${this.unread}</div>`
            : nothing
        }

        <!-- Chat panel -->
        ${
          this.open
            ? html`
          <div class="panel">
            <div class="panel-header">
              <div class="avatar">🤖</div>
              <div>
                <div class="title">AI 客服助手</div>
                <div class="subtitle">有问必答，随时为您服务</div>
              </div>
              <button class="close-btn" @click=${this._togglePanel}>✕</button>
            </div>

            ${
              this.connectError
                ? html`<div class="connect-error">${this.connectError}</div>`
                : this.connecting
                  ? html`
                      <div class="messages"><div class="connecting">连接中…</div></div>
                    `
                  : html`
                  <div class="messages">
                    ${
                      this.messages.length === 0
                        ? html`
                            <div class="msg-wrap ai">
                              <div class="msg-role">🤖 AI 助手</div>
                              <div class="msg-bubble">你好！我是 AI 客服助手，有什么可以帮您的吗？</div>
                            </div>
                          `
                        : this.messages.map((m) => this._renderMessage(m))
                    }
                  </div>
                  <div class="input-area">
                    <textarea
                      rows="1"
                      placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                      .value=${this.inputText}
                      @input=${(e: Event) => {
                        this.inputText = (e.target as HTMLTextAreaElement).value;
                      }}
                      @keydown=${this._onKeyDown}
                      ?disabled=${this.sending}
                    ></textarea>
                    <button
                      class="send-btn"
                      ?disabled=${!this.inputText.trim() || this.sending}
                      @click=${this._sendMessage}
                    >↑</button>
                  </div>
                `
            }
          </div>
        `
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-widget": CSWidget;
  }
}
