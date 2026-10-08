/**
 * TS port of the one-time proof script `/tmp/steer-hold-exp6/matrix6.mjs` (plan §1.2/§3.2),
 * amended for v4.3's Y1 override (B1 lifted ONLY by attributed consumption — E2 — never by the
 * enqueue-confirmation evidence the original script also accepted). This is a FAST, NON-GATING
 * reference/diff tool: a cheap inline re-implementation of the hold state machine (NOT the real
 * `src/web-hub/agent/{hold,hold-driver}.ts`), useful as a pi-upgrade tripwire and for isolating
 * whether a discrepancy is in this package's own modules or in a pi behavior change. The real gate
 * is `tests/conformance/steer-hold-driver.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function mkModel(win: number) {
  return {
    id: "fake",
    name: "Fake",
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "http://x",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: win,
    maxTokens: 512,
  };
}
let model = mkModel(200_000);
const usage = (inp: number) => ({
  input: inp,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: inp + 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function msg(content: unknown[], stopReason: string, extra: { inp?: number; err?: string } = {}) {
  return {
    role: "assistant" as const,
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(extra.inp ?? 1),
    stopReason,
    timestamp: Date.now(),
    ...(extra.err ? { errorMessage: extra.err } : {}),
  };
}
type Scripted = { m: () => ReturnType<typeof msg> };
const tool = (id: string, inp?: number, slow?: boolean): Scripted => ({
  m: () =>
    msg(
      [{ type: "toolCall", id, name: "bash", arguments: { command: `sleep ${slow ? "0.3" : "0.02"}; echo hi` } }],
      "toolUse",
      { inp },
    ),
});
const text = (t: string, inp?: number): Scripted => ({ m: () => msg([{ type: "text", text: t }], "stop", { inp }) });
const err = (e: string): Scripted => ({ m: () => msg([], "error", { err: e }) });
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function userTexts(msgs: unknown[] | undefined): string[] {
  return (msgs ?? [])
    .filter((x): x is { role: string; content: unknown } => (x as { role?: unknown }).role === "user")
    .map((x) =>
      Array.isArray(x.content)
        ? (x.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
        : (x.content as string),
    );
}

const CONFIRM_MS = 200;
const DISPLAY_MS = 300; // stands in for the 30s ledger `unobserved` display timer

interface HeldEntry {
  t: string;
  deliver: "steer" | "followUp";
}
export interface RefProbeState {
  phase: "idle" | "armed" | "between";
  held: HeldEntry[];
  outcome: Map<string, string>;
  events: string[];
  skipFired: number;
  heldAtSettled: number;
  sendCalls: string[];
  handlerResolvedCalls: number[];
  confirmTimeouts: number;
  inflight: { t: string; enqueued: boolean } | undefined;
  consumed: Set<string>;
  observed: Set<string>;
  blocked: number;
  enqueueConfirmed: number;
  display: Map<string, string[]>;
}
export interface RefProbeApi {
  hold(t: string, deliver?: "steer" | "followUp"): boolean;
  forceHold(t: string, deliver?: "steer" | "followUp"): void;
  recall(t: string): boolean;
  st: RefProbeState;
  pi?: ExtensionAPI;
}
export interface RefHooks {
  tool?: (api: RefProbeApi, ctx: ExtensionContext) => void;
  context?: (api: RefProbeApi, ctx: ExtensionContext) => void;
  turn_start?: (api: RefProbeApi, ctx: ExtensionContext) => void;
  turn_end?: (api: RefProbeApi, ctx: ExtensionContext, ev: { outcome?: string }) => void;
  settledPre?: (api: RefProbeApi, ctx: ExtensionContext) => void;
  compact?: (api: RefProbeApi) => void;
  afterPass?: (api: RefProbeApi, ctx: ExtensionContext, trigger: string) => void;
  before?: ExtensionFactory[];
  after?: ExtensionFactory[];
  authFail?: boolean;
  noSkipDetect?: boolean;
  noAgentEnd?: boolean;
  allowLeftover?: boolean;
  session?: unknown;
  __calls?: unknown;
  __api?: RefProbeApi;
  __final?: { finalUsers: string[]; calls: string[][]; promptThrew?: string };
}

/** Y1 fix vs. the original matrix6.mjs: `enqueued` (E1) is tracked ONLY for display telemetry; it
 * no longer appears in `blocked()`'s predicate. Only `consumed` (E2) lifts B1. */
