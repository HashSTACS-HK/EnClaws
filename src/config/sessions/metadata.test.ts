import { describe, it, expect } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveGroupSessionPatch } from "./metadata.js";

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    From: "feishu:group:oc_abc123",
    ChatType: "group",
    Provider: "feishu",
    GroupSubject: "研发讨论群",
    SenderName: "张三",
    ...overrides,
  } as MsgContext;
}

describe("deriveGroupSessionPatch", () => {
  it("writes groupName (not displayName) for regular group session", () => {
    const ctx = makeCtx();
    const patch = deriveGroupSessionPatch({
      ctx,
      sessionKey: "agent:ops:feishu:group:oc_abc123",
    });
    expect(patch).not.toBeNull();
    expect(patch!.groupName).toBeTruthy();
    expect(patch!.displayName).toBeUndefined();
  });

  it("writes displayName=senderName for per-sender group session", () => {
    const ctx = makeCtx({ SenderName: "张三" });
    const patch = deriveGroupSessionPatch({
      ctx,
      sessionKey: "agent:ops:feishu:group:oc_abc123:sender:ou_xyz",
    });
    expect(patch).not.toBeNull();
    expect(patch!.groupName).toBeTruthy();
    expect(patch!.displayName).toBe("张三");
  });

  it("does not write displayName when SenderName is ou_ placeholder", () => {
    const ctx = makeCtx({ SenderName: "ou_abc123" });
    const patch = deriveGroupSessionPatch({
      ctx,
      sessionKey: "agent:ops:feishu:group:oc_abc123:sender:ou_abc123",
    });
    expect(patch!.displayName).toBeUndefined();
  });

  it("does not write displayName when SenderName is absent", () => {
    const ctx = makeCtx({ SenderName: undefined });
    const patch = deriveGroupSessionPatch({
      ctx,
      sessionKey: "agent:ops:feishu:group:oc_abc123:sender:ou_xyz",
    });
    expect(patch!.displayName).toBeUndefined();
  });

  it("writes displayName=userId for WeCom per-sender session (userId IS the display identity)", () => {
    // WeCom sets SenderName=fromUser=SenderId — the userId is intentionally the display identity
    const ctx = makeCtx({
      From: "wecom:group:chatid123:sender:liuyu",
      Provider: "wecom",
      SenderName: "liuyu",
      SenderId: "liuyu",
    } as Partial<MsgContext>);
    const patch = deriveGroupSessionPatch({
      ctx,
      sessionKey: "agent:aaa:wecom:group:chatid123:sender:liuyu",
    });
    expect(patch!.groupName).toBeTruthy();
    expect(patch!.displayName).toBe("liuyu");
  });
});
