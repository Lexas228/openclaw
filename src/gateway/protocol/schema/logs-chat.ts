import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ChatFilesPendingParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatFilesResolveParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    id: Type.Optional(NonEmptyString),
    toolCallId: Type.Optional(NonEmptyString),
    decision: Type.Union([Type.Literal("accept"), Type.Literal("rollback")]),
  },
  { additionalProperties: false },
);

export const ChatFileApprovalSchema = Type.Object(
  {
    id: NonEmptyString,
    sessionKey: NonEmptyString,
    path: NonEmptyString,
    backupPath: NonEmptyString,
    firstToolCallId: NonEmptyString,
    lastToolCallId: NonEmptyString,
    runId: NonEmptyString,
    toolName: NonEmptyString,
    changesCount: Type.Integer({ minimum: 1 }),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