function makeRefProbe(log: string[], hooks: RefHooks): ExtensionFactory {
  const st: RefProbeState = {
    phase: "idle",
    held: [],
    outcome: new Map(),
    events: [],
    skipFired: 0,
    heldAtSettled: -1,
    sendCalls: [],
    handlerResolvedCalls: [],
    confirmTimeouts: 0,
    inflight: undefined,
    consumed: new Set(),
    observed: new Set(),
    blocked: 0,
    enqueueConfirmed: 0,
    display: new Map(),
  };
  const disp = (t: string, v: string) => {
    const a = st.display.get(t) ?? [];
    a.push(v);
    st.display.set(t, a);
  };
  const finish = (t: string, o: string) => {
    const prev = st.outcome.get(t);
    st.outcome.set(t, prev ? `${prev}+${o}` : o);
  };
  const waiters = new Map<string, () => void>();
  const api: RefProbeApi = {
    hold(t, deliver = "steer") {
      if (st.phase !== "armed") {
        log.push(`hold-refused(${st.phase}) ${t}`);
        return false;
      }
      st.held.push({ t, deliver });
      log.push(`held ${t}`);
      return true;
    },
    forceHold(t, deliver = "steer") {
      st.held.push({ t, deliver });
      log.push(`FORCED-held ${t}`);
    },
    recall(t) {
      const i = st.held.findIndex((h) => h.t === t);
      if (i < 0) return false;
      st.held.splice(i, 1);
      finish(t, "recalled");
      return true;
    },
    st,
  };
  return (pi: ExtensionAPI) => {
    api.pi = pi;
    const returnAll = (why: string) => {
      for (const h of st.held.splice(0)) finish(h.t, `returned(${why})`);
    };
    // Y1: B1 depends ONLY on consumption — `enqueued` no longer participates.
    const blocked = () => st.inflight !== undefined && !st.consumed.has(st.inflight.t);
    const sendOne = (allowFU: boolean, trigger: string) => {
      if (blocked()) {
        st.blocked++;
        log.push(`blocked-by:${st.inflight!.t} at ${trigger}`);
        return undefined;
      }
      const i = st.held.findIndex((h) => h.deliver === "steer" || allowFU);
      if (i < 0) return undefined;
      const [h] = st.held.splice(i, 1)!;
      st.sendCalls.push(h.t);
      const observedP = new Promise<void>((r) => waiters.set(h.t, r));
      st.inflight = { t: h.t, enqueued: false };
      disp(h.t, "dispatched");
      pi.sendUserMessage(h.t, { deliverAs: h.deliver });
      finish(h.t, "handed");
      setTimeout(() => {
        if (!st.consumed.has(h.t)) disp(h.t, "unconfirmed");
      }, DISPLAY_MS);
      log.push(`sent:${trigger} ${h.t}`);
      return { h, observedP };
    };
    const confirm = async (
      sent: { h: HeldEntry; observedP: Promise<void> },
      calls: unknown,
      ctx: ExtensionContext,
      pendingBefore: boolean,
    ) => {
      const deadline = Date.now() + CONFIRM_MS;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      const cap = new Promise<void>((r) => {
        timer = setTimeout(() => {
          timedOut = true;
          r();
        }, CONFIRM_MS);
      });
      await Promise.race([sent.observedP, cap]);
      if (!timedOut && !pendingBefore) {
        while (!ctx.hasPendingMessages() && Date.now() < deadline) await sleep(2);
        // Y1: a true enqueue flip is still recorded (telemetry only) but never clears `blocked()`.
        if (ctx.hasPendingMessages() && st.observed.has(sent.h.t)) {
          st.inflight!.enqueued = true;
          st.enqueueConfirmed++;
          log.push(`enqueued ${sent.h.t}`);
        } else timedOut = true;
      }
      if (!timedOut) await tick();
      clearTimeout(timer!);
      if (timedOut) st.confirmTimeouts++;
      st.handlerResolvedCalls.push(Array.isArray(calls) ? calls.length : 0);
    };
    const hook = (trigger: string, ctx: ExtensionContext, ev: { outcome?: string } | undefined, allowFU: boolean) => {
      const aborted = ctx.signal?.aborted === true || ev?.outcome === "aborted";
      log.push(`hook:${trigger} aborted=${aborted} n=${st.held.length}`);
      if (aborted) {
        returnAll("aborted");
        st.phase = "between";
        return undefined;
      }
      const pendingBefore = ctx.hasPendingMessages();
      const sent = sendOne(allowFU, trigger);
      st.phase = "between";
      hooks.afterPass?.(api, ctx, trigger);
      if (sent === undefined) return undefined;
      return confirm(sent, hooks.__calls, ctx, pendingBefore);
    };
    const dispatchPass = (allowFU: boolean, trigger: string) => {
      const r = sendOne(allowFU, trigger);
      return r ? [r.observedP] : [];
    };
    pi.on("input", (e: { text: string; source: string; streamingBehavior?: string }) => {
      log.push(`input:${e.text} sb=${e.streamingBehavior ?? "none"} src=${e.source}`);
      if (e.source === "extension" && st.inflight?.t === e.text) {
        st.observed.add(e.text);
        disp(e.text, "observed");
      }
      waiters.get(e.text)?.();
    });
    pi.on("message_start", (e: { message?: { role: string; content?: unknown } }) => {
      if (e.message?.role === "user") {
        const t = Array.isArray(e.message.content)
          ? (e.message.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
          : (e.message.content as string);
        log.push(`user_msg_start:${t}`);
        if (st.observed.has(t)) {
          st.consumed.add(t);
          disp(t, "consumed");
        }
      }
    });
    pi.on("context", (_e: unknown, ctx: ExtensionContext) => {
      st.events.push("context");
      if (ctx.signal?.aborted !== true) st.phase = "armed";
      hooks.context?.(api, ctx);
      return undefined;
    });
    pi.on("turn_start", (_e: unknown, ctx: ExtensionContext) => {
      st.events.push("turn_start");
      hooks.turn_start?.(api, ctx);
      if (!hooks.noSkipDetect && st.phase === "armed") {
        st.skipFired++;
        log.push(`skip-detect n=${st.held.length}`);
        if (st.held.length > 0) dispatchPass(false, "turn_start(skip)");
        st.phase = "between";
      }
    });
    pi.on("tool_execution_start", (_e: unknown, ctx: ExtensionContext) => {
      hooks.tool?.(api, ctx);
    });
    pi.on("turn_end", (ev: { outcome?: string; message?: { content?: unknown } }, ctx: ExtensionContext) => {
      st.events.push(`turn_end(${ev.outcome},sig=${ctx.signal?.aborted === true})`);
      hooks.turn_end?.(api, ctx, ev);
      if (st.held.length === 0) {
        st.phase = "between";
        return undefined;
      }
      const content = ev.message?.content;
      const noTool = !(Array.isArray(content) ? content : []).some((c) => (c as { type?: string }).type === "toolCall");
      const allowFU =
        ev.outcome === "completed" &&
        noTool &&
        !st.held.some((h) => h.deliver === "steer") &&
        !ctx.hasPendingMessages();
      return hook("turn_end", ctx, ev, allowFU);
    });
    pi.on("agent_end", (_e: unknown, ctx: ExtensionContext) => {
      st.events.push(`agent_end(sig=${ctx.signal?.aborted === true})`);
      if (hooks.noAgentEnd) {
        st.phase = "between";
        return undefined;
      }
      if (st.held.length === 0) {
        st.phase = "between";
        return undefined;
      }
      if (blocked()) {
        st.blocked++;
        log.push(`agent_end blocked-by:${st.inflight!.t} \u21d2 return ${st.held.length}`);
        returnAll("stale");
        st.phase = "between";
        return undefined;
      }
      return hook("agent_end", ctx, undefined, true);
    });
    pi.on("agent_settled", (_e: unknown, ctx: ExtensionContext) => {
      st.events.push("agent_settled");
      hooks.settledPre?.(api, ctx);
      st.heldAtSettled = Math.max(st.heldAtSettled, st.held.length);
      returnAll("stale");
      st.phase = "idle";
    });
    pi.on(
      "session_before_compact",
      (e: { reason: string; preparation: { firstKeptEntryId: string; tokensBefore: number } }) => {
        st.events.push(`compact(${e.reason})`);
        hooks.compact?.(api);
        return {
          compaction: {
            summary: "S",
            firstKeptEntryId: e.preparation.firstKeptEntryId,
            tokensBefore: e.preparation.tokensBefore,
          },
        };
      },
    );
    hooks.__api = api;
  };
}

export interface RunOpts {
  scripted: Scripted[];
  hooks: RefHooks;
  win?: number;
  settings?: Record<string, unknown>;
  patch?: (session: unknown) => void;
  kick?: (session: { prompt: (t: string, o?: unknown) => Promise<void> }) => Promise<void>;
  settleWaitMs?: number;
}
export interface RunResult {
  ok: boolean;
  why?: string;
  st: RefProbeState;
  log: string[];
  calls: string[][];
}

export async function runRefRow(
  opts: RunOpts,
  expect: (finalUsers: string[], calls: string[][], log: string[], hooks: RefHooks) => { ok: boolean; why?: string },
): Promise<RunResult> {
  model = mkModel(opts.win ?? 200_000);
  const cwd = mkdtempSync(join(tmpdir(), "shx6-"));
  const calls: string[][] = [];
  const log: string[] = [];
  let i = 0;
  opts.hooks.__calls = calls;
  const modelRuntime = {
    streamSimple: (_m: unknown, ctx: { messages?: unknown[] }) => {
      calls.push(userTexts(ctx.messages));
      const t = opts.scripted[Math.min(i, opts.scripted.length - 1)]!;
      i++;
      const stream = createAssistantMessageEventStream();
      const m = t.m();
      stream.push({
        type: m.stopReason === "error" ? "error" : "done",
        reason: m.stopReason,
        ...(m.stopReason === "error" ? { error: m } : { message: m }),
      });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => !opts.hooks.authFail,
    checkAuth: async () => (opts.hooks.authFail ? undefined : { ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
  };
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, baseDelayMs: 20, maxRetries: 2 },
    ...opts.settings,
  });
  const probe = makeRefProbe(log, opts.hooks);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [...(opts.hooks.before ?? []), probe, ...(opts.hooks.after ?? [])],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: modelRuntime as never,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader: loader,
    tools: ["bash"],
  });
  opts.hooks.session = session;
  if (opts.patch) opts.patch(session);
  const settled = new Promise<void>((r) => {
    const off = (session as unknown as { subscribe: (f: (e: { type: string }) => void) => () => void }).subscribe(
      (e) => {
        if (e.type === "agent_settled") {
          off();
          r();
        }
      },
    );
  });
  let promptThrew: string | undefined;
  try {
    if (opts.kick) await opts.kick(session as never);
    else await (session as unknown as { prompt: (t: string) => Promise<void> }).prompt("P0");
  } catch (e) {
    promptThrew = e instanceof Error ? e.message : String(e);
  }
  await Promise.race([settled, sleep(4000)]);
  await (session as unknown as { waitForIdle?: () => Promise<void> }).waitForIdle?.();
  await sleep(opts.settleWaitMs ?? 150);
  await (session as unknown as { waitForIdle?: () => Promise<void> }).waitForIdle?.();
  const finalUsers = userTexts((session as unknown as { messages?: unknown[] }).messages);
  const st = opts.hooks.__api!.st;
  const res = expect(finalUsers, calls, log, opts.hooks);
  const dbl = [...st.outcome].filter(([, o]) => o.includes("+"));
  const inv = dbl.length === 0 && (opts.hooks.allowLeftover === true || st.heldAtSettled <= 0);
  (session as unknown as { dispose: () => void }).dispose();
  rmSync(cwd, { recursive: true, force: true });
  return {
    ok: res.ok && inv,
    why: res.why ?? (dbl.length > 0 ? "double-terminal" : !inv ? "leftover-at-settled" : undefined),
    st,
    log,
    calls,
  };
}

