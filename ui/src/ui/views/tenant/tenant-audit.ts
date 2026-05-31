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

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { caretFix } from "../../shared-styles.ts";
import { renderSessions } from "../sessions.ts";
import type { SessionsProps } from "../sessions.ts";
import "./tenant-traces.ts";

// ── Sub-tab IDs ───────────────────────────────────────────────────────────────

type AuditTab = "sessions" | "traces";

const AUDIT_TABS: AuditTab[] = ["sessions", "traces"];

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

  @state() private currentSubTab: AuditTab = "sessions";

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }

      /* ── Tab bar ─────────────────────────────────────────────────────────── */
      .audit-tab-bar {
        display: flex;
        gap: 4px;
        padding: 0 1.5rem;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        background: var(--surface, transparent);
        flex-wrap: wrap;
      }

      .audit-tab-btn {
        padding: 10px 16px;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-muted, #888);
        white-space: nowrap;
        transition:
          color 0.15s,
          border-color 0.15s;
      }

      .audit-tab-btn:hover {
        color: var(--text, #e5e5e5);
      }

      .audit-tab-btn.active {
        color: var(--accent, #7c6af5);
        border-bottom-color: var(--accent, #7c6af5);
      }

      /* ── Content area ───────────────────────────────────────────────────── */
      .audit-content {
        /* embedded views manage their own padding */
      }
    `,
  ];

  /** i18n key for each sub-tab. */
  private _tabLabelKey(tab: AuditTab): string {
    const keyMap: Record<AuditTab, string> = {
      sessions: "tenantAudit.sessionsTab",
      traces: "tenantAudit.tracesTab",
    };
    return keyMap[tab];
  }

  private _renderTabBar() {
    return html`
      <div class="audit-tab-bar" role="tablist" aria-label="AI Employee Audit">
        ${AUDIT_TABS.map(
          (tab) => html`
            <button
              type="button"
              role="tab"
              aria-selected=${this.currentSubTab === tab}
              class="audit-tab-btn ${this.currentSubTab === tab ? "active" : ""}"
              @click=${() => {
                this.currentSubTab = tab;
              }}
            >
              ${t(this._tabLabelKey(tab))}
            </button>
          `,
        )}
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

      case "traces":
        return html`<tenant-traces-view .gatewayUrl=${this.gatewayUrl}></tenant-traces-view>`;

      default:
        return nothing;
    }
  }

  render() {
    return html`
      ${this._renderTabBar()}
      <div class="audit-content">${this._renderContent()}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tenant-audit-view": TenantAuditView;
  }
}
