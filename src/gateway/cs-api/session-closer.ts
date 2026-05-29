/**
 * CS-API session auto-closer cron (v1.2 §F state machine, Task 7).
 *
 * Scans cs-api sessions whose latest customer message is older than
 * IDLE_THRESHOLD_MS and transitions them to `closed`. Runs every
 * SCAN_INTERVAL_MS while the gateway is up.
 *
 * Scope (Option B mapping at boundary):
 *   - Only cs-api sessions (rows with `app_object_id IS NOT NULL`).
 *   - S1 widget sessions are excluded.
 *   - Sessions already in `closed` are excluded by the helper query.
 *
 * cs-api 会话自动关闭 cron：超 IDLE_THRESHOLD_MS 无客户消息的活跃 cs-api 会话
 * 自动设为 closed。每 SCAN_INTERVAL_MS 扫描一次。S1 widget 不受影响。
 */

import { findInactiveCsApiSessions, setSessionState } from "../../db/models/cs-session.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("cs-api-session-closer");

/** Inactivity threshold: 300s without a customer message. */
export const IDLE_THRESHOLD_MS = 300_000;
/** Scan interval: every 60s. */
export const SCAN_INTERVAL_MS = 60_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let scanInFlight = false;

/**
 * Internal scan routine — finds stale sessions and closes them.
 * Exported for tests; production code should rely on the cron tick.
 *
 * 单次扫描：找出超时会话并置为 closed。导出仅供测试使用。
 */
export async function runSessionCloserScan(): Promise<void> {
  if (scanInFlight) {
    return;
  }
  scanInFlight = true;
  try {
    const stale = await findInactiveCsApiSessions(IDLE_THRESHOLD_MS);
    for (const s of stale) {
      try {
        await setSessionState({
          tenantId: s.tenantId,
          sessionId: s.id,
          state: "closed",
          activeResponder: null,
        });
      } catch (err) {
        log.warn(`failed to close session ${s.id} (tenant ${s.tenantId}): ${String(err)}`);
      }
    }
  } catch (err) {
    log.error(`scan failed: ${String(err)}`);
  } finally {
    scanInFlight = false;
  }
}

/**
 * Start the auto-close cron. Idempotent — second call is a no-op.
 *
 * 启动自动关闭 cron，重复调用为空操作。
 */
export function startSessionCloser(): void {
  if (intervalHandle) {
    return;
  }
  intervalHandle = setInterval(() => {
    void runSessionCloserScan();
  }, SCAN_INTERVAL_MS);
  // Don't block process exit waiting for the cron.
  // 不让 cron 阻塞进程退出。
  if (typeof intervalHandle === "object" && "unref" in intervalHandle) {
    intervalHandle.unref();
  }
  log.info?.(
    `started (idle threshold: ${Math.round(IDLE_THRESHOLD_MS / 1000)}s, scan interval: ${Math.round(SCAN_INTERVAL_MS / 1000)}s)`,
  );
}

/**
 * Stop the auto-close cron. Idempotent.
 *
 * 停止 cron，重复调用为空操作。
 */
export function stopSessionCloser(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
