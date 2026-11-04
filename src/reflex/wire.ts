/**
 * jev-reflex · pi-facing assembly (plan R0 step 8 + R2b; arch §4.2). The six registrations and their
 * order are frozen by R0 (activate-trace `max` pins it). R2b fills the SHADOW behaviour: candidates are
 * recorded (read-only port run + one `subagent:reflex-record` at agent_settled), nothing is ever answered
 * (high ∧ auto is treated as shadow until R3a).
 *
 * Invariants kept here: R-I1 (secure/locked ⇒ zero registration), R-I3 (never sendUserMessage / sendMessage /
 * triggerTurn / transform — the input handler's only results are `continue`), R-I5 (sync input handler; ports run
 * in a microtask), R-I7 (generation/disposed protocol, PD11), R-I8 (all mutable state in this closure, no
 * `Symbol.for`; timers only via the injected Clock).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock } from "../core/clock.js";
import { createReflexCommand } from "./command.js";
import { collectToolShapes, judgeAgreement, type BranchEntryLike } from "./core/agreement.js";
import { PENDING_MAX_AGE_MS, REFLEX_BUDGET_MS, REPEAT_WINDOW_MS } from "./core/budget.js";
import { BUILTIN_SCRIPTS } from "./core/catalog.js";
import { requestDigest } from "./core/digest.js";
import { evaluateGate } from "./core/gate.js";
import { compileCatalog } from "./core/match.js";
import { normalizeInput } from "./core/normalize.js";
import type { ReflexSettings } from "./core/settings.js";
import { detectCorrection, effectiveState, onExecOutcome, reset, type CorrectionMemo } from "./core/state.js";
import type {
  Agreement,
  Band,
  ExecOutcome,
  ReflexRecordV1,
  ReflexStatusSnapshot,
  RScriptV1,
  ScriptRuntime,
  ScriptState,
} from "./core/types.js";
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
}

export interface ReflexWiring {
  /** Read-only snapshot for the command and tests. */
  snapshot(): ReflexStatusSnapshot;
  /** PD11: late async settles must be dropped when `disposed || gen !== generation`. */
  isStale(gen: number): boolean;
  generation(): number;
}

