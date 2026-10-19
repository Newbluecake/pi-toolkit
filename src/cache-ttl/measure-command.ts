/** Main-session-only `/cache-ttl measure` assembly (measure-plan.md r4 §1/§7). No provider requests via session hooks. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { calculateCost, clampThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  VERSION as PI_VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock } from "../core/clock.js";
import { getMeasureClaim, type MeasureClaimInternal } from "./measure-claim.js";
import { parseMeasureArgs } from "./measure-args.js";
import { recordEligible } from "./measure-classify.js";
import {
  buildExecutionPlan,
  contextWindowAdmits,
  formatConfirmText,
  formatCost,
  formatPlanLines,
} from "./measure-plan.js";
import { makeRunId } from "./measure-prefix.js";
import { validateMeasurePayload } from "./measure-payload.js";
import { measureRouteKey } from "./measure-route.js";
import { startMeasurement, type MeasureRunnerDeps } from "./measure-runner.js";
import { createMeasureStore, type MeasureStore } from "./measure-store.js";
import { readMeasureUsage } from "./measure-usage.js";
import { sendPipelinePing } from "./pipeline-ping.js";
import type { PipelinePingModel, SendPipelinePing } from "./pipeline-ping-types.js";
import {
  MEASURE_APIS,
  MEASURE_STATUS_KEY,
  MEASURE_STORE_FILE,
  MEASURE_TIMING,
  type ExecutionPlan,
  type MeasureCancelReason,
  type MeasureClaimToken,
  type MeasurePriceFn,
  type MeasureProgress,
  type MeasureRouteIdentity,
  type MeasureRunHandle,
  type MeasureRunRecord,
  type MeasureSendFn,
} from "./measure-types.js";

export const MEASURE_USAGE =
  "usage: /cache-ttl measure [<provider>/<id>] [--long] [--estimate] [--yes] | measure status | measure cancel";

export interface MeasureCommandDeps {
  clock?: Clock;
  claim?: MeasureClaimInternal;
  store?: MeasureStore;
  agentDir?: string;
  transport?: SendPipelinePing;
  fetchImpl?: typeof fetch;
  activationId?: string;
}
export interface MeasureCommandPort {
  handle(rawArgs: string, ctx: ExtensionContext): Promise<void>;
  statusLine(ctx: ExtensionContext): Promise<string | undefined>;
  completions(prefix: string): Array<{ value: string; label: string; description: string }>;
}

/** calculateCost owns tier selection and 1h-write pricing; 0/missing rates never masquerade as free service. */
export function measurePriceFor(model: PipelinePingModel): MeasurePriceFn {
  return (tokens) => {
    const total = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    let rates = model.cost;
    let threshold = -1;
    for (const tier of model.cost.tiers ?? [])
      if (total > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
        rates = tier;
        threshold = tier.inputTokensAbove;
      }
    const long = tokens.cacheWrite1h ?? 0;
    const needed = [
      [tokens.input + long, rates.input],
      [tokens.cacheRead, rates.cacheRead],
      [tokens.cacheWrite - long, rates.cacheWrite],
      [tokens.output, rates.output],
    ];
    if (needed.some(([count, rate]) => count! > 0 && (!Number.isFinite(rate) || rate! <= 0))) return undefined;
    const usage: Usage = {
      ...tokens,
      totalTokens: total + tokens.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    try {
      const cost = calculateCost(model, usage).total;
      return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    } catch {
      return undefined;
    }
  };
}

const duration = (ms: number): string =>
  ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.max(0, Math.floor(ms / 1000))}s`;
const saved = (at: number | undefined, now: number): string =>
  at === undefined ? "not saved yet" : `saved ${duration(Math.max(0, now - at))} ago`;
function progressLine(p: MeasureProgress, now: number): string {
  const next =
    p.nextDueAt === undefined
      ? ""
      : ` · next ${p.nextGapMs === undefined ? p.nextKind : duration(p.nextGapMs)} in ${duration(Math.max(0, p.nextDueAt - now))}`;
  return `ttl-measure ${p.status} ${p.slotsDone}/6${next} · ${saved(p.lastSavedAt, now)}`;
}
function resultLine(record: MeasureRunRecord, route: MeasureRouteIdentity | undefined): string {
  const renewal = record.renewal;
  const basis = renewal?.basis === "paired-empirical" ? "empirical" : "documented";
  return `${record.ttl.eligible ? "learned ttl" : `ttl-measure ${record.status} · ttl`} ${route?.requestedRetention ?? "?"} ${record.ttl.lowerMs === undefined ? "unknown" : `≥${duration(record.ttl.lowerMs)}`} · renew ${renewal?.renewsOnRead ?? "unknown"}${renewal?.renewsOnRead === "true" ? `(${basis})` : ""} · ${new Date(record.finishedAt ?? record.startedAt).toISOString().slice(0, 10)}`;
}

/** Full text report: spending is emitted ONLY on completion (ruling 6), never in progress/status. */
export function renderMeasureResult(
  record: MeasureRunRecord,
  route: MeasureRouteIdentity | undefined,
  spend = false,
): string[] {
  const lines = [
    `ttl-measure ${record.status}${record.statusReason ? `(${record.statusReason})` : ""} · ${record.runId} · requests ${record.requests.sent}/${record.requests.cap}`,
    ...(route ? [`route: ${route.label} · tier ${route.effectiveTier}`, resultLine(record, route)] : []),
    `observed under this run's load: ${record.load.prefixes} prefixes ≈ ${record.load.ownTokens} cached tokens on one key`,
    `control: ${record.control.verdict} (${record.control.attempts} attempts) · consistent ${record.ttl.consistent}`,
    ...record.samples.map(
      (s) =>
        `${duration(s.gapMs)}: ${s.verdict}${s.reason ? `(${s.reason})` : ""}${s.idleMs ? ` · idle [${s.idleMs[0]}, ${s.idleMs[1]}]ms` : ""}`,
    ),
  ];
  if (record.ttl.missMs !== undefined)
    lines.push(
      `miss observed at ≤ ${duration(record.ttl.missMs)} (expiry or eviction under this run's load) — not a TTL ceiling`,
    );
  lines.push(
    `read renewal: ${record.renewal?.renewsOnRead ?? "unknown"}${record.renewal?.reason ? `(${record.renewal.reason})` : ""}${record.renewal?.basis ? ` · ${record.renewal.basis}` : ""}`,
  );
  if (record.renewal?.assumptions) lines.push(`renewal assumptions: ${record.renewal.assumptions.join("; ")}`);
  if (record.httpError) lines.push(`http-${record.httpError.status}: ${record.httpError.message}`);
  if (record.statusReason === "bound-exceeded") {
    const detail = record.boundExceeded;
    if (detail)
      lines.push(
        `${detail.condition} ${detail.condition === "C1" ? "prompt" : "output"} ${detail.observed} > ${detail.limit}`,
      );
    lines.push("The stated conditional cost bound did not hold; stopped before the next send.");
  }
  lines.push(
    "Residual: same-size backend/key splits can be undetectable; a miss may be eviction, not expiry. No negative renewal conclusion is proven.",
  );
  if (spend) lines.push(formatCost(record.cost));
  return lines;
}

