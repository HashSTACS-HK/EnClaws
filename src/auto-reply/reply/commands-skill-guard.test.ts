import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleInstallSkillCommand } from "./commands-install-skill.js";
import { handleSkillInstallGuard, handleSkillMutateGuard } from "./commands-skill-guard.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const cfg = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
} as OpenClawConfig;

function paramsFor(body: string, tenantRole?: string, isAuthorized = true) {
  const base = buildCommandTestParams(body, cfg, { TenantUserRole: tenantRole });
  return {
    ...base,
    command: {
      ...base.command,
      isAuthorizedSender: isAuthorized,
      senderId: "tester",
    },
  };
}

describe("handleInstallSkillCommand role check (Fix 2)", () => {
  it("blocks /install-skill for member role", async () => {
    const result = await handleInstallSkillCommand(
      paramsFor("/install-skill feishu", "member"),
      true,
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "权限不足：仅管理员可安装技能" },
    });
  });

  it("blocks /install-skill for viewer role", async () => {
    const result = await handleInstallSkillCommand(
      paramsFor("/install-skill feishu", "viewer"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("权限不足");
  });

  it("rejects unauthorized senders regardless of role", async () => {
    const result = await handleInstallSkillCommand(
      paramsFor("/install-skill feishu", "owner", false),
      true,
    );
    expect(result).toEqual({ shouldContinue: false });
  });

  it("ignores non-install-skill commands", async () => {
    const result = await handleInstallSkillCommand(paramsFor("/help", "member"), true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are disabled", async () => {
    const result = await handleInstallSkillCommand(
      paramsFor("/install-skill feishu", "member"),
      false,
    );
    expect(result).toBeNull();
  });

  it("lets owner through role gate (falls through to usage message on empty arg)", async () => {
    // With no skill name after /install-skill, the handler returns a usage reply;
    // reaching that path proves the role check allowed the command through.
    const result = await handleInstallSkillCommand(paramsFor("/install-skill", "owner"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("/install-skill");
    expect(result?.reply?.text).not.toContain("权限不足");
  });
});

describe("handleSkillInstallGuard (Fix 3)", () => {
  describe("role gating", () => {
    it("returns null when tenantRole is absent (single-user / CLI)", async () => {
      const result = await handleSkillInstallGuard(
        paramsFor("帮我安装飞书技能包", undefined),
        true,
      );
      expect(result).toBeNull();
    });

    it("returns null for owner", async () => {
      const result = await handleSkillInstallGuard(paramsFor("帮我安装飞书技能包", "owner"), true);
      expect(result).toBeNull();
    });

    it("returns null for admin", async () => {
      const result = await handleSkillInstallGuard(
        paramsFor("install the feishu skill", "admin"),
        true,
      );
      expect(result).toBeNull();
    });

    it("ignores slash commands (delegates to dedicated handler)", async () => {
      const result = await handleSkillInstallGuard(
        paramsFor("/install-skill feishu-chat install", "member"),
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe("intent detection (member role)", () => {
    const blocked = [
      "帮我安装飞书技能",
      "给我装一下飞书技能包",
      "装上 feishu-chat 这个 skill",
      "部署这个技能到系统",
      "install the feishu skill",
      "please deploy feishu skill pack",
      "add this skill from github",
      "从 https://github.com/foo/bar 仓库安装飞书技能包",
      "可以从 gitee 仓库部署一下这个技能吗",
      "git clone 这个仓库然后装成技能",
    ];

    for (const input of blocked) {
      it(`blocks: ${input}`, async () => {
        const result = await handleSkillInstallGuard(paramsFor(input, "member"), true);
        expect(result).not.toBeNull();
        expect(result?.shouldContinue).toBe(false);
        expect(result?.reply?.text).toContain("权限不足");
        expect(result?.reply?.text).toContain("/install-skill");
      });
    }
  });

  describe("false-positive guard (member role)", () => {
    const allowed = [
      "今天天气怎么样",
      "我已经装好飞书了",
      "飞书这个技能怎么用？",
      "帮我调用 feishu-chat 技能发消息给张三",
      "给张三安装了新手机",
      "这个 skill 为什么不工作",
      "请问 install 是什么意思",
      "帮我查一下这个仓库的 README",
    ];

    for (const input of allowed) {
      it(`allows: ${input}`, async () => {
        const result = await handleSkillInstallGuard(paramsFor(input, "member"), true);
        expect(result).toBeNull();
      });
    }
  });
});

describe("handleSkillMutateGuard (delete/uninstall NL intent)", () => {
  describe("role gating", () => {
    it("returns null when tenantRole is absent (single-user / CLI)", async () => {
      const result = await handleSkillMutateGuard(
        paramsFor("删除租户级所有skill", undefined),
        true,
      );
      expect(result).toBeNull();
    });

    it("returns null for owner", async () => {
      const result = await handleSkillMutateGuard(paramsFor("删除租户级所有skill", "owner"), true);
      expect(result).toBeNull();
    });

    it("returns null for admin", async () => {
      const result = await handleSkillMutateGuard(
        paramsFor("uninstall the feishu skill", "admin"),
        true,
      );
      expect(result).toBeNull();
    });

    it("ignores slash commands", async () => {
      const result = await handleSkillMutateGuard(
        paramsFor("/uninstall-skill feishu", "member"),
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe("intent detection (member role)", () => {
    const blocked = [
      "删除租户级所有skill",
      "删除这个技能",
      "卸载飞书技能包",
      "移除feishu-skills这个技能",
      "清除所有技能",
      "下架这个 skill",
      "禁用飞书技能",
      "技能删除掉",
      "uninstall the feishu skill",
      "please remove all skills from the tenant",
      "delete this skill pack",
      "disable feishu skills",
    ];

    for (const input of blocked) {
      it(`blocks: ${input}`, async () => {
        const result = await handleSkillMutateGuard(paramsFor(input, "member"), true);
        expect(result).not.toBeNull();
        expect(result?.shouldContinue).toBe(false);
        expect(result?.reply?.text).toContain("权限不足");
      });
    }
  });

  describe("false-positive guard (member role)", () => {
    const allowed = [
      "今天天气怎么样",
      "这个技能怎么用？",
      "帮我调用 feishu-chat 技能",
      "技能列表里有什么",
      "skill 为什么执行失败",
      "重新运行一下这个技能",
      "查一下技能有没有调用日志",
    ];

    for (const input of allowed) {
      it(`allows: ${input}`, async () => {
        const result = await handleSkillMutateGuard(paramsFor(input, "member"), true);
        expect(result).toBeNull();
      });
    }
  });
});
