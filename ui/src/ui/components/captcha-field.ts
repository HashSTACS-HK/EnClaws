/**
 * Graphic captcha input used on login / register / forgot-password
 * forms in multi-tenant mode.
 *
 * The component issues `captcha.challenge` on first render (and on
 * every `refresh()` call or click of the SVG), renders the returned
 * SVG, and exposes the user's answer via the `value` getter.
 *
 * Parents read `.captchaId` + `.value` before submitting the form, and
 * call `refresh()` after any auth failure so a single challenge cannot
 * be reused across attempts.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { requestCaptchaChallenge } from "../auth-store.ts";

@customElement("captcha-field")
export class CaptchaField extends LitElement {
  // Subscribe to locale changes so labels re-render on language switch.
  private i18nCtrl = new I18nController(this);

  @property({ type: String, attribute: "gateway-url" }) gatewayUrl = "";
  @property({ type: String }) error = "";

  @state() private svg = "";
  @state() private challengeId = "";
  @state() private expiresAt = 0;
  @state() private loading = false;
  @state() private answer = "";
  @state() private loadError = "";

  private expiryTimer?: ReturnType<typeof setTimeout>;

  static styles = css`
    :host {
      display: block;
    }
    .row {
      display: flex;
      align-items: stretch;
      gap: 10px;
    }
    .image-btn {
      flex: 0 0 auto;
      width: 140px;
      padding: 0;
      border: 1.5px solid var(--input-border, #d1e8ef);
      border-radius: 10px;
      background: var(--input-bg, #f8fcfd);
      cursor: pointer;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      transition:
        border-color 0.15s,
        background 0.15s;
    }
    .image-btn:hover {
      border-color: var(--accent, #0891b2);
      background: var(--surface, #ffffff);
    }
    .image-btn svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .placeholder {
      font-size: 13px;
      color: var(--text-3, #94a3b8);
    }
    input {
      flex: 1 1 auto;
      width: 100%;
      padding: 13px 16px;
      border: 1.5px solid var(--input-border, #d1e8ef);
      border-radius: 10px;
      font-size: 15px;
      font-family: inherit;
      letter-spacing: 2px;
      background: var(--input-bg, #f8fcfd);
      color: var(--text, #0c1a1f);
      outline: none;
      transition:
        border-color 0.15s,
        box-shadow 0.15s,
        background 0.15s;
      box-sizing: border-box;
    }
    input::placeholder {
      color: var(--text-3, #94a3b8);
      letter-spacing: normal;
    }
    input:focus {
      border-color: var(--accent, #0891b2);
      box-shadow: 0 0 0 4px var(--accent-light, rgba(8, 145, 178, 0.08));
      background: var(--surface, #ffffff);
    }
    input.has-error {
      border-color: var(--danger, #ef4444);
    }
    input.has-error:focus {
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.08);
    }
    .error {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 6px;
      color: var(--danger, #ef4444);
      font-size: 12px;
    }
    .error svg {
      flex-shrink: 0;
      width: 13px;
      height: 13px;
      fill: currentColor;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
  }

  /** Current user-entered answer. */
  get value(): string {
    return this.answer.trim();
  }

  /** Current challenge id — undefined until the first load resolves. */
  get captchaId(): string {
    return this.challengeId;
  }

  /** Fetch a new challenge and clear the answer field. */
  async refresh(): Promise<void> {
    if (!this.gatewayUrl) {
      this.loadError = t("captcha.loadFailed");
      return;
    }
    this.loading = true;
    this.loadError = "";
    this.answer = "";
    try {
      const c = await requestCaptchaChallenge(this.gatewayUrl);
      this.challengeId = c.id;
      this.svg = c.svg;
      this.expiresAt = c.expiresAt;
      this.dispatchEvent(
        new CustomEvent("captcha-ready", {
          detail: { id: c.id, expiresAt: c.expiresAt },
          bubbles: true,
          composed: true,
        }),
      );
      this.scheduleAutoRefresh();
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : t("captcha.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private scheduleAutoRefresh(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
    const msUntilExpiry = this.expiresAt - Date.now() - 5_000;
    if (msUntilExpiry <= 0) {
      return;
    }
    this.expiryTimer = setTimeout(() => {
      void this.refresh();
    }, msUntilExpiry);
  }

  private onInput(e: Event): void {
    this.answer = (e.target as HTMLInputElement).value;
    this.dispatchEvent(
      new CustomEvent("captcha-input", {
        detail: { value: this.answer },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected render() {
    void this.i18nCtrl; // subscribe to locale changes
    const errorText = this.error || this.loadError;
    return html`
      <div class="row">
        <button
          type="button"
          class="image-btn"
          @click=${() => {
            void this.refresh();
          }}
          title=${t("captcha.refreshHint")}
          aria-label=${t("captcha.refreshAria")}
          ?disabled=${this.loading}
        >
          ${
            this.svg
              ? html`<span .innerHTML=${this.svg}></span>`
              : html`<span class="placeholder">${this.loading ? t("captcha.loading") : t("captcha.clickToLoad")}</span>`
          }
        </button>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          maxlength="8"
          class=${errorText ? "has-error" : ""}
          placeholder=${t("captcha.placeholder")}
          .value=${this.answer}
          @input=${this.onInput}
        />
      </div>
      ${
        errorText
          ? html`
          <div class="error">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.5a.75.75 0 0 1 1.5 0v3.25a.75.75 0 0 1-1.5 0V4.5ZM8 11.5A.875.875 0 1 1 8 9.75a.875.875 0 0 1 0 1.75Z"/>
            </svg>
            <span>${errorText}</span>
          </div>
        `
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "captcha-field": CaptchaField;
  }
}
