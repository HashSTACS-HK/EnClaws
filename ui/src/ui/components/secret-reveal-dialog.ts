/**
 * One-time secret reveal dialog for CS AI Services.
 *
 * Displayed immediately after creating or regenerating a CS AI Service secret.
 * The plaintext secret is only available at this moment — the server never
 * returns it again.  The user MUST copy it before closing.
 *
 * Usage:
 *   import { showSecretReveal } from "../components/secret-reveal-dialog.ts";
 *   await showSecretReveal({ appId, appSecret, endpointUrl });
 *
 * CS AI 服务一次性密钥展示弹窗。创建或重置密钥后立即弹出，关闭即消失，无法再次获取。
 */

import { html, css, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { caretFix } from "../shared-styles.ts";

export interface SecretRevealOptions {
  appId: string;
  appSecret: string;
  endpointUrl: string;
}

@customElement("secret-reveal-dialog")
export class SecretRevealDialog extends LitElement {
  static styles = [
    caretFix,
    css`
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10100;
        animation: fadeIn 0.15s ease;
      }
      .card {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 8px);
        padding: 1.75rem;
        width: 520px;
        max-width: 94vw;
        animation: slideUp 0.15s ease;
      }
      .title {
        margin: 0 0 0.5rem;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text, #e5e5e5);
      }
      .warning {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0;
        margin-bottom: 1rem;
        font-size: 0.82rem;
        color: var(--text-secondary, #a3a3a3);
        line-height: 1.5;
      }
      .warning-icon {
        font-size: 1rem;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .fields {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        margin-bottom: 1.5rem;
      }
      .field-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary, #a3a3a3);
        margin-bottom: 0.3rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .field-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      .field-value {
        flex: 1;
        font-family: monospace;
        font-size: 0.8rem;
        color: var(--text, #e5e5e5);
        background: var(--bg-input, #1c1c1c);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        padding: 0.45rem 0.7rem;
        word-break: break-all;
        line-height: 1.5;
        user-select: all;
      }
      .btn-copy {
        padding: 0.4rem 0.75rem;
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        font-size: 0.78rem;
        cursor: pointer;
        background: transparent;
        color: var(--text, #e5e5e5);
        white-space: nowrap;
        flex-shrink: 0;
        transition:
          background 0.12s,
          color 0.12s;
      }
      .btn-copy:hover {
        background: var(--border, #262626);
      }
      .btn-copy.copied {
        border-color: var(--color-success, #1a7f37);
        color: var(--color-success, #1a7f37);
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
      .btn-done {
        padding: 0.5rem 1.25rem;
        border: none;
        border-radius: var(--radius-md, 6px);
        font-size: 0.85rem;
        cursor: pointer;
        background: var(--accent, #3b82f6);
        color: white;
        font-weight: 500;
        transition: opacity 0.15s;
      }
      .btn-done:hover {
        opacity: 0.85;
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ];

  @property() appId = "";
  @property() appSecret = "";
  @property() endpointUrl = "";

  /** Tracks which field was just copied (for feedback). 记录刚复制的字段名。 */
  @state() private _copied: string | null = null;

  // Re-renders when the active locale changes. 语言切换时触发重新渲染。
  private _i18n = new I18nController(this);

  private _resolve?: () => void;
  private _copyTimer?: ReturnType<typeof setTimeout>;

  /** Called by showSecretReveal() to wire the promise. */
  init(resolve: () => void) {
    this._resolve = resolve;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._copyTimer);
  }

  private async _copy(field: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this._copied = field;
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        this._copied = null;
      }, 2000);
    } catch {
      // Clipboard not available in non-secure context — ignore.
    }
  }

  private _close() {
    this._resolve?.();
    this.remove();
  }

  private _renderField(label: string, fieldKey: string, value: string) {
    const isCopied = this._copied === fieldKey;
    return html`
      <div>
        <div class="field-label">${label}</div>
        <div class="field-row">
          <div class="field-value">${value}</div>
          <button
            class="btn-copy ${isCopied ? "copied" : ""}"
            @click=${() => this._copy(fieldKey, value)}
          >${isCopied ? t("cs.apiMode.secretDialog.copied") : t("cs.apiMode.secretDialog.copy")}</button>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="overlay">
        <div class="card">
          <div class="title">${t("cs.apiMode.secretDialog.title")}</div>

          <div class="warning">
            <span class="warning-icon">⚠️</span>
            <span>
              ${t("cs.apiMode.secretDialog.warning")}
            </span>
          </div>

          <div class="fields">
            ${this._renderField(t("cs.apiMode.secretDialog.appId"), "appId", this.appId)}
            ${this._renderField(t("cs.apiMode.secretDialog.appSecret"), "appSecret", this.appSecret)}
            ${this._renderField(t("cs.apiMode.secretDialog.endpointUrl"), "endpointUrl", this.endpointUrl)}
          </div>

          <div class="footer">
            <button class="btn-done" @click=${() => this._close()}>${t("cs.apiMode.secretDialog.doneBtn")}</button>
          </div>
        </div>
      </div>
    `;
  }
}

/**
 * Show the one-time secret reveal dialog.
 * Returns a Promise that resolves when the user closes the dialog.
 *
 * 展示一次性密钥弹窗，用户点击"已保存"后 resolve。
 */
export function showSecretReveal(opts: SecretRevealOptions): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement("secret-reveal-dialog");
    el.appId = opts.appId;
    el.appSecret = opts.appSecret;
    el.endpointUrl = opts.endpointUrl;
    el.init(resolve);
    document.body.appendChild(el);
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "secret-reveal-dialog": SecretRevealDialog;
  }
}
