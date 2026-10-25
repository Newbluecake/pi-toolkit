import type { Ident, JournalEvent, Loc, Obs, Owner, TidyManifestV2, TidyRunState } from "../contracts.js";

export type VerdictKind = "roll-forward" | "roll-back" | "conflict";
export type JournalAction = { kind: "unlink"; loc: Loc; expect: Ident };
export interface Verdict {
  outcome: VerdictKind;
  /** Compatibility spellings used by executors/tests with different jargon. */
  disposition: VerdictKind;
  kind: VerdictKind;
  actions: readonly JournalAction[];
  leftovers: readonly LocationObservation[];
  reason?: string;
}

export interface LocationObservation {
  loc: Loc;
  obs: Obs;
}

export interface DecideInput {
  intent: Extract<JournalEvent, { ev: "intent" }>;
  staged?: readonly Extract<JournalEvent, { ev: "staged" }>[];
  observations: readonly LocationObservation[] | ReadonlyMap<string, Obs>;
}
export type JournalRecord = DecideInput | Extract<JournalEvent, { ev: "intent" }> | readonly JournalEvent[];

function locKey(loc: Loc): string {
  return loc.area === "tmp" ? `tmp:${loc.within}:${loc.name}` : `${loc.area}:${loc.name}`;
}
function sameIdent(a: Ident, b: Ident): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha === b.sha;
}
function sameInode(a: Ident, b: Ident): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
interface Classified {
  loc: Loc;
  obs: Obs;
  cls: "B" | "A" | "S" | "∅" | "X";
  ident?: Ident;
}

function observationMap(observations: DecideInput["observations"]): Map<string, Obs> {
  if (!Array.isArray(observations)) return new Map<string, Obs>(observations as ReadonlyMap<string, Obs>);
  return new Map<string, Obs>(
    observations.map((item: LocationObservation) => [locKey(item.loc), item.obs] as [string, Obs]),
  );
}
function stagedMap(staged: readonly Extract<JournalEvent, { ev: "staged" }>[] | undefined): Map<string, Ident> {
  const result = new Map<string, Ident>();
  for (const event of staged ?? []) result.set(locKey(event.tmp), event.ident);
  return result;
}
function classify(
  loc: Loc,
  obs: Obs | undefined,
  before: Ident | undefined,
  after: Ident | undefined,
  staged: ReadonlyMap<string, Ident>,
): Classified {
  const value = obs ?? { kind: "absent" as const };
  if (value.kind === "other") return { loc, obs: value, cls: "X" };
  if (value.kind === "absent") return { loc, obs: value, cls: "∅" };
  if (before && sameIdent(value, before)) return { loc, obs: value, cls: "B", ident: value };
  if (after && sameIdent(value, after)) return { loc, obs: value, cls: "A", ident: value };
  const stagedIdent = staged.get(locKey(loc));
  if (stagedIdent && sameIdent(value, stagedIdent)) return { loc, obs: value, cls: "S", ident: value };
  return { loc, obs: value, cls: "X", ident: value };
}
function cleanup(
  actions: JournalAction[],
  entries: readonly Classified[],
  allowed: Set<"A" | "S" | "B"> = new Set(["S"]),
): void {
  for (const entry of entries) {
    if (entry.ident && allowed.has(entry.cls as "A" | "S" | "B"))
      actions.push({ kind: "unlink", loc: entry.loc, expect: entry.ident });
  }
}
function conflict(entries: readonly Classified[], reason?: string, actions: readonly JournalAction[] = []): Verdict {
  // Only X objects are unproven ownership leftovers. B/A/S objects belong
  // to this operation and are either already in the desired state or listed
  // in actions for safe identity-checked cleanup.
  const leftovers = entries.filter((e) => e.cls === "X").map(({ loc, obs }) => ({ loc, obs }));
  return {
    outcome: "conflict",
    disposition: "conflict",
    kind: "conflict",
    actions,
    leftovers,
    ...(reason ? { reason } : {}),
  };
}
function done(outcome: Exclude<VerdictKind, "conflict">, actions: readonly JournalAction[] = []): Verdict {
  return { outcome, disposition: outcome, kind: outcome, actions, leftovers: [] };
}

/**
 * Decide recovery from an intent and the observations belonging to that op.
 * This is deliberately conservative: an object not proven to be the before,
 * after, or staged identity is X and is never removed.
 */
