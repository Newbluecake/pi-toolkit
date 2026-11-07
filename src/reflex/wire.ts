/**
 * jev-reflex · pi-facing assembly (plan R0 step 8 + R2b + R3a; arch §4.2). The six registrations and
 * their order are frozen by R0 (activate-trace `max` pins it). R2b filled the SHADOW behaviour; R3a adds
 * the AUTO branch (plan R3a steps 0–2): high ∧ effective state "auto" answers in-band — the ONLY path
 * that awaits and the ONLY sender of `subagent:reflex` custom messages (§5.1); everything else still
 * behaves as shadow.
 *
 * Invariants kept here: R-I1 (secure/locked ⇒ zero registration), R-I3 (never sendUserMessage /
 * triggerTurn / transform; the single sanctioned outbound message is the AUTO answer's
 * `sendMessage({customType:"subagent:reflex", …})` with NO options — idle append, no run), R-I4 (only an
 * in-budget `ok` AUTO port result returns `handled`; every other outcome — including exceptions —
 * returns `continue`), R-I5 (the input handler stays a plain non-async function; every branch except
 * AUTO returns synchronously, shadow ports run in a microtask), R-I7 (generation/disposed protocol,
 * PD11; the AUTO continuation captures its generation and drops itself when stale), R-I8 (all mutable
 * state in this closure, no `Symbol.for`; timers only via the injected Clock).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../core/agent-dir.js";
import { systemClock, type Clock } from "../core/clock.js";
import { createReflexCommand } from "./command.js";
import { collectToolShapes, judgeAgreement } from "./core/agreement.js";
import { toBranchLike } from "./core/branch-like.js";
import { PENDING_MAX_AGE_MS, REFLEX_BUDGET_MS, REPEAT_WINDOW_MS } from "./core/budget.js";
import { BUILTIN_SCRIPTS } from "./core/catalog.js";
import { requestDigest } from "./core/digest.js";
import { evaluateGate } from "./core/gate.js";
import { compileCatalog, type Matcher } from "./core/match.js";
import { normalizeInput } from "./core/normalize.js";
import { renderAnswer } from "./core/render.js";
import type { ReflexSettings } from "./core/settings.js";
import {
  detectCorrection,
  effectiveState,
  onCorrected,
  onExecOutcome,
  onRepeat,
  reset,
  type CorrectionMemo,
} from "./core/state.js";
import type {
  Agreement,
  Band,
  DraftLoadResult,
  ExecOutcome,
  LoadedDraft,
  ReflexCorrectionV1,
  ReflexRecordV1,
  ReflexStatusSnapshot,
  RScriptV1,
  ScriptRuntime,
  ScriptState,
} from "./core/types.js";
import { loadDrafts, type DraftFs } from "./drafts/load.js";
import { createPortRegistry, executePort, type ReflexPortDeps } from "./ports/index.js";
import { renderReflexMessage } from "./render-tui.js";

export interface ReflexWireDeps {
  /** Live getter (autoResolve is re-read on every input). */
  settings: () => ReflexSettings;
  secureDomainKind: "plain" | "secure" | "locked";
  ports: ReflexPortDeps;
  fences: {
    /** Late-bound: topic-switch is wired AFTER the R layer. */
    topicSwitchActive: () => boolean;
    goalBusy: () => boolean;
  };
  /** PD9: injected wall clock (default `systemClock`, unref'd + segmented). Tests pass a FakeClock. */
  clock?: Clock;
  /** PD9: monotonic ms for port durations (default `performance.now`). */
  monoNow?: () => number;
  /** Test hook: alternative catalog (default `BUILTIN_SCRIPTS`). */
  scripts?: readonly RScriptV1[];
  /** #25 BD9: test hook — drafts directory (default `<agentDir>/reflex/drafts`, computed inside, only when drafts are on). */
  draftsDir?: string;
  /** #25 BD9: test hook — injectable fs for the draft loader (default `node:fs/promises`). */
  draftFs?: DraftFs;
}

export interface ReflexWiring {
  /** Read-only snapshot for the command and tests. */
  snapshot(): ReflexStatusSnapshot;
  /** PD11: late async settles must be dropped when `disposed || gen !== generation`. */
  isStale(gen: number): boolean;
  generation(): number;
}

