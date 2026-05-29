/**
 * Auth Phase 1 — supplementary login views.
 *
 * Custom elements:
 *   <enclaws-forgot-password>      → entry point for the forgot-password flow.
 *                                    Calls auth.capabilities to decide whether
 *                                    to show "enter your email" or "contact admin".
 *   <enclaws-reset-password>       → token landing page for the email-based
 *                                    reset flow.  Reads the token from the
 *                                    location hash query string.
 *   <enclaws-temp-password-view>   → one-time view of an admin-issued temp
 *                                    password.  Auto-consumes the token on
 *                                    first successful read.
 *   <enclaws-force-change-password>→ overlay shown when the JWT carries
 *                                    `fcp: true`.  Calls auth.changePassword
 *                                    and then asks the user to log in again.
 *   <enclaws-change-password>      → self-service change page reachable from
 *                                    the password-expiry banner; has a back
 *                                    link that returns to the console.
 *
 * All views are intentionally minimal — no theme toggle, just the core form.
 * They slot into the existing app shell via window.location.hash routing.
 * All user-visible strings go through `t("auth.…")`; add new keys to all
 * five locale files under `ui/src/i18n/locales/`.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import "../components/captcha-field.ts";
import {
  callAuthRpc,
  changePasswordAuthed,
  CaptchaInvalidError,
  getAuthCapabilities,
  requestForgotPassword,
  verifyForgotPassword,
  viewTempPassword,
  clearAuth,
} from "../auth-store.ts";
import type { CaptchaField } from "../components/captcha-field.ts";

// ---------------------------------------------------------------------------
// Shared password policy mirror — keep aligned with src/auth/password-policy.ts.
// Returns an i18n key (or null if the password is OK) so the UI can translate
// the message at render time and react to locale switches.
// ---------------------------------------------------------------------------

function classCount(p: string): number {
  let n = 0;
  if (/[a-z]/.test(p)) {
    n++;
  }
  if (/[A-Z]/.test(p)) {
    n++;
  }
  if (/[0-9]/.test(p)) {
    n++;
  }
  if (/[^a-zA-Z0-9]/.test(p)) {
    n++;
  }
  return n;
}

function clientValidatePasswordKey(pw: string): string | null {
  if (!pw || pw.length < 8) {
    return "auth.policy.tooShort";
  }
  if (pw.length > 128) {
    return "auth.policy.tooLong";
  }
  if (classCount(pw) < 3) {
    return "auth.policy.missingClasses";
  }
  if (/(.)\1\1/.test(pw)) {
    return "auth.policy.repeatedChars";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const baseStyles = css`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: var(--bg, #0a0a0a);
    color: var(--text, #e5e5e5);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: var(--card, #141414);
    border: 1px solid var(--border, #262626);
    border-radius: var(--radius-lg, 8px);
    padding: 2rem;
    box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.3));
  }
  h1 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  .subtitle {
    font-size: 0.85rem;
    color: var(--text-muted, #737373);
    margin: 0 0 1.25rem;
  }
  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 500;
    margin: 0.75rem 0 0.35rem;
    color: var(--text-secondary, #a3a3a3);
  }
  input {
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: var(--bg, #0a0a0a);
    border: 1px solid var(--border, #262626);
    border-radius: var(--radius-md, 6px);
    color: var(--text, #e5e5e5);
    font-size: 0.9rem;
    outline: none;
    box-sizing: border-box;
  }
  input:focus {
    border-color: var(--accent, #3b82f6);
  }
  button.primary {
    margin-top: 1.25rem;
    width: 100%;
    padding: 0.6rem;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: var(--radius-md, 6px);
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error {
    margin-top: 0.75rem;
    font-size: 0.78rem;
    color: var(--text-destructive, #ef4444);
  }
  .ok {
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: var(--text, #e5e5e5);
  }
  .link {
    color: var(--accent, #3b82f6);
    cursor: pointer;
    text-decoration: none;
    font-size: 0.8rem;
  }
  .footer {
    margin-top: 1rem;
    text-align: center;
  }
  .hint {
    font-size: 0.72rem;
    color: var(--text-hint, #8a8a8a);
    margin-top: 0.25rem;
  }
  .temp-pw {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 1.05rem;
    background: var(--bg, #0a0a0a);
    border: 1px dashed var(--border, #262626);
    border-radius: var(--radius-md, 6px);
    padding: 0.75rem;
    word-break: break-all;
    user-select: all;
  }
  /* Password input with eye-toggle button */
  .secret-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .secret-wrap input {
    flex: 1;
    padding-right: 2.25rem;
  }
  .eye-btn {
    position: absolute;
    right: 0.4rem;
    background: none;
    border: none;
    color: var(--text-muted, #525252);
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .eye-btn:hover {
    color: var(--text, #e5e5e5);
  }
  .eye-btn svg {
    pointer-events: none;
  }
`;

// Eye-open / eye-off SVG icons (16px, stroke-based, match login.ts style).
const eyeOpenSvg = html`
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
`;
const eyeOffSvg = html`
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.9 20.9 0 0 1 5.17-6.17" />
    <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.9 20.9 0 0 1-3.11 4.38" />
    <path d="M9.17 9.17a3 3 0 0 0 4.24 4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
`;

/**
 * Render a password input with an eye-toggle button.  Clicking the eye
 * swaps between `type=password` and `type=text` so the user can verify
 * what they typed.
 */
function renderPasswordField(opts: {
  value: string;
  onInput: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  required?: boolean;
  label?: string;
}) {
  return html`
    <div class="secret-wrap">
      <input
        type=${opts.visible ? "text" : "password"}
        .value=${opts.value}
        @input=${(e: InputEvent) => opts.onInput((e.target as HTMLInputElement).value)}
        ?required=${opts.required ?? false}
      />
      <button
        type="button"
        class="eye-btn"
        aria-label=${opts.label ?? ""}
        @click=${opts.onToggle}
      >${opts.visible ? eyeOffSvg : eyeOpenSvg}</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Navigation helpers.  Assigning to window.location.hash natively fires
// `hashchange`, so we don't dispatch it manually.  The app shell's listener
// (see app-lifecycle.ts) bumps hashRouteTick and triggers a re-render.
// ---------------------------------------------------------------------------

function goToLogin(): void {
  window.location.hash = "";
}

function goBackHome(): void {
  // Clearing the hash returns to whatever tab the app was on; the
  // password-expiry banner button set the hash, so clearing it returns.
  window.location.hash = "";
}

function renderBackToLoginLink() {
  return html`
    <div class="footer">
      <a class="link" @click=${goToLogin}>${t("auth.common.backToLogin")}</a>
    </div>
  `;
}

function renderBackHomeLink() {
  return html`
    <div class="footer">
      <a class="link" @click=${goBackHome}>${t("auth.common.backHome")}</a>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// <enclaws-forgot-password>
// ---------------------------------------------------------------------------

@customElement("enclaws-forgot-password")
export class EnClawsForgotPassword extends LitElement {
  // Subscribe to locale changes so labels update in place.
  private i18nCtrl = new I18nController(this);
  static styles = baseStyles;
  @property({ type: String }) gatewayUrl = "";

  @state() private loading = true;
  @state() private hasEmail = false;
  @state() private email = "";
  @state() private submitting = false;
  @state() private done = false;
  @state() private error = "";

  async connectedCallback() {
    super.connectedCallback();
    try {
      const caps = await getAuthCapabilities(this.gatewayUrl);
      this.hasEmail = caps.email;
    } catch {
      this.hasEmail = false;
    } finally {
      this.loading = false;
    }
  }

  private getCaptcha(): CaptchaField | null {
    return this.renderRoot.querySelector("captcha-field");
  }

  private async submit(e: Event) {
    e.preventDefault();
    if (!this.email) {
      return;
    }
    const captcha = this.getCaptcha();
    if (!captcha?.captchaId || !captcha.value) {
      this.error = t("captcha.errRequired");
      return;
    }
    this.submitting = true;
    this.error = "";
    try {
      await requestForgotPassword(this.gatewayUrl, this.email, {
        id: captcha.captchaId,
        answer: captcha.value,
      });
      this.done = true;
    } catch (err) {
      void this.getCaptcha()?.refresh();
      if (err instanceof CaptchaInvalidError) {
        this.error = t("captcha.errInvalid");
      } else {
        this.error = err instanceof Error ? err.message : t("auth.forgot.requestFailed");
      }
    } finally {
      this.submitting = false;
    }
  }

  render() {
    void this.i18nCtrl; // referenced for side-effect subscription
    if (this.loading) {
      return html`<div class="card"><div class="ok">${t("auth.forgot.checking")}</div></div>`;
    }
    if (!this.hasEmail) {
      return html`
        <div class="card">
          <h1>${t("auth.forgot.noEmailTitle")}</h1>
          <p class="subtitle">${t("auth.forgot.noEmailBody")}</p>
          <p class="ok">${t("auth.forgot.contactAdmin")}</p>
          ${renderBackToLoginLink()}
        </div>
      `;
    }
    if (this.done) {
      return html`
        <div class="card">
          <h1>${t("auth.forgot.sentTitle")}</h1>
          <p class="ok">${t("auth.forgot.sentBody")}</p>
          ${renderBackToLoginLink()}
        </div>
      `;
    }
    return html`
      <div class="card">
        <h1>${t("auth.forgot.title")}</h1>
        <p class="subtitle">${t("auth.forgot.subtitle")}</p>
        <form @submit=${this.submit}>
          <label>${t("auth.forgot.emailLabel")}</label>
          <input
            type="email"
            placeholder=${t("auth.forgot.emailPlaceholder")}
            .value=${this.email}
            @input=${(e: InputEvent) => {
              this.email = (e.target as HTMLInputElement).value;
            }}
            required
          />
          <label>${t("captcha.label")}</label>
          <captcha-field gateway-url=${this.gatewayUrl}></captcha-field>
          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.submitting}>
            ${this.submitting ? t("auth.forgot.sending") : t("auth.forgot.submit")}
          </button>
        </form>
        ${renderBackToLoginLink()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-reset-password>
// ---------------------------------------------------------------------------

function readHashParam(name: string): string {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) {
    return "";
  }
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  return params.get(name) ?? "";
}

@customElement("enclaws-reset-password")
export class EnClawsResetPassword extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = baseStyles;
  @property({ type: String }) gatewayUrl = "";

  @state() private newPassword = "";
  @state() private confirmPassword = "";
  @state() private showNew = false;
  @state() private showConfirm = false;
  @state() private submitting = false;
  @state() private done = false;
  @state() private error = "";

  private get token(): string {
    return readHashParam("token");
  }

  private async submit(e: Event) {
    e.preventDefault();
    this.error = "";
    const policyKey = clientValidatePasswordKey(this.newPassword);
    if (policyKey) {
      this.error = t(policyKey);
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error = t("auth.reset.mismatch");
      return;
    }
    if (!this.token) {
      this.error = t("auth.reset.invalidLink");
      return;
    }
    this.submitting = true;
    try {
      await verifyForgotPassword(this.gatewayUrl, this.token, this.newPassword);
      this.done = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("auth.reset.failed");
    } finally {
      this.submitting = false;
    }
  }

  render() {
    void this.i18nCtrl;
    if (this.done) {
      return html`
        <div class="card">
          <h1>${t("auth.reset.doneTitle")}</h1>
          <p class="ok">${t("auth.reset.doneBody")}</p>
          ${renderBackToLoginLink()}
        </div>
      `;
    }
    return html`
      <div class="card">
        <h1>${t("auth.reset.title")}</h1>
        <p class="subtitle">${t("auth.reset.subtitle")}</p>
        <form @submit=${this.submit}>
          <label>${t("auth.reset.newPasswordLabel")}</label>
          ${renderPasswordField({
            value: this.newPassword,
            onInput: (v) => {
              this.newPassword = v;
            },
            visible: this.showNew,
            onToggle: () => {
              this.showNew = !this.showNew;
            },
            required: true,
            label: t("auth.reset.newPasswordLabel"),
          })}
          <div class="hint">${t("auth.policy.hint")}</div>
          <label>${t("auth.reset.confirmLabel")}</label>
          ${renderPasswordField({
            value: this.confirmPassword,
            onInput: (v) => {
              this.confirmPassword = v;
            },
            visible: this.showConfirm,
            onToggle: () => {
              this.showConfirm = !this.showConfirm;
            },
            required: true,
            label: t("auth.reset.confirmLabel"),
          })}
          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.submitting}>
            ${this.submitting ? t("auth.common.submitting") : t("auth.reset.submit")}
          </button>
        </form>
        ${renderBackToLoginLink()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-temp-password-view>
// ---------------------------------------------------------------------------

@customElement("enclaws-temp-password-view")
export class EnClawsTempPasswordView extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = baseStyles;
  @property({ type: String }) gatewayUrl = "";

  @state() private loading = true;
  @state() private tempPassword = "";
  @state() private error = "";

  async connectedCallback() {
    super.connectedCallback();
    const token = readHashParam("token");
    if (!token) {
      this.error = t("auth.tempView.invalidLink");
      this.loading = false;
      return;
    }
    try {
      const r = await viewTempPassword(this.gatewayUrl, token);
      this.tempPassword = r.tempPassword;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("auth.tempView.viewFailed");
    } finally {
      this.loading = false;
    }
  }

  private copy() {
    if (!this.tempPassword) {
      return;
    }
    void navigator.clipboard?.writeText(this.tempPassword).catch(() => undefined);
  }

  render() {
    void this.i18nCtrl;
    if (this.loading) {
      return html`<div class="card"><div class="ok">${t("auth.tempView.checking")}</div></div>`;
    }
    if (this.error || !this.tempPassword) {
      return html`
        <div class="card">
          <h1>${t("auth.tempView.invalidTitle")}</h1>
          <p class="error">${this.error || t("auth.tempView.linkExpired")}</p>
          ${renderBackToLoginLink()}
        </div>
      `;
    }
    return html`
      <div class="card">
        <h1>${t("auth.tempView.title")}</h1>
        <p class="subtitle">${t("auth.tempView.subtitle")}</p>
        <div class="temp-pw">${this.tempPassword}</div>
        <button class="primary" @click=${this.copy}>${t("auth.tempView.copy")}</button>
        <p class="hint">${t("auth.tempView.hint")}</p>
        ${renderBackToLoginLink()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Shared change-password form logic.
//
// `<enclaws-force-change-password>` and `<enclaws-change-password>` share the
// exact same three-input form; only the header copy and the post-success
// side-door differ.  The base class below owns the form state and submit
// machinery; subclasses just provide header strings and decide what
// "cancel" means (logout vs. back home).
// ---------------------------------------------------------------------------

abstract class ChangePasswordFormBase extends LitElement {
  protected i18nCtrl = new I18nController(this);
  static styles = baseStyles;

  @state() protected currentPassword = "";
  @state() protected newPassword = "";
  @state() protected confirmPassword = "";
  @state() protected showCurrent = false;
  @state() protected showNew = false;
  @state() protected showConfirm = false;
  @state() protected submitting = false;
  @state() protected error = "";
  @state() protected done = false;

  protected abstract getTitle(): string;
  protected abstract getSubtitle(): string;
  protected abstract getDoneMessage(): string;
  protected abstract onAfterSuccess(): void;
  protected abstract renderSideDoor(): unknown;

  protected async submit(e: Event) {
    e.preventDefault();
    this.error = "";
    if (!this.currentPassword) {
      this.error = t("auth.change.currentRequired");
      return;
    }
    const policyKey = clientValidatePasswordKey(this.newPassword);
    if (policyKey) {
      this.error = t(policyKey);
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error = t("auth.reset.mismatch");
      return;
    }
    if (this.currentPassword === this.newPassword) {
      this.error = t("auth.change.cannotReuse");
      return;
    }
    this.submitting = true;
    try {
      await changePasswordAuthed(this.currentPassword, this.newPassword);
      this.done = true;
      setTimeout(() => this.onAfterSuccess(), 1500);
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("auth.change.failed");
    } finally {
      this.submitting = false;
    }
  }

  render() {
    void this.i18nCtrl;
    if (this.done) {
      return html`
        <div class="card">
          <h1>${t("auth.change.doneTitle")}</h1>
          <p class="ok">${this.getDoneMessage()}</p>
        </div>
      `;
    }
    return html`
      <div class="card">
        <h1>${this.getTitle()}</h1>
        <p class="subtitle">${this.getSubtitle()}</p>
        <form @submit=${this.submit}>
          <label>${t("auth.change.currentLabel")}</label>
          ${renderPasswordField({
            value: this.currentPassword,
            onInput: (v) => {
              this.currentPassword = v;
            },
            visible: this.showCurrent,
            onToggle: () => {
              this.showCurrent = !this.showCurrent;
            },
            required: true,
            label: t("auth.change.currentLabel"),
          })}
          <label>${t("auth.reset.newPasswordLabel")}</label>
          ${renderPasswordField({
            value: this.newPassword,
            onInput: (v) => {
              this.newPassword = v;
            },
            visible: this.showNew,
            onToggle: () => {
              this.showNew = !this.showNew;
            },
            required: true,
            label: t("auth.reset.newPasswordLabel"),
          })}
          <div class="hint">${t("auth.policy.hint")}</div>
          <label>${t("auth.reset.confirmLabel")}</label>
          ${renderPasswordField({
            value: this.confirmPassword,
            onInput: (v) => {
              this.confirmPassword = v;
            },
            visible: this.showConfirm,
            onToggle: () => {
              this.showConfirm = !this.showConfirm;
            },
            required: true,
            label: t("auth.reset.confirmLabel"),
          })}
          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.submitting}>
            ${this.submitting ? t("auth.common.submitting") : t("auth.change.submit")}
          </button>
        </form>
        ${this.renderSideDoor()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-force-change-password> — shown as overlay when fcp=true.
// ---------------------------------------------------------------------------

@customElement("enclaws-force-change-password")
export class EnClawsForceChangePassword extends ChangePasswordFormBase {
  protected getTitle() {
    return t("auth.change.forcedTitle");
  }
  protected getSubtitle() {
    return t("auth.change.forcedSubtitle");
  }
  protected getDoneMessage() {
    return t("auth.change.doneRedirect");
  }

  protected onAfterSuccess() {
    clearAuth();
    window.location.href = "/login";
  }

  protected renderSideDoor() {
    return html`
      <div class="footer">
        <a class="link" @click=${this.logoutInstead}>${t("auth.common.logout")}</a>
      </div>
    `;
  }

  private logoutInstead() {
    clearAuth();
    window.location.href = "/login";
  }
}

// ---------------------------------------------------------------------------
// <enclaws-change-password> — self-service change reachable via hash route.
// Has a "back to home" link so the user can cancel.
// ---------------------------------------------------------------------------

@customElement("enclaws-change-password")
export class EnClawsChangePassword extends ChangePasswordFormBase {
  protected getTitle() {
    return t("auth.change.title");
  }
  protected getSubtitle() {
    return "";
  }
  protected getDoneMessage() {
    return t("auth.change.doneRelogin");
  }

  protected onAfterSuccess() {
    // changePasswordAuthed already cleared auth — hard-navigate to login.
    window.location.href = "/login";
  }

  protected renderSideDoor() {
    return renderBackHomeLink();
  }
}

// Suppress unused-import warnings for callAuthRpc — it's re-exported here so
// downstream consumers can build new flows without re-importing from auth-store.
export { callAuthRpc };
