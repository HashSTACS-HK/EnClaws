import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SUPPORTED_LOCALES } from "../../i18n/index.ts";
import type { Locale } from "../../i18n/index.ts";
import { caretFix } from "../shared-styles.ts";

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "pt-BR": "Portugues",
  de: "Deutsch",
};

@customElement("language-switcher")
export class LanguageSwitcher extends LitElement {
  @property({ type: String }) locale: string = "en";
  @state() private menuOpen = false;

  static styles = [
    caretFix,
    css`
      :host {
        display: inline-block;
        position: relative;
      }

      button {
        background: transparent;
        border: none;
        color: var(--text-color, var(--text, #e5e5e5));
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 14px;
        transition: background 0.2s;
      }

      button:hover {
        background: var(--surface-2, rgba(128, 128, 128, 0.15));
      }

      .icon {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .icon svg {
        width: 14px;
        height: 14px;
      }

      .menu {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: var(--surface-1, var(--card, #1f1f1f));
        border: 1px solid var(--border-color, var(--border, #303030));
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        min-width: 120px;
        z-index: 100;
        display: none;
        flex-direction: column;
        padding: 4px;
      }

      .menu.open {
        display: flex;
      }

      .menu-item {
        background: transparent;
        border: none;
        text-align: left;
        padding: 8px 12px;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-color, var(--text, #e5e5e5));
        border-radius: 4px;
        width: 100%;
      }

      .menu-item:hover {
        background: var(--surface-2, rgba(128, 128, 128, 0.15));
      }

      .menu-item.active {
        font-weight: 600;
        background: var(--surface-2, rgba(128, 128, 128, 0.15));
        color: var(--primary-color, var(--accent, #3b82f6));
      }
    `,
  ];

  private handleToggle() {
    this.menuOpen = !this.menuOpen;
  }

  private handleSelect(loc: Locale) {
    this.menuOpen = false;
    if (this.locale !== loc) {
      this.dispatchEvent(
        new CustomEvent("locale-change", {
          detail: { locale: loc },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private handleClickOutside = (e: MouseEvent) => {
    if (!this.shadowRoot?.contains(e.composedPath()[0] as Node)) {
      this.menuOpen = false;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("click", this.handleClickOutside);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this.handleClickOutside);
  }

  render() {
    const globeIcon = html`
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path
          d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
        />
        <path d="M2 12h20" />
      </svg>
    `;

    const currentLabel = LOCALE_LABELS[this.locale as Locale] ?? "English";

    return html`
      <button @click=${() => this.handleToggle()}>
        <span class="icon">${globeIcon}</span>
        <span>${currentLabel}</span>
      </button>

      <div class="menu ${this.menuOpen ? "open" : ""}">
        ${SUPPORTED_LOCALES.map(
          (loc) => html`
            <button
              class="menu-item ${this.locale === loc ? "active" : ""}"
              @click=${() => this.handleSelect(loc)}
            >
              ${LOCALE_LABELS[loc]}
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "language-switcher": LanguageSwitcher;
  }
}
