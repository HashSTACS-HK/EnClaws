/**
 * Custom confirm dialog component matching the project's dark UI style.
 * Replaces native `confirm()` with a styled modal.
 *
 * Usage:
 *   import { showConfirm } from "../components/confirm-dialog.ts";
 *   const ok = await showConfirm({ title: "Delete?", message: "This cannot be undone." });
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { caretFix } from "../shared-styles.ts";

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  hideCancel?: boolean;
}

@customElement("confirm-dialog")
export class ConfirmDialog extends LitElement {
  static styles = [
    caretFix,
    css`
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        animation: fadeIn 0.15s ease;
      }
      .card {
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 8px);
        padding: 1.5rem;
        width: 400px;
        max-width: 90vw;
        animation: slideUp 0.15s ease;
      }
      .title {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text, #e5e5e5);
      }
      .message {
        font-size: 0.85rem;
        color: var(--text-secondary, #a3a3a3);
        line-height: 1.5;
        margin: 0 0 1.25rem;
        white-space: pre-wrap;
      }
      .footer {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
      }
      .btn {
        padding: 0.45rem 0.9rem;
        border: none;
        border-radius: var(--radius-md, 6px);
        font-size: 0.85rem;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .btn:hover {
        opacity: 0.85;
      }
      .btn-cancel {
        background: transparent;
        border: 1px solid var(--border, #262626);
        color: var(--text, #e5e5e5);
      }
      .btn-confirm {
        background: var(--accent, #3b82f6);
        color: white;
      }
      .btn-confirm.danger {
        background: var(--bg-destructive, #7f1d1d);
        color: var(--text-destructive, #fca5a5);
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

  @property() title = "";
  @property() message = "";
  @property() confirmText = "OK";
  @property() cancelText = "取消";
  @property({ type: Boolean }) danger = false;
  @property({ type: Boolean }) hideCancel = false;

  private _resolve?: (value: boolean) => void;

  show(resolve: (value: boolean) => void) {
    this._resolve = resolve;
  }

  private _confirm() {
    this._resolve?.(true);
    this.remove();
  }

  private _cancel() {
    this._resolve?.(false);
    this.remove();
  }

  private _overlayClick(e: Event) {
    if (e.target === e.currentTarget) {
      this._cancel();
    }
  }

  render() {
    return html`
      <div class="overlay" @click=${this._overlayClick}>
        <div class="card">
          ${this.title ? html`<div class="title">${this.title}</div>` : nothing}
          <div class="message">${this.message}</div>
          <div class="footer">
            ${this.hideCancel ? nothing : html`<button class="btn btn-cancel" @click=${this._cancel}>${this.cancelText}</button>`}
            <button class="btn btn-confirm ${this.danger ? "danger" : ""}" @click=${this._confirm}>${this.confirmText}</button>
          </div>
        </div>
      </div>
    `;
  }
}

export function showConfirm(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("confirm-dialog") as ConfirmDialog;
    el.title = opts.title;
    el.message = opts.message;
    if (opts.confirmText) {
      el.confirmText = opts.confirmText;
    }
    if (opts.cancelText) {
      el.cancelText = opts.cancelText;
    }
    if (opts.danger) {
      el.danger = true;
    }
    if (opts.hideCancel) {
      el.hideCancel = true;
    }
    el.show(resolve);
    document.body.appendChild(el);
  });
}
