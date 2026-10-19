/** LAN security r2 §5: frozen HTTP + local-socket contracts. Never import messages.ts here. */
import { Type, type Static } from "@sinclair/typebox";

export const NEW_IP_WINDOW_MS = 30 * 24 * 3_600_000;
export const LAN_SESSION_IDLE_MINUTES = 720;
export const LAN_SESSION_IDLE_MIN = 5;
export const LAN_SESSION_IDLE_MAX = 10080;
export const LAN_2FA_COOKIE = "pwh_lan2fa";
export const LAN_LOGIN_PATH = "/api/login";
export const LAN_2FA_PATH = "/api/login/2fa";
export const LAN_2FA_WAIT_PATH = "/api/login/2fa/wait";
export const LAN_2FA_CANCEL_PATH = "/api/login/2fa/cancel";
export const LAN_2FA_LIMITS = Object.freeze({
  challengeMs: 300_000,
  attempts: 5,
  challenges: 64,
  perIp: 4,
  methodAttempts: 10,
  methodWindowMs: 900_000,
  approvalMs: 120_000,
  approvalSendMs: 5_000,
  cardsPerIp: 3,
  cardsGlobal: 6,
  cardWindowMs: 600_000,
  postKdfMs: 10_000,
  factorMs: 12_000,
  completionReserveMs: 4_000,
  waitHoldMs: 15_000,
  waitReserveMs: 8_000,
  pollTimeoutMs: 30_000,
  recoveryCodes: 10,
  recoveryBits: 60,
  loginIps: 256,
});
export const TOTP_CODE_RE = /^[0-9]{6}$/;
export const RECOVERY_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
/** Crockford aliases + optional display separators; undefined is malformed, no verifier op. */
export function normalizeRecoveryCode(raw: string): string | undefined {
  const code = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return RECOVERY_CODE_RE.test(code) ? code : undefined;
}
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const method = Type.Union([Type.Literal("totp"), Type.Literal("recovery"), Type.Literal("feishu")]);
export const LanFactorBodySchema = Type.Union([
  Type.Object({ method: Type.Literal("totp"), code: Type.String({ pattern: TOTP_CODE_RE.source }) }, strict),
  Type.Object({ method: Type.Literal("recovery"), code: Type.String({ pattern: RECOVERY_CODE_RE.source }) }, strict),
]);
export type LanFactorBody = Static<typeof LanFactorBodySchema>;
export type LanLoginMethod = "password" | "totp" | "recovery" | "feishu";
export const Lan2faChallengeSchema = Type.Object(
  {
    error: Type.Literal("E_2FA"),
    methods: Type.Array(method, { minItems: 1, maxItems: 3, uniqueItems: true }),
    feishu: Type.Union([Type.Literal("sent"), Type.Literal("unavailable")]),
    expiresAt: count,
  },
  strict,
);
export type Lan2faChallenge = Static<typeof Lan2faChallengeSchema>;
export const Lan2faWaitSchema = Type.Object(
  { state: Type.Union([Type.Literal("pending"), Type.Literal("denied"), Type.Literal("expired")]) },
  strict,
);
export const LAN_2FA_ERRORS = [
  "E_2FA_CODE",
  "E_2FA_BUSY",
  "E_2FA_USED",
  "E_2FA_EXPIRED",
  "E_2FA_METHOD_LOCKED",
] as const;
export const LanLoginErrorSchema = Type.Object(
  {
    error: Type.Union(
      [...LAN_2FA_ERRORS, "E_AUTH", "E_BAD_REQUEST", "E_DB", "E_DEADLINE", "E_LOCKED", "E_RATE"].map((v) =>
        Type.Literal(v),
      ),
    ),
    attemptsLeft: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    retryAfterMs: Type.Optional(count),
    saturated: Type.Optional(Type.Boolean()),
  },
  strict,
);
export const LanLoginSuccessSchema = Type.Object(
  { ok: Type.Literal(true), initialPassword: Type.Optional(Type.Boolean()) },
  strict,
);
export const LanLoginResponseSchema = Type.Union([
  LanLoginSuccessSchema,
  Lan2faChallengeSchema,
  Lan2faWaitSchema,
  LanLoginErrorSchema,
]);
export type LanLoginResponse = Static<typeof LanLoginResponseSchema>;

export const TFA_REQ_TYPE = "tfa_req";
export const TFA_RES_TYPE = "tfa_res";
export const TFA_OPS = [
  "status",
  "totp_begin",
  "totp_confirm",
  "feishu",
  "recovery_regen",
  "reset",
  "forget_ips",
  "repair",
] as const;
export type TfaOp = (typeof TFA_OPS)[number];
const rid = Type.String({ minLength: 1, maxLength: 64 });
const req = <T extends (typeof TFA_OPS)[number]>(op: T) => ({
  t: Type.Literal(TFA_REQ_TYPE),
  rid,
  op: Type.Literal(op),
});
export const TfaReqSchema = Type.Union([
  Type.Object(req("status"), strict),
  Type.Object({ ...req("totp_begin"), replace: Type.Optional(Type.Literal(true)) }, strict),
  Type.Object({ ...req("totp_confirm"), code: Type.String({ pattern: TOTP_CODE_RE.source }) }, strict),
  Type.Object({ ...req("feishu"), on: Type.Boolean() }, strict),
  Type.Object(req("recovery_regen"), strict),
  Type.Object({ ...req("reset"), confirm: Type.Literal(true) }, strict),
  Type.Object(req("forget_ips"), strict),
  Type.Object({ ...req("repair"), confirm: Type.Literal(true) }, strict),
]);
export type TfaReqFrame = Static<typeof TfaReqSchema>;
export const TfaStatusSchema = Type.Object(
  {
    kind: Type.Literal("status"),
    state: Type.Union([Type.Literal("none"), Type.Literal("enrolled"), Type.Literal("inconsistent")]),
    totp: Type.Boolean(),
    feishu: Type.Boolean(),
    recoveryLeft: Type.Integer({ minimum: 0, maximum: 10 }),
    knownIps: Type.Integer({ minimum: 0, maximum: 256 }),
    repairNeeded: Type.Optional(Type.String({ maxLength: 256 })),
  },
  strict,
);
const recoveryCodes = Type.Array(Type.String({ pattern: RECOVERY_CODE_RE.source }), {
  minItems: 10,
  maxItems: 10,
  uniqueItems: true,
});
export const TfaResDataSchema = Type.Union([
  TfaStatusSchema,
  Type.Object(
    {
      kind: Type.Literal("totp_begin"),
      otpauthUri: Type.String({ minLength: 1, maxLength: 2048, pattern: "^otpauth://totp/" }),
      secretB32: Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Z2-7]+$" }),
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("totp_confirm"), recoveryCodes }, strict),
  Type.Object({ kind: Type.Literal("recovery_regen"), recoveryCodes }, strict),
  Type.Object({ kind: Type.Literal("ok") }, strict),
]);
export type TfaResData = Static<typeof TfaResDataSchema>;
export const TfaResSchema = Type.Union([
  Type.Object({ t: Type.Literal(TFA_RES_TYPE), rid, ok: Type.Literal(true), data: TfaResDataSchema }, strict),
  Type.Object(
    {
      t: Type.Literal(TFA_RES_TYPE),
      rid,
      ok: Type.Literal(false),
      code: Type.String({ pattern: "^E_[A-Z0-9_]{1,48}$" }),
      message: Type.String({ maxLength: 512 }),
    },
    strict,
  ),
]);
export type TfaResFrame = Static<typeof TfaResSchema>;
