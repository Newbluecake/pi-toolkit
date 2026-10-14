/**
 * P7w/P7wa 共享（external-agent quota-plan r2 §9A.5）：改动前 `QuotaWireSchema` 的
 * **逐字副本**（一个尚未升级的 hub 实际用来解码的 schema）。原先是
 * `tests/web-hub/protocol/quota-pools-schema.test.ts` 的内嵌副本，P7wa 抽出共享，
 * 内容保持 verbatim（do not edit）：
 *  - P7w：钉住「未门控的 droid 帧会被旧 schema 拒」「旧形状 wire 在新旧 schema 下解码相同」；
 *  - P7wa：钉住「`projectQuota(…, { pools: false })` 的输出能通过旧 schema」（agent 对旧 hub
 *    字节不变、不丢帧）。
 */
import { Type } from "@sinclair/typebox";

// ---- verbatim pre-P7w copy (do not edit) ---------------------------------------------------
const LegacyQuotaWindowSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("5h"), Type.Literal("week")]),
    usedPct: Type.Number({ minimum: 0, maximum: 100 }),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    resetAt: Type.Optional(Type.Number()),
    etaMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);
const LegacyQuotaProviderSchema = Type.Object(
  {
    id: Type.Union([Type.Literal("zai-coding-cn"), Type.Literal("zai"), Type.Literal("kimi-coding")]),
    plan: Type.Optional(Type.String({ maxLength: 64 })),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    stale: Type.Boolean(),
    fetchedAt: Type.Optional(Type.Number()),
    demotedUntil: Type.Optional(Type.Number()),
    windows: Type.Array(LegacyQuotaWindowSchema, { maxItems: 8 }),
  },
  { additionalProperties: true },
);
export const LEGACY_QUOTA_WIRE_SCHEMA = Type.Object(
  {
    v: Type.Literal(1),
    at: Type.Number({ minimum: 0 }),
    providers: Type.Array(LegacyQuotaProviderSchema, { maxItems: 16 }),
  },
  { additionalProperties: true },
);
// ---------------------------------------------------------------------------------------------
