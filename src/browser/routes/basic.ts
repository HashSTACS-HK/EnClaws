import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import {
  listSessionProfiles,
  removeSessionProfile,
  sessionKeyToProfileName,
  setSessionProfile,
} from "../session-profile-map.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

async function withBasicProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (err) {
    jsonError(params.res, 500, String(err));
  }
}

export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // List all profiles with their status
  app.get("/profiles", async (_req, res) => {
    try {
      const service = createBrowserProfilesService(ctx);
      const profiles = await service.listProfiles();
      res.json({ profiles });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Get status (profile-aware)
  app.get("/", async (req, res) => {
    let current: ReturnType<typeof ctx.state>;
    try {
      current = ctx.state();
    } catch {
      return jsonError(res, 503, "browser server not started");
    }

    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    const [cdpHttp, cdpReady] = await Promise.all([
      profileCtx.isHttpReachable(300),
      profileCtx.isReachable(600),
    ]);

    const profileState = current.profiles.get(profileCtx.profile.name);
    let detectedBrowser: string | null = null;
    let detectedExecutablePath: string | null = null;
    let detectError: string | null = null;

    try {
      const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
      if (detected) {
        detectedBrowser = detected.kind;
        detectedExecutablePath = detected.path;
      }
    } catch (err) {
      detectError = String(err);
    }

    res.json({
      enabled: current.resolved.enabled,
      profile: profileCtx.profile.name,
      running: cdpReady,
      cdpReady,
      cdpHttp,
      pid: profileState?.running?.pid ?? null,
      cdpPort: profileCtx.profile.cdpPort,
      cdpUrl: profileCtx.profile.cdpUrl,
      chosenBrowser: profileState?.running?.exe.kind ?? null,
      detectedBrowser,
      detectedExecutablePath,
      detectError,
      userDataDir: profileState?.running?.userDataDir ?? null,
      color: profileCtx.profile.color,
      headless: current.resolved.headless,
      noSandbox: current.resolved.noSandbox,
      executablePath: current.resolved.executablePath ?? null,
      attachOnly: current.resolved.attachOnly,
    });
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        await profileCtx.ensureBrowserAvailable();
        res.json({ ok: true, profile: profileCtx.profile.name });
      },
    });
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        const result = await profileCtx.stopRunningBrowser();
        res.json({
          ok: true,
          stopped: result.stopped,
          profile: profileCtx.profile.name,
        });
      },
    });
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        const result = await profileCtx.resetProfile();
        res.json({ ok: true, profile: profileCtx.profile.name, ...result });
      },
    });
  });

  // Create a new profile
  app.post("/profiles/create", async (req, res) => {
    const name = toStringOrEmpty((req.body as { name?: unknown })?.name);
    const color = toStringOrEmpty((req.body as { color?: unknown })?.color);
    const cdpUrl = toStringOrEmpty((req.body as { cdpUrl?: unknown })?.cdpUrl);
    const driver = toStringOrEmpty((req.body as { driver?: unknown })?.driver) as
      | "enclaws"
      | "extension"
      | "";

    if (!name) {
      return jsonError(res, 400, "name is required");
    }

    try {
      const service = createBrowserProfilesService(ctx);
      const result = await service.createProfile({
        name,
        color: color || undefined,
        cdpUrl: cdpUrl || undefined,
        driver: driver === "extension" ? "extension" : undefined,
      });
      res.json(result);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("already exists")) {
        return jsonError(res, 409, msg);
      }
      if (msg.includes("invalid profile name")) {
        return jsonError(res, 400, msg);
      }
      if (msg.includes("no available CDP ports")) {
        return jsonError(res, 507, msg);
      }
      if (msg.includes("cdpUrl")) {
        return jsonError(res, 400, msg);
      }
      jsonError(res, 500, msg);
    }
  });

  // Delete a profile
  app.delete("/profiles/:name", async (req, res) => {
    const name = toStringOrEmpty(req.params.name);
    if (!name) {
      return jsonError(res, 400, "profile name is required");
    }

    try {
      const service = createBrowserProfilesService(ctx);
      const result = await service.deleteProfile(name);
      res.json(result);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("invalid profile name")) {
        return jsonError(res, 400, msg);
      }
      if (msg.includes("default profile")) {
        return jsonError(res, 400, msg);
      }
      if (msg.includes("not found")) {
        return jsonError(res, 404, msg);
      }
      jsonError(res, 500, msg);
    }
  });

  // ─── Session → Profile Persistence API ───────────────────────────────────────
  // Enables agents to maintain login state across runs for Feishu, Douyin, etc.
  // Workflow:
  //   1. Agent calls browser with ?sessionName=feishu-task
  //   2. First run: use default profile, agent logs in manually or via browser automation
  //   3. Agent calls POST /profiles/session-bind to persist the mapping
  //   4. Subsequent runs: browser ?sessionName=feishu-task auto-uses the bound profile

  // GET /profiles/session-map — list all session → profile bindings
  app.get("/profiles/session-map", (_req, res) => {
    try {
      const map = listSessionProfiles();
      res.json({ ok: true, bindings: map });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // POST /profiles/session-bind — bind a session key to a profile name
  // Body: { sessionName: string, profile?: string }
  // If profile is omitted, auto-generates a profile name from the session key.
  app.post("/profiles/session-bind", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionName = toStringOrEmpty(body.sessionName);
    if (!sessionName) {
      return jsonError(res, 400, "sessionName is required");
    }

    // Resolve the profile to bind to (explicit or auto-derived)
    const explicitProfile = toStringOrEmpty(body.profile);
    const profileName = explicitProfile || sessionKeyToProfileName(sessionName);

    // Verify the profile exists (or offer to create it)
    const autoCreate = body.autoCreate === true;
    const state = ctx.state();
    const profileExists = profileName in state.resolved.profiles;

    if (!profileExists) {
      if (!autoCreate) {
        return jsonError(
          res,
          404,
          [
            `Profile "${profileName}" does not exist.`,
            `Set autoCreate:true to automatically create it, or create it first with POST /profiles/create.`,
          ].join("\n"),
        );
      }
      // Auto-create the profile so the agent can start using it immediately
      try {
        const service = createBrowserProfilesService(ctx);
        await service.createProfile({ name: profileName });
      } catch (err) {
        const msg = String(err);
        if (!msg.includes("already exists")) {
          return jsonError(res, 500, `Failed to auto-create profile: ${msg}`);
        }
      }
    }

    await setSessionProfile(sessionName, profileName);
    res.json({
      ok: true,
      sessionName,
      profile: profileName,
      autoCreated: !profileExists && autoCreate,
    });
  });

  // DELETE /profiles/session-bind — remove a session → profile binding
  app.delete("/profiles/session-bind", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionName = toStringOrEmpty(body.sessionName);
    if (!sessionName) {
      return jsonError(res, 400, "sessionName is required");
    }
    await removeSessionProfile(sessionName);
    res.json({ ok: true, sessionName });
  });
}
