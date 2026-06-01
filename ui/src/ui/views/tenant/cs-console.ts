/**
 * 客服控制台 (CS Console) — merged container for API mode + Widget mode.
 *
 * Embeds two existing views as internal tabs:
 *   Tab "API模式"    → <cs-api-mode-view .gatewayUrl>
 *   Tab "Widget模式" → <cs-widget-management-view .gatewayUrl>
 *
 * Uses LIGHT DOM (createRenderRoot returns this) and inline tab-bar styles,
 * mirroring the pattern used in tenant-audit.ts to avoid shadow-DOM styling issues.
 *
 * 客服控制台双标签容器：API模式嵌套 cs-api-mode-view，Widget 模式嵌套
 * cs-widget-management-view，两者通过 .gatewayUrl 接收网关地址。
 */

import { html, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import "./cs-api-mode.ts";
import "./cs-widget-management.ts";

// ── Sub-tab IDs ───────────────────────────────────────────────────────────────

type ConsoleTab = "api" | "widget";

const CONSOLE_TABS: ConsoleTab[] = ["api", "widget"];

// ── Component ─────────────────────────────────────────────────────────────────

@customElement("cs-console-view")
export class CsConsoleView extends LitElement {
  // LIGHT DOM — avoids shadow-DOM styling isolation issues (mirrors tenant-audit.ts)
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) gatewayUrl = "";

  @state() private currentTab: ConsoleTab = "api";

  // Reactive i18n
  private _i18n = new I18nController(this);

  private _tabLabelKey(tab: ConsoleTab): string {
    const keyMap: Record<ConsoleTab, string> = {
      api: "csConsole.apiTab",
      widget: "csConsole.widgetTab",
    };
    return keyMap[tab];
  }

  private _renderTabBar() {
    return html`
      <div
        role="tablist"
        aria-label="CS Console"
        style="display: flex; gap: 4px; border-bottom: 1px solid var(--border, #262626); margin-bottom: 16px;"
      >
        ${CONSOLE_TABS.map((tab) => {
          const active = this.currentTab === tab;
          return html`
            <button
              type="button"
              role="tab"
              aria-selected=${active}
              @click=${() => {
                this.currentTab = tab;
              }}
              style="padding: 8px 16px; background: none; border: none; border-bottom: 2px solid ${active
                ? "var(--accent, #3b82f6)"
                : "transparent"}; color: ${active
                ? "var(--accent, #3b82f6)"
                : "var(--text-2, #888)"}; cursor: pointer; font-size: 0.9rem; font-weight: ${active
                ? "600"
                : "400"};"
            >
              ${t(this._tabLabelKey(tab))}
            </button>
          `;
        })}
      </div>
    `;
  }

  private _renderContent() {
    switch (this.currentTab) {
      case "api":
        return html`<cs-api-mode-view .gatewayUrl=${this.gatewayUrl}></cs-api-mode-view>`;
      case "widget":
        return html`<cs-widget-management-view
          .gatewayUrl=${this.gatewayUrl}
        ></cs-widget-management-view>`;
      default:
        return nothing;
    }
  }

  override render() {
    return html`
      ${this._renderTabBar()}
      <div>${this._renderContent()}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-console-view": CsConsoleView;
  }
}