export const refHelpers = {
  count: (arr: string[], t: string) => arr.filter((x) => x === t).length,
  once: (t: string) => (fu: string[]) =>
    refHelpers.count(fu, t) === 1 ? { ok: true } : { ok: false, why: `${t} x${refHelpers.count(fu, t)}` },
  never: (t: string) => (fu: string[]) =>
    refHelpers.count(fu, t) === 0 ? { ok: true } : { ok: false, why: `${t} x${refHelpers.count(fu, t)}` },
  firstIn: (t: string, k: number) => (_fu: string[], calls: string[][]) => {
    const idx = calls.findIndex((c) => c.includes(t));
    return idx === k - 1 ? { ok: true } : { ok: false, why: `${t} first in LLM#${idx + 1}, want #${k}` };
  },
  before: (a: string, b: string) => (fu: string[]) =>
    fu.indexOf(a) >= 0 && fu.indexOf(a) < fu.indexOf(b)
      ? { ok: true }
      : { ok: false, why: `order ${a}<${b} fu=${JSON.stringify(fu)}` },
  all:
    (
      ...fs: Array<(fu: string[], calls: string[][], log: string[], hooks: RefHooks) => { ok: boolean; why?: string }>
    ) =>
    (fu: string[], calls: string[][], log: string[], hooks: RefHooks) => {
      for (const f of fs) {
        const r = f(fu, calls, log, hooks);
        if (!r.ok) return r;
      }
      return { ok: true };
    },
};
export { tool, text, err };
