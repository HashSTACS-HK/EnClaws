/**
 * Minimal User-Agent parser (Phase 3 sessions UI).
 *
 * We don't need the full depth of `ua-parser-js` — only enough to label
 * a device in the sessions list: "Chrome on macOS", "Safari on iPhone",
 * "Unknown client".  Avoiding the dependency keeps the backend bundle
 * small and deterministic.
 *
 * Output is deliberately fuzzy and falls through to "Unknown" on any
 * shape we don't recognize.  Tests should not assert on exact strings.
 */

export interface ParsedUserAgent {
  browser: string;
  os: string;
  label: string; // e.g. "Chrome on macOS"
}

const UNKNOWN: ParsedUserAgent = { browser: "Unknown", os: "Unknown", label: "Unknown device" };

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua || typeof ua !== "string") {
    return UNKNOWN;
  }
  const s = ua;

  // ---- Browser ----
  let browser = "Unknown";
  // Order matters: check more specific strings first (Edge before Chrome, etc.)
  if (/Edg\//i.test(s)) {
    browser = "Edge";
  } else if (/OPR\/|Opera/i.test(s)) {
    browser = "Opera";
  } else if (/Firefox\//i.test(s)) {
    browser = "Firefox";
  } else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) {
    browser = "Chrome";
  } else if (/Chromium\//i.test(s)) {
    browser = "Chromium";
  } else if (/Safari\//i.test(s) && /Version\//i.test(s)) {
    browser = "Safari";
  } else if (/curl\//i.test(s)) {
    browser = "curl";
  } else if (/PostmanRuntime/i.test(s)) {
    browser = "Postman";
  } else if (/node-fetch|axios|got\//i.test(s)) {
    browser = "HTTP client";
  }

  // ---- OS ----
  let os = "Unknown";
  if (/Windows NT/i.test(s)) {
    os = "Windows";
  } else if (/Android/i.test(s)) {
    os = "Android";
  } else if (/iPhone|iPad|iPod/i.test(s)) {
    os = "iOS";
  } else if (/Mac OS X|Macintosh/i.test(s)) {
    os = "macOS";
  } else if (/Linux/i.test(s)) {
    os = "Linux";
  } else if (/CrOS/i.test(s)) {
    os = "ChromeOS";
  }

  const label =
    browser === "Unknown" && os === "Unknown"
      ? s.length > 40
        ? s.slice(0, 40) + "…"
        : s
      : `${browser} on ${os}`;

  return { browser, os, label };
}
