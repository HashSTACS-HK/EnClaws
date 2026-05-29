/**
 * AI Customer Service — Session records view.
 *
 * Lists all CS sessions for the tenant with visitor info, state, and timestamps.
 * Click a row to expand and view the message thread.
 *
 * AI 客服会话记录页面。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { I18nController } from "../../../i18n/index.ts";
import { loadAuth } from "../../auth-store.ts";
import { caretFix } from "../../shared-styles.ts";
import { tenantRpc } from "./rpc.ts";

interface CSMessage {
  id: string;
  role: "customer" | "ai" | "boss" | "system";
  content: string;
  createdAt: string;
}

interface CSSession {
  id: string;
  visitorId: string;
  visitorName: string | null;
  state: "ai_active" | "human_active";
  channel: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  lastMessage: { role: string; content: string } | null;
}

const STATE_LABEL: Record<string, string> = {
  ai_active: "AI 处理中",
  human_active: "人工介入",
};

const STATE_COLOR: Record<string, string> = {
  ai_active: "#1a7f37",
  human_active: "#9a6700",
};

const ROLE_LABEL: Record<string, string> = {
  customer: "访客",
  ai: "🤖 AI",
  boss: "👔 人工",
  system: "系统",
};

@customElement("cs-sessions-view")
export class CSSessionsView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }

      .toolbar h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        flex: 1;
      }

      .btn {
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid var(--color-border, #e1e4e8);
        background: var(--color-bg-secondary, #f6f8fa);
        font-weight: 500;
        white-space: nowrap;
      }

      .btn:hover {
        background: var(--color-bg-hover, #eaeef2);
      }

      .session-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }

      .session-table th {
        text-align: left;
        padding: 8px 12px;
        font-weight: 600;
        border-bottom: 2px solid var(--color-border, #e1e4e8);
        color: var(--color-text-secondary, #6a737d);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .session-table td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--color-border, #e1e4e8);
        vertical-align: top;
      }

      .session-row {
        cursor: pointer;
        transition: background 0.1s;
      }
      .session-row:hover td {
        background: var(--color-bg-secondary, #f6f8fa);
      }
      .session-row.expanded td {
        background: var(--color-bg-secondary, #f6f8fa);
      }

      .visitor-name {
        font-weight: 500;
      }
      .visitor-id {
        font-size: 11px;
        font-family: monospace;
        color: var(--color-text-secondary, #6a737d);
        margin-top: 2px;
      }

      .state-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
        border: 1px solid currentColor;
      }

      .date-cell {
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
        white-space: nowrap;
      }

      .expand-icon {
        font-size: 11px;
        color: var(--color-text-secondary, #6a737d);
        transition: transform 0.15s;
      }

      .expand-icon.open {
        transform: rotate(90deg);
        display: inline-block;
      }

      /* Message thread panel */
      .thread-row td {
        padding: 0;
        background: var(--color-bg, #fff);
        border-bottom: 2px solid var(--color-border, #e1e4e8);
      }

      .thread-panel {
        padding: 16px 20px;
        max-height: 400px;
        overflow-y: auto;
      }

      .msg {
        margin-bottom: 12px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .msg-header {
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-secondary, #6a737d);
      }

      .msg-content {
        background: var(--color-bg-secondary, #f6f8fa);
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 13px;
        line-height: 1.5;
        max-width: 80%;
      }

      .msg.customer .msg-content {
        background: var(--color-accent-muted, #ddf4ff);
      }

      .msg-loading {
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
        padding: 8px 0;
      }

      .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: var(--color-text-secondary, #6a737d);
        font-size: 14px;
      }

      .loading {
        text-align: center;
        padding: 32px;
        color: var(--color-text-secondary, #6a737d);
        font-size: 14px;
      }

      .error-msg {
        color: var(--color-danger, #cf222e);
        font-size: 13px;
        margin-top: 8px;
      }

      .load-more {
        margin-top: 16px;
        text-align: center;
      }
    `,
  ];

  @state() private sessions: CSSession[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private expandedId: string | null = null;
  @state() private messages: Record<string, CSMessage[]> = {};
  @state() private messagesLoading: string | null = null;
  @state() private offset = 0;
  @state() private hasMore = true;

  private readonly PAGE_SIZE = 30;
  private _i18n = new I18nController(this);

  private get tenantId(): string | undefined {
    return loadAuth()?.user?.tenantId;
  }

  connectedCallback() {
    super.connectedCallback();
    void this._loadSessions(true);
  }

  private async _loadSessions(reset = false) {
    const tenantId = this.tenantId;
    if (!tenantId) {
      return;
    }
    if (reset) {
      this.offset = 0;
      this.sessions = [];
    }
    this.loading = true;
    this.error = null;
    try {
      const result = (await tenantRpc("cs.sessions.list", {
        tenantId,
        limit: this.PAGE_SIZE,
        offset: this.offset,
      })) as { sessions: CSSession[] };
      const newSessions = result.sessions ?? [];
      this.sessions = reset ? newSessions : [...this.sessions, ...newSessions];
      this.hasMore = newSessions.length === this.PAGE_SIZE;
      this.offset += newSessions.length;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "加载失败";
    } finally {
      this.loading = false;
    }
  }

  private async _toggleSession(sessionId: string) {
    if (this.expandedId === sessionId) {
      this.expandedId = null;
      return;
    }
    this.expandedId = sessionId;
    if (!this.messages[sessionId]) {
      await this._loadMessages(sessionId);
    }
  }

  private async _loadMessages(sessionId: string) {
    this.messagesLoading = sessionId;
    try {
      const result = (await tenantRpc("cs.session.messages", { sessionId, limit: 100 })) as {
        messages: CSMessage[];
      };
      this.messages = { ...this.messages, [sessionId]: result.messages ?? [] };
    } catch (err) {
      this.messages = { ...this.messages, [sessionId]: [] };
    } finally {
      this.messagesLoading = null;
    }
  }

  private _formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return iso;
    }
  }

  private _renderThread(session: CSSession) {
    const msgs = this.messages[session.id];
    return html`
      <tr class="thread-row">
        <td colspan="6">
          <div class="thread-panel">
            ${
              this.messagesLoading === session.id
                ? html`
                    <p class="msg-loading">加载消息中…</p>
                  `
                : msgs?.length
                  ? msgs.map(
                      (m) => html`
                    <div class="msg ${m.role}">
                      <div class="msg-header">
                        ${ROLE_LABEL[m.role] ?? m.role}
                        · ${this._formatDate(m.createdAt)}
                      </div>
                      <div class="msg-content">${m.content}</div>
                    </div>
                  `,
                    )
                  : html`
                      <p class="msg-loading">暂无消息记录</p>
                    `
            }
          </div>
        </td>
      </tr>
    `;
  }

  render() {
    return html`
      <div class="toolbar">
        <h2>AI 客服会话记录</h2>
        <button class="btn" @click=${() => this._loadSessions(true)}>刷新</button>
      </div>

      ${this.error ? html`<p class="error-msg">${this.error}</p>` : nothing}

      ${
        this.loading && this.sessions.length === 0
          ? html`
              <div class="loading">加载中…</div>
            `
          : !this.error && this.sessions.length === 0
            ? html`
                <div class="empty-state">暂无客服会话记录</div>
              `
            : this.sessions.length > 0
              ? html`
            <table class="session-table">
              <thead>
                <tr>
                  <th></th>
                  <th>访客</th>
                  <th>状态</th>
                  <th>最后发言</th>
                  <th>发起时间</th>
                  <th>最近活动</th>
                </tr>
              </thead>
              <tbody>
                ${this.sessions.map((s) => {
                  const lastRole = s.lastMessage?.role ?? null;
                  const needsAttention = !s.closedAt && lastRole === "customer";
                  return html`
                  <tr
                    class="session-row ${this.expandedId === s.id ? "expanded" : ""}"
                    @click=${() => this._toggleSession(s.id)}
                  >
                    <td>
                      <span class="expand-icon ${this.expandedId === s.id ? "open" : ""}">▶</span>
                    </td>
                    <td>
                      <div class="visitor-name">${s.visitorName ?? "匿名访客"}</div>
                      <div class="visitor-id">${s.visitorId.slice(0, 16)}…</div>
                    </td>
                    <td>
                      <span
                        class="state-badge"
                        style="color: ${STATE_COLOR[s.state] ?? "#555"}"
                      >${STATE_LABEL[s.state] ?? s.state}</span>
                      ${
                        s.closedAt
                          ? html`
                              <br /><span style="font-size: 11px; color: #6a737d">已关闭</span>
                            `
                          : nothing
                      }
                    </td>
                    <td>
                      ${
                        s.lastMessage
                          ? html`
                        <div style="display:flex;align-items:center;gap:6px">
                          ${
                            needsAttention
                              ? html`
                                  <span style="color: #cf222e; font-size: 11px; font-weight: 600">● 待回复</span>
                                `
                              : html`
                                  <span style="color: #6a737d; font-size: 11px">● 已回复</span>
                                `
                          }
                          <span style="font-size:12px;color:#6a737d;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            ${s.lastMessage.content.slice(0, 40)}${s.lastMessage.content.length > 40 ? "…" : ""}
                          </span>
                        </div>
                      `
                          : html`
                              <span style="font-size: 11px; color: #aaa">—</span>
                            `
                      }
                    </td>
                    <td class="date-cell">${this._formatDate(s.createdAt)}</td>
                    <td class="date-cell">${this._formatDate(s.updatedAt)}</td>
                  </tr>
                  ${this.expandedId === s.id ? this._renderThread(s) : nothing}
                `;
                })}

              </tbody>
            </table>

            ${
              this.hasMore
                ? html`
                <div class="load-more">
                  <button class="btn" ?disabled=${this.loading} @click=${() => this._loadSessions(false)}>
                    ${this.loading ? "加载中…" : "加载更多"}
                  </button>
                </div>`
                : nothing
            }
          `
              : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-sessions-view": CSSessionsView;
  }
}
