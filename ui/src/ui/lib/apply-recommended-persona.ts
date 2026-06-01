/**
 * Shared helper: apply the recommended CS persona to a selected agent.
 *
 * Extracted from tenant-agents.ts (P5-T5) so that cs-api-mode and
 * cs-widget-management can reuse the same confirm-dialog + RPC logic.
 *
 * 从 tenant-agents.ts 提取的共享逻辑，避免在 cs-api-mode / cs-widget-management
 * 中重复实现相同的确认弹窗 + RPC 调用。
 */

import { showConfirm } from "../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal RPC caller interface — accepts method + params, returns a promise. */
export type RpcFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Result from applyRecommendedPersona. */
export interface ApplyResult {
  ok: boolean;
  /** Error message (present when ok = false). */
  error?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Show a confirm dialog then write IDENTITY / SOUL / AGENTS for the given agent.
 *
 * Returns { ok: true } on success, { ok: false, error } when the user cancels
 * or the RPC throws.  Never swallows errors silently.
 *
 * 弹出确认框后，通过 RPC 将推荐配置写入选定 agent 的三个人设文件。
 * 用户取消返回 { ok: false }（无 error）；RPC 失败返回 { ok: false, error }。
 */
export async function applyRecommendedPersona(
  agentId: string,
  rpc: RpcFn,
): Promise<ApplyResult> {
  const confirmed = await showConfirm({
    title: t("agents.persona.recommended.confirmTitle"),
    message: t("agents.persona.recommended.confirmMessage"),
    confirmText: t("agents.persona.recommended.confirmBtn"),
    danger: true,
  });

  if (!confirmed) {
    return { ok: false };
  }

  try {
    const p = (await rpc("tenant.cs.recommended-persona.get", {})) as {
      identity: string;
      soul: string;
      agents: string;
    };

    const writes: Array<[string, string]> = [
      ["IDENTITY.md", p.identity],
      ["SOUL.md", p.soul],
      ["AGENTS.md", p.agents],
    ];

    for (const [name, content] of writes) {
      await rpc("agents.files.set", { agentId, name, content });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
