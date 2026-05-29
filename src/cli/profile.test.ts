import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "enclaws",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "enclaws", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "enclaws", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "enclaws", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "enclaws", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "enclaws", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "enclaws", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "enclaws", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "enclaws", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".enclaws-dev");
    expect(env.ENCLAWS_PROFILE).toBe("dev");
    expect(env.ENCLAWS_STATE_DIR).toBe(expectedStateDir);
    expect(env.ENCLAWS_CONFIG_PATH).toBe(path.join(expectedStateDir, "enclaws.json"));
    expect(env.ENCLAWS_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      ENCLAWS_STATE_DIR: "/custom",
      ENCLAWS_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.ENCLAWS_STATE_DIR).toBe("/custom");
    expect(env.ENCLAWS_GATEWAY_PORT).toBe("19099");
    expect(env.ENCLAWS_CONFIG_PATH).toBe(path.join("/custom", "enclaws.json"));
  });

  it("uses ENCLAWS_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      ENCLAWS_HOME: "/srv/enclaws-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/enclaws-home");
    expect(env.ENCLAWS_STATE_DIR).toBe(path.join(resolvedHome, ".enclaws-work"));
    expect(env.ENCLAWS_CONFIG_PATH).toBe(path.join(resolvedHome, ".enclaws-work", "enclaws.json"));
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "enclaws doctor --fix",
      env: {},
      expected: "enclaws doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "enclaws doctor --fix",
      env: { ENCLAWS_PROFILE: "default" },
      expected: "enclaws doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "enclaws doctor --fix",
      env: { ENCLAWS_PROFILE: "Default" },
      expected: "enclaws doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "enclaws doctor --fix",
      env: { ENCLAWS_PROFILE: "bad profile" },
      expected: "enclaws doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "enclaws --profile work doctor --fix",
      env: { ENCLAWS_PROFILE: "work" },
      expected: "enclaws --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "enclaws --dev doctor",
      env: { ENCLAWS_PROFILE: "dev" },
      expected: "enclaws --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("enclaws doctor --fix", { ENCLAWS_PROFILE: "work" })).toBe(
      "enclaws --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("enclaws doctor --fix", { ENCLAWS_PROFILE: "  jbenclaws  " })).toBe(
      "enclaws --profile jbenclaws doctor --fix",
    );
  });

  it("handles command with no args after enclaws", () => {
    expect(formatCliCommand("enclaws", { ENCLAWS_PROFILE: "test" })).toBe("enclaws --profile test");
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm enclaws doctor", { ENCLAWS_PROFILE: "work" })).toBe(
      "pnpm enclaws --profile work doctor",
    );
  });
});
