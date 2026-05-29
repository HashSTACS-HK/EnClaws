/**
 * Deferred update for Windows npm mode.
 *
 * On Windows, npm cannot rename the package directory while the gateway process
 * holds file locks. This module creates a temporary script that:
 * 1. Waits for the gateway process to exit
 * 2. Runs npm install -g to update the package
 * 3. Restarts the gateway with the same arguments
 *
 * The script is spawned detached so it outlives the parent process.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export interface DeferredUpdateOptions {
  /** npm install spec, e.g. "enclaws@latest" */
  spec: string;
  /** Package manager: npm, pnpm, or bun */
  manager: "npm" | "pnpm" | "bun";
  /** Gateway port to wait for release */
  port: number;
  /** Current process PID to wait for exit */
  pid: number;
  /** Full command to restart gateway */
  restartCommand: string[];
  /** Working directory for restart */
  cwd: string;
}

function buildBatScript(opts: DeferredUpdateOptions): string {
  // In bat scripts, external commands like npm/pnpm must use "call" prefix,
  // otherwise the bat exits immediately after the command finishes.
  const installCmd =
    opts.manager === "pnpm"
      ? `call pnpm add -g ${opts.spec}`
      : opts.manager === "bun"
        ? `call bun add -g ${opts.spec}`
        : `call npm i -g ${opts.spec} --no-fund --no-audit --loglevel=error`;

  const restartCmd = opts.restartCommand.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");

  const logFile = `%~dp0update-deferred.log`;

  return `@echo off
set LOGFILE=${logFile}
set UPDATE_OK=0
echo [%date% %time%] [enclaws-update] Started, waiting for PID ${opts.pid} to exit... > "%LOGFILE%"
:wait_pid
tasklist /FI "PID eq ${opts.pid}" 2>nul | findstr /I "${opts.pid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait_pid
)
echo [%date% %time%] [enclaws-update] Gateway process exited. Running update... >> "%LOGFILE%"
${installCmd} >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] [enclaws-update] First attempt failed, retrying with --omit=optional... >> "%LOGFILE%"
  ${installCmd} --omit=optional >> "%LOGFILE%" 2>&1
  if errorlevel 1 (
    echo [%date% %time%] [enclaws-update] Update failed. >> "%LOGFILE%"
    goto cleanup
  )
)
set UPDATE_OK=1
echo [%date% %time%] [enclaws-update] Update complete. >> "%LOGFILE%"${
    restartCmd
      ? `
cd /d "${opts.cwd}"
echo [%date% %time%] [enclaws-update] Restarting gateway... >> "%LOGFILE%"
start "" ${restartCmd}`
      : ""
  }
echo [%date% %time%] [enclaws-update] Done. >> "%LOGFILE%"
:cleanup
del "%~dp0update-deferred.vbs" 2>nul
if "%UPDATE_OK%"=="1" del "%LOGFILE%" 2>nul
del "%~f0"
`;
}

function buildShScript(opts: DeferredUpdateOptions): string {
  const installCmd =
    opts.manager === "pnpm"
      ? `pnpm add -g ${opts.spec}`
      : opts.manager === "bun"
        ? `bun add -g ${opts.spec}`
        : `npm i -g ${opts.spec} --no-fund --no-audit --loglevel=error`;

  const restartCmd = opts.restartCommand.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");

  return `#!/bin/bash
LOGFILE="$(dirname "$0")/update-deferred.log"
UPDATE_OK=0
echo "[$(date)] [enclaws-update] Started, waiting for PID ${opts.pid} to exit..." > "$LOGFILE"
while kill -0 ${opts.pid} 2>/dev/null; do sleep 1; done
echo "[$(date)] [enclaws-update] Gateway process exited. Running update..." >> "$LOGFILE"
if ${installCmd} >> "$LOGFILE" 2>&1 || ${installCmd} --omit=optional >> "$LOGFILE" 2>&1; then
  UPDATE_OK=1
  echo "[$(date)] [enclaws-update] Update complete." >> "$LOGFILE"${
    restartCmd
      ? `
  cd "${opts.cwd}"
  echo "[$(date)] [enclaws-update] Restarting gateway..." >> "$LOGFILE"
  nohup ${restartCmd} > /dev/null 2>&1 &`
      : ""
  }
  echo "[$(date)] [enclaws-update] Done." >> "$LOGFILE"
else
  echo "[$(date)] [enclaws-update] Update failed." >> "$LOGFILE"
fi
[ "$UPDATE_OK" = "1" ] && rm -f "$LOGFILE"
rm -f "$0"
`;
}

export async function spawnDeferredUpdate(
  opts: DeferredUpdateOptions,
): Promise<{ scriptPath: string }> {
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".bat" : ".sh";
  const script = isWindows ? buildBatScript(opts) : buildShScript(opts);

  const stateDir = resolveStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const scriptPath = path.join(stateDir, `update-deferred${ext}`);
  await fs.writeFile(scriptPath, script, "utf-8");

  if (!isWindows) {
    await fs.chmod(scriptPath, 0o755);
  }

  if (isWindows) {
    // Use a VBS wrapper to run the .bat hidden (cmd.exe ignores windowsHide)
    const vbsPath = path.join(stateDir, "update-deferred.vbs");
    const vbsContent = `Set ws = CreateObject("Wscript.Shell")\nws.Run "cmd /c ""${scriptPath}""", 0, False`;
    await fs.writeFile(vbsPath, vbsContent, "utf-8");
    const child = spawn("wscript.exe", [vbsPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } else {
    const child = spawn("/bin/bash", [scriptPath], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  return { scriptPath };
}
