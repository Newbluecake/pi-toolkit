/**
 * Shared deterministic harness for ThreadEngine tests: FakeClock-driven, manually-settled
 * steers, array sinks, a mutable run-facts world. No real timers anywhere.
 */
import { FakeClock } from "../../../src/core/clock.js";
import { ThreadEngine, type ThreadEngineDeps } from "../../../src/fabric/thread/engine.js";
import type { ThreadEngineSettings, ThreadEventInput, ThreadRunFacts } from "../../../src/fabric/thread/types.js";

export const H1 = "fs:threadAAAA1";
export const H2 = "fs:threadBBBB2";
export const RUN_A = "r_ABCDEFGH";
export const RUN_B = "r_JKLMNPQR";
export const RUN_C = "r_STUVWXYZ";

export interface PendingSteer {
  runId: string;
  text: string;
  capMs: number;
  resolve: (disposition: string) => void;
  reject: (error: unknown) => void;
}

export interface Harness {
  clock: FakeClock;
  engine: ThreadEngine;
  facts: Map<string, ThreadRunFacts>;
  hubOnline: { value: boolean };
  steers: PendingSteer[];
  routed: Array<{ eventId: string; runs: Array<{ runId: string; label: string }> }>;
  /** successful native releases (the event went back to the slow path). */
  native: string[];
  /** every releaseToNative ATTEMPT, successful or refused. */
  nativeAttempts: string[];
  /** set false to make releaseToNative refuse (§6.7 复检失败 ⇒ engine replies E_STALE_CTX). */
  nativeOk: { value: boolean };
  autoReturns: Array<{ eventId: string; outcomesSnapshot: string[] }>;
  staleCtx: string[];
  display: string[];
  hints: string[];
  audits: Array<Record<string, unknown>>;
  /** Resolve ALL pending steers with a disposition (default "queued"). */
  settleAll(disposition?: string): void;
  /** Resolve the n-th pending steer (0-based, FIFO). */
  settleOne(index: number, disposition?: string): void;
  /** Advance the clock AND flush microtasks so steer .then chains land. */
  tick(ms: number): Promise<void>;
  event(overrides?: Partial<ThreadEventInput>): ThreadEventInput;
}

export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

export function makeHarness(settings?: Partial<ThreadEngineSettings>): Harness {
  const clock = new FakeClock(0);
  const facts = new Map<string, ThreadRunFacts>();
  const hubOnline = { value: true };
  const steers: PendingSteer[] = [];
  const routed: Harness["routed"] = [];
  const native: string[] = [];
  const nativeAttempts: string[] = [];
  const nativeOk = { value: true };
  const autoReturns: Harness["autoReturns"] = [];
  const staleCtx: string[] = [];
  const display: string[] = [];
  const hints: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const deps: ThreadEngineDeps = {
    clock,
    settings,
    runFacts: (runId) => facts.get(runId),
    hubCapable: () => hubOnline.value,
    steerThread: (runId, text, capMs) =>
      new Promise<string>((resolve, reject) => {
        steers.push({ runId, text, capMs, resolve, reject });
      }),
    replyRouted: (eventId, runs) => routed.push({ eventId, runs: [...runs] }),
    releaseToNative: (eventId) => {
      nativeAttempts.push(eventId);
      if (!nativeOk.value) return false;
      native.push(eventId);
      return true;
    },
    requestAutoReturn: (eventId) => {
      const record = engine.inspectRecord(eventId);
      autoReturns.push({ eventId, outcomesSnapshot: record ? [...record.perSub.values()] : [] });
    },
    replyStaleCtx: (eventId) => staleCtx.push(eventId),
    display: (line) => display.push(line),
    hint: (line) => hints.push(line),
    audit: (entry) => audits.push(entry),
  };
  const engine = new ThreadEngine(deps);
  let evSeq = 0;
  const harness: Harness = {
    clock,
    engine,
    facts,
    hubOnline,
    steers,
    routed,
    native,
    nativeAttempts,
    nativeOk,
    autoReturns,
    staleCtx,
    display,
    hints,
    audits,
    settleAll(disposition = "queued") {
      for (const s of [...steers]) s.resolve(disposition);
    },
    settleOne(index, disposition = "queued") {
      const s = steers[index];
      if (s !== undefined) s.resolve(disposition);
    },
    async tick(ms) {
      clock.advance(ms);
      await flushMicrotasks();
    },
    event(overrides) {
      evSeq++;
      return {
        eventId: `fs${String(evSeq).padStart(30, "0")}`,
        h: H1,
        label: "topic",
        sentAt: 0,
        trustedOrigin: true,
        hasThreadMeta: true,
        threadMetaValid: true,
        headerOk: true,
        bypass: false,
        addressedOther: false,
        frameDeadlineMs: 8000,
        text: `wrapper-${evSeq}`,
        ...overrides,
      };
    },
  };
  return harness;
}

/** Standard world: one open thread, one running steerable run subscribed to it. */
export function primeWorld(h: Harness, opts?: { runStatus?: ThreadRunFacts["status"] }): string {
  h.engine.noteThread(H1, "topic");
  h.facts.set(RUN_A, { direct: true, status: opts?.runStatus ?? "running", steerable: true });
  const res = h.engine.subscribe({ runId: RUN_A, h: H1, label: "worker-a", scope: "scope", createdBy: "root" });
  if (!res.ok) throw new Error(`primeWorld subscribe failed: ${res.reason}`);
  return res.subId;
}
