/**
 * Login / Register view for multi-tenant mode.
 *
 * Renders as a full-page overlay when the user is not authenticated.
 * Supports both login (existing account) and register (new tenant + owner).
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, i18n, I18nController, SUPPORTED_LOCALES } from "../../i18n/index.ts";
import "../components/captcha-field.ts";
import type { Locale } from "../../i18n/index.ts";
import {
  login,
  register,
  LoginRateLimitedError,
  LoginMfaRequiredError,
  RegisterPendingVerificationError,
  CaptchaInvalidError,
  type AuthState,
} from "../auth-store.ts";
import type { CaptchaField } from "../components/captcha-field.ts";
import { caretFix } from "../shared-styles.ts";
import { loadSettings, saveSettings } from "../storage.ts";
import type { ThemeMode } from "../theme.ts";
import "../components/language-switcher.ts";
import { resolveTheme } from "../theme.ts";

type AuthMode = "login" | "register";

/** Per-field error map. Keys are field identifiers, values are i18n error strings. */
type FieldErrors = Record<string, string>;

@customElement("enclaws-login")
export class EnClawsLogin extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex-direction: row;
        min-height: 100vh;
        height: 100vh;
        font-family: var(
          --font-body,
          -apple-system,
          BlinkMacSystemFont,
          "Inter",
          "PingFang SC",
          sans-serif
        );
        color: var(--text);
        overflow: hidden;
      }

      /* ══ Brand Panel (left 48%) ══ */
      .brand-panel {
        width: 48%;
        min-height: 100vh;
        background: linear-gradient(145deg, #083344 0%, #0891b2 40%, #06b6d4 75%, #0e9ab8 100%);
        padding: 48px 56px;
        display: flex;
        flex-direction: column;
        position: relative;
        overflow: hidden;
        flex-shrink: 0;
        box-shadow: 6px 0 32px rgba(0, 0, 0, 0.18);
      }

      /* animated blobs */
      .blob {
        position: absolute;
        border-radius: 50%;
        filter: blur(60px);
        pointer-events: none;
      }
      .blob-1 {
        width: 400px;
        height: 400px;
        background: rgba(103, 232, 249, 0.25);
        top: -120px;
        right: -100px;
        animation: blob-float1 9s ease-in-out infinite;
      }
      .blob-2 {
        width: 300px;
        height: 300px;
        background: rgba(8, 51, 68, 0.4);
        bottom: -80px;
        left: -80px;
        animation: blob-float2 11s ease-in-out infinite;
      }
      .blob-3 {
        width: 200px;
        height: 200px;
        background: rgba(255, 255, 255, 0.08);
        top: 40%;
        left: 20%;
      }

      @keyframes blob-float1 {
        0%,
        100% {
          transform: translate(0, 0);
        }
        40% {
          transform: translate(-28px, 22px);
        }
        70% {
          transform: translate(18px, -18px);
        }
      }
      @keyframes blob-float2 {
        0%,
        100% {
          transform: translate(0, 0);
        }
        50% {
          transform: translate(26px, -22px);
        }
      }

      /* dot matrix */
      .brand-dots {
        position: absolute;
        inset: 0;
        background-image: radial-gradient(rgba(255, 255, 255, 0.15) 1.5px, transparent 1.5px);
        background-size: 28px 28px;
        mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 40%, transparent 100%);
        pointer-events: none;
      }

      .brand-inner {
        position: relative;
        z-index: 2;
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      .brand-logo {
        display: flex;
        align-items: center;
      }
      .brand-logo img {
        height: 104px;
        width: auto;
        object-fit: contain;
        filter: brightness(0) invert(1) drop-shadow(0 0 16px rgba(103, 232, 249, 0.4));
      }

      .brand-hero {
        margin-top: 80px;
        padding-bottom: 16px;
      }

      .brand-tagline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 100px;
        padding: 5px 14px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.9);
        font-weight: 500;
        margin-bottom: 22px;
        letter-spacing: 0.02em;
      }
      .brand-tagline-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #67e8f9;
        box-shadow: 0 0 8px #67e8f9;
        animation: pulse-dot 2s ease-in-out infinite;
      }

      .brand-hero h1 {
        font-size: 46px;
        font-weight: 900;
        color: #fff;
        line-height: 1.08;
        letter-spacing: -0.04em;
        margin: 0 0 16px;
      }
      .brand-hero h1 em {
        font-style: normal;
        background: linear-gradient(90deg, #67e8f9, #a5f3fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .brand-hero p {
        font-size: 15px;
        color: rgba(255, 255, 255, 0.65);
        line-height: 1.65;
        max-width: 380px;
        margin: 0 0 28px;
      }

      /* Feature highlight rows */
      .brand-features {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .brand-feat {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        padding: 14px 16px;
        backdrop-filter: blur(8px);
        transition: background 0.2s;
      }
      .brand-feat:hover {
        background: rgba(255, 255, 255, 0.11);
      }
      .brand-feat-icon {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: rgba(103, 232, 249, 0.15);
        border: 1px solid rgba(103, 232, 249, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .brand-feat-icon svg {
        width: 15px;
        height: 15px;
        stroke: #67e8f9;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .brand-feat-text {
        flex: 1;
        min-width: 0;
      }
      .brand-feat-title {
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        margin-bottom: 3px;
        letter-spacing: -0.01em;
      }
      .brand-feat-desc {
        font-size: 12.5px;
        color: rgba(255, 255, 255, 0.58);
        line-height: 1.55;
      }

      /* ── Pitch callout ── */
      .brand-pitch {
        margin-top: 20px;
        padding: 14px 16px;
        background: rgba(103, 232, 249, 0.08);
        border: 1px solid rgba(103, 232, 249, 0.2);
        border-radius: 12px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .brand-pitch-icon {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: rgba(103, 232, 249, 0.15);
        border: 1px solid rgba(103, 232, 249, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .brand-pitch-icon svg {
        width: 15px;
        height: 15px;
        stroke: #67e8f9;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .brand-pitch-body {
      }
      .brand-pitch-title {
        font-size: 14px;
        font-weight: 800;
        color: #67e8f9;
        margin-bottom: 4px;
        letter-spacing: -0.01em;
      }
      .brand-pitch-desc {
        font-size: 12.5px;
        color: rgba(255, 255, 255, 0.55);
        line-height: 1.55;
      }

      /* ── Floating particles ── */
      .particle {
        position: absolute;
        border-radius: 50%;
        background: rgba(103, 232, 249, 0.75);
        box-shadow: 0 0 6px 1px rgba(103, 232, 249, 0.4);
        pointer-events: none;
      }
      @keyframes particle-rise {
        0% {
          transform: translateY(0) translateX(0);
          opacity: 0.85;
        }
        40% {
          opacity: 0.6;
        }
        100% {
          transform: translateY(-110vh) translateX(12px);
          opacity: 0;
        }
      }
      .p1 {
        width: 3px;
        height: 3px;
        left: 12%;
        bottom: 8%;
        animation: particle-rise 9s linear infinite;
      }
      .p2 {
        width: 2px;
        height: 2px;
        left: 28%;
        bottom: 15%;
        animation: particle-rise 11s linear 2.5s infinite;
      }
      .p3 {
        width: 4px;
        height: 4px;
        left: 55%;
        bottom: 5%;
        animation: particle-rise 8s linear 1s infinite;
      }
      .p4 {
        width: 2px;
        height: 2px;
        left: 72%;
        bottom: 20%;
        animation: particle-rise 13s linear 4s infinite;
      }
      .p5 {
        width: 3px;
        height: 3px;
        left: 88%;
        bottom: 12%;
        animation: particle-rise 10s linear 0.7s infinite;
      }
      .p6 {
        width: 2px;
        height: 2px;
        left: 40%;
        bottom: 28%;
        animation: particle-rise 12s linear 3s infinite;
      }
      .p7 {
        width: 3px;
        height: 3px;
        left: 65%;
        bottom: 42%;
        animation: particle-rise 7s linear 5.2s infinite;
      }
      .p8 {
        width: 2px;
        height: 2px;
        left: 20%;
        bottom: 36%;
        animation: particle-rise 15s linear 1.5s infinite;
      }

      /* ── Entry animations ── */
      @keyframes fadeSlideUp {
        from {
          opacity: 0;
          transform: translateY(16px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .brand-logo {
        animation: fadeIn 0.8s ease-out both;
      }
      .brand-tagline {
        animation: fadeSlideUp 0.5s ease-out 0.15s both;
      }
      .brand-hero h1 {
        animation: fadeSlideUp 0.55s ease-out 0.28s both;
      }
      .brand-hero p {
        animation: fadeSlideUp 0.5s ease-out 0.42s both;
      }
      .brand-feat:nth-child(1) {
        animation: fadeSlideUp 0.45s ease-out 0.55s both;
      }
      .brand-feat:nth-child(2) {
        animation: fadeSlideUp 0.45s ease-out 0.67s both;
      }
      .brand-feat:nth-child(3) {
        animation: fadeSlideUp 0.45s ease-out 0.79s both;
      }
      .brand-pitch {
        animation: fadeSlideUp 0.45s ease-out 0.92s both;
      }

      /* ── Feature icon glow pulse ── */
      @keyframes icon-glow {
        0%,
        100% {
          box-shadow: 0 0 0 0 rgba(103, 232, 249, 0);
        }
        50% {
          box-shadow: 0 0 0 5px rgba(103, 232, 249, 0.18);
        }
      }
      .brand-feat:nth-child(1) .brand-feat-icon {
        animation: icon-glow 3.5s ease-in-out 0.8s infinite;
      }
      .brand-feat:nth-child(2) .brand-feat-icon {
        animation: icon-glow 3.5s ease-in-out 1.7s infinite;
      }
      .brand-feat:nth-child(3) .brand-feat-icon {
        animation: icon-glow 3.5s ease-in-out 2.6s infinite;
      }

      /* ── Scan line ── */
      @keyframes scan-slide {
        0% {
          top: 100%;
          opacity: 0;
        }
        5% {
          opacity: 1;
        }
        95% {
          opacity: 0.6;
        }
        100% {
          top: -2%;
          opacity: 0;
        }
      }
      .brand-scan {
        position: absolute;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(103, 232, 249, 0.5) 40%,
          rgba(103, 232, 249, 0.7) 50%,
          rgba(103, 232, 249, 0.5) 60%,
          transparent 100%
        );
        pointer-events: none;
        animation: scan-slide 8s linear 1s infinite;
      }

      /* ══ Form Panel (right, flex: 1) ══ */
      .form-panel {
        flex: 1;
        min-height: 100vh;
        background: var(--surface, #ffffff);
        display: flex;
        flex-direction: column;
        padding: 40px 64px;
        overflow-y: auto;
      }

      .form-topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
        margin-bottom: 4px;
      }

      .topbar-lang {
        --text-color: var(--text-2);
        --surface-1: var(--surface);
        --surface-2: var(--bg);
        --border-color: var(--border);
        --primary-color: var(--accent);
      }

      /* Theme toggle — rectangular tab style */
      .theme-switch {
        display: flex;
        background: var(--bg, #f0fdfe);
        border: 1px solid var(--border, #e2eef2);
        border-radius: 10px;
        padding: 4px;
        gap: 2px;
      }
      .theme-switch__btn {
        display: flex;
        align-items: center;
        gap: 5px;
        border: none;
        background: transparent;
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 7px;
        font-size: 12px;
        color: var(--text-3, #94a3b8);
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }
      .theme-switch__btn:hover {
        color: var(--text-2, #4a6572);
      }
      .theme-switch__btn.active {
        background: var(--surface, #ffffff);
        color: var(--text, #0c1a1f);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      }
      .theme-switch__btn svg {
        width: 13px;
        height: 13px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.8px;
        stroke-linecap: round;
        stroke-linejoin: round;
        flex-shrink: 0;
      }

      /* ══ Form main (centered, max-width 380px) ══ */
      .form-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        max-width: 380px;
        width: 100%;
        margin: 0 auto;
        padding: 20px 0;
      }

      .form-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--accent-light, rgba(8, 145, 178, 0.08));
        border: 1px solid var(--accent-light-border, rgba(8, 145, 178, 0.2));
        border-radius: 100px;
        padding: 5px 12px;
        font-size: 12px;
        color: var(--accent, #0891b2);
        font-weight: 600;
        margin-bottom: 24px;
        width: fit-content;
        letter-spacing: 0.02em;
      }

      .form-title {
        font-size: 32px;
        font-weight: 800;
        color: var(--text-strong, #060e12);
        letter-spacing: -0.04em;
        line-height: 1.1;
        margin: 0 0 8px;
      }
      .form-subtitle {
        font-size: 15px;
        color: var(--text-2, #4a6572);
        margin: 0 0 32px;
        line-height: 1.5;
      }

      /* Tabs (Login / Register) */
      .form-tabs {
        display: flex;
        background: var(--bg, #f0fdfe);
        border: 1px solid var(--border, #e2eef2);
        border-radius: 10px;
        padding: 4px;
        gap: 2px;
        margin-bottom: 28px;
      }
      .form-tab {
        flex: 1;
        text-align: center;
        padding: 9px;
        border-radius: 7px;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-3, #94a3b8);
        cursor: pointer;
        transition: all 0.15s;
        border: none;
        background: transparent;
        font-family: inherit;
      }
      .form-tab:hover {
        color: var(--text-2, #4a6572);
      }
      .form-tab.active {
        background: var(--surface, #ffffff);
        color: var(--text, #0c1a1f);
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      }

      /* Form fields */
      .form-group {
        margin-bottom: 18px;
      }
      .form-label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-2, #4a6572);
        margin-bottom: 8px;
        letter-spacing: 0.01em;
      }
      .form-input-wrap {
        position: relative;
      }
      .form-input {
        width: 100%;
        padding: 13px 16px;
        border: 1.5px solid var(--input-border, #d1e8ef);
        border-radius: 10px;
        font-size: 15px;
        color: var(--text, #0c1a1f);
        background: var(--input-bg, #f8fcfd);
        outline: none;
        transition:
          border-color 0.15s,
          box-shadow 0.15s,
          background 0.15s;
        font-family: inherit;
        box-sizing: border-box;
      }
      .form-input:focus {
        border-color: var(--accent, #0891b2);
        box-shadow: 0 0 0 4px var(--accent-light, rgba(8, 145, 178, 0.08));
        background: var(--surface, #ffffff);
      }
      .form-input::placeholder {
        color: var(--text-3, #94a3b8);
      }
      .form-input.has-error {
        border-color: var(--danger, #ef4444);
      }
      .form-input.has-error:focus {
        box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.08);
      }
      .form-input-wrap .form-input {
        padding-right: 48px;
      }

      .eye-btn {
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        cursor: pointer;
        color: var(--text-3, #94a3b8);
        padding: 4px;
        transition: color 0.15s;
        display: flex;
        align-items: center;
      }
      .eye-btn:hover {
        color: var(--text-2, #4a6572);
      }
      .eye-btn svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        pointer-events: none;
      }

      .form-hint {
        font-size: 12px;
        color: var(--muted, #7ea5b2);
        margin-top: 6px;
      }

      .field-error {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-top: 6px;
        font-size: 12px;
        color: var(--danger, #ef4444);
      }
      .field-error svg {
        flex-shrink: 0;
        width: 13px;
        height: 13px;
        fill: currentColor;
      }

      .form-error {
        margin-bottom: 16px;
      }

      /* Forgot password row */
      .form-meta {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 24px;
      }
      .form-forgot {
        font-size: 13px;
        color: var(--accent, #0891b2);
        font-weight: 500;
        text-decoration: none;
        cursor: pointer;
        background: none;
        border: none;
        padding: 0;
        font-family: inherit;
      }
      .form-forgot:hover {
        text-decoration: underline;
      }

      /* Submit button */
      .btn-submit {
        width: 100%;
        padding: 14px;
        background: linear-gradient(135deg, var(--accent, #0891b2), var(--accent-2, #06b6d4));
        color: #fff;
        border: none;
        border-radius: 10px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        letter-spacing: 0.02em;
        font-family: inherit;
        transition:
          opacity 0.15s,
          transform 0.1s,
          box-shadow 0.15s;
        box-shadow: 0 4px 16px rgba(8, 145, 178, 0.35);
        margin-bottom: 20px;
      }
      .btn-submit:hover {
        opacity: 0.92;
        box-shadow: 0 6px 22px rgba(8, 145, 178, 0.45);
      }
      .btn-submit:active {
        transform: scale(0.99);
      }
      .btn-submit:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      /* Register section divider */
      .section-divider {
        display: flex;
        align-items: center;
        margin: 4px 0 20px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-3, #94a3b8);
      }
      .section-divider::before,
      .section-divider::after {
        content: "";
        flex: 1;
        border-top: 1px solid var(--border, #e2eef2);
      }
      .section-divider span {
        padding: 0 10px;
      }

      /* ══ Responsive ══ */
      @media (max-width: 900px) {
        :host {
          flex-direction: column;
          height: auto;
        }
        .brand-panel {
          width: 100%;
          min-height: auto;
          padding: 40px 32px;
        }
        .brand-hero h1 {
          font-size: 32px;
        }
        .brand-stats {
          gap: 8px;
        }
        .brand-stat-card {
          padding: 12px;
        }
        .brand-stat-num {
          font-size: 20px;
        }
        .form-panel {
          padding: 32px 24px;
          min-height: auto;
        }
        .form-main {
          padding: 16px 0;
        }
      }
      @media (max-width: 600px) {
        .brand-panel {
          padding: 32px 24px;
        }
        .brand-hero h1 {
          font-size: 28px;
        }
        .form-panel {
          padding: 24px 20px;
        }
        .form-title {
          font-size: 26px;
        }
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private mode: AuthMode = "login";
  @state() private loading = false;
  @state() private currentTheme: ThemeMode = loadSettings().theme ?? "system";
  /** Stores the raw server error message; translated at render time. */
  @state() private serverError = "";
  @state() private fieldErrors: FieldErrors = {};
  /** Countdown (seconds) when login is rate-limited; 0 = no countdown active. */
  @state() private rateLimitCountdown = 0;
  private rateLimitTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase 3: when MFA is required, store the challenge token to render the MFA view. */
  @state() private mfaChallengeToken = "";
  /** Phase 3: when email verification is required after registration. */
  @state() private pendingVerificationEmail = "";

  // Login fields
  @state() private email = "";
  @state() private password = "";

  // Register fields
  @state() private regTenantName = "";
  @state() private regEmail = "";
  @state() private regPassword = "";
  @state() private regDisplayName = "";

  // Focus tracking for inline hints
  @state() private regPasswordFocused = false;

  private handleLocaleChange(e: CustomEvent<{ locale: string }>) {
    const loc = e.detail.locale;
    if (SUPPORTED_LOCALES.includes(loc as Locale)) {
      void i18n.setLocale(loc as Locale).then(() => {
        if (Object.keys(this.fieldErrors).length > 0) {
          this.fieldErrors =
            this.mode === "login" ? this.validateLoginForm() : this.validateRegisterForm();
        }
      });
      const settings = loadSettings();
      saveSettings({ ...settings, locale: loc });
    }
  }

  /** Map raw server error to i18n at render time so language switches take effect. */
  private translateServerError(raw: string): string {
    if (raw === "__rate_limited__") {
      return t("login.rateLimited");
    }
    if (raw.includes("Invalid credentials")) {
      return t("login.invalidCredentials");
    }
    if (
      raw.includes("已注册") ||
      raw.includes("already registered") ||
      raw.includes("duplicate key") ||
      raw.includes("unique constraint")
    ) {
      return t("login.emailAlreadyRegistered");
    }
    if (raw.includes("verify your email") || raw.includes("pendingVerification")) {
      return t("login.pendingVerification");
    }
    if (
      raw.includes("该企业账号已被禁用") ||
      raw.includes("tenant suspended") ||
      raw.includes("Tenant is suspended")
    ) {
      return t("login.tenantSuspended");
    }
    return raw;
  }

  private resolveGatewayUrl(): string {
    if (this.gatewayUrl) {
      return this.gatewayUrl;
    }
    const settings = loadSettings();
    return settings.gatewayUrl;
  }

  private validateEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private validatePasswordStrength(pw: string): boolean {
    return (
      pw.length >= 8 &&
      /[a-z]/.test(pw) &&
      /[A-Z]/.test(pw) &&
      /\d/.test(pw) &&
      /[^a-zA-Z0-9]/.test(pw)
    );
  }

  private validateLoginForm(): FieldErrors {
    const errors: FieldErrors = {};
    if (!this.email) {
      errors.email = t("login.errRequired", { field: t("login.email") });
    } else if (!this.validateEmail(this.email)) {
      errors.email = t("login.errEmailInvalid");
    }
    if (!this.password) {
      errors.password = t("login.errRequired", { field: t("login.password") });
    }
    return errors;
  }

  private validateRegisterForm(): FieldErrors {
    const errors: FieldErrors = {};
    if (!this.regTenantName) {
      errors.tenantName = t("login.errRequired", { field: t("login.tenantName") });
    }
    if (!this.regEmail) {
      errors.regEmail = t("login.errRequired", { field: t("login.email") });
    } else if (!this.validateEmail(this.regEmail)) {
      errors.regEmail = t("login.errEmailInvalid");
    }
    if (!this.regPassword) {
      errors.regPassword = t("login.errRequired", { field: t("login.password") });
    } else if (!this.validatePasswordStrength(this.regPassword)) {
      errors.regPassword = t("login.errPasswordWeak");
    }
    return errors;
  }

  private renderFieldError(field: string) {
    const msg = this.fieldErrors[field];
    if (!msg) {
      return nothing;
    }
    return html`
      <div class="field-error">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.5a.75.75 0 0 1 1.5 0v3.25a.75.75 0 0 1-1.5 0V4.5ZM8 11.5A.875.875 0 1 1 8 9.75a.875.875 0 0 1 0 1.75Z"/>
        </svg>
        <span>${msg}</span>
      </div>
    `;
  }

  private renderFormError(msg: string) {
    return html`
      <div class="field-error form-error">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.5a.75.75 0 0 1 1.5 0v3.25a.75.75 0 0 1-1.5 0V4.5ZM8 11.5A.875.875 0 1 1 8 9.75a.875.875 0 0 1 0 1.75Z"/>
        </svg>
        <span>${msg}</span>
      </div>
    `;
  }

  private hasError(field: string): boolean {
    return !!this.fieldErrors[field];
  }

  private clearFieldError(field: string) {
    if (this.fieldErrors[field]) {
      const next = { ...this.fieldErrors };
      delete next[field];
      this.fieldErrors = next;
    }
    if (this.serverError) {
      this.serverError = "";
    }
  }

  private startRateLimitCountdown(retryAfterMs: number): void {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
    }
    this.rateLimitCountdown = Math.max(1, Math.ceil(retryAfterMs / 1000));
    this.rateLimitTimer = setInterval(() => {
      this.rateLimitCountdown -= 1;
      if (this.rateLimitCountdown <= 0) {
        if (this.rateLimitTimer) {
          clearInterval(this.rateLimitTimer);
        }
        this.rateLimitTimer = null;
        this.rateLimitCountdown = 0;
      }
    }, 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
    }
  }

  private getCaptchaField(name: "login" | "register"): CaptchaField | null {
    return this.renderRoot.querySelector(`captcha-field[data-scope="${name}"]`);
  }

  private async handleLogin(e: Event) {
    e.preventDefault();
    this.fieldErrors = {};
    this.serverError = "";

    const captcha = this.getCaptchaField("login");
    const errors = this.validateLoginForm();
    if (!captcha?.captchaId || !captcha.value) {
      errors.captcha = t("captcha.errRequired");
    }
    if (Object.keys(errors).length > 0) {
      this.fieldErrors = errors;
      return;
    }

    if (this.rateLimitCountdown > 0) {
      return;
    }

    this.loading = true;

    try {
      const auth = await login({
        gatewayUrl: this.resolveGatewayUrl(),
        email: this.email,
        password: this.password,
        captchaId: captcha!.captchaId,
        captchaAnswer: captcha!.value,
      });
      this.dispatchEvent(
        new CustomEvent("auth-success", {
          detail: { ...auth, forceChangePassword: auth.user.forceChangePassword === true },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      // Any failure invalidates the used captcha on the server. Refresh
      // so the user isn't left with a stale/empty image.
      void this.getCaptchaField("login")?.refresh();
      if (err instanceof LoginRateLimitedError) {
        this.startRateLimitCountdown(err.retryAfterMs);
        this.serverError = "__rate_limited__";
      } else if (err instanceof LoginMfaRequiredError) {
        this.mfaChallengeToken = err.challengeToken;
      } else if (err instanceof CaptchaInvalidError) {
        this.fieldErrors = { ...this.fieldErrors, captcha: t("captcha.errInvalid") };
      } else {
        this.serverError = err instanceof Error ? err.message : t("login.loginFailed");
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleRegister(e: Event) {
    e.preventDefault();
    this.fieldErrors = {};
    this.serverError = "";

    const captcha = this.getCaptchaField("register");
    const errors = this.validateRegisterForm();
    if (!captcha?.captchaId || !captcha.value) {
      errors.captcha = t("captcha.errRequired");
    }
    if (Object.keys(errors).length > 0) {
      this.fieldErrors = errors;
      return;
    }

    this.loading = true;

    try {
      const auth = await register({
        gatewayUrl: this.resolveGatewayUrl(),
        tenantName: this.regTenantName,
        email: this.regEmail,
        password: this.regPassword,
        displayName: this.regDisplayName || undefined,
        captchaId: captcha!.captchaId,
        captchaAnswer: captcha!.value,
      });
      this.dispatchEvent(
        new CustomEvent("auth-success", {
          detail: { ...auth, isNewRegistration: true },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      void this.getCaptchaField("register")?.refresh();
      if (err instanceof RegisterPendingVerificationError) {
        // Phase 3: email verification required — show the pending view
        this.pendingVerificationEmail = err.email;
      } else if (err instanceof CaptchaInvalidError) {
        this.fieldErrors = { ...this.fieldErrors, captcha: t("captcha.errInvalid") };
      } else {
        this.serverError = err instanceof Error ? err.message : "register_failed";
      }
    } finally {
      this.loading = false;
    }
  }

  private switchMode(mode: AuthMode) {
    this.mode = mode;
    this.serverError = "";
    this.fieldErrors = {};
    this.email = "";
    this.password = "";
    this.regTenantName = "";
    this.regEmail = "";
    this.regPassword = "";
    this.regDisplayName = "";
  }

  private applyTheme(next: ThemeMode, _e?: MouseEvent) {
    this.currentTheme = next;
    const settings = loadSettings();
    saveSettings({ ...settings, theme: next });
    const resolved = resolveTheme(next);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }

  render() {
    // Phase 3: MFA challenge
    if (this.mfaChallengeToken) {
      return html`<enclaws-mfa-challenge
        .gatewayUrl=${this.resolveGatewayUrl()}
        .challengeToken=${this.mfaChallengeToken}
      ></enclaws-mfa-challenge>`;
    }

    // Phase 3: email verification pending — handled inside the normal
    // two-panel layout below (see form-main section).

    return html`
      <!-- Brand Panel -->
      <div class="brand-panel">
        <div class="blob blob-1"></div>
        <div class="blob blob-2"></div>
        <div class="blob blob-3"></div>
        <div class="brand-dots"></div>
        <div class="brand-scan"></div>
        <span class="particle p1"></span>
        <span class="particle p2"></span>
        <span class="particle p3"></span>
        <span class="particle p4"></span>
        <span class="particle p5"></span>
        <span class="particle p6"></span>
        <span class="particle p7"></span>
        <span class="particle p8"></span>

        <div class="brand-inner">
          <div class="brand-logo">
            <img src="/favicon.svg" alt="EnClaws" />
          </div>

          <div class="brand-hero">
            <div class="brand-tagline">
              <span class="brand-tagline-dot"></span>
              ${t("login.brand.tagline")}
            </div>
            <h1>${t("login.brand.headline1")}<br/><em>${t("login.brand.headline2")}</em></h1>
            <p>${t("login.brand.subline")}</p>
            <div class="brand-features">
              <div class="brand-feat">
                <div class="brand-feat-icon">
                  <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                </div>
                <div class="brand-feat-text">
                  <div class="brand-feat-title">${t("login.brand.feat1Title")}</div>
                  <div class="brand-feat-desc">${t("login.brand.feat1Desc")}</div>
                </div>
              </div>
              <div class="brand-feat">
                <div class="brand-feat-icon">
                  <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="brand-feat-text">
                  <div class="brand-feat-title">${t("login.brand.feat2Title")}</div>
                  <div class="brand-feat-desc">${t("login.brand.feat2Desc")}</div>
                </div>
              </div>
              <div class="brand-feat">
                <div class="brand-feat-icon">
                  <svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                </div>
                <div class="brand-feat-text">
                  <div class="brand-feat-title">${t("login.brand.feat3Title")}</div>
                  <div class="brand-feat-desc">${t("login.brand.feat3Desc")}</div>
                </div>
              </div>
            </div>
            <div class="brand-pitch">
              <div class="brand-pitch-icon">
                <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div class="brand-pitch-body">
                <div class="brand-pitch-title">${t("login.brand.pitch")}</div>
                <div class="brand-pitch-desc">${t("login.brand.pitchDesc")}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Form Panel -->
      <div class="form-panel">
        <div class="form-topbar">
          <div class="topbar-lang">
            <language-switcher
              .locale=${i18n.getLocale()}
              @locale-change=${this.handleLocaleChange}
            ></language-switcher>
          </div>
          <div class="theme-switch">
            <button class="theme-switch__btn ${this.currentTheme === "light" ? "active" : ""}"
              @click=${(e: MouseEvent) => this.applyTheme("light", e)}>
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-14.07 1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2m-4.34-5.66 1.41-1.41M6.34 17.66l-1.41 1.41"/></svg>
              ${t("login.themeLight")}
            </button>
            <button class="theme-switch__btn ${this.currentTheme === "system" ? "active" : ""}"
              @click=${(e: MouseEvent) => this.applyTheme("system", e)}>
              <svg viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
              ${t("login.themeSystem")}
            </button>
            <button class="theme-switch__btn ${this.currentTheme === "dark" ? "active" : ""}"
              @click=${(e: MouseEvent) => this.applyTheme("dark", e)}>
              <svg viewBox="0 0 24 24"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>
              ${t("login.themeDark")}
            </button>
          </div>
        </div>

        <div class="form-main">
          ${
            this.pendingVerificationEmail
              ? html`
            <!-- Phase 3: email verification pending -->
            <div class="form-badge">✉ ${t("auth.verify.pendingTitle")}</div>
            <h1 class="form-title">${t("auth.verify.pendingTitle")}</h1>
            <p class="form-subtitle">${t("auth.verify.pendingBody")}</p>
            <div style="text-align:center;padding:20px 0;font-size:15px;font-weight:600;color:var(--accent,#0891b2);">
              ${this.pendingVerificationEmail}
            </div>
            <button class="btn-submit" @click=${() => {
              this.pendingVerificationEmail = "";
              this.switchMode("login");
            }}>
              ${t("auth.common.backToLogin")}
            </button>
          `
              : html`
            <div class="form-badge">✦ ${t("login.formBadge")}</div>
            <h1 class="form-title">
              ${
                this.mode === "login"
                  ? html`${t("login.welcomeLine1")}<br/>${t("login.welcomeLine2")}`
                  : html`${t("login.createLine1")}<br/>${t("login.createLine2")}`
              }
            </h1>
            <p class="form-subtitle">
              ${this.mode === "login" ? t("login.subtitle") : t("login.subtitleRegister")}
            </p>

            <div class="form-tabs">
              <button type="button" class="form-tab ${this.mode === "login" ? "active" : ""}"
                @click=${() => this.switchMode("login")}>${t("login.loginBtn")}</button>
              <button type="button" class="form-tab ${this.mode === "register" ? "active" : ""}"
                @click=${() => this.switchMode("register")}>${t("login.registerBtn")}</button>
            </div>

            ${this.mode === "login" ? this.renderLoginForm() : this.renderRegisterForm()}
          `
          }
        </div>

      </div>
    `;
  }

  private renderLoginForm() {
    return html`
      <form @submit=${this.handleLogin} novalidate>
        <div class="form-group">
          <label class="form-label">${t("login.email")}</label>
          <input
            class="form-input ${this.hasError("email") ? "has-error" : ""}"
            type="email"
            placeholder=${t("login.emailPlaceholder")}
            .value=${this.email}
            @input=${(e: InputEvent) => {
              this.email = (e.target as HTMLInputElement).value;
              this.clearFieldError("email");
            }}
          />
          ${this.renderFieldError("email")}
        </div>

        <div class="form-group">
          <label class="form-label">${t("login.password")}</label>
          <div class="form-input-wrap">
            <input
              class="form-input ${this.hasError("password") ? "has-error" : ""}"
              type="password"
              placeholder=${t("login.passwordPlaceholder")}
              .value=${this.password}
              @input=${(e: InputEvent) => {
                this.password = (e.target as HTMLInputElement).value;
                this.clearFieldError("password");
              }}
            />
            <button type="button" class="eye-btn"
              @mousedown=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "text";
              }}
              @mouseup=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "password";
              }}
              @mouseleave=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "password";
              }}
            >
              <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          ${this.renderFieldError("password")}
        </div>

        <div class="form-group">
          <label class="form-label">${t("captcha.label")}</label>
          <captcha-field
            data-scope="login"
            gateway-url=${this.resolveGatewayUrl()}
            .error=${this.fieldErrors.captcha ?? ""}
          ></captcha-field>
        </div>

        <div class="form-meta">
          <button type="button" class="form-forgot"
            @click=${() => {
              window.location.hash = "#/auth/forgot-password";
            }}
          >${t("login.forgotPassword")}</button>
        </div>

        ${this.serverError ? this.renderFormError(this.translateServerError(this.serverError)) : nothing}

        <button class="btn-submit" type="submit" ?disabled=${this.loading || this.rateLimitCountdown > 0}>
          ${
            this.rateLimitCountdown > 0
              ? `${this.rateLimitCountdown}s`
              : this.loading
                ? t("login.loggingIn")
                : t("login.loginBtn")
          }
        </button>
      </form>
    `;
  }

  private renderRegisterForm() {
    return html`
      <form @submit=${this.handleRegister} novalidate>
        <div class="form-group">
          <label class="form-label">${t("login.tenantName")}</label>
          <input
            class="form-input ${this.hasError("tenantName") ? "has-error" : ""}"
            type="text"
            placeholder=${t("login.tenantNamePlaceholder")}
            .value=${this.regTenantName}
            @input=${(e: InputEvent) => {
              this.regTenantName = (e.target as HTMLInputElement).value;
              this.clearFieldError("tenantName");
            }}
          />
          ${this.renderFieldError("tenantName")}
        </div>

        <div class="section-divider"><span>${t("login.adminAccount")}</span></div>

        <div class="form-group">
          <label class="form-label">${t("login.displayName")}</label>
          <input
            class="form-input"
            type="text"
            placeholder=${t("login.displayNamePlaceholder")}
            .value=${this.regDisplayName}
            @input=${(e: InputEvent) => (this.regDisplayName = (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="form-group">
          <label class="form-label">${t("login.email")}</label>
          <input
            class="form-input ${this.hasError("regEmail") ? "has-error" : ""}"
            type="email"
            placeholder=${t("login.regEmailPlaceholder")}
            .value=${this.regEmail}
            @input=${(e: InputEvent) => {
              this.regEmail = (e.target as HTMLInputElement).value;
              this.clearFieldError("regEmail");
            }}
          />
          ${this.renderFieldError("regEmail")}
        </div>

        <div class="form-group">
          <label class="form-label">${t("login.password")}</label>
          <div class="form-input-wrap">
            <input
              class="form-input ${this.hasError("regPassword") ? "has-error" : ""}"
              type="password"
              placeholder=${t("login.regPasswordPlaceholder")}
              .value=${this.regPassword}
              @input=${(e: InputEvent) => {
                this.regPassword = (e.target as HTMLInputElement).value;
                this.clearFieldError("regPassword");
              }}
              @focus=${() => {
                this.regPasswordFocused = true;
              }}
              @blur=${() => {
                this.regPasswordFocused = false;
              }}
            />
            <button type="button" class="eye-btn"
              @mousedown=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "text";
              }}
              @mouseup=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "password";
              }}
              @mouseleave=${(e: Event) => {
                const wrap = (e.target as HTMLElement).closest(".form-input-wrap")!;
                (wrap.querySelector("input") as HTMLInputElement).type = "password";
              }}
            >
              <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          ${this.regPasswordFocused ? html`<div class="form-hint">${t("login.passwordHint")}</div>` : this.renderFieldError("regPassword")}
        </div>

        <div class="form-group">
          <label class="form-label">${t("captcha.label")}</label>
          <captcha-field
            data-scope="register"
            gateway-url=${this.resolveGatewayUrl()}
            .error=${this.fieldErrors.captcha ?? ""}
          ></captcha-field>
        </div>

        ${this.serverError ? this.renderFormError(this.translateServerError(this.serverError)) : nothing}

        <button class="btn-submit" type="submit" ?disabled=${this.loading}>
          ${this.loading ? t("login.registering") : t("login.registerBtn")}
        </button>
      </form>
    `;
  }
}