/** One un-settled candidate (single slot): shadow / ambiguous (R2b), fallback / repeat (R3a AUTO). */
interface Pending {
  /** #25: who owns the slot. A "draft" slot is shadow-only: it never touches `stateOf`/runtimes/AUTO. */
  origin: "builtin" | "draft";
  /** Draft slots only: identity written onto the record (builtin records get NO new fields, BD11). */
  draft?: { templateHash: string; draftHash: string };
  kind: "shadow" | "ambiguous" | "fallback" | "repeat";
  at: number;
  scriptId: string;
  scriptVer: number;
  candidates?: readonly string[];
  state: ScriptState;
  band: Band;
  digest: string;
  chars: number;
  reasked: boolean;
  port?: NonNullable<ReflexRecordV1["port"]>;
}

/** The correction memo plus (draft targets only) the template hash the correction entry must carry. */
type WireMemo = CorrectionMemo & { draft?: { templateHash: string } };

const REASK_MAP_CAP = 64;

// #25 B0 (BA §4.1): `toBranchLike` moved VERBATIM to `core/branch-like.ts` (shared with the
// offline backtest); this import swap is the ONLY wire.ts change B0 makes.

/** Double lock: `secureDomainKind !== "plain"` ⇒ return undefined, zero registrations. */
export function wireReflex(pi: ExtensionAPI, deps: ReflexWireDeps): ReflexWiring | undefined {
  if (deps.secureDomainKind !== "plain") return undefined;

  const clock = deps.clock ?? systemClock;
  const monoNow = deps.monoNow ?? (() => performance.now());
  const catalog = deps.scripts ?? BUILTIN_SCRIPTS;
  const scriptById = new Map(catalog.map((s) => [s.id, s]));
  const matcher = compileCatalog(catalog);
  const registry = createPortRegistry(deps.ports);

  // ---- closure state (I4/R-I8) ----
  let disposed = false;
  let generation = 0;
  let inFlight = false; // R3a: true only while an AUTO answer awaits in-band (single-flight, arch R3/C-R7)
  let abort = new AbortController();
  let pending: Pending | undefined;
  let memo: WireMemo | undefined;
  /** `${id}@${ver}\0${digest}` → time it last became a candidate (PD6 window; per session). */
  const recent = new Map<string, number>();
  /** `${id}@${ver}\0${digest}` → time reflex last ANSWERED it (AUTO repeat window, PD5; per session). */
  const answers = new Map<string, number>();
  /** Script demote overlay: survives sessions until `/reflex reset` or `/reload` (PD11). */
  const runtimes = new Map<string, ScriptRuntime>();
  const counters: Record<string, number> = {
    candidates: 0,
    answered: 0,
    ambiguous: 0,
    repeat: 0,
    reasked: 0,
    corrected: 0,
  };
  const bump = (k: string): void => {
    counters[k] = (counters[k] ?? 0) + 1;
  };

  // ---- #25 runtime drafts (BD8): loaded once per activation, shadow-only ----
  let draftResult: DraftLoadResult | undefined;
  let draftLoad: AbortController | undefined;
  let draftMatcher: Matcher | undefined;
  const draftById = new Map<string, LoadedDraft>();
  const draftsEnabled = (): boolean => deps.settings().drafts?.enabled === true;
  const draftsDirPath = (): string =>
    deps.draftsDir ?? join(resolveAgentDir(process.env, homedir()).dir, "reflex", "drafts");

  const isStale = (gen: number): boolean => disposed || gen !== generation;
  const rtOf = (id: string): ScriptRuntime => runtimes.get(id) ?? { strikes: 0, demoted: false };
  const stateOf = (id: string): ScriptState => effectiveState(id, deps.settings().autoResolve, rtOf(id));
  const CONTINUE: InputEventResult = { action: "continue" };

  /** Best-effort audit append; `true` iff the entry was actually persisted. */
  const safeAppend = (customType: string, data: unknown): boolean => {
    try {
      pi.appendEntry(customType, data);
      return true;
    } catch {
      /* best-effort audit: a failed append never affects the session */
      return false;
    }
  };

  /** Persist the pending slot as exactly one record and empty the slot. */
  const settlePending = (p: Pending, model: { agree: Agreement; tools: readonly string[] }): void => {
    if (pending === p) pending = undefined;
    const rec: ReflexRecordV1 = {
      v: 1,
      kind: p.kind,
      at: p.at,
      scriptId: p.scriptId,
      scriptVer: p.scriptVer,
      ...(p.candidates !== undefined ? { candidates: p.candidates } : {}),
      state: p.state,
      band: p.band,
      requestDigest: p.digest,
      chars: p.chars,
      ...(p.port !== undefined ? { port: p.port } : {}),
      model,
      ...(p.reasked ? { reasked: true as const } : {}),
      ...(p.origin === "draft" && p.draft !== undefined
        ? { origin: "draft" as const, draftHash: p.draft.draftHash, templateHash: p.draft.templateHash }
        : {}),
    };
    safeAppend("subagent:reflex-record", rec);
    // Any model-answered outcome (shadow / fallback / repeat) can be corrected next; an ambiguous
    // slot has no single script to attribute a correction to (R2b semantics, kept by R3a).
    if (p.kind !== "ambiguous") {
      memo = {
        kind: "shadow",
        scriptId: p.scriptId,
        scriptVer: p.scriptVer,
        digest: p.digest,
        settledAt: clock.now(),
        corrected: false,
        ...(p.origin === "draft" && p.draft !== undefined ? { draft: { templateHash: p.draft.templateHash } } : {}),
      };
    }
  };

  /** Entry-time age check (no timers): an over-age slot is flushed as unknown. */
  const flushIfOverAge = (now: number): void => {
    const p = pending;
    if (p !== undefined && now - p.at > PENDING_MAX_AGE_MS) settlePending(p, { agree: "unknown", tools: [] });
  };

  /** Insert-order LRU touch shared by the candidate and answer windows (cap REASK_MAP_CAP). */
  const remember = (map: Map<string, number>, key: string, now: number): void => {
    map.delete(key);
    map.set(key, now);
    while (map.size > REASK_MAP_CAP) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  /**
   * Run the read-only port off the input path (microtask) and attach the outcome to `p` (#25: shared by
   * builtin and draft slots; it NEVER touches script state). `onOutcome` runs right after the attach, only
   * for the slot owner that wants state accounting (builtin).
   */
  const runPortAttach = (
    p: Pending,
    script: RScriptV1,
    cwd: string,
    onOutcome?: (outcome: ExecOutcome) => void,
  ): void => {
    const gen = generation;
    const signal = abort.signal;
    queueMicrotask(() => {
      void (async () => {
        try {
          const port = registry.get(script.port.id);
          const t0 = monoNow();
          const outcome: ExecOutcome =
            port === undefined
              ? { kind: "unavailable", reason: "no port" }
              : await executePort(
                  port,
                  { cwd, now: clock.now(), signal, budgetMs: script.budgetMs ?? REFLEX_BUDGET_MS },
                  clock,
                );
          const ms = Math.max(0, Math.round(monoNow() - t0));
          // PD11: a late settle from a shut-down / replaced session, or for a replaced slot, is dropped.
          if (isStale(gen) || pending !== p) return;
          p.port = {
            outcome: outcome.kind,
            ms,
            ...("reason" in outcome ? { reason: outcome.reason.slice(0, 80) } : {}),
            portVer: port?.version ?? 0,
            ...(p.origin === "draft" ? { portId: script.port.id } : {}),
          };
          onOutcome?.(outcome);
        } catch {
          /* fail-open: the shadow slot just keeps no port data */
        }
      })();
    });
  };

  /**
   * Builtin-only state accounting (strikes / demote overlay). Callers MUST be inside an
   * `origin === "builtin"` branch (G5 scans for it); the id check is the runtime backstop.
   */
  const accountBuiltin = (script: RScriptV1, outcome: ExecOutcome, onDemoted: (rt: ScriptRuntime) => void): void => {
    if (!scriptById.has(script.id)) return;
    const before = stateOf(script.id);
    const r = onExecOutcome(rtOf(script.id), outcome, clock.now());
    runtimes.set(script.id, r.rt);
    if (r.demotedNow && before === "auto") {
      try {
        onDemoted(r.rt);
      } catch {
        /* ui best-effort */
      }
    }
  };

  /** AUTO admission: only a builtin id from the catalog whose effective state is "auto" (R-I12). */
  const admitAuto = (id: string): boolean => scriptById.has(id) && stateOf(id) === "auto";

  const scheduleShadowPort = (p: Pending, script: RScriptV1, cwd: string, notify: (m: string) => void): void => {
    if (p.origin === "builtin") {
      runPortAttach(p, script, cwd, (outcome) =>
        accountBuiltin(script, outcome, (rt) =>
          notify(`reflex: ${script.id} demoted to shadow (${rt.demoteReason ?? "strikes"})`),
        ),
      );
    } else {
      runPortAttach(p, script, cwd); // draft: port evidence only — no strikes, no overlay, no notify
    }
  };

  /**
   * R3a AUTO branch (plan R3a step 1) — the only awaited path, strictly in-band (≤ REFLEX_BUDGET_MS
   * via raceBudget inside executePort). `gen` is captured at dispatch: every side effect after the
   * await re-checks `isStale(gen)`, so an await that crossed a shutdown / session switch leaves zero
   * traces (PD11). A non-ok outcome never answers: it falls back to the model and the slot settles
   * into a `kind:"fallback"` record at agent_settled (R-I4).
   */
  const runAuto = async (
    script: RScriptV1,
    p: Pending,
    key: string,
    event: InputEvent,
    ctx: ExtensionContext,
    gen: number,
  ): Promise<InputEventResult> => {
    try {
      ctx.ui?.setStatus?.("reflex", "reflex…");
      const port = registry.get(script.port.id);
      const t0 = monoNow();
      const outcome: ExecOutcome =
        port === undefined
          ? { kind: "unavailable", reason: "no port" }
          : await executePort(
              port,
              {
                cwd: ctx.cwd,
                now: clock.now(),
                signal: abort.signal,
                budgetMs: script.budgetMs ?? REFLEX_BUDGET_MS,
              },
              clock,
            );
      const ms = Math.max(0, Math.round(monoNow() - t0));
      // PD11: the await crossed a shutdown / session switch — drop everything (no send, no
      // append, no strike) and let the re-armed closure serve the new session.
      if (isStale(gen)) return CONTINUE;
      if (outcome.kind === "ok") {
        const rendered = renderAnswer({ script, outcome, question: event.text, ms, portVer: port?.version ?? 0 });
        pi.sendMessage({
          customType: "subagent:reflex",
          content: rendered.content,
          display: true,
          details: rendered.details,
        });
        bump("answered");
        remember(answers, key, clock.now()); // repeat-window anchor (PD5/PD6)
        if (pending === p) pending = undefined; // answered ⇒ no reflex-record at agent_settled (§5.1)
        memo = {
          kind: "answer",
          scriptId: script.id,
          scriptVer: script.version,
          digest: p.digest,
          settledAt: clock.now(),
          corrected: false,
        }; // a later correction of THIS answer demotes the script (PD12/PD5)
        return { action: "handled" };
      }
      if (p.origin === "builtin") {
        accountBuiltin(script, outcome, () =>
          ctx.ui?.notify?.(`reflex：${script.id} 连续失败，已降回 shadow（/reflex reset 或 /reload 恢复）`, "warning"),
        );
      }
      bump(`fallback.${outcome.kind}`);
      p.kind = "fallback";
      p.port = {
        outcome: outcome.kind,
        ms,
        ...("reason" in outcome ? { reason: outcome.reason.slice(0, 80) } : {}),
        portVer: port?.version ?? 0,
      };
      return CONTINUE;
    } catch {
      return CONTINUE; // fail-open (R-I4): anything unexpected degrades to "the model answers as usual"
    } finally {
      // Only the CURRENT session's continuation may clear the single-flight guard and the status
      // line — a shut-down / replaced session's re-arm has already reset them (PD11).
      if (!isStale(gen)) {
        inFlight = false;
        try {
          ctx.ui?.setStatus?.("reflex", undefined);
        } catch {
          /* ui best-effort */
        }
      }
    }
  };

  /**
   * BD8: on every `session_start`, if drafts are on and there is neither a result nor a load in flight,
   * start the one-shot bounded load. The finished result survives re-arms until `/reload`; an aborted
   * load (shutdown mid-flight) is dropped so the next start retries. Never notifies, never sets status.
   */
  const startDraftLoad = (): void => {
    if (!draftsEnabled() || draftResult !== undefined || draftLoad !== undefined) return;
    const ac = new AbortController();
    draftLoad = ac;
    void loadDrafts(draftsDirPath(), new Set(scriptById.keys()), clock, ac.signal, deps.draftFs)
      .then((res) => {
        if (draftLoad === ac) draftLoad = undefined;
        if (ac.signal.aborted) return;
        draftResult = res;
        draftById.clear();
        for (const d of res.loaded) draftById.set(d.script.id, d);
        draftMatcher = res.loaded.length > 0 ? compileCatalog(res.loaded.map((d) => d.script)) : undefined;
      })
      .catch(() => {
        if (draftLoad === ac) draftLoad = undefined;
      });
  };

  /**
   * #25 draft candidate (builtin MISSED, drafts loaded). Shadow-only by construction: no `stateOf`, no
   * `runtimes`, no `runAuto` — only a slot whose port evidence lands on the record. Always a sync `continue`.
   */
  const draftCandidate = (norm: string, chars: number, now: number, ctx: ExtensionContext): InputEventResult => {
    const dm = draftMatcher?.match(norm, registry.capabilities());
    if (dm === undefined || dm.kind === "miss") return CONTINUE;
    const loaded = draftById.get(dm.scriptId);
    if (loaded === undefined) return CONTINUE;
    const script = loaded.script;
    const digest = requestDigest(norm);
    const old = pending;
    if (old !== undefined) settlePending(old, { agree: "unknown", tools: [] }); // single slot (shared with builtin)
    const ref = { templateHash: loaded.templateHash, draftHash: loaded.draftHash };
    if (dm.band === "ambiguous") {
      bump("draft.ambiguous");
      pending = {
        origin: "draft",
        draft: ref,
        kind: "ambiguous",
        at: now,
        scriptId: script.id,
        scriptVer: script.version,
        candidates: dm.candidates,
        state: "shadow",
        band: "ambiguous",
        digest,
        chars,
        reasked: false,
      };
      return CONTINUE;
    }
    const key = `${script.id}@${script.version}\u0000${digest}`;
    const prev = recent.get(key);
    const reasked = prev !== undefined && now - prev <= REPEAT_WINDOW_MS;
    remember(recent, key, now);
    bump("draft.candidates");
    if (reasked) bump("draft.reasked");
    const p: Pending = {
      origin: "draft",
      draft: ref,
      kind: "shadow",
      at: now,
      scriptId: script.id,
      scriptVer: script.version,
      state: "shadow", // a draft is ALWAYS shadow, whatever `autoResolve` says (R-I12)
      band: "high",
      digest,
      chars,
      reasked,
    };
    pending = p;
    const ui = ctx.ui;
    scheduleShadowPort(p, script, ctx.cwd, (msg) => ui.notify(msg, "warning"));
    return CONTINUE;
  };

  // ① input — plain (non-async) function. fail-open on purpose: pi's docs suggest fail-closed for guards, but this
  // layer is purely advisory — any bug must degrade to "the model answers as usual", never to a dropped input.
  // R3a step 0: every branch returns a synchronous `InputEventResult` EXCEPT the AUTO branch, which
  // returns runAuto(…)'s promise (`ExtensionHandler` allows `R | Promise<R>`).
  pi.on("input", (event, ctx) => {
    try {
      const now = clock.now();
      flushIfOverAge(now);

      // PD12: a correction is persisted right here, independent of what S0/S1 decide about this very input.
      if (event.source === "interactive" && ctx.mode === "tui") {
        const c = detectCorrection(normalizeInput(event.text).norm, memo, now);
        if (c !== undefined && memo !== undefined) {
          const target = memo;
          // #25: a correction of a DRAFT candidate carries its origin + template hash (builtin entries stay
          // byte-identical) and never demotes anything — drafts have no state machine.
          const entry: ReflexCorrectionV1 =
            target.draft !== undefined
              ? { ...c, targetOrigin: "draft", targetTemplateHash: target.draft.templateHash }
              : c;
          const written = safeAppend("subagent:reflex-correction", entry);
          // Flip the one-shot ONLY when the entry was actually persisted (root nit b): a failed
          // append leaves the window open so a later correction can retry it.
          if (written) {
            memo = { ...target, corrected: true };
            bump(target.draft !== undefined ? "draft.corrected" : "corrected");
          }
          // A corrected AUTO answer demotes immediately (PD5) + one notify. The persisted entry
          // above is the audit record; the demote is behaviour and happens either way.
          if (target.kind === "answer" && target.draft === undefined) {
            const r = onCorrected(rtOf(target.scriptId), clock.now(), stateOf(target.scriptId));
            runtimes.set(target.scriptId, r.rt);
            if (r.demotedNow) {
              try {
                ctx.ui?.notify?.(
                  `reflex：${target.scriptId} 作答被纠正，已降回 shadow（/reflex reset 或 /reload 恢复）`,
                  "warning",
                );
              } catch {
                /* ui best-effort */
              }
            }
          }
        }
      }

      const gate = evaluateGate({
        source: event.source,
        mode: ctx.mode,
        streamingBehavior: event.streamingBehavior,
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
        imageCount: event.images?.length ?? 0,
        text: event.text,
        topicSwitchActive: deps.fences.topicSwitchActive(),
        goalBusy: deps.fences.goalBusy(),
        inFlight,
      });
      if (!gate.pass) return CONTINUE;

      const m = matcher.match(gate.norm.norm, registry.capabilities());
      // #25 K2: drafts only get a look when the builtin catalog MISSES (builtin behaviour stays untouched).
      if (m.kind === "miss") {
        return draftMatcher === undefined ? CONTINUE : draftCandidate(gate.norm.norm, gate.norm.chars, now, ctx);
      }
      const script = scriptById.get(m.scriptId);
      if (script === undefined) return CONTINUE;

      const digest = requestDigest(gate.norm.norm);
      const old = pending;
      if (old !== undefined) settlePending(old, { agree: "unknown", tools: [] }); // single slot

      if (m.band === "ambiguous") {
        bump("ambiguous");
        pending = {
          origin: "builtin",
          kind: "ambiguous",
          at: now,
          scriptId: script.id,
          scriptVer: script.version,
          candidates: m.candidates,
          state: stateOf(script.id),
          band: "ambiguous",
          digest,
          chars: gate.norm.chars,
          reasked: false,
        };
        return CONTINUE;
      }

      // band high — AUTO (R3a) or shadow (R2b path). The effective state is read LIVE here: an
      // autoResolve edit via /agent settings takes effect on the very next input (I8 live setting).
      const state = stateOf(script.id);
      const key = `${script.id}@${script.version}\u0000${digest}`;
      const prev = recent.get(key);
      const reasked = prev !== undefined && now - prev <= REPEAT_WINDOW_MS;
      remember(recent, key, now);
      bump("candidates");
      if (reasked) bump("reasked");
      const p: Pending = {
        origin: "builtin",
        kind: "shadow",
        at: now,
        scriptId: script.id,
        scriptVer: script.version,
        state,
        band: "high",
        digest,
        chars: gate.norm.chars,
        reasked,
      };
      pending = p;

      if (admitAuto(script.id)) {
        // Repeat escape hatch (PD5/PD6): this exact question was ANSWERED within the window ⇒ hand
        // it to the model, demote immediately, notify once. Synchronous `continue` (no await).
        const ansAt = answers.get(key);
        if (ansAt !== undefined && now - ansAt <= REPEAT_WINDOW_MS) {
          const r = onRepeat(rtOf(script.id), clock.now(), state);
          runtimes.set(script.id, r.rt);
          if (r.demotedNow) {
            try {
              ctx.ui?.notify?.(
                `reflex：${script.id} 检测到同一问题重复提问，已降回 shadow（/reflex reset 或 /reload 恢复）`,
                "warning",
              );
            } catch {
              /* ui best-effort */
            }
          }
          bump("repeat");
          // A repeat record already counts as a re-ask (promotion 口径: `state:"auto"` +
          // `kind:"repeat"`); reasked stays false so it is not counted twice.
          pending = { ...p, kind: "repeat", reasked: false };
          return CONTINUE;
        }
        inFlight = true; // single-flight: inputs arriving during the await are vetoed in-flight (S0)
        const gen = generation;
        return runAuto(script, p, key, event, ctx, gen).catch(() => CONTINUE);
      }

      // shadow / demoted — sync continue; the read-only port runs off the input path (R-I5).
      const ui = ctx.ui;
      scheduleShadowPort(p, script, ctx.cwd, (msg) => ui.notify(msg, "warning"));
      return CONTINUE;
    } catch {
      return CONTINUE;
    }
  });

  // ② agent_settled — the shadow record is persisted here, with the model's tool shapes as agreement.
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    try {
      flushIfOverAge(clock.now());
      const p = pending;
      if (p === undefined) return;
      let model: { agree: Agreement; tools: readonly string[] } = { agree: "unknown", tools: [] };
      try {
        const branch = ctx.sessionManager.getBranch();
        const collected = collectToolShapes(toBranchLike(branch as readonly unknown[]), p.digest);
        const script = p.origin === "draft" ? draftById.get(p.scriptId)?.script : scriptById.get(p.scriptId);
        if (collected.status === "ok") {
          // An ambiguous slot has no single script to judge against ⇒ unknown, shapes kept for
          // audit; shadow / fallback / repeat slots all name one script and ARE judged (R3a).
          model =
            p.kind !== "ambiguous" && script !== undefined
              ? { agree: judgeAgreement(script, collected.shapes), tools: collected.shapes }
              : { agree: "unknown", tools: collected.shapes };
        }
      } catch {
        /* getBranch unavailable ⇒ unknown */
      }
      settlePending(p, model);
    } catch {
      /* fail-open */
    }
  });

  // ③ session_start — PD11 re-arm: the same closure serves the next session of this activation.
  pi.on("session_start", () => {
    disposed = false;
    abort = new AbortController();
    pending = undefined;
    memo = undefined;
    recent.clear();
    answers.clear(); // the repeat/correction windows bind to THIS session's transcript (PD11)
    inFlight = false;
    startDraftLoad();
  });

  // ④ session_shutdown — abort in-flight work, drop pending (NOT persisted), bump generation.
  pi.on("session_shutdown", () => {
    try {
      abort.abort();
    } catch {
      /* best-effort */
    }
    try {
      draftLoad?.abort(); // an in-flight draft load is cancelled; its result is dropped (retried on the next start)
      draftLoad = undefined;
    } catch {
      /* best-effort */
    }
    pending = undefined;
    disposed = true;
    generation += 1;
  });

  // ⑤ renderer (probe-registered: hosts without the API fall back to pi's default rendering).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer("subagent:reflex", renderReflexMessage);
  }

  const snapshot = (): ReflexStatusSnapshot => {
    const known = new Set(catalog.map((s) => s.id));
    return {
      enabled: deps.settings().enabled,
      generation,
      disposed,
      inFlight,
      scripts: catalog.map((s) => {
        const rt = rtOf(s.id);
        return {
          id: s.id,
          state: stateOf(s.id),
          strikes: rt.strikes,
          ...(rt.demoteReason !== undefined ? { demoteReason: rt.demoteReason } : {}),
        };
      }),
      counters: { ...counters },
      unknownAutoResolve: deps.settings().autoResolve.filter((id) => !known.has(id)),
    };
  };

  // ⑥ command
  pi.registerCommand(
    "reflex",
    createReflexCommand({
      enabled: () => deps.settings().enabled,
      autoResolve: () => deps.settings().autoResolve,
      snapshot,
      catalog,
      matcher,
      capabilities: () => registry.capabilities(),
      drafts: {
        enabled: draftsEnabled,
        dir: draftsDirPath,
        result: () => draftResult,
        loading: () => draftLoad !== undefined,
        counters: () => ({
          candidates: counters["draft.candidates"] ?? 0,
          ambiguous: counters["draft.ambiguous"] ?? 0,
          reasked: counters["draft.reasked"] ?? 0,
          corrected: counters["draft.corrected"] ?? 0,
        }),
      },
      reset: (id) => {
        if (id === undefined) {
          for (const [k, rt] of runtimes) runtimes.set(k, reset(rt));
          return true;
        }
        if (!scriptById.has(id)) return false;
        runtimes.set(id, reset(rtOf(id)));
        return true;
      },
    }),
  );

  return { snapshot, isStale, generation: () => generation };
}