/** One un-settled shadow/ambiguous candidate (single slot). */
interface Pending {
  kind: "shadow" | "ambiguous";
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

const REASK_MAP_CAP = 64;

/** pi branch entries → the structural look-alike `core/agreement.ts` reads (no pi import in core). */
function toBranchLike(entries: readonly unknown[]): BranchEntryLike[] {
  const out: BranchEntryLike[] = [];
  for (const raw of entries) {
    const e = raw as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (e === null || typeof e !== "object" || e.type !== "message" || e.message === undefined) {
      out.push({ role: "other" });
      continue;
    }
    const role = typeof e.message.role === "string" ? e.message.role : "other";
    const content = e.message.content;
    if (role === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((p: unknown) => {
                  const part = p as { type?: unknown; text?: unknown };
                  return part?.type === "text" && typeof part.text === "string" ? part.text : "";
                })
                .join("")
            : "";
      out.push({ role, text });
    } else if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = content
        .filter((p: unknown) => (p as { type?: unknown })?.type === "toolCall")
        .map((p: unknown) => {
          const c = p as { name?: unknown; arguments?: unknown };
          return { name: typeof c.name === "string" ? c.name : "", arguments: c.arguments };
        });
      out.push({ role, toolCalls });
    } else {
      out.push({ role });
    }
  }
  return out;
}

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
  const inFlight = false; // R3a's AUTO await sets this; shadow never awaits inside the handler
  let abort = new AbortController();
  let pending: Pending | undefined;
  let memo: CorrectionMemo | undefined;
  /** `${id}@${ver}\0${digest}` → time it last became a candidate (PD6 window; per session). */
  const recent = new Map<string, number>();
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

  const isStale = (gen: number): boolean => disposed || gen !== generation;
  const rtOf = (id: string): ScriptRuntime => runtimes.get(id) ?? { strikes: 0, demoted: false };
  const stateOf = (id: string): ScriptState => effectiveState(id, deps.settings().autoResolve, rtOf(id));

  const safeAppend = (customType: string, data: unknown): void => {
    try {
      pi.appendEntry(customType, data);
    } catch {
      /* best-effort audit: a failed append never affects the session */
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
    };
    safeAppend("subagent:reflex-record", rec);
    if (p.kind === "shadow") {
      memo = {
        kind: "shadow",
        scriptId: p.scriptId,
        scriptVer: p.scriptVer,
        digest: p.digest,
        settledAt: clock.now(),
        corrected: false,
      };
    }
  };

  /** Entry-time age check (no timers): an over-age slot is flushed as unknown. */
  const flushIfOverAge = (now: number): void => {
    const p = pending;
    if (p !== undefined && now - p.at > PENDING_MAX_AGE_MS) settlePending(p, { agree: "unknown", tools: [] });
  };

  const rememberCandidate = (key: string, now: number): void => {
    recent.delete(key);
    recent.set(key, now);
    while (recent.size > REASK_MAP_CAP) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  };

  /** Run the read-only port off the input path (microtask) and attach the outcome to `p`. */
  const scheduleShadowPort = (p: Pending, script: RScriptV1, cwd: string, notify: (m: string) => void): void => {
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
          };
          const before = stateOf(script.id);
          const r = onExecOutcome(rtOf(script.id), outcome, clock.now());
          runtimes.set(script.id, r.rt);
          if (r.demotedNow && before === "auto") {
            try {
              notify(`reflex: ${script.id} demoted to shadow (${r.rt.demoteReason ?? "strikes"})`);
            } catch {
              /* ui best-effort */
            }
          }
        } catch {
          /* fail-open: the shadow slot just keeps no port data */
        }
      })();
    });
  };

  // ① input — plain (non-async) function. fail-open on purpose: pi's docs suggest fail-closed for guards, but this
  // layer is purely advisory — any bug must degrade to "the model answers as usual", never to a dropped input.
  pi.on("input", (event, ctx) => {
    try {
      const now = clock.now();
      flushIfOverAge(now);

      // PD12: a correction is persisted right here, independent of what S0/S1 decide about this very input.
      if (event.source === "interactive" && ctx.mode === "tui") {
        const c = detectCorrection(normalizeInput(event.text).norm, memo, now);
        if (c !== undefined && memo !== undefined) {
          safeAppend("subagent:reflex-correction", c);
          memo = { ...memo, corrected: true };
          bump("corrected");
          // A target of kind "answer" (AUTO) is demoted by R3a's onCorrected; R2b never answers.
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
      if (!gate.pass) return { action: "continue" as const };

      const m = matcher.match(gate.norm.norm, registry.capabilities());
      if (m.kind === "miss") return { action: "continue" as const };
      const script = scriptById.get(m.scriptId);
      if (script === undefined) return { action: "continue" as const };

      const digest = requestDigest(gate.norm.norm);
      const old = pending;
      if (old !== undefined) settlePending(old, { agree: "unknown", tools: [] }); // single slot

      if (m.band === "ambiguous") {
        bump("ambiguous");
        pending = {
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
        return { action: "continue" as const };
      }

      // band high, state shadow | demoted | auto — R2b treats all of them as shadow (R3a adds the AUTO branch).
      const key = `${script.id}@${script.version}\u0000${digest}`;
      const prev = recent.get(key);
      const reasked = prev !== undefined && now - prev <= REPEAT_WINDOW_MS;
      rememberCandidate(key, now);
      bump("candidates");
      if (reasked) bump("reasked");
      const p: Pending = {
        kind: "shadow",
        at: now,
        scriptId: script.id,
        scriptVer: script.version,
        state: stateOf(script.id),
        band: "high",
        digest,
        chars: gate.norm.chars,
        reasked,
      };
      pending = p;
      const ui = ctx.ui;
      scheduleShadowPort(p, script, ctx.cwd, (msg) => ui.notify(msg, "warning"));
      return { action: "continue" as const };
    } catch {
      return { action: "continue" as const };
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
        const script = scriptById.get(p.scriptId);
        if (collected.status === "ok") {
          // An ambiguous slot has no single script to judge against ⇒ unknown, shapes kept for audit.
          model =
            p.kind === "shadow" && script !== undefined
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
  });

  // ④ session_shutdown — abort in-flight work, drop pending (NOT persisted), bump generation.
  pi.on("session_shutdown", () => {
    try {
      abort.abort();
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
