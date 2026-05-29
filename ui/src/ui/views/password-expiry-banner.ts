/**
 * Password expiry warning banner (Phase 2, §6).
 *
 * Shown at the top of the console when:
 *   - The JWT carries `pwExp` (policy enabled), AND
 *   - The remaining days until expiry is between 0 and WARN_DAYS (14 by default)
 *
 * Already-expired users never see this banner — they hit the
 * force-change-password overlay instead (see auth-phase1.ts).
 *
 * Dismissal is per-session: clicking the × hides it for the current
 * session (recorded in sessionStorage, not localStorage), so the next
 * login rehydrates it.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { loadAuth } from "../auth-store.ts";

/** Default warning window (days) — keep in sync with backend default. */
const DEFAULT_WARN_DAYS = 14;

const DISMISS_KEY_PREFIX = "enclaws.pwexp.dismissed.v1:";

@customElement("enclaws-password-expiry-banner")
export class EnClawsPasswordExpiryBanner extends LitElement {
  // Subscribe to locale changes so the banner re-renders when the user
  // switches language.
  private i18nCtrl = new I18nController(this);
  static styles = css`
    :host {
      display: block;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.6rem 1rem;
      background: var(--warning-bg, #3b2f0a);
      color: var(--warning-fg, #f4c97a);
      border-bottom: 1px solid var(--warning-border, #6b4f10);
      font-size: 0.85rem;
    }
    .msg {
      flex: 1;
    }
    .btn {
      background: transparent;
      border: 1px solid currentColor;
      color: inherit;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 1rem;
      cursor: pointer;
      padding: 0.1rem 0.4rem;
      line-height: 1;
    }
  `;

  @state() private dismissed = false;

  connectedCallback(): void {
    super.connectedCallback();
    const auth = loadAuth();
    if (auth?.pwExp) {
      const key = DISMISS_KEY_PREFIX + auth.user.id;
      try {
        const raw = sessionStorage.getItem(key);
        if (raw && Number(raw) === auth.pwExp) {
          this.dismissed = true;
        }
      } catch {
        /* sessionStorage may be unavailable in some contexts */
      }
    }
  }

  private daysRemaining(): number | null {
    const auth = loadAuth();
    if (!auth?.pwExp) {
      return null;
    }
    const diffMs = auth.pwExp - Date.now();
    return Math.floor(diffMs / 86400_000);
  }

  private dismiss(): void {
    const auth = loadAuth();
    if (!auth?.pwExp) {
      return;
    }
    try {
      sessionStorage.setItem(DISMISS_KEY_PREFIX + auth.user.id, String(auth.pwExp));
    } catch {
      /* ignore */
    }
    this.dismissed = true;
  }

  private goToChangePassword(): void {
    // Assigning location.hash natively fires `hashchange`; the app shell
    // listener bumps hashRouteTick and triggers a re-render.
    window.location.hash = "#/auth/change-password";
  }

  render() {
    void this.i18nCtrl; // referenced for locale-change subscription
    if (this.dismissed) {
      return nothing;
    }
    const days = this.daysRemaining();
    if (days === null) {
      return nothing;
    }
    // Only show when within the warning window (0..WARN_DAYS).
    // Already-expired users (days < 0) are handled by the force-change overlay.
    if (days < 0 || days > DEFAULT_WARN_DAYS) {
      return nothing;
    }

    const msg =
      days === 0
        ? t("auth.banner.willExpireToday")
        : t("auth.banner.willExpireDays", { days: String(days) });

    return html`
      <div class="bar" role="alert">
        <span>⚠</span>
        <span class="msg">${msg}</span>
        <button class="btn" @click=${this.goToChangePassword}>${t("auth.banner.changeNow")}</button>
        <button class="close" @click=${this.dismiss} aria-label=${t("auth.banner.closeLabel")}>×</button>
      </div>
    `;
  }
}
