/**
 * jev-reflex · #25 B1 historical replay (BA §4.3): Turns × the two-layer matcher → ReplayRow.
 * Semantics deliberately mirror the runtime (`wire.ts`): builtin catalog first, drafts only on
 * a builtin MISS (K2); the gate runs on ideal TUI facts (`/reflex explain` semantics — the
 * counterfactual "would this question have hit if typed in a live idle TUI"), with the REAL
 * imageCount and text. Acceptance comes from the Turn's `unknownFacts` (confirmed ⇔ empty).
 *
 * Corrections replay the runtime memo exactly (single slot, set at `settledAt`, one-shot,
 * non-correcting inputs never clear it); offline cannot see process restarts, so corrections
 * can only be OVER-counted (conservative, BA §4.3). `reasked` windows key on the V2 identity
 * (lineage + templateHash) + digest, per session. Pure, pi-free, no state (I4/R-I10).
 */

import { CORRECTION_WINDOW_MS, REPEAT_WINDOW_MS } from "../budget.js";
import { judgeAgreement } from "../agreement.js";
import { evaluateGate } from "../gate.js";
import { identityKey, templateHash } from "../identity.js";
import { compileCatalog, type Matcher } from "../match.js";
import { normalizeInput } from "../normalize.js";
import { portSignatureOf } from "../port-defaults.js";
import type {
  Agreement,
  Capability,
  CorrectionFact,
  MatchResult,
  ReplayClass,
  ReplayRow,
  RScriptV1,
  SuspectCode,
  Turn,
} from "../types.js";

/** The matcher pair replay evaluates: builtin first, drafts only on a builtin miss (K2). */
export interface ReplayCatalog {
  builtin: readonly RScriptV1[];
  drafts?: readonly RScriptV1[];
}

interface LayeredMatch {
  layer: "builtin" | "draft";
  m: MatchResult;
}

function twoLayer(
  norm: string,
  builtin: Matcher,
  drafts: Matcher | undefined,
  caps: ReadonlySet<Capability>,
): LayeredMatch | undefined {
  const b = builtin.match(norm, caps);
  if (b.kind !== "miss") return { layer: "builtin", m: b };
  if (drafts === undefined) return undefined;
  const d = drafts.match(norm, caps);
  if (d.kind !== "miss") return { layer: "draft", m: d };
  return undefined;
}

function scriptById(cat: ReplayCatalog, layer: "builtin" | "draft", id: string): RScriptV1 | undefined {
  return (layer === "draft" ? cat.drafts : cat.builtin)?.find((s) => s.id === id);
}

/** A row under construction; `corrected` is patched in place by the memo walk. */

/**
 * Replay all turns. Rows come back in INPUT order; `corrections` may contain facts from any
 * session (only `origin ∈ {tui, replay}` ones are consulted, mirroring the runtime's
 * interactive+tui-only correction acceptance).
 */
