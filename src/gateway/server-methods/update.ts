import { resolveGatewayPort } from "../../config/paths.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageName } from "../../infra/package-json.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { trackToNpmTag } from "../../infra/update-channels.js";
import { checkUpdateStatus, type InstallKind } from "../../infra/update-check.js";
import { spawnDeferredUpdate } from "../../infra/update-deferred.js";
import {
  detectGlobalInstallManagerForRoot,
  type GlobalInstallManager,
} from "../../infra/update-global.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { getStoredUpdateTrack } from "../../infra/update-settings.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateUpdateRunParams } from "../protocol/index.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const updateHandlers: GatewayRequestHandlers = {
  "update.run": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
    const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let storedTrack: string | null | undefined;
    const root =
      (await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      })) ?? process.cwd();
    storedTrack = await getStoredUpdateTrack();

    // Detect install kind to decide update strategy
    const status = await checkUpdateStatus({
      root,
      timeoutMs: 2500,
      fetchGit: false,
      includeRegistry: false,
    });
    const installKind: InstallKind = status.installKind;

    // Windows package mode: use deferred update to avoid EBUSY
    if (
      process.platform === "win32" &&
      (installKind === "package" || installKind === "installer")
    ) {
      const globalManager = await detectGlobalInstallManagerForRoot(
        (argv, opts) =>
          runCommandWithTimeout(argv, { timeoutMs: opts?.timeoutMs ?? 5000, cwd: opts?.cwd }),
        root,
        5000,
      );
      if (globalManager) {
        const packageName = (await readPackageName(root)) ?? "enclaws";
        const track = storedTrack ?? "stable";
        const tag = trackToNpmTag(track as "stable" | "beta" | "dev");
        const spec = `${packageName}@${tag}`;
        const port = resolveGatewayPort(undefined, process.env);

        await spawnDeferredUpdate({
          spec,
          manager: globalManager as "npm" | "pnpm" | "bun",
          port,
          pid: process.pid,
          restartCommand: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
          cwd: process.cwd(),
        });

        // Respond first, then exit after a short delay so the response is sent
        respond(
          true,
          {
            ok: true,
            result: { status: "ok", mode: "deferred", reason: "windows-deferred-update" },
            restart: null,
          },
          undefined,
        );

        // Exit the process so file locks are released and the deferred script can run npm install.
        // The deferred script will restart the gateway after npm install completes.
        setTimeout(() => {
          context?.logGateway?.info("update.run (deferred): exiting process for npm install");
          process.exit(0);
        }, 2000);
        return;
      }
    }

    // Standard update path (git mode, or non-Windows package mode)
    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      result = await runGatewayUpdate({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
        track: storedTrack ?? undefined,
      });
    } catch (err) {
      result = {
        status: "error",
        mode: "unknown",
        reason: String(err),
        steps: [],
        durationMs: 0,
      };
    }

    const payload: RestartSentinelPayload = {
      kind: "update",
      status: result.status,
      ts: Date.now(),
      sessionKey,
      deliveryContext,
      threadId,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: result.mode,
        root: result.root ?? undefined,
        before: result.before ?? null,
        after: result.after ?? null,
        steps: result.steps.map((step) => ({
          name: step.name,
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            stdoutTail: step.stdoutTail ?? null,
            stderrTail: step.stderrTail ?? null,
            exitCode: step.exitCode ?? null,
          },
        })),
        reason: result.reason ?? null,
        durationMs: result.durationMs,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Restart gateway after successful update (skip for git mode — user restarts manually)
    const restart =
      result.status === "ok" && result.mode !== "git"
        ? scheduleGatewaySigusr1Restart({
            delayMs: restartDelayMs,
            reason: "update.run",
            audit: {
              actor: actor.actor,
              deviceId: actor.deviceId,
              clientIp: actor.clientIp,
              changedPaths: [],
            },
          })
        : null;
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );

    respond(
      true,
      {
        ok: result.status !== "error",
        result,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
