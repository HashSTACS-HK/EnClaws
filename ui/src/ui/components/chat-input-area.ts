import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { caretFix } from "../shared-styles.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { ChatAttachment } from "../ui-types.ts";

@customElement("chat-input-area")
export class ChatInputArea extends LitElement {
  private _i18n = new I18nController(this);
  @property({ type: String }) draft = "";
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) sending = false;
  @property({ type: Boolean }) canAbort = false;
  @property({ type: Array }) attachments: ChatAttachment[] = [];
  @property({ type: String }) disabledHint = "";

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        position: relative;
      }

      .chat-compose {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: var(--shadow-md);
        max-width: 840px;
        margin: 0 auto;
        width: 100%;
      }

      .chat-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 4px;
      }

      .chat-attachment {
        position: relative;
        width: 60px;
        height: 60px;
        border-radius: 8px;
        border: 1px solid var(--border);
        overflow: hidden;
        background: var(--bg-accent);
      }

      .chat-attachment__img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .chat-attachment__remove {
        position: absolute;
        top: 2px;
        right: 2px;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        border: none;
        border-radius: 50%;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        font-size: 10px;
        transition: background 0.2s;
      }

      .chat-attachment__remove:hover {
        background: rgba(255, 77, 79, 0.8);
      }

      .chat-compose__row {
        display: flex;
        align-items: flex-end;
        gap: 12px;
      }

      .chat-compose__field {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .chat-compose__field span {
        display: none;
      }

      textarea {
        width: 100%;
        min-height: 40px;
        max-height: 240px;
        resize: none;
        background: transparent;
        border: none;
        color: var(--text);
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5;
        padding: 8px 0;
        outline: none;
      }

      textarea::placeholder {
        color: var(--muted);
        opacity: 0.7;
      }

      .chat-compose__actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px; /* Align with textarea text center better */
      }

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
        height: 36px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--bg-accent);
        color: var(--text);
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s var(--ease-out);
        white-space: nowrap;
      }

      .btn:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn.primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }

      .btn.primary:hover:not(:disabled) {
        filter: brightness(1.05);
        box-shadow: 0 2px 8px var(--accent-subtle);
      }

      .btn-kbd {
        margin-left: 8px;
        font-family: var(--mono);
        font-size: 11px;
        opacity: 0.6;
        padding: 1px 4px;
        background: rgba(0, 0, 0, 0.05);
        border-radius: 4px;
      }
    `,
  ];

  private generateAttachmentId(): string {
    return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        imageItems.push(item);
      }
    }

    if (imageItems.length === 0) {
      return;
    }

    e.preventDefault();

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }

      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = reader.result as string;
        const newAttachment: ChatAttachment = {
          id: this.generateAttachmentId(),
          dataUrl,
          mimeType: file.type,
        };
        this.dispatchEvent(
          new CustomEvent("attachments-change", {
            detail: { attachments: [...this.attachments, newAttachment] },
            bubbles: true,
            composed: true,
          }),
        );
      });
      reader.readAsDataURL(file);
    }
  };

  private adjustTextareaHeight(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  render() {
    const hasAttachments = this.attachments.length > 0;
    const composePlaceholder = this.connected
      ? hasAttachments
        ? t("chat.placeholderAttach")
        : t("chat.placeholder")
      : this.disabledHint || t("chat.placeholderDisconnected");

    return html`
      <div class="chat-compose">
        ${
          this.attachments.length > 0
            ? html`
          <div class="chat-attachments">
            ${this.attachments.map(
              (att) => html`
              <div class="chat-attachment">
                <img src=${att.dataUrl} alt="Attachment" class="chat-attachment__img" />
                <button
                  class="chat-attachment__remove"
                  @click=${() => {
                    const next = this.attachments.filter((a) => a.id !== att.id);
                    this.dispatchEvent(
                      new CustomEvent("attachments-change", {
                        detail: { attachments: next },
                        bubbles: true,
                        composed: true,
                      }),
                    );
                  }}
                >${icons.x}</button>
              </div>
            `,
            )}
          </div>
        `
            : nothing
        }

        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              .value=${this.draft}
              dir=${detectTextDirection(this.draft)}
              ?disabled=${!this.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (
                  e.key !== "Enter" ||
                  e.isComposing ||
                  e.keyCode === 229 ||
                  e.shiftKey ||
                  !this.connected
                ) {
                  return;
                }
                e.preventDefault();
                this.dispatchEvent(new CustomEvent("send", { bubbles: true, composed: true }));
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                this.adjustTextareaHeight(target);
                this.dispatchEvent(
                  new CustomEvent("draft-change", {
                    detail: { draft: target.value },
                    bubbles: true,
                    composed: true,
                  }),
                );
              }}
              @paste=${this.handlePaste}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>

          <div class="chat-compose__actions">
            <button
              class="btn"
              ?disabled=${!this.connected || (!this.canAbort && this.sending)}
              @click=${() => this.dispatchEvent(new CustomEvent(this.canAbort ? "abort" : "new-session", { bubbles: true, composed: true }))}
            >
              ${this.canAbort ? t("chat.stop") : t("chat.newSession")}
            </button>
            <button
              class="btn primary"
              ?disabled=${!this.connected}
              @click=${() => this.dispatchEvent(new CustomEvent("send", { bubbles: true, composed: true }))}
            >
              ${this.sending ? t("chat.queue") : t("chat.send")}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