export function decide(input: DecideInput): Verdict;
export function decide(
  record: readonly JournalEvent[],
  observations: readonly LocationObservation[] | ReadonlyMap<string, Obs>,
): Verdict;
export function decide(
  intent: Extract<JournalEvent, { ev: "intent" }>,
  observations: readonly LocationObservation[] | ReadonlyMap<string, Obs>,
  staged?: readonly Extract<JournalEvent, { ev: "staged" }>[],
): Verdict;
export function decide(
  inputOrIntent: DecideInput | Extract<JournalEvent, { ev: "intent" }> | readonly JournalEvent[],
  observationsArg?: readonly LocationObservation[] | ReadonlyMap<string, Obs>,
  stagedArg?: readonly Extract<JournalEvent, { ev: "staged" }>[],
): Verdict {
  let input: DecideInput;
  if (Array.isArray(inputOrIntent)) {
    const intent = inputOrIntent.find(
      (event): event is Extract<JournalEvent, { ev: "intent" }> => event.ev === "intent",
    );
    if (!intent) throw new Error("journal record has no intent");
    input = {
      intent,
      observations: observationsArg ?? [],
      staged: inputOrIntent.filter((event): event is Extract<JournalEvent, { ev: "staged" }> => event.ev === "staged"),
    };
  } else if ("ev" in inputOrIntent) {
    input = { intent: inputOrIntent, observations: observationsArg ?? [], ...(stagedArg ? { staged: stagedArg } : {}) };
  } else {
    input = inputOrIntent as DecideInput;
  }
  const op = input.intent.op;
  const observed = observationMap(input.observations);
  const staged = stagedMap(input.staged);
  if (op.prim === "MOVE") {
    const src = classify(op.src, observed.get(locKey(op.src)), op.obj, undefined, staged);
    const dst = classify(op.dst, observed.get(locKey(op.dst)), undefined, op.obj, staged);
    if (src.cls === "B" && dst.cls === "∅") return done("roll-back");
    if (src.cls === "B" && dst.cls === "A" && src.ident && dst.ident && sameInode(src.ident, dst.ident)) {
      return done("roll-forward", [{ kind: "unlink", loc: op.src, expect: op.obj }]);
    }
    if (src.cls === "∅" && dst.cls === "A") return done("roll-forward");
    return conflict([src, dst], src.cls === "∅" && dst.cls === "∅" ? "missing" : undefined);
  }
  if (op.prim === "CREATE") {
    const stagedIdent = staged.get(locKey(op.tmpContent));
    const target = classify(op.target, observed.get(locKey(op.target)), undefined, stagedIdent, staged);
    const tmp = classify(op.tmpContent, observed.get(locKey(op.tmpContent)), undefined, undefined, staged);
    if (target.cls === "∅" && tmp.cls === "∅") return done("roll-back");
    if (target.cls === "∅" && tmp.cls === "S")
      return done("roll-back", tmp.ident ? [{ kind: "unlink", loc: tmp.loc, expect: tmp.ident }] : []);
    if (target.cls === "A" && tmp.cls === "S" && target.ident && tmp.ident && sameInode(target.ident, tmp.ident)) {
      return done("roll-forward", [{ kind: "unlink", loc: tmp.loc, expect: tmp.ident }]);
    }
    if (target.cls === "A" && tmp.cls === "∅") return done("roll-forward");
    if (target.cls === "X") {
      const actions: JournalAction[] = [];
      cleanup(actions, [tmp]);
      return conflict([target, tmp], undefined, actions);
    }
    return conflict([target, tmp]);
  }
  const backupIdent = staged.get(locKey(op.tmpBackup));
  const contentIdent = staged.get(locKey(op.tmpContent));
  const target = classify(op.target, observed.get(locKey(op.target)), op.before, contentIdent, staged);
  const backup = classify(op.backup, observed.get(locKey(op.backup)), undefined, backupIdent, staged);
  const tmpBackup = classify(op.tmpBackup, observed.get(locKey(op.tmpBackup)), undefined, undefined, staged);
  const tmpContent = classify(op.tmpContent, observed.get(locKey(op.tmpContent)), undefined, undefined, staged);
  const entries = [target, backup, tmpBackup, tmpContent];
  const extras: JournalAction[] = [];
  const hasX = entries.some((entry) => entry.cls === "X");
  if (target.cls === "B") {
    cleanup(extras, [backup, tmpBackup, tmpContent], new Set(["A", "S"]));
    return hasX ? conflict(entries, undefined, extras) : done("roll-back", extras);
  }
  if (target.cls === "A" && backup.cls === "A") {
    cleanup(extras, [tmpBackup, tmpContent]);
    return hasX ? conflict(entries, "foreign leftover", extras) : done("roll-forward", extras);
  }
  if (target.cls === "X") {
    cleanup(extras, [tmpBackup, tmpContent]);
    return conflict(entries, undefined, extras);
  }
  if (target.cls === "∅") return conflict(entries, "missing", extras);
  return conflict(entries, undefined, extras);
}

export interface FoldedJournal {
  manifest: TidyManifestV2;
  run: Extract<JournalEvent, { ev: "run" }> | undefined;
  owner: Owner | undefined;
  epoch: number;
  intents: ReadonlyMap<string, Extract<JournalEvent, { ev: "intent" }>>;
  staged: ReadonlyMap<string, readonly Extract<JournalEvent, { ev: "staged" }>[]>;
  attempts: ReadonlyMap<string, Extract<JournalEvent, { ev: "attempt" }>>;
  results: ReadonlyMap<string, Extract<JournalEvent, { ev: "result" }>>;
  terminal: boolean;
}

