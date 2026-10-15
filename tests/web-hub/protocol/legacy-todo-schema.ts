/**
 * todo-archive plan v2.1 §3 (D5)：改动前 `TodoWireSchema` 的 **逐字副本**（一个尚未升级的
 * hub 实际用来解码的 schema，取自 `git show 9327dcf:src/web-hub/protocol/messages.ts`）。
 * 内容保持 verbatim（do not edit）：钉住「未门控的新字段（completedHidden/archived）会被旧
 * schema 拒 ⇒ cap 门必要」「旧形状 wire 在新旧 schema 下结果相同」。
 */
import { Type } from "@sinclair/typebox";

// ---- verbatim pre-todo-archive copy (do not edit) -------------------------------------------
// todo-web plan §3.1 (T2): same nested-payload posture as QueueItemSchema above — the
// task-row/todo bodies are pinned (additionalProperties:false) while the enclosing
// StatusFrameSchema stays open-ended for forward compatibility.
const LegacyTodoTaskSchema = Type.Object(
  {
    id: Type.Integer(),
    subject: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    owner: Type.Optional(Type.String()),
    activeForm: Type.Optional(Type.String()),
    blockedBy: Type.Array(Type.Integer()),
    description: Type.Optional(Type.String()),
    descTruncated: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export const LEGACY_TODO_WIRE_SCHEMA = Type.Object(
  {
    tasks: Type.Array(LegacyTodoTaskSchema),
    total: Type.Integer(),
    counts: Type.Object(
      { open: Type.Integer(), inProgress: Type.Integer(), completed: Type.Integer(), blocked: Type.Integer() },
      { additionalProperties: false },
    ),
    omitted: Type.Optional(Type.Integer()),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);
// ---------------------------------------------------------------------------------------------
