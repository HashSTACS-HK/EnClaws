/**
 * Custom date picker component matching the project's dark UI style.
 * Supports i18n via the app's locale system.
 *
 * Usage:
 *   <date-picker .value=${"2026-04-01"} .locale=${"zh-CN"}
 *     @change=${(e) => this.date = e.detail.value}>
 *   </date-picker>
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { caretFix } from "../shared-styles.ts";

const WEEK_LABELS: Record<string, string[]> = {
  "en-US": ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  "zh-CN": ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"],
  "zh-TW": ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"],
  "de-DE": ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  "pt-BR": ["Do", "Se", "Te", "Qu", "Qu", "Se", "Sa"],
};

const MONTH_LABELS: Record<string, string[]> = {
  "en-US": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  "zh-CN": [
    "1\u6708",
    "2\u6708",
    "3\u6708",
    "4\u6708",
    "5\u6708",
    "6\u6708",
    "7\u6708",
    "8\u6708",
    "9\u6708",
    "10\u6708",
    "11\u6708",
    "12\u6708",
  ],
  "zh-TW": [
    "1\u6708",
    "2\u6708",
    "3\u6708",
    "4\u6708",
    "5\u6708",
    "6\u6708",
    "7\u6708",
    "8\u6708",
    "9\u6708",
    "10\u6708",
    "11\u6708",
    "12\u6708",
  ],
  "de-DE": ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  "pt-BR": ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"],
};

const TODAY_LABEL: Record<string, string> = {
  "en-US": "Today",
  "zh-CN": "\u4ECA\u5929",
  "zh-TW": "\u4ECA\u5929",
  "de-DE": "Heute",
  "pt-BR": "Hoje",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function toDateStr(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}
function todayStr(): string {
  const d = new Date();
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

@customElement("date-picker")
export class DatePicker extends LitElement {
  static styles = [
    caretFix,
    css`
      :host {
        display: inline-block;
        position: relative;
      }
      .trigger {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.35rem 0.5rem;
        min-width: 120px;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        color: var(--text, #e5e5e5);
        font-size: 0.8rem;
        cursor: pointer;
        user-select: none;
        outline: none;
        transition: border-color 0.15s;
      }
      .trigger:hover,
      .trigger:focus {
        border-color: var(--accent, #3b82f6);
      }
      .trigger svg {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        opacity: 0.5;
      }
      .placeholder {
        color: var(--text-muted, #525252);
      }
      .clear {
        margin-left: auto;
        padding: 0 2px;
        cursor: pointer;
        color: var(--text-muted, #525252);
        font-size: 0.9rem;
        line-height: 1;
      }
      .clear:hover {
        color: var(--text, #e5e5e5);
      }

      .dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 1000;
        background: var(--card, #141414);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-lg, 8px);
        padding: 0.75rem;
        width: 260px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        animation: dpFadeIn 0.12s ease;
      }
      @keyframes dpFadeIn {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.5rem;
      }
      .header-title {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--text, #e5e5e5);
        cursor: default;
      }
      .nav-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #a3a3a3);
        cursor: pointer;
        padding: 0.2rem 0.4rem;
        border-radius: 4px;
        font-size: 0.85rem;
        line-height: 1;
      }
      .nav-btn:hover {
        background: var(--border, #262626);
        color: var(--text, #e5e5e5);
      }

      .weekdays {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        text-align: center;
        font-size: 0.68rem;
        font-weight: 600;
        color: var(--text-muted, #525252);
        margin-bottom: 0.25rem;
      }
      .days {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
      }
      .day {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 28px;
        border-radius: 4px;
        font-size: 0.75rem;
        cursor: pointer;
        border: none;
        background: none;
        color: var(--text-secondary, #a3a3a3);
        transition: all 0.1s;
      }
      .day:hover {
        background: var(--border, #262626);
        color: var(--text, #e5e5e5);
      }
      .day.other-month {
        color: var(--text-muted, #333);
      }
      .day.other-month:hover {
        color: var(--text-muted, #525252);
      }
      .day.disabled {
        opacity: 0.25;
        cursor: not-allowed;
        pointer-events: none;
      }
      .day.today {
        color: var(--accent, #3b82f6);
        font-weight: 600;
      }
      .day.selected {
        background: var(--accent, #3b82f6);
        color: #fff;
        font-weight: 600;
      }
      .day.selected:hover {
        background: var(--accent, #3b82f6);
        opacity: 0.9;
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.4rem;
        margin-top: 0.5rem;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border, #262626);
      }
      .footer-btn {
        padding: 0.25rem 0.6rem;
        border: none;
        border-radius: 4px;
        font-size: 0.75rem;
        cursor: pointer;
        background: var(--border, #262626);
        color: var(--text-secondary, #a3a3a3);
      }
      .footer-btn:hover {
        color: var(--text, #e5e5e5);
      }
      .footer-btn.accent {
        background: var(--accent, #3b82f6);
        color: #fff;
      }
    `,
  ];

  @property() value = "";
  @property() placeholder = "";
  @property() locale = "en-US";
  @property() min = "";
  @property() max = "";

  @state() private open = false;
  @state() private viewYear = 0;
  @state() private viewMonth = 0;

  private _docClickBound = this._onDocClick.bind(this);

  connectedCallback() {
    super.connectedCallback();
    this._initView();
  }

  private _initView() {
    if (this.value) {
      const [y, m] = this.value.split("-").map(Number);
      this.viewYear = y;
      this.viewMonth = m - 1;
    } else {
      const now = new Date();
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
    }
  }

  private _toggle() {
    this.open = !this.open;
    if (this.open) {
      this._initView();
      document.addEventListener("click", this._docClickBound, true);
    } else {
      document.removeEventListener("click", this._docClickBound, true);
    }
  }

  private _onDocClick(e: Event) {
    if (!this.renderRoot.contains(e.target as Node)) {
      this.open = false;
      document.removeEventListener("click", this._docClickBound, true);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._docClickBound, true);
  }

  private _prevMonth() {
    if (this.viewMonth === 0) {
      this.viewYear--;
      this.viewMonth = 11;
    } else {
      this.viewMonth--;
    }
  }

  private _nextMonth() {
    if (this.viewMonth === 11) {
      this.viewYear++;
      this.viewMonth = 0;
    } else {
      this.viewMonth++;
    }
  }

  private _select(dateStr: string) {
    this.value = dateStr;
    this.open = false;
    document.removeEventListener("click", this._docClickBound, true);
    this.dispatchEvent(
      new CustomEvent("change", { detail: { value: dateStr }, bubbles: true, composed: true }),
    );
  }

  private _clear(e: Event) {
    e.stopPropagation();
    this.value = "";
    this.dispatchEvent(
      new CustomEvent("change", { detail: { value: "" }, bubbles: true, composed: true }),
    );
  }

  private _today() {
    this._select(todayStr());
  }

  private _isDisabled(dateStr: string): boolean {
    if (this.min && dateStr < this.min) {
      return true;
    }
    if (this.max && dateStr > this.max) {
      return true;
    }
    return false;
  }

  private _getDays(): Array<{
    day: number;
    dateStr: string;
    currentMonth: boolean;
    today: boolean;
    selected: boolean;
    disabled: boolean;
  }> {
    const y = this.viewYear,
      m = this.viewMonth;
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const daysInPrev = new Date(y, m, 0).getDate();
    const today = todayStr();
    const cells: Array<{
      day: number;
      dateStr: string;
      currentMonth: boolean;
      today: boolean;
      selected: boolean;
      disabled: boolean;
    }> = [];

    // Previous month padding
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = daysInPrev - i;
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      const ds = toDateStr(py, pm, d);
      cells.push({
        day: d,
        dateStr: ds,
        currentMonth: false,
        today: ds === today,
        selected: ds === this.value,
        disabled: this._isDisabled(ds),
      });
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = toDateStr(y, m, d);
      cells.push({
        day: d,
        dateStr: ds,
        currentMonth: true,
        today: ds === today,
        selected: ds === this.value,
        disabled: this._isDisabled(ds),
      });
    }
    // Next month padding
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const nm = m === 11 ? 0 : m + 1;
      const ny = m === 11 ? y + 1 : y;
      const ds = toDateStr(ny, nm, d);
      cells.push({
        day: d,
        dateStr: ds,
        currentMonth: false,
        today: ds === today,
        selected: ds === this.value,
        disabled: this._isDisabled(ds),
      });
    }
    return cells;
  }

  private _formatDisplay(): string {
    if (!this.value) {
      return "";
    }
    const [y, m, d] = this.value.split("-").map(Number);
    const months = MONTH_LABELS[this.locale] ?? MONTH_LABELS["en-US"];
    if (this.locale.startsWith("zh")) {
      return `${y}\u5E74${m}\u6708${d}\u65E5`;
    }
    return `${months[m - 1]} ${d}, ${y}`;
  }

  render() {
    const weeks = WEEK_LABELS[this.locale] ?? WEEK_LABELS["en-US"];
    const months = MONTH_LABELS[this.locale] ?? MONTH_LABELS["en-US"];
    const display = this._formatDisplay();

    return html`
      <div class="trigger" tabindex="0" @click=${this._toggle}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="2" y="3" width="12" height="11" rx="1.5"/>
          <line x1="2" y1="6.5" x2="14" y2="6.5"/>
          <line x1="5.5" y1="1.5" x2="5.5" y2="4.5"/>
          <line x1="10.5" y1="1.5" x2="10.5" y2="4.5"/>
        </svg>
        ${display ? html`<span>${display}</span>` : html`<span class="placeholder">${this.placeholder}</span>`}
        ${this.value ? html`<span class="clear" @click=${this._clear}>\u00D7</span>` : nothing}
      </div>

      ${
        this.open
          ? html`
        <div class="dropdown">
          <div class="header">
            <button class="nav-btn" @click=${this._prevMonth}>\u25C0</button>
            <span class="header-title">${this.locale.startsWith("zh") ? `${this.viewYear}\u5E74 ${months[this.viewMonth]}` : `${months[this.viewMonth]} ${this.viewYear}`}</span>
            <button class="nav-btn" @click=${this._nextMonth}>\u25B6</button>
          </div>
          <div class="weekdays">
            ${weeks.map((w) => html`<span>${w}</span>`)}
          </div>
          <div class="days">
            ${this._getDays().map(
              (c) => html`
              <button class="day ${c.currentMonth ? "" : "other-month"} ${c.today ? "today" : ""} ${c.selected ? "selected" : ""} ${c.disabled ? "disabled" : ""}"
                @click=${() => {
                  if (!c.disabled) {
                    this._select(c.dateStr);
                  }
                }}>${c.day}</button>
            `,
            )}
          </div>
          <div class="footer">
            <button class="footer-btn" @click=${this._today}>${TODAY_LABEL[this.locale] ?? "Today"}</button>
          </div>
        </div>
      `
          : nothing
      }
    `;
  }
}
