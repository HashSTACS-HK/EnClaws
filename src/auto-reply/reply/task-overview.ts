/**
 * Aggregates per-agent task overview from diagnostic session states
 * and followup queues.  Pure read-only — does not mutate any state.
 */

import { getActiveDiagnosticSessions } from "../../logging/diagnostic-session-state.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getAllFollowupQueues } from "./queue/state.js";

export type TaskInfo = {
  sessionKey: string;
  state: "processing" | "queued";
  /** 1-based position in queue (only for queued items). */
  queuePosition?: number;
  enqueuedAt?: number;
  lastActivity?: number;
  /** First 80 chars of the queued prompt. */
  contentPreview?: string;
  queueMode?: string;
};

export type AgentTaskOverview = {
  agentId: string;
  processing: TaskInfo[];
  queued: TaskInfo[];
  stats: { total: number; processing: number; queued: number };
};

/**
 * Build a task overview grouped by agent.
 * Optionally filter to a single agent via `filterAgentId`.
 */
export function getAgentTaskOverview(filterAgentId?: string): AgentTaskOverview[] {
  const agentMap = new Map<string, { processing: TaskInfo[]; queued: TaskInfo[] }>();

  const ensure = (agentId: string) => {
    let entry = agentMap.get(agentId);
    if (!entry) {
      entry = { processing: [], queued: [] };
      agentMap.set(agentId, entry);
    }
    return entry;
  };

  // 1. Collect processing sessions from diagnostic state
  const sessions = getActiveDiagnosticSessions();
  for (const [, state] of sessions) {
    if (state.state !== "processing") {
      continue;
    }
    const key = state.sessionKey ?? state.sessionId;
    if (!key) {
      continue;
    }
    const agentId = parseAgentSessionKey(key)?.agentId ?? "main";
    if (filterAgentId && agentId !== filterAgentId) {
      continue;
    }
    ensure(agentId).processing.push({
      sessionKey: key,
      state: "processing",
      lastActivity: state.lastActivity,
    });
  }

  // 2. Collect queued items from followup queues
  const queues = getAllFollowupQueues();
  for (const [queueKey, qState] of queues) {
    if (qState.items.length === 0) {
      continue;
    }
    // Derive agentId from the queue key or first item's run.agentId
    const firstRun = qState.items[0]?.run;
    const agentId =
      parseAgentSessionKey(queueKey)?.agentId ?? firstRun?.agentId ?? "main";
    if (filterAgentId && agentId !== filterAgentId) {
      continue;
    }
    const bucket = ensure(agentId);
    for (let i = 0; i < qState.items.length; i++) {
      const item = qState.items[i];
      bucket.queued.push({
        sessionKey: item.run.sessionKey ?? queueKey,
        state: "queued",
        queuePosition: i + 1,
        enqueuedAt: item.enqueuedAt,
        contentPreview: item.prompt?.slice(0, 80) || undefined,
        queueMode: qState.mode,
      });
    }
  }

  // 3. Build result array sorted by agent ID
  const result: AgentTaskOverview[] = [];
  for (const [agentId, data] of [...agentMap.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    result.push({
      agentId,
      processing: data.processing,
      queued: data.queued,
      stats: {
        total: data.processing.length + data.queued.length,
        processing: data.processing.length,
        queued: data.queued.length,
      },
    });
  }
  return result;
}

/** Format task overview as a human-readable text block. */
export function formatTaskOverview(overviews: AgentTaskOverview[]): string {
  if (overviews.length === 0) {
    return "No active or queued tasks.";
  }
  const lines: string[] = ["📋 Task Overview", ""];
  for (const agent of overviews) {
    lines.push(
      `🤖 Agent: ${agent.agentId}  (${agent.stats.processing} processing, ${agent.stats.queued} queued)`,
    );
    if (agent.processing.length > 0) {
      lines.push("  Processing:");
      for (const t of agent.processing) {
        const age = t.lastActivity
          ? `${Math.round((Date.now() - t.lastActivity) / 1000)}s ago`
          : "";
        lines.push(`    ▶ ${t.sessionKey}${age ? `  (active ${age})` : ""}`);
      }
    }
    if (agent.queued.length > 0) {
      lines.push("  Queued:");
      for (const t of agent.queued) {
        const preview = t.contentPreview ? `  "${t.contentPreview}"` : "";
        lines.push(`    ${t.queuePosition}. ${t.sessionKey}${preview}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