export function replay(
  turns: readonly Turn[],
  corrections: readonly CorrectionFact[],
  cat: ReplayCatalog,
  caps: ReadonlySet<Capability>,
): readonly ReplayRow[] {
  const builtin = compileCatalog(cat.builtin);
  const drafts = cat.drafts !== undefined && cat.drafts.length > 0 ? compileCatalog(cat.drafts) : undefined;

  const rows = new Map<Turn, ReplayRow>();

  // Per-session event walk: {input → evaluate/set reask window} / {settle → set memo} /
  // {correction → maybe mark the memo target}. Ties order corr < input < settle (a correcting
  // input is checked before its own candidacy; a settle is always after its input).
  type Ev = { t: number; o: 0 | 1 | 2; turn?: Turn; corr?: CorrectionFact };
  const bySession = new Map<string, { evs: Ev[]; turns: Turn[] }>();
  for (const turn of turns) {
    const entry = bySession.get(turn.session) ?? { evs: [], turns: [] };
    bySession.set(turn.session, entry);
    entry.turns.push(turn);
    entry.evs.push({ t: turn.at, o: 1, turn });
    entry.evs.push({ t: turn.settledAt, o: 2, turn });
  }
  for (const c of corrections) {
    const entry = bySession.get(c.session);
    if (entry === undefined) continue;
    entry.evs.push({ t: c.at, o: 0, corr: c });
  }

  for (const { evs } of bySession.values()) {
    evs.sort((a, b) => a.t - b.t || a.o - b.o);
    /** identityKey\0digest → last time it became high (REPEAT_WINDOW_MS, per session). */
    const reask = new Map<string, number>();
    let memo: { row: ReplayRow; settledAt: number; corrected: boolean } | undefined;

    for (const ev of evs) {
      if (ev.corr !== undefined) {
        const c = ev.corr;
        if ((c.origin !== "tui" && c.origin !== "replay") || !c.corrHit) continue;
        if (memo === undefined || memo.corrected) continue;
        const delta = c.at - memo.settledAt;
        if (delta < 0 || delta > CORRECTION_WINDOW_MS) continue;
        memo.corrected = true;
        memo.row.corrected = true; // patched in place; read at output time
        continue;
      }
      const turn = ev.turn!;
      if (ev.o === 1) {
        // input — gate on ideal TUI facts, then the two-layer matcher.
        const cls = classify(turn, cat, builtin, drafts, caps);
        const row: ReplayRow = {
          turn,
          cls,
          acceptance: turn.unknownFacts.length === 0 ? "confirmed" : "lenient",
          reasked: false,
          corrected: false,
        };
        if (cls.k === "high") {
          const script = scriptById(cat, cls.layer, cls.scriptId);
          const key =
            script !== undefined
              ? `${identityKey({ lineage: script.lineage ?? script.id, templateHash: templateHash(script), portId: script.port.id, portVer: 0 })}\u0000${turn.digest}`
              : `${cls.scriptId}\u0000${turn.digest}`;
          const prev = reask.get(key);
          row.reasked = prev !== undefined && turn.at - prev <= REPEAT_WINDOW_MS;
          reask.set(key, turn.at);
        }
        rows.set(turn, row);
        continue;
      }
      // settle — a high candidate owns the correction memo slot from its settledAt (BA §4.3).
      const row = rows.get(turn);
      if (row !== undefined && row.cls.k === "high") {
        memo = { row, settledAt: turn.settledAt, corrected: false };
      }
    }
  }

  const out: ReplayRow[] = [];
  for (const turn of turns) {
    const row = rows.get(turn);
    if (row === undefined) continue;
    const suspect = suspectOf(row, cat);
    out.push({ ...row, ...(suspect !== undefined ? { suspect } : {}) });
  }
  return out;
}

function classify(
  turn: Turn,
  cat: ReplayCatalog,
  builtin: Matcher,
  drafts: Matcher | undefined,
  caps: ReadonlySet<Capability>,
): ReplayClass {
  const gate = evaluateGate({
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: turn.imageCount,
    text: turn.text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  });
  const norm = normalizeInput(turn.text).norm;
  if (!gate.pass) {
    // `wouldHit` reports what the two-layer matcher WOULD have done without the veto.
    const would = twoLayer(norm, builtin, drafts, caps);
    const wouldHit = would !== undefined && would.m.kind === "hit" ? would.m.scriptId : undefined;
    return { k: "veto", code: gate.veto, ...(wouldHit !== undefined ? { wouldHit } : {}) };
  }
  const hit = twoLayer(norm, builtin, drafts, caps);
  if (hit === undefined || hit.m.kind === "miss") return { k: "miss" };
  if (hit.m.kind === "hit" && hit.m.band === "high") {
    const script = scriptById(cat, hit.layer, hit.m.scriptId);
    const agree: Agreement = script !== undefined ? judgeAgreement(script, turn.shapes) : "unknown";
    return { k: "high", scriptId: hit.m.scriptId, layer: hit.layer, agree };
  }
  return { k: "ambiguous", candidates: hit.m.candidates };
}

/** Suspect precedence (single slot per row): corrected > reasked > diverge-family. */
function suspectOf(row: ReplayRow, cat: ReplayCatalog): SuspectCode | undefined {
  if (row.cls.k !== "high") return undefined;
  if (row.corrected) return "corrected";
  if (row.reasked) return "reasked";
  if (row.cls.agree === "diverge") {
    if (row.turn.hasWrite) return "write-turn";
    const script = scriptById(cat, row.cls.layer, row.cls.scriptId);
    const own = script !== undefined ? portSignatureOf(script.port.id) : undefined;
    // An empty own signature (quota.summary, BA §2) can never evidence another port ⇒ plain
    // diverge; otherwise a shape in ANOTHER port's vocabulary (and not this one) ⇒ other-port.
    if (script !== undefined && own !== undefined && own.tools.size > 0) {
      const otherPort = row.turn.shapes.some(
        (s) =>
          !own.tools.has(s) &&
          cat.builtin.some((b) => b.port.id !== script.port.id && portSignatureOf(b.port.id)?.tools.has(s) === true),
      );
      if (otherPort) return "other-port";
    }
    return "diverge";
  }
  return undefined;
}
