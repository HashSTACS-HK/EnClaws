/**
 * Auth Phase 3 — sessions, email verification, MFA views.
 *
 * Custom elements:
 *   <enclaws-sessions-list>         — list + revoke active sessions
 *   <enclaws-pending-verification>  — "check your email" screen
 *   <enclaws-verify-email>          — token landing page
 *   <enclaws-mfa-setup>             — QR code + verify first code + backup codes
 *   <enclaws-mfa-challenge>         — 6-digit input during MFA login
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import {
  callAuthRpc,
  callPublicRpc,
  loadAuth,
  saveAuth,
  clearAuth,
  type AuthState,
} from "../auth-store.ts";
import { loadSettings } from "../storage.ts";

// ---------------------------------------------------------------------------
// Shared styles (reuse the Phase 1 card look)
// ---------------------------------------------------------------------------

const cardStyles = css`
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
    max-width: 480px;
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
  h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 1.25rem 0 0.5rem;
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
    margin-top: 1rem;
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
`;

function goToLogin() {
  window.location.hash = "";
}
function backToLoginLink() {
  return html`<div class="footer"><a class="link" @click=${goToLogin}>${t("auth.common.backToLogin")}</a></div>`;
}

// ---------------------------------------------------------------------------
// <enclaws-sessions-list>
// ---------------------------------------------------------------------------

const sessionsStyles = css`
  ${cardStyles}
  .session-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.6rem 0; border-bottom: 1px solid var(--border, #262626);
    font-size: 0.85rem;
  }
  .session-item:last-child { border-bottom: none; }
  .session-label { flex: 1; }
  .session-meta { font-size: 0.72rem; color: var(--text-muted, #737373); }
  .session-current { font-size: 0.72rem; color: var(--accent, #3b82f6); margin-left: 0.5rem; }
  .revoke-btn {
    background: none; border: 1px solid var(--text-destructive, #ef4444);
    color: var(--text-destructive, #ef4444); padding: 0.2rem 0.5rem;
    border-radius: 4px; font-size: 0.75rem; cursor: pointer; flex-shrink: 0;
  }
  .revoke-btn:hover { background: rgba(239,68,68,0.1); }
  .revoke-all-btn {
    margin-top: 0.75rem; width: 100%; padding: 0.5rem;
    background: transparent; border: 1px solid var(--border, #262626);
    color: var(--text-muted, #737373); border-radius: var(--radius-md, 6px);
    font-size: 0.8rem; cursor: pointer;
  }
`;

interface SessionItem {
  id: string;
  label: string;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  isCurrent: boolean;
}

@customElement("enclaws-sessions-list")
export class EnClawsSessionsList extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = sessionsStyles;

  @state() private sessions: SessionItem[] = [];
  @state() private loading = true;
  @state() private error = "";

  async connectedCallback() {
    super.connectedCallback();
    await this.loadSessions();
  }

  private async loadSessions() {
    this.loading = true;
    try {
      const r = await callAuthRpc<{ sessions: SessionItem[] }>("auth.sessions", {});
      this.sessions = r.sessions ?? [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to load sessions";
    } finally {
      this.loading = false;
    }
  }

  private async revoke(id: string) {
    try {
      await callAuthRpc("auth.revokeSession", { sessionId: id });
      this.sessions = this.sessions.filter((s) => s.id !== id);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed";
    }
  }

  private async revokeAllOthers() {
    const auth = loadAuth();
    if (!auth?.refreshToken) {
      return;
    }
    try {
      await callAuthRpc("auth.revokeAllOtherSessions", { currentRefreshToken: auth.refreshToken });
      this.sessions = this.sessions.filter((s) => s.isCurrent);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed";
    }
  }

  private goBack() {
    window.location.hash = "";
  }

  render() {
    void this.i18nCtrl;
    if (this.loading) {
      return html`<div class="card"><div class="ok">${t("auth.common.submitting")}</div></div>`;
    }
    return html`
      <div class="card">
        <h1>${t("auth.sessions.title")}</h1>
        <p class="subtitle">${t("auth.sessions.subtitle")}</p>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${
          this.sessions.length === 0
            ? html`<p class="ok">${t("auth.sessions.noSessions")}</p>`
            : this.sessions.map(
                (s) => html`
              <div class="session-item">
                <div class="session-label">
                  <div>${s.label}${s.isCurrent ? html`<span class="session-current">${t("auth.sessions.currentDevice")}</span>` : nothing}</div>
                  <div class="session-meta">${s.ipAddress ?? ""} · ${s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : new Date(s.createdAt).toLocaleString()}</div>
                </div>
                ${!s.isCurrent ? html`<button class="revoke-btn" @click=${() => this.revoke(s.id)}>${t("auth.sessions.revoke")}</button>` : nothing}
              </div>
            `,
              )
        }
        ${
          this.sessions.length > 1
            ? html`<button class="revoke-all-btn" @click=${this.revokeAllOthers}>${t("auth.sessions.revokeAllOthers")}</button>`
            : nothing
        }
        <div class="footer"><a class="link" @click=${this.goBack}>${t("auth.common.backHome")}</a></div>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-pending-verification>
// ---------------------------------------------------------------------------

@customElement("enclaws-pending-verification")
export class EnClawsPendingVerification extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = cardStyles;
  @property({ type: String }) gatewayUrl = "";
  @property({ type: String }) email = "";

  @state() private resending = false;
  @state() private resent = false;
  @state() private error = "";

  private async resend() {
    if (!this.email) {
      return;
    }
    this.resending = true;
    this.error = "";
    try {
      await callPublicRpc(this.gatewayUrl, "auth.resendVerifyEmail", { email: this.email });
      this.resent = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed";
    } finally {
      this.resending = false;
    }
  }

  render() {
    void this.i18nCtrl;
    return html`
      <div class="card">
        <h1>${t("auth.verify.pendingTitle")}</h1>
        <p class="subtitle">${t("auth.verify.pendingBody")}</p>
        <p class="ok">${this.email}</p>
        ${
          this.resent
            ? html`<p class="ok">${t("auth.verify.resent")}</p>`
            : html`<button class="primary" ?disabled=${this.resending} @click=${this.resend}>
              ${this.resending ? t("auth.common.submitting") : t("auth.verify.resendBtn")}
            </button>`
        }
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${backToLoginLink()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-verify-email>
// ---------------------------------------------------------------------------

function readHashParam(name: string): string {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) {
    return "";
  }
  return new URLSearchParams(hash.slice(q + 1)).get(name) ?? "";
}

@customElement("enclaws-verify-email")
export class EnClawsVerifyEmail extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = cardStyles;
  @property({ type: String }) gatewayUrl = "";

  @state() private loading = true;
  @state() private ok = false;
  @state() private error = "";

  async connectedCallback() {
    super.connectedCallback();
    const token = readHashParam("token");
    if (!token) {
      this.error = t("auth.verify.invalidLink");
      this.loading = false;
      return;
    }
    try {
      const r = await callPublicRpc(this.gatewayUrl, "auth.verifyEmail", { token });
      if (r.ok) {
        this.ok = true;
      } else {
        this.error = r.errorMessage ?? "Verification failed";
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Verification failed";
    } finally {
      this.loading = false;
    }
  }

  render() {
    void this.i18nCtrl;
    if (this.loading) {
      return html`<div class="card"><div class="ok">${t("auth.common.submitting")}</div></div>`;
    }
    if (this.ok) {
      return html`
        <div class="card">
          <h1>${t("auth.verify.doneTitle")}</h1>
          <p class="ok">${t("auth.verify.doneBody")}</p>
          ${backToLoginLink()}
        </div>
      `;
    }
    return html`
      <div class="card">
        <h1>${t("auth.verify.failedTitle")}</h1>
        <p class="error">${this.error}</p>
        ${backToLoginLink()}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-mfa-setup>
// ---------------------------------------------------------------------------

@customElement("enclaws-mfa-setup")
export class EnClawsMfaSetup extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = css`
    ${cardStyles}
    .qr-uri { font-family: var(--font-mono, monospace); font-size: 0.72rem; word-break: break-all; background: var(--bg, #0a0a0a); border: 1px solid var(--border, #262626); border-radius: 6px; padding: 0.75rem; margin: 0.5rem 0; user-select: all; }
    .backup-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.25rem 1rem; font-family: var(--font-mono, monospace); font-size: 0.9rem; margin: 0.5rem 0; }
    .backup-list span { background: var(--bg, #0a0a0a); padding: 0.3rem 0.5rem; border-radius: 4px; text-align: center; }
    .step-label { font-size: 0.8rem; font-weight: 600; color: var(--accent, #3b82f6); margin: 1rem 0 0.5rem; }
  `;

  @state() private step: "qr" | "verify" | "done" = "qr";
  @state() private secret = "";
  @state() private otpauthUri = "";
  @state() private backupCodes: string[] = [];
  @state() private code = "";
  @state() private loading = true;
  @state() private submitting = false;
  @state() private error = "";

  async connectedCallback() {
    super.connectedCallback();
    try {
      const r = await callAuthRpc<{ secret: string; otpauthUri: string; backupCodes: string[] }>(
        "auth.mfa.setup.begin",
        {},
      );
      this.secret = r.secret;
      this.otpauthUri = r.otpauthUri;
      this.backupCodes = r.backupCodes;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Setup failed";
    } finally {
      this.loading = false;
    }
  }

  private async verifyCode(e: Event) {
    e.preventDefault();
    this.error = "";
    if (this.code.replace(/\s/g, "").length !== 6) {
      this.error = t("auth.mfa.invalidCode");
      return;
    }
    this.submitting = true;
    try {
      await callAuthRpc("auth.mfa.setup.verify", {
        secret: this.secret,
        code: this.code.replace(/\s/g, ""),
        backupCodes: this.backupCodes,
      });
      this.step = "done";
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Verification failed";
    } finally {
      this.submitting = false;
    }
  }

  private goBack() {
    window.location.hash = "";
  }

  render() {
    void this.i18nCtrl;
    if (this.loading) {
      return html`<div class="card"><div class="ok">${t("auth.common.submitting")}</div></div>`;
    }

    if (this.step === "done") {
      return html`
        <div class="card">
          <h1>${t("auth.mfa.enabledTitle")}</h1>
          <p class="ok">${t("auth.mfa.enabledBody")}</p>
          <div class="footer"><a class="link" @click=${this.goBack}>${t("auth.common.backHome")}</a></div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <h1>${t("auth.mfa.setupTitle")}</h1>
        <p class="subtitle">${t("auth.mfa.setupSubtitle")}</p>

        <div class="step-label">${t("auth.mfa.step1")}</div>
        <p class="hint">${t("auth.mfa.scanHint")}</p>
        <div class="qr-uri">${this.otpauthUri}</div>
        <p class="hint">${t("auth.mfa.manualHint")}: <strong>${this.secret}</strong></p>

        <div class="step-label">${t("auth.mfa.step2")}</div>
        <p class="hint">${t("auth.mfa.backupHint")}</p>
        <div class="backup-list">
          ${this.backupCodes.map((c) => html`<span>${c}</span>`)}
        </div>

        <div class="step-label">${t("auth.mfa.step3")}</div>
        <form @submit=${this.verifyCode}>
          <label>${t("auth.mfa.codeLabel")}</label>
          <input type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            .value=${this.code}
            @input=${(e: InputEvent) => {
              this.code = (e.target as HTMLInputElement).value;
            }}
            placeholder="000000" required />
          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.submitting}>
            ${this.submitting ? t("auth.common.submitting") : t("auth.mfa.verifyBtn")}
          </button>
        </form>
        <div class="footer"><a class="link" @click=${this.goBack}>${t("auth.common.backHome")}</a></div>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// <enclaws-mfa-challenge> — shown during login when MFA is required
// ---------------------------------------------------------------------------

@customElement("enclaws-mfa-challenge")
export class EnClawsMfaChallenge extends LitElement {
  private i18nCtrl = new I18nController(this);
  static styles = cardStyles;
  @property({ type: String }) gatewayUrl = "";
  @property({ type: String }) challengeToken = "";

  @state() private code = "";
  @state() private submitting = false;
  @state() private error = "";

  private async submit(e: Event) {
    e.preventDefault();
    this.error = "";
    const cleaned = this.code.replace(/\s/g, "");
    if (!cleaned) {
      this.error = t("auth.mfa.invalidCode");
      return;
    }
    this.submitting = true;
    try {
      const r = await callPublicRpc<{
        user: {
          id: string;
          email: string;
          role: string;
          displayName: string | null;
          tenantId: string;
          forceChangePassword: boolean;
          mfaEnabled: boolean;
        };
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        pwExp?: number;
      }>(this.gatewayUrl, "auth.mfa.verify", {
        challengeToken: this.challengeToken,
        code: cleaned,
      });
      if (!r.ok) {
        this.error = r.errorMessage ?? t("auth.mfa.invalidCode");
        return;
      }
      const p = r.payload!;
      const auth: AuthState = {
        accessToken: p.accessToken,
        refreshToken: p.refreshToken,
        expiresAt: Date.now() + p.expiresIn * 1000,
        user: {
          id: p.user.id,
          email: p.user.email,
          role: p.user.role,
          displayName: p.user.displayName,
          tenantId: p.user.tenantId,
          forceChangePassword: Boolean(p.user.forceChangePassword),
        },
        tenant: { id: p.user.tenantId, name: "" },
        pwExp: p.pwExp,
      };
      saveAuth(auth);
      // Trigger app re-render via full navigation
      window.location.href = "/";
    } catch (err) {
      this.error = err instanceof Error ? err.message : "MFA verification failed";
    } finally {
      this.submitting = false;
    }
  }

  private logout() {
    clearAuth();
    window.location.href = "/login";
  }

  render() {
    void this.i18nCtrl;
    return html`
      <div class="card">
        <h1>${t("auth.mfa.challengeTitle")}</h1>
        <p class="subtitle">${t("auth.mfa.challengeSubtitle")}</p>
        <form @submit=${this.submit}>
          <label>${t("auth.mfa.codeLabel")}</label>
          <input type="text" inputmode="numeric" maxlength="8" autocomplete="one-time-code"
            .value=${this.code}
            @input=${(e: InputEvent) => {
              this.code = (e.target as HTMLInputElement).value;
            }}
            placeholder="000000" required />
          <p class="hint">${t("auth.mfa.backupCodeHint")}</p>
          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.submitting}>
            ${this.submitting ? t("auth.common.submitting") : t("auth.mfa.verifyBtn")}
          </button>
        </form>
        <div class="footer"><a class="link" @click=${this.logout}>${t("auth.common.logout")}</a></div>
      </div>
    `;
  }
}
