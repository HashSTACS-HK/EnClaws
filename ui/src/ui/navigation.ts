import {t} from "../i18n/index.ts";
import type {IconName} from "./icons.js";

export const TAB_GROUPS = [
    {
        label: "",
        tabs: ["overview"],
    },
    {
        label: "",
        tabs: ["tenant-overview"],
    },
    {
        label: "workspace",
        tabs: ["tenant-agents", "chat", "sessions"],
    },
    {
        label: "resources",
        tabs: ["tenant-channels", "tenant-models"],
    },
    {
        label: "enterprise",
        tabs: ["tenant-settings", "tenant-knowledge", "tenant-users", "tenant-traces", "tenant-usage", "tenant-cron"],
    },
    {
        label: "cs",
        tabs: ["cs-setup", "cs-knowledge", "cs-sessions"],
    },
    {
        label: "platform",
        tabs: ["platform-tools","platform-models","platform-tenants"],
    },
    {
        label: "system",
        tabs: ["logs"],
    },
] as const;

export type Tab =
    | "agents"
    | "overview"
    | "platform-models"
    | "channels"
    | "instances"
    | "sessions"
    | "usage"
    | "cron"
    | "skills"
    | "nodes"
    | "chat"
    | "config"
    | "debug"
    | "sandbox"
    | "logs"
    | "tenant-settings"
    | "tenant-knowledge"
    | "tenant-users"
    | "tenant-models"
    | "tenant-agents"
    | "tenant-channels"
    | "tenant-skills"
    | "tenant-overview"
    | "tenant-traces"
    | "tenant-usage"
    | "tenant-cron"
    | "platform-tools"
    | "platform-tenants"
    | "cs-setup"
    | "cs-knowledge"
    | "cs-sessions";

const TAB_PATHS: Record<Tab, string> = {
    agents: "/agents",
    overview: "/overview",
    "platform-models": "/platform-models",
    channels: "/channels",
    instances: "/instances",
    sessions: "/sessions",
    usage: "/usage",
    cron: "/cron",
    skills: "/skills",
    nodes: "/nodes",
    chat: "/chat",
    config: "/config",
    debug: "/debug",
    sandbox: "/sandbox",
    logs: "/logs",
    "tenant-overview": "/tenant-overview",
    "tenant-settings": "/tenant-settings",
    "tenant-knowledge": "/tenant-knowledge",
    "tenant-users": "/tenant-users",
    "tenant-models": "/tenant-models",
    "tenant-agents": "/tenant-agents",
    "tenant-channels": "/tenant-channels",
    "tenant-skills": "/tenant-skills",
    "tenant-traces": "/tenant-traces",
    "tenant-usage": "/tenant-usage",
    "tenant-cron": "/tenant-cron",
    "platform-tools": "/platform-tools",
    "platform-tenants": "/platform-tenants",
    "cs-setup": "/cs-setup",
    "cs-knowledge": "/cs-knowledge",
    "cs-sessions": "/cs-sessions",
};

const PATH_TO_TAB = new Map(Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]));

export function normalizeBasePath(basePath: string): string {
    if (!basePath) {
        return "";
    }
    let base = basePath.trim();
    if (!base.startsWith("/")) {
        base = `/${base}`;
    }
    if (base === "/") {
        return "";
    }
    if (base.endsWith("/")) {
        base = base.slice(0, -1);
    }
    return base;
}

export function normalizePath(path: string): string {
    if (!path) {
        return "/";
    }
    let normalized = path.trim();
    if (!normalized.startsWith("/")) {
        normalized = `/${normalized}`;
    }
    if (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
    const base = normalizeBasePath(basePath);
    const path = TAB_PATHS[tab];
    return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
    const base = normalizeBasePath(basePath);
    let path = pathname || "/";
    if (base) {
        if (path === base) {
            path = "/";
        } else if (path.startsWith(`${base}/`)) {
            path = path.slice(base.length);
        }
    }
    let normalized = normalizePath(path).toLowerCase();
    if (normalized.endsWith("/index.html")) {
        normalized = "/";
    }
    if (normalized === "/") {
        return null;
    }
    return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
    let normalized = normalizePath(pathname);
    if (normalized.endsWith("/index.html")) {
        normalized = normalizePath(normalized.slice(0, -"/index.html".length));
    }
    if (normalized === "/" || normalized === "/login") {
        return "";
    }
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) {
        return "";
    }
    for (let i = 0; i < segments.length; i++) {
        const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
        if (PATH_TO_TAB.has(candidate)) {
            const prefix = segments.slice(0, i);
            return prefix.length ? `/${prefix.join("/")}` : "";
        }
    }
    return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
    switch (tab) {
        case "agents":
            return "folder";
        case "chat":
            return "messageSquare";
        case "overview":
            return "barChart";
        case "platform-models":
            return "settings";
        case "channels":
            return "link";
        case "instances":
            return "radio";
        case "sessions":
            return "fileText";
        case "usage":
            return "barChart";
        case "cron":
            return "loader";
        case "skills":
            return "zap";
        case "nodes":
            return "monitor";
        case "config":
            return "settings";
        case "debug":
            return "bug";
        case "sandbox":
            return "puzzle";
        case "logs":
            return "scrollText";
        case "tenant-overview":
            return "barChart";
        case "tenant-settings":
            return "settings";
        case "tenant-knowledge":
            return "fileText";
        case "tenant-users":
            return "folder";
        case "tenant-agents":
            return "folder";
        case "tenant-channels":
            return "link";
        case "tenant-models":
            return "settings";
        case "tenant-skills":
            return "zap";
        case "tenant-traces":
            return "scrollText";
        case "tenant-usage":
            return "barChart";
        case "tenant-cron":
            return "loader";
        case "platform-tools":
            return "zap";
        case "platform-tenants":
            return "folder";
        case "cs-setup":
            return "settings";
        case "cs-knowledge":
            return "zap";
        case "cs-sessions":
            return "messageSquare";
        default:
            return "folder";
    }
}

export function titleForTab(tab: Tab) {
    return t(`tabs.${tab}`);
}

export function subtitleForTab(tab: Tab) {
    return t(`subtitles.${tab}`);
}
