/**
 * LAN credential-hardening phase gate (docs/dev/web-hub-auth-hardening/plan.md §4.0, #66).
 *
 * Pure, ZERO imports (I8: the maintenance subprocess text and the hub main thread share these
 * constants by value only). Two-stage rollout:
 *
 * - phase 1 (this release): READ side only — the hub can read scrypt N ≤ 2^17 and (later packs)
 *   53-byte encrypted TOTP rows, and stamps the reader marker; every WRITE stays at the legacy
 *   shape (2^15 / plaintext TOTP) regardless of the marker.
 * - phase 2 (a later release, flipped by pack P3): writes switch on only once the reader marker has
 *   existed for `WRITER_SOAK_MS`, so a downgrade within the soak window never meets data it cannot
 *   read.
 *
 * `writerActive` is decided ONCE, by the maintenance subprocess at open time; everything else
 * (query child env, KDF write target) receives that single verdict. Never recompute it elsewhere.
 */

/** Release phase. Constant (not a setting — I11): P3 flips it to 2 in the second release. */
export const HARDENING_PHASE: 1 | 2 = 1;

/** `meta` key holding `{"v":number,"since":epochMs}` — older hubs ignore unknown meta keys. */
export const READER_MARKER_KEY = "hardening_reader";

/** v1 = can read KDF ≤ 2^17 and 53-byte TOTP rows. */
export const READER_MARKER_VERSION = 1;

/** The reader marker must be this old before the writer side may activate (14 days). */
export const WRITER_SOAK_MS = 14 * 86_400_000;

export interface ReaderMarker {
  readonly v: number;
  readonly since: number;
}

/** True only in phase 2, with a v≥1 marker that is ≥ `WRITER_SOAK_MS` old (a future `since` never qualifies). */
export function writerActive(phase: 1 | 2, marker: ReaderMarker | undefined, now: number): boolean {
  if (phase !== 2) return false;
  if (marker === undefined) return false;
  if (!Number.isFinite(marker.v) || !Number.isFinite(marker.since) || !Number.isFinite(now)) return false;
  if (marker.v < READER_MARKER_VERSION) return false;
  return marker.since <= now - WRITER_SOAK_MS;
}

/** Parse the stored marker text; anything malformed counts as absent. */
export function parseReaderMarker(raw: unknown): ReaderMarker | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null) return undefined;
    const v = (o as { v?: unknown }).v;
    const since = (o as { since?: unknown }).since;
    if (typeof v !== "number" || typeof since !== "number") return undefined;
    if (!Number.isSafeInteger(v) || !Number.isSafeInteger(since) || v < 0 || since < 0) return undefined;
    return { v, since };
  } catch {
    return undefined;
  }
}

/**
 * Marker step of `open-check-migrate`: missing/invalid ⇒ `{v:1, since:now}`; an older version only
 * has its `v` raised (the original `since` is kept); an equal/newer marker is untouched.
 */
export function nextReaderMarker(existing: ReaderMarker | undefined, now: number): ReaderMarker {
  if (existing === undefined) return { v: READER_MARKER_VERSION, since: now };
  if (existing.v < READER_MARKER_VERSION) return { v: READER_MARKER_VERSION, since: existing.since };
  return existing;
}
