/**
 * Alias-force-default plan §5.1/§5.2 (AF0): the PURE half of the cwd-basename auto-claim — no pi, no I/O, no timers.
 *
 *  - `deriveAutoAlias`: cwd ⇒ candidate alias (skips `/`, `$HOME`, `os.tmpdir()`; the basename rules live in
 *    `protocol/xs-alias.ts` `deriveAliasFromDirName`, shared with the completion chip so chip ≡ auto).
 *  - `shouldAutoClaim`: the gate the agent bridge evaluates at the end of a reconcile (AF3 wires it).
 *
 * Callers inject `home` / `tmpdir` (this module never reads the environment), so it stays deterministic.
 */
import { deriveAliasFromDirName } from "../../web-hub/protocol/xs-alias.js";
import type { XsAliasAutoSkipReason } from "./types-alias.js";

export type DeriveAutoAliasResult =
  | { readonly ok: true; readonly alias: string }
  | { readonly ok: false; readonly reason: Extract<XsAliasAutoSkipReason, "dir" | "invalid"> };

/** Path segments split on `/` and `\`, empties dropped (so trailing/duplicate separators never matter). */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s !== "");
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * §5.2-1 + the basename derivation. `dir` ⇒ the directory itself is not a meaningful name (cwd is the filesystem root,
 * `$HOME` or the temp dir, or has no basename); `invalid` ⇒ the basename cannot be turned into a legal alias
 * (reserved / id-like / no usable characters) — never a parent-directory fallback, never a suffix.
 */
export function deriveAutoAlias(
  cwd: string | undefined,
  dirs: { readonly home?: string | undefined; readonly tmpdir?: string | undefined } = {},
): DeriveAutoAliasResult {
  const segs = segmentsOf(typeof cwd === "string" ? cwd : "");
  if (segs.length === 0) return { ok: false, reason: "dir" };
  for (const special of [dirs.home, dirs.tmpdir]) {
    if (typeof special !== "string") continue;
    const sp = segmentsOf(special);
    if (sp.length > 0 && samePath(segs, sp)) return { ok: false, reason: "dir" };
  }
  const base = segs[segs.length - 1];
  if (base === undefined) return { ok: false, reason: "dir" };
  const r = deriveAliasFromDirName(base);
  return r.ok ? { ok: true, alias: r.alias } : { ok: false, reason: "invalid" };
}

/** Facts `shouldAutoClaim` needs; every one is read by the caller from live state at decision time. */
export interface AutoClaimFacts {
  /** `fabric.crossSession.alias.autoFromCwd` (frozen at stack build). */
  readonly autoFromCwd: boolean;
  /** Main session (the xs bridge is never built for child sessions; kept explicit so the gate is self-describing). */
  readonly mainSession: boolean;
  /** Local `alias.enabled` ∧ hub advertised `xs.alias.v1` (the cache port's `usable`). */
  readonly aliasUsable: boolean;
  /** The CURRENT hub advertises `xs.alias.v2`. */
  readonly hubAliasV2: boolean;
  /** xs membership is joined. */
  readonly joined: boolean;
  /** A human already decided for this sessionId (`subagent:xs-alias-decided`, I8). */
  readonly decided: boolean;
  /** A `/new` handoff of the previous sid's alias is still pending (AF7): do not race it with an auto-claim. */
  readonly pendingHandoff: boolean;
}

export type AutoClaimVerdict =
  | { readonly claim: true }
  | {
      readonly claim: false;
      readonly skip: Extract<XsAliasAutoSkipReason, "off" | "hub-cap" | "not-joined" | "decided"> | "handoff-pending";
    };

/**
 * `autoFromCwd ∧ 主会话 ∧ aliasUsable ∧ hub caps ∋ v2 ∧ joined ∧ ¬decided ∧ ¬pendingHandoff` (§5.1), evaluated in this
 * order; the first failing clause is the skip reason (`/fabric status` renders it as `auto skip:<reason>`).
 * `handoff-pending` is internal — it is transient and not one of the status tokens.
 */
export function shouldAutoClaim(f: AutoClaimFacts): AutoClaimVerdict {
  if (!f.autoFromCwd || !f.mainSession || !f.aliasUsable) return { claim: false, skip: "off" };
  if (!f.hubAliasV2) return { claim: false, skip: "hub-cap" };
  if (!f.joined) return { claim: false, skip: "not-joined" };
  if (f.decided) return { claim: false, skip: "decided" };
  if (f.pendingHandoff) return { claim: false, skip: "handoff-pending" };
  return { claim: true };
}
