import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

/** Channels that represent system-level automation (not a real user channel). */
const SYSTEM_CHANNELS = new Set(["cron"]);

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVEL_KEYS = ["", "off", "on", "full"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

const THINK_LABEL_MAP: Record<string, string> = {
  off: "sessions.thinkOff",
  minimal: "sessions.thinkMinimal",
  low: "sessions.thinkLow",
  medium: "sessions.thinkMedium",
  high: "sessions.thinkHigh",
  xhigh: "sessions.thinkXhigh",
  on: "sessions.thinkOn",
};

const VERBOSE_LABEL_MAP: Record<string, string> = {
  off: "sessions.verboseOff",
  on: "sessions.verboseOn",
  full: "sessions.verboseFull",
};

const REASONING_LABEL_MAP: Record<string, string> = {
  off: "sessions.reasoningOff",
  on: "sessions.reasoningOn",
  stream: "sessions.reasoningStream",
};

function localizedLabel(value: string, map: Record<string, string>): string {
  const key = map[value];
  return key ? t(key) : value;
}

function localizedRelativeTime(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) {
    return "n/a";
  }
  const diff = Date.now() - epochMs;
  if (diff < 0) {
    return "n/a";
  }
  const sec = Math.round(diff / 1000);
  if (sec < 60) {
    return t("sessions.timeJustNow");
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return t("sessions.timeMinAgo", { n: String(min) });
  }
  const hr = Math.round(min / 60);
  if (hr < 48) {
    return t("sessions.timeHourAgo", { n: String(hr) });
  }
  const day = Math.round(hr / 24);
  return t("sessions.timeDayAgo", { n: String(day) });
}

const KIND_LABEL_MAP: Record<string, string> = {
  direct: "sessions.kindDirect",
  group: "sessions.kindGroup",
  global: "sessions.kindGlobal",
  unknown: "sessions.kindUnknown",
};

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function _withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((option) => option.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: `${current} (custom)` }];
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  if (value === "on") {
    return "low";
  }
  return value;
}

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: flex-end;">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("sessions.loading") : t("sessions.refresh")}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field">
          <span>${t("sessions.activeMinutes")}</span>
          <input
            .value=${props.activeMinutes}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: (e.target as HTMLInputElement).value,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field">
          <span>${t("sessions.limit")}</span>
          <input
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: (e.target as HTMLInputElement).value,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field checkbox">
          <span>${t("sessions.includeGlobal")}</span>
          <input
            type="checkbox"
            .checked=${props.includeGlobal}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: (e.target as HTMLInputElement).checked,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field checkbox">
          <span>${t("sessions.includeUnknown")}</span>
          <input
            type="checkbox"
            .checked=${props.includeUnknown}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: (e.target as HTMLInputElement).checked,
              })}
          />
        </label>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }


      <div class="session-list" style="margin-top: 16px;">
        ${
          rows.length === 0
            ? html`
                <div class="muted">${t("sessions.noSessions")}</div>
              `
            : rows.map((row) =>
                renderRow(row, props.basePath, props.onPatch, props.onDelete, props.loading),
              )
        }
      </div>
    </section>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  disabled: boolean,
) {
  const updated = localizedRelativeTime(row.updatedAt);
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentOption(VERBOSE_LEVEL_KEYS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const displayName =
    typeof row.displayName === "string" && row.displayName.trim().length > 0
      ? row.displayName.trim()
      : null;
  const _label = typeof row.label === "string" ? row.label.trim() : "";
  // userRole=owner means the session belongs to a webchat user (owner account);
  // anything else is an external channel session — use row.channel for the badge.
  const isWebChat = row.userRole === "owner";
  const rawChannel = row.channel || "unknown";
  const resolvedChannel = isWebChat
    ? "WebChat"
    : SYSTEM_CHANNELS.has(rawChannel)
      ? "System"
      : rawChannel;
  const canLink = row.kind !== "global" && isWebChat;
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const titleText = displayName ?? (row.key.length > 25 ? `${row.key.slice(0, 25)}…` : row.key);
  const channelBadge = isWebChat
    ? html`
        <span class="session-channel-badge session-channel-badge--web">WebChat</span>
      `
    : html`<span class="session-channel-badge session-channel-badge--${resolvedChannel}" title=${resolvedChannel}>${resolvedChannel}</span>`;

  const kindLabel = KIND_LABEL_MAP[row.kind] ? t(KIND_LABEL_MAP[row.kind]) : row.kind;
  const tokens = formatSessionTokens(row);
  const modelDisplay = row.model ? (row.model.split("/").pop() ?? row.model) : "";

  return html`
    <div class="session-card">
      <div class="session-card__header">
        <div class="session-card__left">
          <div class="session-card__title-line">
            ${channelBadge}
            ${
              canLink
                ? html`<a href=${chatUrl} class="session-link" title=${displayName ? "" : row.key} @click=${(
                    e: MouseEvent,
                  ) => {
                    if (
                      e.defaultPrevented ||
                      e.button !== 0 ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey
                    ) {
                      return;
                    }
                    e.preventDefault();
                    window.history.pushState({}, "", chatUrl);
                    window.dispatchEvent(new PopStateEvent("popstate"));
                  }}>${titleText}</a>`
                : html`<span class="session-card__key" title=${displayName ? "" : row.key}>${titleText}</span>`
            }
          </div>
          <div class="session-card__meta">
            <span>${kindLabel}</span>
            ${tokens ? html`<span>${tokens}</span>` : nothing}
            <span>${updated}</span>
          </div>
        </div>
        <div class="session-card__badges">
          ${modelDisplay ? html`<span class="badge badge-platform">${modelDisplay}</span>` : nothing}
        </div>
      </div>
      <div class="session-card__controls">
        <label class="session-card__field">
          <span class="session-card__field-label">${t("sessions.colLabel")}</span>
          <input
            .value=${row.label ?? ""}
            ?disabled=${disabled}
            placeholder=${t("sessions.optional")}
            @change=${(e: Event) => {
              const value = (e.target as HTMLInputElement).value.trim();
              onPatch(row.key, { label: value || null });
            }}
          />
        </label>
        <label class="session-card__field">
          <span class="session-card__field-label">${t("sessions.colThinking")}</span>
          <select
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, {
                thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
              });
            }}
          >
            ${thinkLevels.map(
              (level) =>
                html`<option value=${level} ?selected=${thinking === level}>
                  ${level ? localizedLabel(level, THINK_LABEL_MAP) : t("sessions.inherit")}
                </option>`,
            )}
          </select>
        </label>
        <label class="session-card__field">
          <span class="session-card__field-label">${t("sessions.colVerbose")}</span>
          <select
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, { verboseLevel: value || null });
            }}
          >
            ${verboseLevels.map(
              (level) =>
                html`<option value=${level} ?selected=${verbose === level}>
                  ${level ? localizedLabel(level, VERBOSE_LABEL_MAP) : t("sessions.inherit")}
                </option>`,
            )}
          </select>
        </label>
        <label class="session-card__field">
          <span class="session-card__field-label">${t("sessions.colReasoning")}</span>
          <select
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, { reasoningLevel: value || null });
            }}
          >
            ${reasoningLevels.map(
              (level) =>
                html`<option value=${level} ?selected=${reasoning === level}>
                  ${level ? localizedLabel(level, REASONING_LABEL_MAP) : t("sessions.inherit")}
                </option>`,
            )}
          </select>
        </label>
        <button class="btn danger session-card__delete" ?disabled=${disabled} @click=${() => onDelete(row.key)}>
          ${t("sessions.delete")}
        </button>
      </div>
    </div>
  `;
}
