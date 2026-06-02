import { html } from "lit";

export function formatComingSoonLabel(pageName: string, comingSoonLabel: string): string {
  const page = pageName.trim();
  const suffix = comingSoonLabel.trim();
  if (!page) {
    return suffix;
  }
  if (!suffix) {
    return page;
  }
  return `${page}——${suffix}`;
}

export function renderComingSoonPlaceholder(pageName: string, comingSoonLabel: string) {
  return html`
    <div
      class="coming-soon-placeholder"
      style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:80px 24px;color:var(--text-muted,#888);text-align:center;"
    >
      <span
        class="coming-soon-icon"
        aria-hidden="true"
        style="font-size:32px;line-height:1;opacity:0.5;"
      >
        🔧
      </span>
      <span class="coming-soon-label" style="font-size:14px;">
        ${formatComingSoonLabel(pageName, comingSoonLabel)}
      </span>
    </div>
  `;
}
