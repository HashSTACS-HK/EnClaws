/**
 * Platform overview dashboard — platform-level statistics.
 *
 * Shows tenant count, token usage trends, LLM interaction stats,
 * channel distribution, agent activity, and user activity.
 */

import * as echarts from "echarts";
import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { caretFix } from "../shared-styles.ts";
import { tenantRpc } from "./tenant/rpc.ts";

// ── Types ────────────────────────────────────────────────────────────

type RankPeriod = "all" | "month" | "today";

interface SummaryData {
  gateway: { status: string; uptimeMs: number };
  tenants: { total: number; active30d: number };
  monthTokens: { current: number; lastMonth: number };
  agents: { total: number; enabled: number; active30d: number };
}

interface TrendItem {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

interface RankData {
  tenants: Array<{ name: string; plan: string; tokens: number }>;
  users: Array<{ name: string; tenantName: string; tokens: number }>;
  models: Array<{ model: string; tokens: number; percent: number }>;
  agents: Array<{ name: string; tenantName: string; tokens: number }>;
}

interface LlmStats {
  turns: number;
  avgDurationMs: number;
  errorRate: number;
  modelDistribution: Array<{ model: string; count: number; percent: number }>;
}

interface UserActivity {
  total: number;
  active30d: number;
  newToday: number;
  newThisWeek: number;
}

interface ChannelItem {
  type: string;
  count: number;
}

// ── Component ───────────────────────────────────────────────────────

@customElement("platform-overview-view")
export class PlatformOverviewView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        padding: 1.5rem;
        color: var(--text);
        font-family: var(--font-sans, system-ui, sans-serif);
      }

      /* ── Header ── */
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      .page-header h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .btn {
        padding: 0.45rem 0.9rem;
        border: none;
        border-radius: var(--radius-md);
        font-size: 0.85rem;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .btn:hover {
        opacity: 0.85;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }

      /* ── Summary cards row ── */
      .summary-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      .summary-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
      }
      .summary-label {
        font-size: 0.8rem;
        color: var(--text-2);
        margin-bottom: 0.35rem;
      }
      .summary-value {
        font-size: 1.6rem;
        font-weight: 700;
      }
      .summary-sub {
        font-size: 0.75rem;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      .status-dot.ok {
        background: var(--ok);
      }
      .status-dot.warn {
        background: var(--warn);
      }
      .status-dot.error {
        background: var(--danger);
      }

      /* ── Section card ── */
      .section {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1rem;
      }
      .section-title {
        font-size: 0.95rem;
        font-weight: 600;
        margin: 0 0 1rem;
      }
      .section-subtitle {
        font-size: 0.75rem;
        color: var(--muted);
        margin-left: 0.5rem;
        font-weight: 400;
      }

      /* ── Two-column layout ── */
      .two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      .three-col {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 1rem;
        margin-bottom: 1rem;
      }

      /* ── Period selector ── */
      .period-tabs {
        display: flex;
        gap: 0.25rem;
        margin-bottom: 1rem;
      }
      .period-tab {
        padding: 0.3rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: transparent;
        color: var(--text-2);
        font-size: 0.8rem;
        cursor: pointer;
        transition: all 0.15s;
      }
      .period-tab:hover {
        border-color: var(--accent);
        color: var(--text);
      }
      .period-tab.active {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-foreground);
      }

      /* ── ECharts chart ── */
      .chart-container {
        width: 100%;
        height: 300px;
        position: relative;
      }

      /* ── Rank block (inside section card) ── */
      .rank-block {
        background: var(--surface-2);
        border-radius: var(--radius-md);
        padding: 1rem;
      }
      .rank-block-title {
        font-size: 0.85rem;
        font-weight: 600;
        margin: 0 0 0.5rem;
      }

      .rank-empty {
        text-align: center;
        padding: 2rem 0;
        color: var(--muted);
        font-size: 0.85rem;
      }

      /* ── Rank list ── */
      .rank-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .rank-item {
        display: flex;
        align-items: center;
        padding: 0.55rem 0;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
      }
      .rank-item:last-child {
        border-bottom: none;
      }
      .rank-index {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.7rem;
        font-weight: 600;
        margin-right: 0.75rem;
        flex-shrink: 0;
      }
      .rank-index img {
        width: 22px;
        height: 22px;
      }
      .rank-index.other {
        border-radius: 50%;
        background: var(--border);
        color: var(--muted);
      }
      .rank-name {
        flex: 1;
      }
      .rank-sub {
        font-size: 0.75rem;
        color: var(--muted);
        margin-left: 0.25rem;
      }
      .rank-value {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .rank-bar-bg {
        display: block;
        width: 80px;
        height: 4px;
        background: var(--border);
        border-radius: 2px;
        margin-left: 0.75rem;
        overflow: hidden;
        flex-shrink: 0;
      }
      .rank-bar-fill {
        display: block;
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, var(--accent), var(--accent-2));
        transition: width 0.4s ease;
      }

      /* ── LLM stats row ── */
      .llm-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
      }
      .llm-stat-card {
        text-align: center;
        padding: 1rem;
        background: var(--surface-2);
        border-radius: var(--radius-md);
      }
      .llm-stat-value {
        font-size: 1.35rem;
        font-weight: 700;
      }
      .llm-stat-label {
        font-size: 0.75rem;
        color: var(--text-2);
        margin-top: 0.25rem;
      }
      .llm-stat-value.error-color {
        color: var(--danger);
      }

      /* ── LLM layout: left stats + right pie ── */
      .llm-layout {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.5rem;
        align-items: start;
      }
      .llm-pie-container,
      .channel-pie-container {
        width: 100%;
        height: 240px;
      }

      /* ── Badge ── */
      .plan-badge {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
        font-size: 0.7rem;
        font-weight: 500;
        margin-left: 0.4rem;
      }
      .plan-badge.free {
        background: var(--border);
        color: var(--muted);
      }
      .plan-badge.pro {
        background: var(--accent-light);
        color: var(--accent);
      }
      .plan-badge.enterprise {
        background: var(--accent-light);
        color: var(--accent-2);
      }

      /* ── User activity ── */
      .user-stats-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
        margin-bottom: 1rem;
      }
      .user-stat {
        text-align: center;
        padding: 0.75rem;
        background: var(--surface-2);
        border-radius: var(--radius-md);
      }
      .user-stat-value {
        font-size: 1.2rem;
        font-weight: 700;
      }
      .user-stat-label {
        font-size: 0.72rem;
        color: var(--text-2);
        margin-top: 0.2rem;
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private period: "7d" | "30d" = "7d";
  @state() private rankPeriod: RankPeriod = "all";
  @state() private llmPeriod: RankPeriod = "all";
  @state() private loading = true;
  @state() private summary: SummaryData | null = null;
  @state() private trend: TrendItem[] = [];
  @state() private rank: RankData | null = null;
  @state() private llmStats: LlmStats | null = null;
  @state() private channels: ChannelItem[] = [];
  @state() private userActivity: UserActivity | null = null;
  private trendChart: echarts.ECharts | null = null;
  private llmPieChart: echarts.ECharts | null = null;
  private channelPieChart: echarts.ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private formatNumber(n: number): string {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
  }

  private rankClass(i: number): string {
    if (i === 0) {
      return "top1";
    }
    if (i === 1) {
      return "top2";
    }
    if (i === 2) {
      return "top3";
    }
    return "other";
  }

  private rankIcon(i: number) {
    const medals = ["/gold-medal.svg", "/silver-medal.svg", "/bronze-medal.svg"];
    return i < 3 ? html`<img src="${medals[i]}" alt="top${i + 1}">` : html`${i + 1}`;
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadAll();
  }

  private async loadAll() {
    this.trendChart?.dispose();
    this.trendChart = null;
    this.llmPieChart?.dispose();
    this.llmPieChart = null;
    this.channelPieChart?.dispose();
    this.channelPieChart = null;
    this.loading = true;
    await Promise.all([
      this.loadSummary(),
      this.loadTrend(),
      this.loadRank(),
      this.loadLlmStats(),
      this.loadChannels(),
      this.loadUserActivity(),
    ]);
    this.loading = false;
  }

  private async loadSummary() {
    try {
      this.summary = (await this.rpc("platform.overview.summary")) as SummaryData;
    } catch (e) {
      console.error("[platform-overview] summary:", e);
      this.summary = null;
    }
  }

  private async loadTrend() {
    try {
      const res = (await this.rpc("platform.overview.tokenTrend", {
        days: this.period === "7d" ? 7 : 30,
      })) as { trend: TrendItem[] };
      this.trend = res.trend ?? [];
    } catch (e) {
      console.error("[platform-overview] trend:", e);
      this.trend = [];
    }
  }

  private async loadRank() {
    try {
      this.rank = (await this.rpc("platform.overview.tokenRank", {
        period: this.rankPeriod,
      })) as RankData;
    } catch (e) {
      console.error("[platform-overview] rank:", e);
      this.rank = null;
    }
  }

  private async loadLlmStats() {
    try {
      this.llmStats = (await this.rpc("platform.overview.llmStats", {
        period: this.llmPeriod,
      })) as LlmStats;
    } catch (e) {
      console.error("[platform-overview] llmStats:", e);
      this.llmStats = null;
    }
  }

  private async loadChannels() {
    try {
      const res = (await this.rpc("platform.overview.channelDistribution")) as {
        channels: ChannelItem[];
      };
      this.channels = res.channels ?? [];
    } catch (e) {
      console.error("[platform-overview] channels:", e);
      this.channels = [];
    }
  }

  private async loadUserActivity() {
    try {
      this.userActivity = (await this.rpc("platform.overview.userActivity")) as UserActivity;
    } catch (e) {
      console.error("[platform-overview] userActivity:", e);
      this.userActivity = null;
    }
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) {
      return `${d}d ${h % 24}h ${m % 60}m`;
    }
    if (h > 0) {
      return `${h}h ${m % 60}m`;
    }
    return `${m}m`;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.trendChart?.dispose();
    this.trendChart = null;
    this.llmPieChart?.dispose();
    this.llmPieChart = null;
    this.channelPieChart?.dispose();
    this.channelPieChart = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  protected updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (changed.has("period")) {
      void this.loadTrend();
    }
    if (changed.has("rankPeriod")) {
      void this.loadRank();
    }
    if (changed.has("llmPeriod")) {
      void this.loadLlmStats();
    }
    // Init charts if not yet created (e.g. after loading state clears)
    if (!this.trendChart) {
      this.initTrendChart();
    }
    if (!this.llmPieChart) {
      this.initLlmPieChart();
    }
    if (!this.channelPieChart) {
      this.initChannelPieChart();
    }
    // Re-render charts on data/locale changes
    this.updateTrendChart();
    this.updateLlmPieChart();
  }

  /** Read a CSS custom property from the component's computed style. */
  private cssVar(v: string): string {
    return getComputedStyle(this).getPropertyValue(v).trim();
  }

  private initTrendChart() {
    const el = this.shadowRoot?.querySelector(".chart-container") as HTMLElement | null;
    if (!el) {
      return;
    }
    this.trendChart = echarts.init(el);
    this.updateTrendChart();
    // Auto resize
    this.resizeObserver = new ResizeObserver(() => this.trendChart?.resize());
    this.resizeObserver.observe(el);
  }

  private updateTrendChart() {
    if (!this.trendChart || this.trend.length === 0) {
      return;
    }
    const data = this.trend;

    this.trendChart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "none" },
        backgroundColor: this.cssVar("--card"),
        borderColor: this.cssVar("--border"),
        textStyle: { color: this.cssVar("--text"), fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as Array<{
            seriesName: string;
            value: number;
            color: string;
            dataIndex: number;
          }>;
          const date = data[p[0]?.dataIndex ?? 0]?.date ?? "";
          let total = 0;
          let rows = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
          for (const item of p) {
            total += item.value;
            rows += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color}"></span>
              ${item.seriesName}: ${item.value >= 1000 ? (item.value / 1000).toFixed(1) + "K" : item.value}
            </div>`;
          }
          rows += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${this.cssVar("--muted")}"></span>
              ${t("platformOverview.total")}: ${total >= 1000 ? (total / 1000).toFixed(1) + "K" : total}
            </div>`;
          return rows;
        },
      },
      legend: {
        data: [t("platformOverview.inputToken"), t("platformOverview.outputToken")],
        top: 0,
        textStyle: { color: this.cssVar("--text-2"), fontSize: 12 },
        icon: "circle",
        itemWidth: 10,
        itemHeight: 10,
        itemStyle: { borderWidth: 0 },
      },
      grid: {
        left: 12,
        right: 12,
        top: 36,
        bottom: 8,
        containLabel: true,
      },
      xAxis: {
        type: "category",
        data: data.map((d) => d.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: this.cssVar("--border") } },
        axisLabel: { color: this.cssVar("--text-2"), fontSize: 12 },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        splitLine: { show: false },
        axisLine: { show: false },
        axisLabel: {
          color: this.cssVar("--text-2"),
          fontSize: 12,
          formatter: (v: number) => (v >= 1000 ? (v / 1000).toFixed(0) + "K" : String(v)),
        },
      },
      series: [
        {
          name: t("platformOverview.inputToken"),
          type: "line",
          data: data.map((d) => d.inputTokens),
          smooth: true,
          symbol: "circle",
          symbolSize: 6,
          itemStyle: { color: this.cssVar("--accent") },
          lineStyle: { width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: this.cssVar("--accent-light") },
              { offset: 1, color: "transparent" },
            ]),
          },
        },
        {
          name: t("platformOverview.outputToken"),
          type: "line",
          data: data.map((d) => d.outputTokens),
          smooth: true,
          symbol: "circle",
          symbolSize: 6,
          itemStyle: { color: this.cssVar("--ok") },
          lineStyle: { width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: this.cssVar("--ok-subtle") },
              { offset: 1, color: "transparent" },
            ]),
          },
        },
      ],
    });
  }

  private renderTrendChart() {
    if (this.trend.length === 0) {
      return html`<div class="chart-container" style="display:grid;place-items:center;color:var(--muted);font-size:0.8rem">${t("platformOverview.noData")}</div>`;
    }
    return html`
      <div class="chart-container"></div>
    `;
  }

  private initLlmPieChart() {
    const el = this.shadowRoot?.querySelector(".llm-pie-container") as HTMLElement | null;
    if (!el) {
      return;
    }
    this.llmPieChart = echarts.init(el);
    this.updateLlmPieChart();
    this.resizeObserver?.observe(el);
  }

  private updateLlmPieChart() {
    if (!this.llmPieChart || !this.llmStats) {
      return;
    }
    const data = this.llmStats.modelDistribution;
    const pieColors = ["#60a5fa", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];

    this.llmPieChart.setOption(
      {
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item",
          backgroundColor: this.cssVar("--card"),
          borderColor: this.cssVar("--border"),
          textStyle: { color: this.cssVar("--text"), fontSize: 12 },
          formatter: (params: unknown) => {
            const p = params as { name: string; value: number; percent: number };
            return `${p.name}<br/>${t("platformOverview.callCount")}: ${p.value}<br/>${t("platformOverview.proportion")}: ${p.percent}%`;
          },
        },
        legend: {
          orient: "vertical",
          right: 10,
          top: "center",
          textStyle: { color: this.cssVar("--text-2"), fontSize: 12 },
          icon: "circle",
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 12,
          itemStyle: { borderWidth: 0 },
        },
        color: pieColors,
        series: [
          {
            type: "pie",
            radius: "70%",
            center: ["35%", "50%"],
            avoidLabelOverlap: true,
            itemStyle: { borderWidth: 0 },
            label: { show: false },
            emphasis: { label: { show: false }, scaleSize: 6 },
            data: data.map((m, i) => ({
              name: m.model,
              value: m.count,
              itemStyle: { color: pieColors[i % pieColors.length] },
            })),
          },
        ],
      },
      true,
    );
  }

  private initChannelPieChart() {
    const el = this.shadowRoot?.querySelector(".channel-pie-container") as HTMLElement | null;
    if (!el) {
      return;
    }
    this.channelPieChart = echarts.init(el);
    const pieColors = ["#60a5fa", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];
    this.channelPieChart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        backgroundColor: this.cssVar("--card"),
        borderColor: this.cssVar("--border"),
        textStyle: { color: this.cssVar("--text"), fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}<br/>${t("platformOverview.count")}: ${p.value}<br/>${t("platformOverview.proportion")}: ${p.percent}%`;
        },
      },
      legend: {
        orient: "vertical",
        right: 10,
        top: "center",
        textStyle: { color: this.cssVar("--text-2"), fontSize: 12 },
        icon: "circle",
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 12,
        itemStyle: { borderWidth: 0 },
      },
      color: pieColors,
      series: [
        {
          type: "pie",
          radius: "70%",
          center: ["35%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderWidth: 0 },
          label: { show: false },
          emphasis: { label: { show: false }, scaleSize: 6 },
          data: this.channels.map((c, i) => ({
            name: c.type,
            value: c.count,
            itemStyle: { color: pieColors[i % pieColors.length] },
          })),
        },
      ],
    });
    this.resizeObserver?.observe(el);
  }

  private renderRankList(
    items: Array<{
      label: string;
      sub?: string;
      value: number;
      badge?: string;
      badgeClass?: string;
    }>,
  ) {
    if (items.length === 0) {
      return html`<div class="rank-empty">${t("platformOverview.noData")}</div>`;
    }
    const maxVal = items.length > 0 ? items[0].value : 1;
    return html`
      <ul class="rank-list">
        ${items.map(
          (item, i) => html`
          <li class="rank-item">
            <span class="rank-index ${this.rankClass(i)}">${this.rankIcon(i)}</span>
            <span class="rank-name">
              ${item.label}
              ${item.badge ? html`<span class="plan-badge ${item.badgeClass ?? ""}">${item.badge}</span>` : nothing}
              ${item.sub ? html`<span class="rank-sub">${item.sub}</span>` : nothing}
            </span>
            <span class="rank-value">${this.formatNumber(item.value)}</span>
            <span class="rank-bar-bg">
              <span class="rank-bar-fill" style="width:${Math.round((item.value / maxVal) * 100)}%"></span>
            </span>
          </li>
        `,
        )}
      </ul>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div style="text-align:center;padding:3rem;color:var(--muted)">${t("platformOverview.refresh")}...</div>`;
    }
    const s = this.summary;
    const ua = this.userActivity;
    return html`
      <div class="page-header">
        <h2>${t("platformOverview.title")}</h2>
        <button class="btn btn-outline" @click=${() => this.loadAll()}>${t("platformOverview.refresh")}</button>
      </div>

      <!-- ── 1. 概况卡片 ── -->
      ${(() => {
        const cur = s?.monthTokens?.current ?? 0;
        const last = s?.monthTokens?.lastMonth ?? 0;
        const diff = last > 0 ? ((cur - last) / last) * 100 : 0;
        const diffText = last > 0 ? `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%` : "-";
        const diffColor = diff < 0 ? "var(--danger)" : "var(--ok)";
        return html`
      <div class="summary-row">
        <div class="summary-card">
          <div class="summary-label">${t("platformOverview.platformStatus")}</div>
          <div class="summary-value">
            <span class="status-dot ok"></span>${t("platformOverview.running")}
          </div>
          <div class="summary-sub">${t("platformOverview.uptime")}: ${s ? this.formatDuration(s.gateway.uptimeMs) : "-"}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">${t("platformOverview.tenantCount")}</div>
          <div class="summary-value">${s?.tenants.total ?? "-"}</div>
          <div class="summary-sub">${t("platformOverview.active30d")}: ${s?.tenants.active30d ?? "-"}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">${t("platformOverview.totalAgents")}</div>
          <div class="summary-value">${s?.agents.total ?? "-"}</div>
          <div class="summary-sub">${t("platformOverview.enabled")}: ${s?.agents.enabled ?? "-"} / ${t("platformOverview.active30d")}: ${s?.agents.active30d ?? "-"}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">${t("platformOverview.monthTokens")}</div>
          <div class="summary-value">${this.formatNumber(cur)}</div>
          <div class="summary-sub">${t("platformOverview.vsLastMonth")}: <span style="color:${diffColor}">${diffText}</span></div>
        </div>
      </div>`;
      })()}

      <!-- ── 2. Token 用量趋势 ── -->
      <div class="section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <h3 class="section-title" style="margin-bottom:0">${t("platformOverview.tokenTrend")}</h3>
          <div class="period-tabs">
            <button class="period-tab ${this.period === "7d" ? "active" : ""}"
              @click=${() => {
                this.period = "7d";
              }}>${t("platformOverview.last7d")}</button>
            <button class="period-tab ${this.period === "30d" ? "active" : ""}"
              @click=${() => {
                this.period = "30d";
              }}>${t("platformOverview.last30d")}</button>
          </div>
        </div>
        ${this.renderTrendChart()}
      </div>

      <!-- ── 3. Token 排行 ── -->
      <div class="section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
          <h3 class="section-title" style="margin:0">${t("platformOverview.tokenRank")}</h3>
          <div class="period-tabs">
            <button class="period-tab ${this.rankPeriod === "all" ? "active" : ""}"
              @click=${() => {
                this.rankPeriod = "all";
              }}>${t("platformOverview.periodAll")}</button>
            <button class="period-tab ${this.rankPeriod === "month" ? "active" : ""}"
              @click=${() => {
                this.rankPeriod = "month";
              }}>${t("platformOverview.periodMonth")}</button>
            <button class="period-tab ${this.rankPeriod === "today" ? "active" : ""}"
              @click=${() => {
                this.rankPeriod = "today";
              }}>${t("platformOverview.periodToday")}</button>
          </div>
        </div>
        <div class="two-col" style="margin-bottom:1rem">
          <div class="rank-block">
            <h4 class="rank-block-title">${t("platformOverview.tenantRank")}</h4>
            ${this.renderRankList(
              (this.rank?.tenants ?? []).map((item) => ({
                label: item.name,
                value: item.tokens,
                badge:
                  t(
                    `platformTenants.plan${item.plan.charAt(0).toUpperCase()}${item.plan.slice(1)}` as any,
                  ) || item.plan,
                badgeClass: item.plan,
              })),
            )}
          </div>
          <div class="rank-block">
            <h4 class="rank-block-title">${t("platformOverview.userRank")}</h4>
            ${this.renderRankList(
              (this.rank?.users ?? []).map((u) => ({
                label: u.name,
                sub: u.tenantName,
                value: u.tokens,
              })),
            )}
          </div>
        </div>
        <div class="two-col" style="margin-bottom:0">
          <div class="rank-block">
            <h4 class="rank-block-title">${t("platformOverview.modelRank")}</h4>
            ${this.renderRankList(
              (this.rank?.models ?? []).map((m) => ({
                label: m.model,
                sub: `${m.percent}%`,
                value: m.tokens,
              })),
            )}
          </div>
          <div class="rank-block">
            <h4 class="rank-block-title">${t("platformOverview.agentRank")}</h4>
            ${this.renderRankList(
              (this.rank?.agents ?? []).map((a) => ({
                label: a.name,
                sub: a.tenantName,
                value: a.tokens,
              })),
            )}
          </div>
        </div>
      </div>

      <!-- ── 4. LLM 交互概览 ── -->
      ${(() => {
        const llm = this.llmStats;
        return html`
      <div class="section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
          <h3 class="section-title" style="margin:0">${t("platformOverview.llmOverview")}</h3>
          <div class="period-tabs">
            <button class="period-tab ${this.llmPeriod === "all" ? "active" : ""}"
              @click=${() => {
                this.llmPeriod = "all";
              }}>${t("platformOverview.periodAll")}</button>
            <button class="period-tab ${this.llmPeriod === "month" ? "active" : ""}"
              @click=${() => {
                this.llmPeriod = "month";
              }}>${t("platformOverview.periodMonth")}</button>
            <button class="period-tab ${this.llmPeriod === "today" ? "active" : ""}"
              @click=${() => {
                this.llmPeriod = "today";
              }}>${t("platformOverview.periodToday")}</button>
          </div>
        </div>
        <div class="llm-layout">
          <div>
            <div class="llm-stats" style="grid-template-columns:repeat(2,1fr)">
              <div class="llm-stat-card">
                <div class="llm-stat-value">${llm?.turns ?? "-"}</div>
                <div class="llm-stat-label">${t("platformOverview.conversationTurns")}</div>
              </div>
              <div class="llm-stat-card">
                <div class="llm-stat-value">${llm ? parseFloat((llm.avgDurationMs / 1000).toFixed(1)) + "s" : "-"}</div>
                <div class="llm-stat-label">${t("platformOverview.avgResponseTime")}</div>
              </div>
              <div class="llm-stat-card">
                <div class="llm-stat-value error-color">${llm ? parseFloat(llm.errorRate.toFixed(1)) + "%" : "-"}</div>
                <div class="llm-stat-label">${t("platformOverview.errorRate")}</div>
              </div>
              <div class="llm-stat-card">
                <div class="llm-stat-value">${llm?.modelDistribution?.length ?? "-"}</div>
                <div class="llm-stat-label">${t("platformOverview.modelsInUse")}</div>
              </div>
            </div>
          </div>
          <div>
            ${
              (llm?.modelDistribution?.length ?? 0) > 0
                ? html`
                    <div class="llm-pie-container"></div>
                  `
                : html`<div class="llm-pie-container" style="display:grid;place-items:center;color:var(--muted);font-size:0.8rem">${t("platformOverview.noData")}</div>`
            }
          </div>
        </div>
      </div>
      `;
      })()}

      <!-- ── 5. 渠道 + 用户活跃度 ── -->
      <div class="two-col">
        <div class="section">
          <h3 class="section-title">${t("platformOverview.channelDistribution")}</h3>
          ${
            this.channels.length > 0
              ? html`
                  <div class="channel-pie-container"></div>
                `
              : html`<div class="channel-pie-container" style="display:grid;place-items:center;color:var(--muted);font-size:0.8rem">${t("platformOverview.noData")}</div>`
          }
        </div>
        <div class="section">
          <h3 class="section-title">${t("platformOverview.userActivity")}</h3>
          <div class="user-stats-row" style="grid-template-columns:repeat(2,1fr)">
            <div class="user-stat">
              <div class="user-stat-value">${ua?.total ?? "-"}</div>
              <div class="user-stat-label">${t("platformOverview.totalUsers")}</div>
            </div>
            <div class="user-stat">
              <div class="user-stat-value" style="color:var(--ok)">${ua?.active30d ?? "-"}</div>
              <div class="user-stat-label">${t("platformOverview.active30d")}</div>
            </div>
            <div class="user-stat">
              <div class="user-stat-value" style="color:var(--accent)">${ua?.newToday ?? "-"}</div>
              <div class="user-stat-label">${t("platformOverview.newToday")}</div>
            </div>
            <div class="user-stat">
              <div class="user-stat-value" style="color:var(--accent)">${ua?.newThisWeek ?? "-"}</div>
              <div class="user-stat-label">${t("platformOverview.newThisWeek")}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
