/**
 * Default frame-ancestors when AGENORA_FRAME_ANCESTORS env var is unset.
 * Used by upstream apps (e.g. jiumi-demo) to iframe-embed agenora control UI.
 * 默认 frame-ancestors（环境变量未设时使用），允许 jiumi 等上层应用 iframe 嵌入。
 */
const DEFAULT_FRAME_ANCESTORS = [
  "'self'",
  "https://jiumi-demo.enclaws.com",
  "http://localhost:5001",
];

function resolveFrameAncestors(): string {
  const fromEnv = process.env.AGENORA_FRAME_ANCESTORS?.trim();
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ");
  }
  return DEFAULT_FRAME_ANCESTORS.join(" ");
}

export function buildControlUiCspHeader(): string {
  // Control UI: block inline scripts, keep styles permissive
  // (UI uses a lot of inline style attributes in templates).
  // Keep Google Fonts origins explicit in CSP for deployments that load
  // external Google Fonts stylesheets/font files.
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${resolveFrameAncestors()}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
  ].join("; ");
}
