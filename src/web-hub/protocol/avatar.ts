/**
 * web-hub custom-avatar protocol (web-hub-avatar plan v2.1, package A0).
 *
 * This is the frozen, runtime-safe protocol face shared by the hub and browser
 * client.  It deliberately contains no filesystem or HTTP implementation.
 */

/** Fixed avatar endpoint paths. */
export const AVATAR_PATH = "/api/avatar";
export const AVATAR_DELETE_PATH = "/api/avatar/delete";

/** The only files used by the hub-side avatar store. */
export const AVATAR_FILE = "avatar.png";
export const AVATAR_TMP = "avatar.png.tmp";

/** Avatar input and image-shape limits. */
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MIN_SIDE = 16;
export const AVATAR_MAX_SIDE = 256;
export const AVATAR_DELETE_BODY_MAX_BYTES = 256;

/** Request and store budgets, frozen by plan §2.3. */
export const AVATAR_TOTAL_MS = 14_000;
export const AVATAR_AUTH_CAP_MS = 2_000;
export const AVATAR_BODY_MIN_MS = 1_000;
export const AVATAR_BODY_CAP_MS = 5_000;
export const AVATAR_AUTH2_CAP_MS = 1_000;
export const AVATAR_PUT_STEP_CAPS = [250, 500, 1_000, 1_500, 250, 500] as const;
export const AVATAR_STORE_MIN_MS = AVATAR_PUT_STEP_CAPS.reduce((sum, cap) => sum + cap, 0);
export const AVATAR_DELETE_STEP_CAPS = [250, 500] as const;
export const AVATAR_DELETE_MIN_MS = AVATAR_DELETE_STEP_CAPS.reduce((sum, cap) => sum + cap, 0);
export const AVATAR_GET_TOTAL_MS = 8_000;
export const AVATAR_GET_SEND_MS = 10_000;
export const AVATAR_GET_INFLIGHT = 8;
export const AVATAR_LOAD_TOTAL_MS = 5_000;
export const AVATAR_CLOSE_WAIT_MS = 1_000;
export const AVATAR_PENDING_CEILING_MS = 30_000;

/** All structural rejection reasons produced by the shared PNG walk. */
export const AVATAR_REJECT_REASONS = [
  "signature",
  "ihdr",
  "dims",
  "color",
  "chunk",
  "crc",
  "animated",
  "order",
  "trailing",
  "idat",
  "size",
] as const;
export type AvatarRejectReason = (typeof AVATAR_REJECT_REASONS)[number];

/** Store/router busy reasons. */
export const AVATAR_BUSY_REASONS = ["loading", "disabled", "inflight", "pending", "tmp-exists"] as const;
export type AvatarBusyReason = (typeof AVATAR_BUSY_REASONS)[number];

export type AvatarEffect = "none" | "unknown";

/** PNG validation result shared by the hub and browser. */
export type AvatarPngValidation =
  | { readonly ok: true; readonly side: number }
  | {
      readonly ok: false;
      readonly reason: AvatarRejectReason;
    };

/** The compact avatar state embedded in HubInfo and write responses. */
export interface AvatarInfo {
  readonly gen: number;
  readonly v?: string;
}

export interface AvatarWriteInfo extends AvatarInfo {
  readonly side: number;
  readonly bytes: number;
  readonly dedup?: boolean;
}

export interface AvatarHubIdentity {
  readonly pid: number;
  readonly startedAt: number;
}

export interface AvatarWriteResponse {
  readonly avatar: AvatarWriteInfo;
  readonly hub: AvatarHubIdentity;
}

export interface AvatarDeleteResponse {
  readonly avatar: Pick<AvatarInfo, "gen">;
  readonly hub: AvatarHubIdentity;
}

/** Error envelopes used by the transport adapters. */
export interface AvatarTransportError {
  readonly error: string;
  readonly status?: number;
  readonly reason?: AvatarRejectReason | AvatarBusyReason | string;
  readonly effect?: AvatarEffect;
  readonly retryAfterS?: number;
}

export type AvatarFetchOutcome =
  | { readonly ok: true; readonly bytes: Blob; readonly etag: string; readonly side: number }
  | ({ readonly ok: false } & AvatarTransportError);

export type AvatarWriteOutcome =
  { readonly ok: true; readonly data: AvatarWriteResponse } | ({ readonly ok: false } & AvatarTransportError);

export type AvatarDeleteOutcome =
  { readonly ok: true; readonly data: AvatarDeleteResponse } | ({ readonly ok: false } & AvatarTransportError);

/** The two paths accepted by an AvatarRoutes implementation. */
export type AvatarPath = typeof AVATAR_PATH | typeof AVATAR_DELETE_PATH;
