import * as os from "node:os";
import * as path from "node:path";

/** 解析 openclaw 状态目录 */
export function resolveStateDir(): string {
  const stateOverride =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) return stateOverride;
  return path.join(os.homedir(), ".openclaw");
}
