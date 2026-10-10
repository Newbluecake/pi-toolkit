/**
 * consult A/B instrumentation plan (docs/dev/consult/ab-instrumentation-plan.md
 * §2/§3, P1a): pure validation for the Agent tool's optional `meta` param —
 * analytics-only dispatch metadata (lane / package id / feature / A-B arm)
 * that never reaches the subagent (`buildPrompt` never reads it) and never
 * changes dispatch behavior by itself. Pi-free, no I/O.
 */

/** Dev-flow lane classification (skills/dev-flow/SKILL.md): L0 direct edit .. L3 complex. */
export type DispatchLane = "L0" | "L1" | "L2" | "L3";

/** Which arm of the consult-whitelist A/B experiment this dispatch belongs to. */
export type AbArm = "experts" | "control";

export interface DispatchMeta {
  lane?: DispatchLane;
  packageId?: string;
  feature?: string;
  abArm?: AbArm;
}

/** The only keys `parseDispatchMeta` accepts; an unknown key is a hard error. */
export const DISPATCH_META_KEYS = ["lane", "packageId", "feature", "abArm"] as const;

/** Shared id shape for `packageId` and `feature`: starts alphanumeric, then up to 63 more id-safe chars. */
export const DISPATCH_META_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/;

const LANES: readonly DispatchLane[] = ["L0", "L1", "L2", "L3"];
const ARMS: readonly AbArm[] = ["experts", "control"];

export type ParseDispatchMetaResult = { ok: true; meta: DispatchMeta | undefined } | { ok: false; error: string };

const ALLOWED_KEYS_TEXT = DISPATCH_META_KEYS.join(", ");

/**
 * Review §8 M2: a "plain object" means its prototype is `Object.prototype`
 * or `null` (a literal `{...}` or `Object.create(null)`) — a `Date`, a class
 * instance, or any other custom-prototype object is rejected outright, even
 * though `typeof x === "object"` is true for all of them.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Review §8 M2 "only read own fields": never read through the prototype chain (defends against a polluted `Object.prototype`, not just non-plain inputs). */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function describeRaw(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    const ctorName = (value as object).constructor?.name;
    return ctorName !== undefined && ctorName !== "Object" ? `a ${ctorName} instance` : "a non-plain object";
  }
  return typeof value;
}

/**
 * Validate a raw (model-supplied or programmatic) `meta` value.
 *
 * `undefined` and `{}` both map to `{ ok: true, meta: undefined }` so the
 * caller never writes an empty/absent `dispatchMeta` field downstream (the
 * "zero fields when unused" contract — §2). Everything else that is not a
 * plain object (including a `Date`, a class instance, or any object with a
 * custom/inherited prototype), carries an unknown OWN key, fails the
 * per-field validation, or sets `abArm` without `packageId` is a hard error
 * with a self-correcting message (the caller — the Agent tool, P2 — throws
 * it verbatim so the model can fix its own call). Only OWN enumerable
 * fields are ever read (`Object.keys` + `ownValue`): an inherited field
 * (via a custom prototype, or a polluted `Object.prototype`) is treated as
 * absent, never as a provided value.
 */
export function parseDispatchMeta(raw: unknown): ParseDispatchMetaResult {
  if (raw === undefined) return { ok: true, meta: undefined };
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: `meta must be a plain object with keys: ${ALLOWED_KEYS_TEXT}; got ${describeRaw(raw)}`,
    };
  }
  const obj = raw;
  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: true, meta: undefined };
  const unknownKeys = keys.filter((k) => !(DISPATCH_META_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `meta has unknown key(s): ${unknownKeys.join(", ")}. Allowed keys: ${ALLOWED_KEYS_TEXT}`,
    };
  }
  const meta: DispatchMeta = {};
  const lane = ownValue(obj, "lane");
  if (lane !== undefined) {
    if (typeof lane !== "string" || !LANES.includes(lane as DispatchLane)) {
      return { ok: false, error: `meta.lane must be one of: ${LANES.join(", ")}; got ${JSON.stringify(lane)}` };
    }
    meta.lane = lane as DispatchLane;
  }
  const packageId = ownValue(obj, "packageId");
  if (packageId !== undefined) {
    if (typeof packageId !== "string" || !DISPATCH_META_ID_RE.test(packageId)) {
      return {
        ok: false,
        error: `meta.packageId must be a non-empty id matching ${DISPATCH_META_ID_RE.source} (max 64 chars); got ${JSON.stringify(packageId)}`,
      };
    }
    meta.packageId = packageId;
  }
  const feature = ownValue(obj, "feature");
  if (feature !== undefined) {
    if (typeof feature !== "string" || !DISPATCH_META_ID_RE.test(feature)) {
      return {
        ok: false,
        error: `meta.feature must be a non-empty id matching ${DISPATCH_META_ID_RE.source} (max 64 chars); got ${JSON.stringify(feature)}`,
      };
    }
    meta.feature = feature;
  }
  const abArm = ownValue(obj, "abArm");
  if (abArm !== undefined) {
    if (typeof abArm !== "string" || !ARMS.includes(abArm as AbArm)) {
      return { ok: false, error: `meta.abArm must be one of: ${ARMS.join(", ")}; got ${JSON.stringify(abArm)}` };
    }
    meta.abArm = abArm as AbArm;
  }
  if (meta.abArm !== undefined && meta.packageId === undefined) {
    return { ok: false, error: "meta.abArm requires meta.packageId (the A/B arm is tracked per package)" };
  }
  return { ok: true, meta };
}
