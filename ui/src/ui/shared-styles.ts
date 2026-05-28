import { css, type LitElement, type ReactiveController, type ReactiveControllerHost } from "lit";

/**
 * Shared caret-color fix for Shadow DOM components.
 * Suppresses stray text-cursor rendering on non-input elements,
 * while preserving normal caret behavior for editable fields.
 *
 * Usage: static styles = [caretFix, css`...`];
 */
export const caretFix = css`
  * {
    caret-color: transparent;
    user-select: none;
  }
  input, textarea, [contenteditable] {
    caret-color: auto !important;
    user-select: text !important;
  }
  select {
    caret-color: auto !important;
  }
`;

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Lit controller that clears stray browser caret/selection when
 * clicking on non-editable areas inside a Shadow DOM component.
 *
 * Usage: private _caretGuard = new CaretGuard(this);
 */
export class CaretGuard implements ReactiveController {
  private host: ReactiveControllerHost & LitElement;
  private handler = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!t) {return;}
    if (EDITABLE_TAGS.has(t.tagName) || t.isContentEditable) {return;}
    // Clear any stray selection/caret the browser placed
    window.getSelection()?.removeAllRanges();
  };

  constructor(host: ReactiveControllerHost & LitElement) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.host.renderRoot.addEventListener("mouseup", this.handler as EventListener);
  }

  hostDisconnected() {
    this.host.renderRoot.removeEventListener("mouseup", this.handler as EventListener);
  }
}
