import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  iconForTab,
  inferBasePathFromPathname,
  isEmbedMode,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from TAB_GROUPS */
const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs) as Tab[];

describe("iconForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const icon = iconForTab(tab);
      expect(icon).toBeTruthy();
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    }
  });

  it("returns stable icons for known tabs", () => {
    expect(iconForTab("chat")).toBe("messageSquare");
    expect(iconForTab("overview")).toBe("barChart");
    expect(iconForTab("channels")).toBe("link");
    expect(iconForTab("instances")).toBe("radio");
    expect(iconForTab("sessions")).toBe("fileText");
    expect(iconForTab("cron")).toBe("loader");
    expect(iconForTab("skills")).toBe("zap");
    expect(iconForTab("nodes")).toBe("monitor");
    expect(iconForTab("config")).toBe("settings");
    expect(iconForTab("debug")).toBe("bug");
    expect(iconForTab("logs")).toBe("scrollText");
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const title = titleForTab(tab);
      expect(title).toBeTruthy();
      expect(typeof title).toBe("string");
    }
  });

  it("returns expected titles", () => {
    expect(titleForTab("chat")).toBe("Chat");
    expect(titleForTab("overview")).toBe("Overview");
    expect(titleForTab("cron")).toBe("Cron Jobs");
  });
});

describe("subtitleForTab", () => {
  it("returns a string for every tab", () => {
    for (const tab of ALL_TABS) {
      const subtitle = subtitleForTab(tab);
      expect(typeof subtitle).toBe("string");
    }
  });

  it("returns descriptive subtitles", () => {
    expect(subtitleForTab("chat")).toContain("chat session");
    expect(subtitleForTab("config")).toContain("enclaws.json");
  });
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("adds leading slash if missing", () => {
    expect(normalizeBasePath("ui")).toBe("/ui");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/enclaws")).toBe("/apps/enclaws");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("adds leading slash if missing", () => {
    expect(normalizePath("chat")).toBe("/chat");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("overview")).toBe("/overview");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/enclaws")).toBe("/apps/enclaws/sessions");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/platform-overview")).toBe("overview");
    expect(tabFromPath("/sessions")).toBe("sessions");
  });

  it("returns chat for root path", () => {
    expect(tabFromPath("/")).toBe("chat");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/enclaws/sessions", "/apps/enclaws")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/enclaws/sessions")).toBe("/apps/enclaws");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups", () => {
    const labels = TAB_GROUPS.map((g) => g.label);
    expect(labels).toContain("workbench");
    expect(labels).toContain("config");
    expect(labels).toContain("workspace-group");
    expect(labels).toContain("platform");
    expect(labels).toContain("system");
  });

  it("workbench group contains expected tabs", () => {
    const workbench = TAB_GROUPS.find((g) => g.label === "workbench");
    expect(workbench).toBeDefined();
    expect(workbench!.tabs).toContain("chat");
    expect(workbench!.tabs).toContain("cs-sessions");
    expect(workbench!.tabs).toContain("scheduler-placeholder");
    expect(workbench!.tabs).toContain("tenant-audit");
  });

  it("config group contains expected tabs", () => {
    const config = TAB_GROUPS.find((g) => g.label === "config");
    expect(config).toBeDefined();
    expect(config!.tabs).toContain("tenant-agents");
    expect(config!.tabs).toContain("tenant-knowledge");
    expect(config!.tabs).toContain("cs-api-management");
    expect(config!.tabs).toContain("cs-widget-management");
    expect(config!.tabs).toContain("tenant-workshop");
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });
});

describe("isEmbedMode", () => {
  it("returns true when ?embed=1 is present", () => {
    expect(isEmbedMode(new URL("https://example.com/tenant-overview?embed=1"))).toBe(true);
  });

  it("returns true when ?embed=1 is combined with other params", () => {
    expect(isEmbedMode(new URL("https://example.com/chat?session=abc&embed=1"))).toBe(true);
  });

  it("returns false when embed param is absent", () => {
    expect(isEmbedMode(new URL("https://example.com/tenant-overview"))).toBe(false);
  });

  it("returns false when embed param is not '1'", () => {
    expect(isEmbedMode(new URL("https://example.com/?embed=true"))).toBe(false);
    expect(isEmbedMode(new URL("https://example.com/?embed=0"))).toBe(false);
    expect(isEmbedMode(new URL("https://example.com/?embed="))).toBe(false);
  });

  it("returns false when url argument is undefined and window is not defined", () => {
    // In a Node/Vitest environment window is undefined — expect graceful false
    expect(isEmbedMode(undefined)).toBe(false);
  });
});

/**
 * ST-D2: embed mode round-trip through the login auth gate.
 *
 * Contract:
 *  1. Pre-login redirect encodes original path as ?redirect=<path> so it is
 *     not lost when the URL is rewritten to /login.
 *  2. Post-login, tabFromPath() resolves the redirect param back to a Tab
 *     so the app restores the original page WITH ?embed=1 still present.
 *  3. isEmbedMode() reads ?embed=1 from the live URL, so it returns true
 *     on the restored post-login URL.
 */
describe("embed mode login round-trip (ST-D2)", () => {
  it("pre-login URL preserves embed param when redirect path is encoded", () => {
    // Simulates: user at /tenant-agents?embed=1 redirected to /login?embed=1&redirect=%2Ftenant-agents
    const loginUrl = new URL("https://example.com/login?embed=1&redirect=%2Ftenant-agents");
    expect(isEmbedMode(loginUrl)).toBe(true);
    expect(loginUrl.searchParams.get("redirect")).toBe("/tenant-agents");
  });

  it("redirect param resolves to a known tab via tabFromPath", () => {
    // Post-login handler reads redirect param and validates it with tabFromPath
    const redirectPath = "/tenant-agents";
    expect(tabFromPath(redirectPath)).toBe("tenant-agents");
  });

  it("redirect param for unknown path resolves to null (open-redirect guard)", () => {
    expect(tabFromPath("/unknown-page")).toBeNull();
    expect(tabFromPath("https://evil.com/steal")).toBeNull();
  });

  it("post-login URL with embed param activates embed mode", () => {
    // After setTab("tenant-agents"), syncUrlWithTab builds /tenant-agents?embed=1
    // because window.location.search still carries ?embed=1 at that point.
    const postLoginUrl = new URL("https://example.com/tenant-agents?embed=1");
    expect(isEmbedMode(postLoginUrl)).toBe(true);
    expect(tabFromPath(postLoginUrl.pathname)).toBe("tenant-agents");
  });

  it("embed=1 survives alongside the redirect param in the login URL", () => {
    // Ensures URLSearchParams round-trip does not drop embed or redirect
    const params = new URLSearchParams("embed=1");
    params.set("redirect", "/tenant-agents");
    const loginUrl = new URL(`https://example.com/login?${params.toString()}`);
    expect(loginUrl.searchParams.get("embed")).toBe("1");
    expect(loginUrl.searchParams.get("redirect")).toBe("/tenant-agents");
    expect(isEmbedMode(loginUrl)).toBe(true);
  });
});
