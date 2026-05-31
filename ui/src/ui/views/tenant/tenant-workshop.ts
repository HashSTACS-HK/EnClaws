/**
 * AI Workshop (AI工坊) tenant container view — ST-C4.
 *
 * A 6-sub-tab container that embeds existing tenant views:
 *   1. 模型管理 (models)    → <tenant-models-view>
 *   2. IM接入   (channels)  → <tenant-channels-view>
 *   3. 定时任务 (cron)      → <tenant-cron-view>
 *   4. 技能     (skills)    → <tenant-skills-view>
 *   5. 工作流   (workflow)  → 即将上线 placeholder
 *   6. 智能操作 (operations)→ 即将上线 placeholder
 *
 * Cross-tab navigation events (navigate-to-agent, navigate-to-agent-cron) fired
 * by embedded views are re-dispatched so the parent (app-render) can handle them
 * exactly as it would standalone.
 *
 * AI 工坊六子标签容器（ST-C4）：前四个嵌入现有视图，后两个为即将上线占位。
 * 子视图触发的跨标签导航事件会向上冒泡到 app-render 处理。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { caretFix } from "../../shared-styles.ts";
import "./tenant-models.ts";
import "./tenant-channels.ts";
import "./tenant-cron.ts";
import "./tenant-skills.ts";

// ── Sub-tab IDs ───────────────────────────────────────────────────────────────

type WorkshopTab = "models" | "channels" | "cron" | "skills" | "workflow" | "operations";

const WORKSHOP_TABS: WorkshopTab[] = [
  "models",
  "channels",
  "cron",
  "skills",
  "workflow",
  "operations",
];

// ── Component ─────────────────────────────────────────────────────────────────

@customElement("tenant-workshop-view")
export class TenantWorkshopView extends LitElement {
  private i18nCtrl = new I18nController(this);

  /** Gateway WebSocket URL — passed through to embedded views. */
  @property({ type: String }) gatewayUrl = "";

  @state() private currentSubTab: WorkshopTab = "models";

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }

      /* ── Tab bar ─────────────────────────────────────────────────────────── */
      .workshop-tab-bar {
        display: flex;
        gap: 4px;
        padding: 0 1.5rem;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        background: var(--surface, transparent);
        flex-wrap: wrap;
      }

      .workshop-tab-btn {
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

      .workshop-tab-btn:hover {
        color: var(--text, #e5e5e5);
      }

      .workshop-tab-btn.active {
        color: var(--accent, #7c6af5);
        border-bottom-color: var(--accent, #7c6af5);
      }

      /* ── Content area ───────────────────────────────────────────────────── */
      .workshop-content {
        /* embedded views manage their own padding */
      }

      /* ── Coming-soon placeholder ────────────────────────────────────────── */
      .coming-soon-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 80px 24px;
        color: var(--text-muted, #888);
        text-align: center;
      }

      .coming-soon-placeholder .coming-soon-icon {
        font-size: 32px;
        opacity: 0.5;
      }

      .coming-soon-placeholder .coming-soon-label {
        font-size: 14px;
      }
    `,
  ];

  /** Label i18n key for each sub-tab. */
  private _tabLabelKey(tab: WorkshopTab): string {
    const keyMap: Record<WorkshopTab, string> = {
      models: "tenantWorkshop.modelsTab",
      channels: "tenantWorkshop.channelsTab",
      cron: "tenantWorkshop.cronTab",
      skills: "tenantWorkshop.skillsTab",
      workflow: "tenantWorkshop.workflowTab",
      operations: "tenantWorkshop.operationsTab",
    };
    return keyMap[tab];
  }

  private _renderTabBar() {
    return html`
      <div class="workshop-tab-bar" role="tablist" aria-label="AI Workshop">
        ${WORKSHOP_TABS.map(
          (tab) => html`
            <button
              type="button"
              role="tab"
              aria-selected=${this.currentSubTab === tab}
              class="workshop-tab-btn ${this.currentSubTab === tab ? "active" : ""}"
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
    const gw = this.gatewayUrl;

    switch (this.currentSubTab) {
      case "models":
        return html`<tenant-models-view .gatewayUrl=${gw}></tenant-models-view>`;

      case "channels":
        return html`<tenant-channels-view
          .gatewayUrl=${gw}
          @navigate-to-agent=${(e: CustomEvent<{ agentId: string }>) => {
            // Re-dispatch so app-render can handle cross-tab navigation
            this.dispatchEvent(
              new CustomEvent("navigate-to-agent", {
                detail: e.detail,
                bubbles: true,
                composed: true,
              }),
            );
          }}
        ></tenant-channels-view>`;

      case "cron":
        return html`<tenant-cron-view
          .gatewayUrl=${gw}
          @navigate-to-agent-cron=${(e: CustomEvent<{ agentId: string }>) => {
            // Re-dispatch so app-render can handle cross-tab navigation
            this.dispatchEvent(
              new CustomEvent("navigate-to-agent-cron", {
                detail: e.detail,
                bubbles: true,
                composed: true,
              }),
            );
          }}
        ></tenant-cron-view>`;

      case "skills":
        return html`<tenant-skills-view .gatewayUrl=${gw}></tenant-skills-view>`;

      case "workflow":
      case "operations": {
        const labelKey =
          this.currentSubTab === "workflow"
            ? "tenantWorkshop.workflowTab"
            : "tenantWorkshop.operationsTab";
        return html`
          <div class="coming-soon-placeholder">
            <span class="coming-soon-icon" aria-hidden="true">🔧</span>
            <span class="coming-soon-label">
              ${t(labelKey)} — ${t("tenantWorkshop.comingSoonLabel")}
            </span>
          </div>
        `;
      }

      default:
        return nothing;
    }
  }

  render() {
    return html`
      ${this._renderTabBar()}
      <div class="workshop-content">${this._renderContent()}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tenant-workshop-view": TenantWorkshopView;
  }
}
