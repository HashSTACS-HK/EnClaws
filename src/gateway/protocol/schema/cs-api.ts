import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const CreateObjectInput = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);
export type CreateObjectInput = Static<typeof CreateObjectInput>;

export const UpdateObjectInput = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    agentId: Type.Optional(NonEmptyString),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdateObjectInput = Static<typeof UpdateObjectInput>;

export const SendMessageInput = Type.Object(
  {
    sessionId: Type.Optional(NonEmptyString),
    content: NonEmptyString,
    customerId: NonEmptyString,
    channelId: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type SendMessageInput = Static<typeof SendMessageInput>;

export const HandoffInput = Type.Object(
  {
    takenOverBy: NonEmptyString,
    retainAiAssist: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ReleaseInput = Type.Object(
  {
    releasedBy: NonEmptyString,
    handoffMessage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Body for POST /{appId}/sessions/{sessionId}/mark-notifying.
 * Both fields are optional — caller may supply matter context and a reason
 * code for observability/audit. Unknown fields are rejected.
 *
 * mark-notifying 端点入参，所有字段均可选；额外字段被拒绝。
 */
export const MarkNotifyingInput = Type.Object(
  {
    matterId: Type.Optional(NonEmptyString),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("low-confidence"),
        Type.Literal("explicit-customer-request"),
        Type.Literal("other"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ObserverInput = Type.Object(
  {
    role: Type.Union([Type.Literal("human-staff"), Type.Literal("customer")]),
    senderParty: NonEmptyString,
    content: NonEmptyString,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const ListSessionsQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    state: Type.Optional(
      Type.Union([
        Type.Literal("ai-handling"),
        Type.Literal("human-handling"),
        Type.Literal("closed"),
      ]),
    ),
    customerId: Type.Optional(Type.String()),
    updatedAfter: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export const TranscriptQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
  },
  { additionalProperties: false },
);