/** Fold append-only events without performing any IO or interpreting paths. */
export function foldEvents(manifest: TidyManifestV2): FoldedJournal {
  const intents = new Map<string, Extract<JournalEvent, { ev: "intent" }>>();
  const staged = new Map<string, Extract<JournalEvent, { ev: "staged" }>[]>();
  const attempts = new Map<string, Extract<JournalEvent, { ev: "attempt" }>>();
  const results = new Map<string, Extract<JournalEvent, { ev: "result" }>>();
  let run: Extract<JournalEvent, { ev: "run" }> | undefined;
  let epoch = 0;
  for (const event of manifest.events) {
    if (event.ev === "run") {
      run = event;
      epoch = event.epoch;
    } else if (event.ev === "intent") {
      intents.set(event.opId, event);
    } else if (event.ev === "staged") {
      const list = staged.get(event.opId) ?? [];
      list.push(event);
      staged.set(event.opId, list);
    } else if (event.ev === "attempt") {
      attempts.set(event.opId, event);
    } else {
      results.set(event.opId, event);
    }
  }
  return {
    manifest,
    run,
    owner: run?.recoveryOwner ?? run?.owner,
    epoch,
    intents,
    staged,
    attempts,
    results,
    terminal: isTerminalState(run?.state),
  };
}

export function isTerminalState(
  state: TidyRunState | undefined,
): state is "complete" | "aborted" | "recovered" | "conflict-reported" {
  return state === "complete" || state === "aborted" || state === "recovered" || state === "conflict-reported";
}

export type RunTransitionEvent = Extract<JournalEvent, { ev: "run" }>;
export interface StateTransitionResult {
  ok: boolean;
  state: TidyRunState;
  reason?: string;
}

/** Validate the run state machine. Terminal states intentionally permit a new run. */
export function transitionRunState(
  from: TidyRunState | undefined,
  to: TidyRunState,
  context?: { allResults?: boolean; hasConflict?: boolean; ownerAlive?: boolean; ownerRevoked?: boolean },
): StateTransitionResult {
  if (from === undefined)
    return to === "applying"
      ? { ok: true, state: to }
      : { ok: false, state: from as unknown as TidyRunState, reason: "run must start applying" };
  if (isTerminalState(from))
    return to === "applying"
      ? { ok: true, state: to }
      : { ok: false, state: from, reason: "terminal run cannot transition" };
  if (from === "applying") {
    if (to === "interrupted")
      return context?.ownerAlive === false || context?.ownerRevoked === true
        ? { ok: true, state: to }
        : { ok: false, state: from, reason: "owner is still active" };
    if (to === "complete" || to === "aborted" || to === "conflict-reported") {
      if (context?.allResults !== true) return { ok: false, state: from, reason: "missing results" };
      if (to === "conflict-reported" && context.hasConflict !== true)
        return { ok: false, state: from, reason: "no conflict to report" };
      if ((to === "complete" || to === "aborted") && context.hasConflict === true)
        return { ok: false, state: from, reason: "conflict pending" };
      return { ok: true, state: to };
    }
  }
  if (from === "interrupted") {
    if (to === "interrupted")
      return context?.ownerAlive === false || context?.ownerRevoked === true
        ? { ok: true, state: to }
        : { ok: false, state: from, reason: "recovery owner is still active" };
    if (to === "recovered" || to === "conflict-reported") {
      if (context?.allResults !== true) return { ok: false, state: from, reason: "missing results" };
      if (to === "conflict-reported" && context.hasConflict !== true)
        return { ok: false, state: from, reason: "no conflict to report" };
      if (to === "recovered" && context.hasConflict === true)
        return { ok: false, state: from, reason: "conflict pending" };
      return { ok: true, state: to };
    }
  }
  return { ok: false, state: from, reason: `invalid transition ${from} -> ${to}` };
}

export function validateRunEvents(events: readonly JournalEvent[]): { ok: boolean; reason?: string } {
  let state: TidyRunState | undefined;
  let epoch = 0;
  const intents = new Set<string>();
  const results = new Map<string, Extract<JournalEvent, { ev: "result" }>>();
  for (const event of events) {
    if (event.ev === "intent") intents.add(event.opId);
    if (event.ev === "result") results.set(event.opId, event);
    if (event.ev !== "run") continue;
    if (!Number.isSafeInteger(event.epoch) || event.epoch < 0 || event.epoch < epoch)
      return { ok: false, reason: "run epoch must be a non-decreasing non-negative integer" };
    const hasConflict = [...results.values()].some((result) => result.state === "conflict");
    const allResults = results.size >= intents.size;
    const transition = transitionRunState(state, event.state, {
      allResults,
      hasConflict,
      ownerAlive: event.state !== "interrupted",
      ownerRevoked: false,
    });
    if (!transition.ok) return transition.reason ? { ok: false, reason: transition.reason } : { ok: false };
    state = event.state;
    epoch = event.epoch;
  }
  return { ok: true };
}
