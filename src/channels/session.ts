import type { MsgContext } from "../auto-reply/templating.js";
import {
  recordSessionMetaFromInbound,
  type GroupKeyResolution,
  type SessionEntry,
  updateLastRoute,
} from "../config/sessions.js";

function normalizeSessionStoreKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

export type InboundLastRouteUpdate = {
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to: string;
  accountId?: string;
  threadId?: string | number;
};

function isMissingSessionDirError(err: unknown): boolean {
  // In multi-tenant mode, plugins may compute a non-tenant storePath before
  // enrichTenantContext redirects sessions to the tenant dir. The resulting
  // ENOENT on the root-agent sessions dir is expected, not a real failure.
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeSessionStoreKey(sessionKey);
  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: canonicalSessionKey,
    ctx,
    groupResolution,
    createIfMissing,
  }).catch((err) => {
    if (isMissingSessionDirError(err)) {return;}
    params.onRecordError(err);
  });

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  const targetSessionKey = normalizeSessionStoreKey(update.sessionKey);
  try {
    await updateLastRoute({
      storePath,
      sessionKey: targetSessionKey,
      deliveryContext: {
        channel: update.channel,
        to: update.to,
        accountId: update.accountId,
        threadId: update.threadId,
      },
      ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
      groupResolution,
    });
  } catch (err) {
    if (isMissingSessionDirError(err)) {return;}
    params.onRecordError(err);
  }
}
