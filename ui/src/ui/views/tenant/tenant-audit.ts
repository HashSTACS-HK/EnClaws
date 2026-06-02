/**
 * AI员工审计 (AI Employee Audit) tenant container view — P7-A.
 *
 * A 2-sub-tab container:
 *   Tab 1: 会话记录 (sessions)  → renderSessions() with props passed from app-render
 *   Tab 2: LLM审计  (traces)    → <tenant-traces-view .gatewayUrl>
 *
 * Sessions state (loading/result/filters/callbacks) is owned by app-render and
 * passed in via `sessionsProps` (attribute: false) — identical to the standalone
 * sessions tab, no extra state duplication.
 *
 * tenant-traces-view fires no cross-tab navigation events; no re-dispatch needed.
 *
 * AI 员工审计双子标签容器（P7-A）：会话记录嵌套现有 renderSessions，
 * LLM审计嵌套现有 tenant-traces-view，两者使用与独立页面完全一致的 props。
 */

import { html, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { renderSessions } from "../sessions.ts";
import type { SessionsProps } from "../sessions.ts";
import "./cs-sessions.ts";
import "./tenant-traces.ts";

// ── Sub-tab IDs ───────────────────────────────────────────────────────────────

type AuditTab = "customer-sessions" | "sessions" | "traces";

const AUDIT_TABS: AuditTab[] = ["customer-sessions", "sessions", "traces"];

// ── Component ─────────────────────────────────────────────────────────────────

@customElement("tenant-audit-view")
export class TenantAuditView extends LitElement {
  private i18nCtrl = new I18nController(this);

  /** Gateway WebSocket URL — passed through to embedded traces view. */
  @property({ type: String }) gatewayUrl = "";

  /**
   * All sessions props (state + callbacks) owned by app-render and passed in.
   * Using attribute:false so object/function references flow through cleanly.
   */
  @property({ attribute: false }) sessionsProps: SessionsProps | null = null;

  @state() private currentSubTab: AuditTab = "customer-sessions";

  /**
   * Light DOM rendering so that renderSessions() content inherits global
   * components.css classes (.card, .field, .session-card, etc.).
   * static styles is not used — tab-bar uses inline styles instead.
   */
  createRenderRoot() {
    return this;
  }

  /** i18n key for each sub-tab. */
  private _tabLabelKey(tab: AuditTab): string {
    const keyMap: Record<AuditTab, string> = {
      "customer-sessions": "tenantAudit.customerSessionsTab",
      sessions: "tenantAudit.sessionsTab",
      traces: "tenantAudit.tracesTab",
    };
    return keyMap[tab];
  }

  private _descriptionKey(tab: AuditTab): string {
    const keyMap: Record<AuditTab, string> = {
      "customer-sessions": "tenantAudit.customerSessionsDescription",
      sessions: "tenantAudit.sessionsDescription",
      traces: "tenantAudit.tracesDescription",
    };
    return keyMap[tab];
  }

  private _renderTabBar() {
    return html`
      <div
        role="tablist"
        aria-label="AI Employee Audit"
        style="display: flex; gap: 4px; border-bottom: 1px solid var(--border, #262626); margin-bottom: 16px;"
      >
        ${AUDIT_TABS.map((tab) => {
          const active = this.currentSubTab === tab;
          return html`
            <button
              type="button"
              role="tab"
              aria-selected=${active}
              @click=${() => {
                this.currentSubTab = tab;
              }}
              style="padding: 8px 16px; background: none; border: none; border-bottom: 2px solid ${
                active ? "var(--accent, #3b82f6)" : "transparent"
              }; color: ${
                active ? "var(--accent, #3b82f6)" : "var(--text-2, #888)"
              }; cursor: pointer; font-size: 0.9rem; font-weight: ${active ? "600" : "400"};"
            >
              ${t(this._tabLabelKey(tab))}
            </button>
          `;
        })}
      </div>
    `;
  }

  private _renderContent() {
    switch (this.currentSubTab) {
      case "sessions":
        if (!this.sessionsProps) {
          return nothing;
        }
        return renderSessions(this.sessionsProps);

      case "customer-sessions":
        return html`
          <cs-sessions-view></cs-sessions-view>
        `;

      case "traces":
        return html`<tenant-traces-view .gatewayUrl=${this.gatewayUrl}></tenant-traces-view>`;

      default:
        return nothing;
    }
  }

  render() {
    return html`
      ${this._renderTabBar()}
      <p style="margin: -4px 0 16px; color: var(--text-2, #6b7280); font-size: 0.9rem;">
        ${t(this._descriptionKey(this.currentSubTab))}
      </p>
      <div>${this._renderContent()}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tenant-audit-view": TenantAuditView;
  }
}
