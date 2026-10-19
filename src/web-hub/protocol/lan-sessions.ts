/** LAN security r2 §3. LAN-only HTTP shapes; no sidHash on this wire. */
import { Type, type Static } from "@sinclair/typebox";
export const LAN_SESSIONS_PATH = "/api/lan/sessions";
export const LAN_SESSIONS_REVOKE_PATH = "/api/lan/sessions/revoke";
export const LAN_SESSIONS_PER_USER_MAX = 32;
export const LAN_SESSION_ABSOLUTE_DAYS = 7;
export const REVOKE_TOTAL_MS = 10_000;
export const LAN_SESSIONS_CLIENT_TIMEOUT_MS = 15_000;
export const LAN_SESSION_PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const strict = { additionalProperties: false } as const;
const time = Type.Integer({ minimum: 0 });
export const LanSessionWireSchema = Type.Object(
  {
    id: Type.String({ pattern: LAN_SESSION_PUBLIC_ID_RE.source }),
    current: Type.Boolean(),
    createdAt: time,
    lastSeenAt: time,
    expiresAt: time,
    absoluteExpiresAt: time,
    createdIp: Type.String({ maxLength: 64 }),
    lastIp: Type.Optional(Type.String({ maxLength: 64 })),
    ua: Type.Optional(Type.String({ maxLength: 512 })),
  },
  strict,
);
export type LanSessionWire = Static<typeof LanSessionWireSchema>;
export const LanSessionsResponseSchema = Type.Object(
  {
    idleMinutes: Type.Integer({ minimum: 5, maximum: 10080 }),
    absoluteDays: Type.Literal(7),
    max: Type.Literal(32),
    sessions: Type.Array(LanSessionWireSchema, { maxItems: 32 }),
  },
  strict,
);
export type LanSessionsResponse = Static<typeof LanSessionsResponseSchema>;
export const LanSessionRevokeBodySchema = Type.Union([
  Type.Object({ id: Type.String({ pattern: LAN_SESSION_PUBLIC_ID_RE.source }) }, strict),
  Type.Object({ others: Type.Literal(true) }, strict),
]);
export type LanSessionRevokeBody = Static<typeof LanSessionRevokeBodySchema>;
export const LanSessionRevokeResponseSchema = Type.Object(
  { ok: Type.Literal(true), revoked: Type.Integer({ minimum: 0, maximum: 64 }), complete: Type.Boolean() },
  strict,
);
export type LanSessionRevokeResponse = Static<typeof LanSessionRevokeResponseSchema>;