export function wireMeasureCommand(pi: ExtensionAPI, deps: MeasureCommandDeps = {}): MeasureCommandPort {
  const clock = deps.clock ?? systemClock;
  const activationId = deps.activationId ?? randomUUID();
  let store: MeasureStore | undefined = deps.store;
  let claim: MeasureClaimInternal | undefined = deps.claim;
  const getClaim = () => (claim ??= getMeasureClaim());
  const getStore = () =>
    (store ??= createMeasureStore({
      filePath: join(deps.agentDir ?? getAgentDir(), MEASURE_STORE_FILE),
      clock,
      slot: getClaim().persistSlot,
    }));
  let epoch = 0;
  let live = true;
  let session = "";
  let context: ExtensionContext | undefined;
  let token: MeasureClaimToken | undefined;
  let run: MeasureRunHandle | undefined;
  let pendingAbort: AbortController | undefined;
  let last: { record: MeasureRunRecord; route: MeasureRouteIdentity | undefined; plan: ExecutionPlan } | undefined;
  let plan: ExecutionPlan | undefined;
  let shutdownFooter: { epoch: number; generation: number; sessionId: string; ctx: ExtensionContext } | undefined;

  const sessionId = (ctx: ExtensionContext): string => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return "";
    }
  };
  const current = (e: number, id: string, ctx: ExtensionContext): boolean =>
    live && e === epoch && session === id && sessionId(ctx) === id;
  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(text, level);
    } catch {}
  };
  const status = (ctx: ExtensionContext, text: string | undefined) => {
    try {
      ctx.ui.setStatus(MEASURE_STATUS_KEY, text);
    } catch {}
  };

  /** Every setup/dialog wait is independently bounded, abortable and unref'd through the injected clock. */
  function wait<T>(work: () => Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: T | undefined) => {
        if (done) return;
        done = true;
        clock.clearTimer(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(undefined);
      const timer = clock.setTimer(ms, () => {
        finish(undefined);
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        finish(undefined);
        return;
      }
      try {
        void work().then(finish, () => finish(undefined));
      } catch {
        finish(undefined);
      }
    });
  }
  function shutdown(reason: MeasureCancelReason, ctx?: ExtensionContext): void {
    live = false;
    epoch += 1;
    pendingAbort?.abort();
    pendingAbort = undefined;
    if (token) getClaim().revoke(token);
    run?.cancel(reason);
    run = undefined;
    token = undefined;
    plan = undefined;
    if (ctx ?? context) {
      const footerCtx = (ctx ?? context)!;
      if (claim?.state === "draining") {
        shutdownFooter = { epoch, generation: claim.generation, sessionId: sessionId(footerCtx), ctx: footerCtx };
        status(footerCtx, "ttl-measure io-pending");
      } else {
        shutdownFooter = undefined;
        status(footerCtx, undefined);
      }
    }
  }
  pi.on("session_shutdown", (event, ctx) => {
    const reason: MeasureCancelReason =
      event.reason === "reload"
        ? "session-reload"
        : event.reason === "new"
          ? "session-new"
          : event.reason === "resume"
            ? "session-resume"
            : event.reason === "fork"
              ? "session-fork"
              : "session-quit";
    shutdown(reason, ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    if (token || run) shutdown("session-new", context);
    epoch += 1;
    live = true;
    session = sessionId(ctx);
    context = ctx;
    last = undefined;
    if (shutdownFooter && claim?.state === "draining") {
      shutdownFooter = { epoch, generation: claim.generation, sessionId: session, ctx };
      status(ctx, "ttl-measure io-pending");
    } else shutdownFooter = undefined;
  });

  async function statusData(
    ctx: ExtensionContext,
  ): Promise<{ line: string; routes: Awaited<ReturnType<MeasureStore["readRoutes"]>> } | undefined> {
    const e = epoch,
      id = sessionId(ctx);
    if (!session) session = id;
    const c = getClaim();
    if (c.state === "draining")
      return { line: `ttl-measure io-pending ${duration(clock.now() - (c.drainingSince ?? clock.now()))}`, routes: [] };
    const p = c.current();
    if (p) return { line: progressLine(p, clock.now()), routes: [] };
    if (c.state === "preparing") return { line: "ttl-measure preparing", routes: [] };
    if (!id) return { line: "ttl-measure idle", routes: [] };
    const routes = await getStore().readRoutes();
    if (!current(e, id, ctx)) return undefined;
    const recent = [...routes].sort((a, b) => (b.latest?.finishedAt ?? 0) - (a.latest?.finishedAt ?? 0));
    const latest = recent.find((r) => r.latest && recordEligible(r.latest, clock.now()));
    return {
      line: last
        ? resultLine(last.record, last.route)
        : latest?.latest
          ? `${resultLine(latest.latest, latest)} · saved route`
          : "ttl-measure idle",
      routes: recent,
    };
  }

  const port: MeasureCommandPort = {
    async statusLine(ctx) {
      const e = epoch,
        id = sessionId(ctx);
      try {
        return (await statusData(ctx))?.line;
      } catch {
        return current(e, id, ctx) ? "ttl-measure saved status unavailable" : undefined;
      }
    },
    completions(prefix) {
      const tokens = prefix.trimStart().split(/\s+/);
      if (tokens[0]?.toLowerCase() !== "measure") return [];
      const partial = /\s$/.test(prefix) ? "" : (tokens.at(-1) ?? "");
      const before = /\s$/.test(prefix) ? prefix.trim() : prefix.trim().slice(0, -partial.length).trimEnd();
      const choices = ["status", "cancel", "--long", "--estimate", "--yes"];
      return choices
        .filter((s) => s.startsWith(partial.toLowerCase()))
        .map((s) => ({ value: `${before} ${s}`, label: s, description: "prompt-cache TTL measurement" }));
    },
    async handle(rawArgs, ctx) {
      const parsed = parseMeasureArgs(rawArgs);
      if (!parsed.ok) {
        notify(ctx, `${MEASURE_USAGE}\n${parsed.detail}`, "warning");
        return;
      }
      const id = sessionId(ctx);
      if (!session) session = id;
      context = ctx;
      const e = epoch;
      if (parsed.command === "status") {
        try {
          const data = await statusData(ctx);
          if (!data || !current(e, id, ctx)) return;
          const lines = [data.line];
          if (plan) lines.push(...formatPlanLines(plan));
          if (run) {
            const snapshot = run.snapshot();
            lines.push(
              `route: ${snapshot.label}`,
              `last successful save: ${snapshot.lastSavedAt === undefined ? "never (this run)" : new Date(snapshot.lastSavedAt).toISOString()}`,
            );
            const rows = await getStore().readRoutes();
            if (!current(e, id, ctx)) return;
            const row = rows.find((r) => r.inProgress?.runId === snapshot.runId);
            if (row?.inProgress) lines.push(...renderMeasureResult(row.inProgress, row));
          }
          if (last) {
            lines.push(...formatPlanLines(last.plan), ...renderMeasureResult(last.record, last.route));
            if (last.route && recordEligible(last.record, clock.now()) && last.record.ttl.lowerMs !== undefined) {
              lines.push(
                `copyable hint: models.json promptCache.${last.route.requestedRetention} ≈ ${Math.floor(last.record.ttl.lowerMs / 1000)}`,
              );
              if (last.record.renewal?.renewsOnRead !== "true")
                lines.push("Warning: native CacheWarmer assumes read renewal, which this run did not prove.");
            }
          }
          for (const route of data.routes.slice(0, 4)) {
            if (!route.latest || route.latest.runId === last?.record.runId) continue;
            lines.push(
              "saved route (not verified as the current authenticated route):",
              ...renderMeasureResult(route.latest, route),
            );
            const estimate = route.latest.cost.estimate;
            lines.push(
              `estimate: typical ${estimate.typicalUsd === null ? "UNKNOWN" : `$${estimate.typicalUsd.toFixed(2)}`} · conditional worst ${estimate.conditionalWorstUsd === null ? "UNKNOWN" : `$${estimate.conditionalWorstUsd.toFixed(2)}`}`,
            );
            if (recordEligible(route.latest, clock.now()) && route.latest.ttl.lowerMs !== undefined) {
              lines.push(
                `copyable hint: models.json promptCache.${route.requestedRetention} ≈ ${Math.floor(route.latest.ttl.lowerMs / 1000)}`,
              );
              if (route.latest.renewal?.renewsOnRead !== "true")
                lines.push("Warning: native CacheWarmer assumes read renewal, which this run did not prove.");
            }
          }
          lines.push(
            `last successful save (process writer): ${getStore().lastSavedAt === undefined ? "unknown in this process" : new Date(getStore().lastSavedAt!).toISOString()} · persistence ${getStore().persistState}`,
          );
          notify(ctx, lines.join("\n"));
        } catch {
          if (current(e, id, ctx)) notify(ctx, "ttl-measure: saved status unavailable", "warning");
        }
        return;
      }
      if (parsed.command === "cancel") {
        if (token && getClaim().owns(token)) {
          pendingAbort?.abort();
          getClaim().revoke(token);
          run?.cancel("user");
          token = undefined;
          run = undefined;
          plan = undefined;
          notify(ctx, "ttl-measure cancelled");
        } else
          notify(
            ctx,
            getClaim().state === "draining"
              ? "ttl-measure busy(io-pending) — waiting for physical IO; restart if it never settles"
              : "ttl-measure no active run",
            "warning",
          );
        return;
      }
      if (!live || ctx.hasUI !== true || !id) {
        notify(ctx, "ttl-measure: interactive UI required — nothing sent", "warning");
        return;
      }
      const c = getClaim();
      const prepared = c.prepare({ activationId, sessionId: id, runId: makeRunId(clock.now()) }, clock.now());
      if (!prepared.ok) {
        notify(
          ctx,
          `ttl-measure ${prepared.reason === "busy-io-pending" ? "busy(io-pending)" : "busy"} — nothing sent`,
          "warning",
        );
        return;
      }
      token = prepared.token;
      const mine = prepared.token;
      const owned = () => current(e, id, ctx) && c.owns(mine);
      const abort = new AbortController();
      pendingAbort = abort;
      try {
        const model = parsed.model ? ctx.modelRegistry.find(parsed.model.provider, parsed.model.id) : ctx.model;
        if (!model) {
          notify(ctx, "ttl-measure: model not found — nothing sent", "warning");
          return;
        }
        if (
          !(MEASURE_APIS as readonly string[]).includes(model.api) ||
          model.provider === "github-copilot" ||
          typeof ctx.modelRegistry.streamSimple !== "function"
        ) {
          notify(ctx, "ttl-measure: unsupported API/provider pipeline — nothing sent", "warning");
          return;
        }
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
          notify(ctx, "ttl-measure: no configured auth — nothing sent", "warning");
          return;
        }
        const api = model.api as ExecutionPlan["api"];
        const price = measurePriceFor(model);
        const frozen = buildExecutionPlan({
          runId: mine.owner.runId,
          api,
          wireModel: model.id,
          requestedRetention: parsed.long ? "long" : "short",
          price,
        });
        if (!contextWindowAdmits(model.contextWindow, frozen.tokens.pBound)) {
          notify(ctx, `ttl-measure: context window must be ≥ ${frozen.tokens.pBound + 2048} — nothing sent`, "warning");
          return;
        }
        if (!owned()) return;
        notify(ctx, formatPlanLines(frozen).join("\n"));
        if (parsed.estimate) return;
        let oauth = false;
        if (api === "anthropic-messages") {
          const auth = await wait(() => ctx.modelRegistry.getApiKeyAndHeaders(model), 10_000, abort.signal);
          if (!owned()) return;
          if (!auth?.ok) {
            notify(ctx, "ttl-measure: auth resolution failed — nothing sent", "warning");
            return;
          }
          oauth = auth.apiKey?.startsWith("sk-ant-oat") === true || ctx.modelRegistry.isUsingOAuth?.(model) === true;
        }
        if (!parsed.yes) {
          const accepted = await wait(
            () =>
              ctx.ui.confirm("Start billed cache TTL measurement?", formatConfirmText(frozen), {
                timeout: MEASURE_TIMING.confirmTimeoutMs,
                signal: abort.signal,
              }),
            MEASURE_TIMING.confirmTimeoutMs,
            abort.signal,
          );
          if (!owned()) return;
          if (accepted !== true) {
            abort.abort();
            notify(ctx, "ttl-measure: re-run with --yes to start — nothing sent", "warning");
            return;
          }
        }
        if (!owned()) return;
        plan = frozen;
        const persist = getStore();
        // Responses has a stock low-effort SimpleStreamOptions path. Off/omitted can
        // become effort:none, which some relays reject. Keep vendor-specific Completions
        // thinking formats unchanged; they can enable budgets/template flags at low.
        const reasoningLevel =
          api === "openai-responses" && model.reasoning ? clampThinkingLevel(model, "low") : undefined;
        const mappedEffort =
          reasoningLevel && reasoningLevel !== "off"
            ? (model.thinkingLevelMap?.[reasoningLevel] ?? reasoningLevel)
            : undefined;
        const lowReasoning = typeof mappedEffort === "string" ? mappedEffort : undefined;
        const compat = model.compat as
          | { thinkingTokenBudgetField?: string; supportsMidConvoEffort?: boolean; forceAdaptiveThinking?: boolean }
          | undefined;
        // Anthropic's stock forceAdaptiveThinking path needs a non-empty reasoning option;
        // otherwise a reasoning model gets thinking:{type:'disabled'}, rejected by some relays.
        // Managed effort takes precedence in pi and keeps its existing, independent construction.
        const forceAdaptive =
          api === "anthropic-messages" &&
          model.reasoning &&
          compat?.forceAdaptiveThinking === true &&
          compat.supportsMidConvoEffort !== true;
        const adaptiveEffort = forceAdaptive ? (model.thinkingLevelMap?.low ?? "low") : undefined;
        const send: MeasureSendFn = (request) =>
          (deps.transport ?? sendPipelinePing)({
            registry: ctx.modelRegistry,
            model,
            sessionId: request.sessionId,
            body: request.body ?? {},
            clock,
            deadlineAt: request.deadlineAt,
            guard: request.guard,
            signal: request.signal,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            measurement: {
              profile: api,
              expectWireModel: model.id,
              routeKey: request.routeKey,
              ...(request.expectRouteKey !== undefined ? { expectRouteKey: request.expectRouteKey } : {}),
              ...(request.build
                ? {
                    build: {
                      ...request.build,
                      maxTokens: frozen.outputCap,
                      cacheRetention: frozen.requestedRetention,
                      ...(lowReasoning || forceAdaptive ? { reasoning: "low" as const } : {}),
                    },
                  }
                : {}),
            },
          });
        let checkedTier: import("./measure-types.js").EffectiveTier | undefined;
        const refreshTerminalStatus = () => {
          // Physical IO can settle AFTER done/claim release; owns(token) is then false.
          // Generation fencing prevents an old settlement from clearing a newer run's footer.
          if (current(e, id, ctx) && c.generation === mine.owner.generation && c.state === "free")
            status(ctx, undefined);
          const pending = shutdownFooter;
          if (
            pending &&
            pending.epoch === epoch &&
            pending.generation === c.generation &&
            pending.sessionId === sessionId(pending.ctx) &&
            c.state === "free"
          ) {
            status(pending.ctx, undefined);
            shutdownFooter = undefined;
          }
        };
        const runnerDeps: MeasureRunnerDeps = {
          plan: frozen,
          token: mine,
          claim: c,
          send,
          clock,
          persist,
          price,
          readUsage: (outcome) => readMeasureUsage(api, outcome.measured?.rawUsage, frozen.requestedRetention),
          validatePayload: (params, expect) => {
            const verdict = validateMeasurePayload(api, params, {
              ...expect,
              ...(compat?.thinkingTokenBudgetField ? { forbiddenKeys: [compat.thinkingTokenBudgetField] } : {}),
              ...(lowReasoning ? { reasoningEffort: lowReasoning } : {}),
              ...(adaptiveEffort ? { adaptiveEffort } : {}),
            });
            if (!verdict.ok) return verdict;
            if (
              api === "openai-completions" &&
              params.prompt_cache_key !== undefined &&
              params.prompt_cache_key !== expect.promptCacheKey
            )
              return { ok: false, code: "prompt-cache-key" };
            if (checkedTier !== undefined && checkedTier !== verdict.effectiveTier)
              return { ok: false, code: "no-cache-control", detail: "effective tier changed during the run" };
            checkedTier = verdict.effectiveTier;
            return verdict;
          },
          routeKeyFor: ({ api, wireModel, effectiveTier, requestUrl }) => {
            runnerDeps.routeOrigin = new URL(requestUrl).origin.toLowerCase();
            return measureRouteKey({ api, wireModel, effectiveTier, url: requestUrl });
          },
          payload: {
            oauth,
            managedEffort: compat?.supportsMidConvoEffort === true,
            promptCacheKeyFor: (sid) => Array.from(sid).slice(0, 64).join(""),
          },
          versions: { piVersion: PI_VERSION },
          onPhysicalSettled: refreshTerminalStatus,
          onProgress: (p) => {
            if (owned()) status(ctx, progressLine(p, clock.now()));
          },
          onDone: (record, route) => {
            if (!owned()) return;
            last = { record, route, plan: frozen };
            status(ctx, undefined);
            notify(
              ctx,
              [
                ...renderMeasureResult(record, route, true),
                ...formatPlanLines(frozen),
                `last successful save: ${persist.lastSavedAtFor(frozen.runId) === undefined ? "never (this run)" : new Date(persist.lastSavedAtFor(frozen.runId)!).toISOString()} · persistence ${persist.persistState}`,
              ].join("\n"),
              record.status === "failed" ? "warning" : "info",
            );
          },
        };
        run = startMeasurement(runnerDeps);
        const started = run;
        void started.done.then(() => {
          if (current(e, id, ctx) && run === started) {
            run = undefined;
            token = undefined;
            plan = undefined;
            if (c.state === "draining") status(ctx, "ttl-measure io-pending");
            else refreshTerminalStatus();
          }
        });
      } catch {
        if (owned()) notify(ctx, "ttl-measure: setup failed — nothing sent", "warning");
      } finally {
        if (c.state === "preparing") c.revoke(mine);
        if (!run && token === mine) {
          token = undefined;
          plan = undefined;
        }
        if (pendingAbort === abort) pendingAbort = undefined;
      }
    },
  };
  return port;
}
