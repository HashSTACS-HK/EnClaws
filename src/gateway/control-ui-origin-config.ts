import { createConfigIO } from "../config/config.js";
import type { GatewayControlUiConfig } from "../config/types.gateway.js";

export function resolveControlUiOriginConfig(
  runtimeControlUi?: GatewayControlUiConfig,
  readFileControlUi: () => GatewayControlUiConfig | undefined = () =>
    createConfigIO().loadConfig().gateway?.controlUi,
): GatewayControlUiConfig | undefined {
  const runtimeOrigins = runtimeControlUi?.allowedOrigins?.filter((origin) => origin.trim()) ?? [];
  if (runtimeOrigins.length > 0) {
    return runtimeControlUi;
  }
  try {
    const fileControlUi = readFileControlUi();
    const fileOrigins = fileControlUi?.allowedOrigins?.filter((origin) => origin.trim()) ?? [];
    if (fileOrigins.length > 0) {
      return { ...runtimeControlUi, ...fileControlUi, allowedOrigins: fileOrigins };
    }
  } catch {
    // Keep the existing runtime behavior if the config file cannot be read.
  }
  return runtimeControlUi;
}
