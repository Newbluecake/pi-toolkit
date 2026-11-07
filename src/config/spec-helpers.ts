/**
 * The shared shape and builders of the settable-surface table (#56 batch 2 ⑧, D8-3): `SettingSpec` plus the
 * `seconds` / `count` / `bool` / `choice` / `csvString` constructors. Split out of `config/setting-specs.ts` so the
 * per-subsystem `setting-specs.ts` shards can build their entries without importing the aggregator.
 */

/**
 * The settable surface shared by `/agent settings` (text command) and the
 * `/agent settings` TUI editor (`src/ui/settings-editor.ts`).
 *
 * Keys are **storage/display keys**: durations use their integer-second `*S`
 * name (`budget.idleS`), while `spec.path` points at the internal
 * millisecond field in `AgentSettings` (`budget.idleMs`). That split is the
 * whole time-unit design — one table, two domains, conversion in exactly one
 * place (`toStored` / `toLive` below).
 *
 * Order = listing order in both surfaces.
 */
export interface SettingSpecBase {
  /** Dotted path inside `AgentSettings`; milliseconds when `time` is set. */
  path: string;
  /** The stored/displayed value is integer seconds while `path` holds milliseconds. */
  time?: true;
  /**
   * `kind: "string"` only: the stored/displayed value is a comma-joined string while `path` holds
   * a `string[]` (webHub.lan.{extraHosts,trustProxyFrom,externalOrigins}, plan §9.1 — on-disk they
   * are comma-separated, the live `AgentSettings` shape LE's frozen `WebHubLanSettings` demands is
   * an array). Mirrors the `time` transform's split between the stored and live domains.
   */
  csv?: true;
  /** Read at spawn time (`budget.*`) ⇒ applies to new runs immediately; everything else needs `/reload`. */
  live?: true;
  /** Effective default when `DEFAULT_SETTINGS` leaves the path unset (`workflow.budget.*`). */
  fallback?: number;
  /** One-line help shown by the editor. */
  hint?: string;
  /** What the knob does, shown in the editor's description column. */
  description?: string;
}

export type SettingSpec = SettingSpecBase &
  (
    | { kind: "number"; min?: number; max?: number; integer?: true }
    | { kind: "boolean" }
    | { kind: "enum"; values: readonly string[] }
    | { kind: "string" }
  );

/** Integer-second duration knob. `min` defaults to 0, where 0 disables the timeout. */
export function seconds(
  path: string,
  options: { max?: number; min?: number; live?: true; hint?: string; description?: string } = {},
): SettingSpec {
  return {
    kind: "number",
    path,
    time: true,
    integer: true,
    min: options.min ?? 0,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.live ? { live: options.live } : {}),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

export function count(path: string, min = 0, description?: string): SettingSpec {
  return { kind: "number", path, min, integer: true, ...(description === undefined ? {} : { description }) };
}

export function bool(path: string, description?: string): SettingSpec {
  return { kind: "boolean", path, ...(description === undefined ? {} : { description }) };
}

export function choice(path: string, values: readonly string[], description?: string): SettingSpec {
  return { kind: "enum", path, values, ...(description === undefined ? {} : { description }) };
}

/** Comma-joined-string ⇄ `string[]` knob (plan §9.1: webHub.lan.{extraHosts,trustProxyFrom,externalOrigins}). */
export function csvString(path: string, description?: string): SettingSpec {
  return { kind: "string", path, csv: true, ...(description === undefined ? {} : { description }) };
}
