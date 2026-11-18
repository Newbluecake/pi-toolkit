/** Sole v2 PTY/ring/allocation owner. No routes, auth persistence, v1 negotiation or assembly. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuthIdentity } from "../../auth-identity.js";
import type {
  TerminalAllocationLedgerPortV2,
  TerminalContextPort,
  TerminalContextSnapshotV2,
  TerminalRuntimeV2,
  TerminalServiceV2,
} from "../../terminal-v2-ports.js";
import type {
  AllocationV2,
  LedgerV2,
  TerminalScopeV2,
  TerminalTargetLimitsV2,
  TerminalMachineLimitsV2,
  TerminalTabRowV2,
  TerminalCreateInputV2,
  TerminalHttpRequestsV2,
  TerminalHttpResponseV2,
  TerminalMetadataV2,
  TerminalFailureV2,
} from "../../../protocol/terminal-v2.js";
import { terminalLedgerV2Ok, terminalHttpRequestV2Ok } from "../../../protocol/terminal-v2.js";
import {
  TERMINAL_V2_LIMITS as L,
  terminalCwdV2Ok,
  terminalBase64BytesV2,
  normalizeTerminalNameV2,
} from "../../../protocol/terminal-v2-values.js";
import {
  createTerminalBackend,
  type TerminalBackend,
  type TerminalBackendOptions,
  type TerminalPhysicalResult,
} from "./backend.js";
import { TerminalReaper } from "./reaper.js";
import { TerminalBackendError } from "./environment.js";
import { DEFAULT_TERMINAL_LIMITS_V2, effectiveLimitsV2, quotaV2, assertQuotaV2, TerminalRingV2 } from "./limits.js";
import { boundedV2, failureV2, TerminalFaultV2, systemClock, type TimerHandle } from "./timing.js";
const id = () => randomBytes(24).toString("base64url");
const key = (s: TerminalScopeV2) => JSON.stringify([s.agentKey, s.sessionId, s.epoch]);
const principal = (auth: AuthIdentity) => `${auth.listener}:${auth.principal}`;
type Intent = {
  scope: string;
  fingerprint: string;
  auth: AuthIdentity;
  promise: Promise<TerminalHttpResponseV2<"create">>;
  result?: TerminalHttpResponseV2<"create">;
  terminalAt?: number;
  allocationId?: string;
  controller: AbortController;
  at: number;
};
type Hot = {
  allocation: AllocationV2;
  creator: AuthIdentity;
  context: TerminalContextSnapshotV2;
  row: TerminalTabRowV2;
  ring: TerminalRingV2;
  invalidated: AbortController;
  backend?: TerminalBackend;
  runtime?: TerminalRuntimeV2;
  changed: Set<() => void>;
  closeWork?: Promise<boolean>;
  closeRequested?: boolean;
  reaper?: TerminalReaper;
  life?: TimerHandle;
  proof?: TerminalPhysicalResult;
  inputSeq: number;
  resizeSeq: number;
  exitCode?: number;
  sealed: boolean;
};
export interface TerminalServiceDependenciesV2 {
  ledger: TerminalAllocationLedgerPortV2;
  context: TerminalContextPort;
  hubInstance: string;
  limits?: Readonly<TerminalMachineLimitsV2>;
  /** Capture fence revision BEFORE any await. check must synchronously recheck auth expiry,
   * fence revision, machine/plain/source, exact live scope, guard and healthy privacy.
   * Throws fixed TerminalFaultV2 on refusal. No terminal disk dependency in auth. */
  revision(): number;
  check(auth: AuthIdentity, scope: TerminalScopeV2, capturedRevision: number): TerminalTargetLimitsV2;
  /** Test-only seam; production omit. Invoked only AFTER exact durable reservation.
   * Factory MUST either return the sole backend handle, or throw before any possible fork. */
  backend?(options: TerminalBackendOptions): TerminalBackend;
  /** Test-only kernel fixture; production reads real kernel boot UUID. */
  kernelBootId?: string;
}
export class HubTerminalServiceV2 implements TerminalServiceV2 {
  private readonly allocationsById = new Map<string, AllocationV2>();
  private readonly hot = new Map<string, Hot>();
  private readonly intents = new Map<string, Intent>();
  private readonly pendingScopes = new Map<string, Intent>();
  private readonly completed = new Map<string, { scope: string; row: TerminalTabRowV2; hidden?: boolean }>();
  private readonly retired = new Set<string>();
  private ledger: LedgerV2 | undefined;
  private unavailable = false;
  private disposed = false;
  private initialized = false;
  private scopeAdmissionBlocked = false;
  private initializeWork: Promise<boolean> | undefined;
  private physicalPrunes = 0;
  private unspawnedPrunes = 0;
  private boot = "";
  private contextFlights = 0;
  private mutationFlights = 0;
  private revision = 0;
  private ordinal = 0;
  private mutations: Promise<void> = Promise.resolve();
  private readonly limits: Readonly<TerminalMachineLimitsV2>;
  private disposeWork: Promise<{ clean: boolean; unresolved: number }> | undefined;
  constructor(private readonly deps: TerminalServiceDependenciesV2) {
    this.limits = Object.freeze({ ...(deps.limits ?? DEFAULT_TERMINAL_LIMITS_V2) });
  }
  /** P6 calls once under existing singleton, after tools supplied a valid v2 store. */
  initialize(signal: AbortSignal): Promise<boolean> {
    if (this.initializeWork) return this.initializeWork;
    this.initialized = true;
    this.initializeWork = (async () => {
      try {
        const work = (async () => {
          this.boot = this.deps.kernelBootId ?? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(this.boot)) throw new Error();
          const loaded = await this.deps.ledger.load(signal);
          if (
            loaded.kind !== "loaded" ||
            !terminalLedgerV2Ok(loaded.ledger) ||
            signal.aborted ||
            this.unavailable ||
            this.disposed
          )
            throw new Error();
          this.ledger = structuredClone(loaded.ledger);
          for (const a of this.ledger.allocations) this.allocationsById.set(a.allocationId, a);
          return true;
        })();
        return await boundedV2(work, Date.now() + L.contextMs, signal);
      } catch {
        this.unavailable = true;
        return false;
      }
    })();
    return this.initializeWork;
  }
  private check(auth: AuthIdentity, scope: TerminalScopeV2, revision: number) {
    if (this.disposed || this.retired.has(key(scope))) throw new TerminalFaultV2("E_SESSION_CHANGED");
    if (Date.now() >= auth.parentExpiresAt) throw new TerminalFaultV2("E_AUTH");
    return effectiveLimitsV2(this.limits, this.deps.check(auth, scope, revision));
  }
  private hub(hubInstance: string) {
    if (hubInstance !== this.deps.hubInstance) throw new TerminalFaultV2("E_HUB_CHANGED");
  }
  private resources() {
    if (!this.initialized || this.unavailable || !this.ledger) throw new TerminalFaultV2("E_RESOURCE_UNAVAILABLE");
    return this.ledger;
  }
  private pendingAllocationIds() {
    return new Set([...this.intents.values()].filter((i) => !i.result && i.allocationId).map((i) => i.allocationId!));
  }
  private hotIds() {
    return new Set([
      ...this.pendingAllocationIds(),
      ...[...this.hot.values()].filter((h) => h.row.state !== "cleanup-unknown").map((h) => h.allocation.allocationId),
    ]);
  }
  private tabs(auth: AuthIdentity, scope: TerminalScopeV2, limits: TerminalMachineLimitsV2) {
    const hotRows = [...this.hot.values()]
      .filter((h) => key(h.allocation.scope) === key(scope))
      .map((h) => ({ ...h.row }));
    const completedRows = [...this.completed.values()]
      .filter((c) => c.scope === key(scope) && !c.hidden)
      .map((c) => ({ ...c.row }));
    const remaining = Math.max(0, L.scopeRows - hotRows.length);
    const pending = this.pendingAllocationIds();
    return {
      revision: this.revision,
      rows: hotRows.concat(remaining ? completedRows.slice(-remaining) : []).sort((a, b) => a.ordinal - b.ordinal),
      unknownResources: [...this.allocationsById.values()]
        .filter((a) => a.quotaSessionKey === scope.sessionId && !this.hot.has(a.termId) && !pending.has(a.allocationId))
        .map((a) => ({ allocationTag: a.allocationId, state: "cleanup-unknown" as const })),
      quota: quotaV2(this.allocationsById.values(), this.hotIds(), scope.sessionId, principal(auth), limits),
    };
  }
  private notify(h: Hot) {
    this.revision++;
    // The existing active term is also the card's sole tabs update channel. Wake every
    // exact-scope runtime on create/rename/close, not only the mutated (possibly inactive) tab.
    const handles = new Set([
      h,
      ...[...this.hot.values()].filter((other) => key(other.allocation.scope) === key(h.allocation.scope)),
    ]);
    for (const handle of handles)
      for (const fn of [...handle.changed]) {
        try {
          fn();
        } catch {
          /* local observer only */
        }
      }
  }
  private async mutate<T>(fn: () => Promise<T>, signal?: AbortSignal, at?: number): Promise<T> {
    const prior = this.mutations;
    let release!: () => void;
    this.mutations = new Promise<void>((r) => {
      release = r;
    });
    this.mutationFlights++;
    const work = prior
      .then(async () => {
        if (signal?.aborted || (at !== undefined && Date.now() >= at)) throw new TerminalFaultV2("E_DEADLINE");
        return fn();
      })
      .finally(() => {
        this.mutationFlights--;
        release();
      });
    // Cancel the waiter, not FIFO ownership: late queued work observes the sealed signal
    // and cannot mutate/fork; successors never overtake an unresolved actual writer.
    return signal && at !== undefined ? boundedV2(work, at, signal) : work;
  }
  private async commit(next: LedgerV2, signal: AbortSignal) {
    const old = this.resources();
    const result = await this.deps.ledger.commit(old.revision, next, signal);
    if (result.kind !== "committed" || result.revision !== next.revision) {
      if (result.kind === "conflict" || result.kind === "committed" || result.effect === "unknown")
        this.unavailable = true;
      throw new TerminalFaultV2("E_RESOURCE_UNAVAILABLE", result.kind === "unavailable" ? result.effect : "unknown");
    }
    this.ledger = structuredClone(next);
  }
  async list(auth: AuthIdentity, scope: TerminalScopeV2, signal: AbortSignal): Promise<TerminalHttpResponseV2<"list">> {
    try {
      if (signal.aborted) throw new TerminalFaultV2("E_DEADLINE");
      const limits = this.check(auth, scope, this.deps.revision());
      this.resources();
      return { ok: true, hubInstance: this.deps.hubInstance, ...this.tabs(auth, scope, limits) };
    } catch (e) {
      return failureV2(e);
    }
  }
  private expireIntents() {
    for (const [k, i] of this.intents)
      if (
        i.terminalAt !== undefined &&
        Date.now() - i.terminalAt >= L.intentTerminalMs &&
        (!i.allocationId || !this.allocationsById.has(i.allocationId))
      )
        this.intents.delete(k);
  }
  async create(
    auth: AuthIdentity,
    scope: TerminalScopeV2,
    input: TerminalCreateInputV2,
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"create">> {
    try {
      this.hub(input.hubInstance);
      if (this.scopeAdmissionBlocked) throw new TerminalFaultV2("E_LIMIT");
      if (signal.aborted) throw new TerminalFaultV2("E_DEADLINE");
      if (!terminalHttpRequestV2Ok("create", { scope, ...input })) throw new TerminalFaultV2("E_BAD_REQUEST");
      const rev = this.deps.revision();
      this.check(auth, scope, rev);
      this.resources();
      const scopeKey = key(scope),
        intentKey = `${scopeKey}:${input.requestId}`;
      const fingerprint = JSON.stringify([principal(auth), auth.sidTag, input.mode, input.cols, input.rows]);
      let intent = this.intents.get(intentKey);
      if (intent && intent.fingerprint !== fingerprint) throw new TerminalFaultV2("E_IDEMPOTENCY_CONFLICT");
      if (!intent) {
        this.expireIntents();
        if (
          this.intents.size >= L.intentsTotal ||
          [...this.intents.values()].filter((i) => i.scope === scopeKey).length >= L.intentsPerScope
        )
          throw new TerminalFaultV2("E_LIMIT");
        const controller = new AbortController();
        const acceptedAt = Date.now() + L.httpMs;
        const end = systemClock.setTimer(L.httpMs, () => controller.abort());
        intent = {
          at: acceptedAt,
          scope: scopeKey,
          fingerprint,
          auth: { ...auth },
          controller,
          promise: Promise.resolve({ ok: false, code: "E_UNAVAILABLE", effect: "none" }),
        };
        this.intents.set(intentKey, intent);
        const pending = this.pendingScopes.get(scopeKey);
        const existing = [...this.hot.values()].find(
          (h) => key(h.allocation.scope) === scopeKey && !h.sealed && ["starting", "live"].includes(h.row.state),
        );
        if (input.mode === "ensure-empty" && (pending || existing)) {
          intent.promise = pending
            ? pending.promise.then((result) => (result.ok ? { ...result, requestId: input.requestId } : result))
            : Promise.resolve({
                ok: true,
                requestId: input.requestId,
                termId: existing!.row.termId,
                state: existing!.row.state,
              });
        } else if (pending) {
          // Every scope has only one context/create flight. Explicit new remains its own intent.
          intent.promise = pending.promise.then(() => this.runCreate(auth, scope, input, rev, intent!));
          this.pendingScopes.set(scopeKey, intent);
        } else {
          intent.promise = this.runCreate(auth, scope, input, rev, intent);
          this.pendingScopes.set(scopeKey, intent);
        }
        const selected = intent;
        void intent.promise
          .then((result) => {
            end.cancel();
            selected.result = result;
            selected.terminalAt = Date.now();
            if (result.ok) {
              const allocation = this.hot.get(result.termId)?.allocation;
              if (allocation) selected.allocationId = allocation.allocationId;
            }
          })
          .finally(() => {
            if (this.pendingScopes.get(scopeKey) === selected) this.pendingScopes.delete(scopeKey);
          });
      }
      // HTTP abort cancels only this waiter, never the accepted owner operation.
      const result = await boundedV2(intent.promise, Date.now() + L.httpMs, signal);
      try {
        this.check(auth, scope, rev);
      } catch (e) {
        const f = failureV2(e);
        return result.ok || result.effect === "unknown" ? { ...f, effect: "unknown" } : f;
      }
      return result;
    } catch (e) {
      return failureV2(e);
    }
  }
  private async runCreate(
    auth: AuthIdentity,
    scope: TerminalScopeV2,
    input: TerminalCreateInputV2,
    rev: number,
    intent: Intent,
  ): Promise<TerminalHttpResponseV2<"create">> {
    const at = intent.at,
      signal = intent.controller.signal;
    const deadline = systemClock.setTimer(Math.max(0, at - Date.now()), () => intent.controller.abort());
    let h: Hot | undefined;
    try {
      const limits = this.check(auth, scope, rev);
      this.resources();
      if (this.scopeAdmissionBlocked) throw new TerminalFaultV2("E_LIMIT");
      if (signal.aborted || Date.now() >= at) throw new TerminalFaultV2("E_DEADLINE");
      if (this.contextFlights >= L.contextFlights) throw new TerminalFaultV2("E_LIMIT");
      this.contextFlights++;
      let snapshot: TerminalContextSnapshotV2;
      const rpc = new AbortController();
      const cancel = () => rpc.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const contextWork = Promise.resolve().then(() => this.deps.context.resolve(scope, rpc.signal));
      void contextWork.then(
        () => {
          this.contextFlights--;
        },
        () => {
          this.contextFlights--;
        },
      );
      try {
        snapshot = await boundedV2(contextWork, Math.min(at, Date.now() + L.contextMs), signal);
      } finally {
        rpc.abort();
        signal.removeEventListener("abort", cancel);
      }
      this.check(auth, scope, rev);
      if (!this.deps.context.current(snapshot) || key(snapshot.scope) !== key(scope))
        throw new TerminalFaultV2("E_SESSION_CHANGED");
      if (!terminalCwdV2Ok(snapshot.cwd)) throw new TerminalFaultV2("E_CWD");
      const effective = effectiveLimitsV2(limits, snapshot.limits);
      const allocation: AllocationV2 = {
        allocationId: id(),
        termId: id(),
        kernelBootId: this.boot,
        hubInstance: this.deps.hubInstance,
        scope: { ...scope },
        quotaSessionKey: scope.sessionId,
        principalKey: principal(auth),
        creatorSidTag: auth.sidTag,
      };
      h = {
        allocation,
        creator: { ...auth },
        context: snapshot,
        row: {
          termId: allocation.termId,
          name: `shell ${++this.ordinal}`,
          state: "starting",
          createdAt: Date.now(),
          ordinal: this.ordinal,
        },
        ring: new TerminalRingV2(),
        invalidated: new AbortController(),
        changed: new Set(),
        inputSeq: 0,
        resizeSeq: 0,
        sealed: false,
      };
      const hot = h;
      await this.mutate(
        async () => {
          this.check(auth, scope, rev);
          if (signal.aborted || !this.deps.context.current(snapshot)) throw new TerminalFaultV2("E_SESSION_CHANGED");
          const ledger = this.resources();
          assertQuotaV2(
            quotaV2(this.allocationsById.values(), this.hotIds(), scope.sessionId, principal(auth), effective),
          );
          this.allocationsById.set(allocation.allocationId, allocation);
          intent.allocationId = allocation.allocationId;
          try {
            await this.commit(
              { ...ledger, revision: ledger.revision + 1, allocations: [...this.allocationsById.values()] },
              signal,
            );
          } catch (e) {
            if (!this.unavailable) this.allocationsById.delete(allocation.allocationId);
            throw e;
          }
          // Durable reserve is complete; only now expose the starting runtime owner.
          this.hot.set(allocation.termId, hot);
          this.notify(hot);
          if (signal.aborted || this.disposed || this.retired.has(key(scope)) || !this.deps.context.current(snapshot)) {
            void this.cleanup(hot);
            throw new TerminalFaultV2("E_SESSION_CHANGED", "unknown");
          }
        },
        signal,
        at,
      );
      this.check(auth, scope, rev);
      if (hot.sealed || signal.aborted || Date.now() >= at || !this.deps.context.current(snapshot))
        throw new TerminalFaultV2("E_SESSION_CHANGED");
      const lifetime = Math.min(effective.maxLifetimeMs, auth.parentExpiresAt - Date.now());
      if (lifetime <= 0) throw new TerminalFaultV2("E_AUTH");
      // No await between final guard and construction/fork.
      hot.backend = (this.deps.backend ?? createTerminalBackend)({
        cwd: snapshot.cwd,
        cols: input.cols,
        rows: input.rows,
        inputIdleMs: effective.inputIdleMs,
        maxLifetimeMs: lifetime,
        onData: (bytes) => {
          if (hot.sealed) return;
          try {
            hot.ring.append(bytes);
            this.notify(hot);
          } catch {
            void this.cleanup(hot);
          }
        },
      });
      hot.life = systemClock.setTimer(lifetime, () => {
        void this.cleanup(hot);
      });
      void hot.backend.done.then((result) => {
        hot.proof = result;
        void this.cleanup(hot);
      });
      await boundedV2(hot.backend.ready, Math.min(at, Date.now() + L.backendMs), signal);
      this.check(auth, scope, rev);
      if (hot.sealed || !this.deps.context.current(snapshot)) throw new TerminalFaultV2("E_SESSION_CHANGED", "unknown");
      hot.row.state = "live";
      const display = hot.backend.display;
      const metadata: TerminalMetadataV2 = {
        cwd: snapshot.cwd,
        shellName: display?.shellName ?? "unknown",
        userLabel: display?.userLabel ?? "unknown",
        hostLabel: display?.hostLabel ?? "unknown",
      };
      hot.row.name = normalizeTerminalNameV2(`${metadata.shellName} ${hot.row.ordinal}`) ?? `shell ${hot.row.ordinal}`;
      hot.runtime = this.makeRuntime(hot, metadata);
      this.notify(hot);
      return { ok: true, requestId: input.requestId, termId: allocation.termId, state: "live" };
    } catch (e) {
      if (h && this.hot.get(h.row.termId) === h) void this.cleanup(h);
      const error =
        e instanceof TerminalBackendError
          ? new TerminalFaultV2(
              e.code === "E_BAD_REQUEST"
                ? "E_CWD"
                : e.code === "E_DEADLINE"
                  ? "E_DEADLINE"
                  : e.code === "E_LIMIT"
                    ? "E_LIMIT"
                    : "E_BACKEND",
              h?.backend ? "unknown" : "none",
            )
          : e;
      const failed = failureV2(error);
      return h && this.allocationsById.has(h.allocation.allocationId) ? { ...failed, effect: "unknown" } : failed;
    } finally {
      deadline.cancel();
    }
  }
  private makeRuntime(h: Hot, metadata: TerminalMetadataV2): TerminalRuntimeV2 {
    const current = () =>
      !this.disposed && !h.sealed && this.hot.get(h.row.termId) === h && this.deps.context.current(h.context);
    return Object.freeze({
      termId: h.row.termId,
      invalidated: h.invalidated.signal,
      metadata: Object.freeze(metadata),
      current,
      snapshot: () => ({
        ...h.ring.snapshot(),
        state: h.row.state,
        ...(h.exitCode !== undefined ? { exitCode: h.exitCode } : {}),
      }),
      read: (offset: number, maxBytes: number) => {
        if (!current()) throw new TerminalFaultV2("E_VIEW_CHANGED");
        return h.ring.read(offset, maxBytes);
      },
      subscribe: (fn: () => void) => {
        if (h.changed.size >= 128) throw new TerminalFaultV2("E_LIMIT");
        h.changed.add(fn);
        return () => {
          h.changed.delete(fn);
        };
      },
      write: async (
        bytesB64: string,
        kind: "user" | "terminal_response",
        signal: AbortSignal,
      ): Promise<{ ok: true } | TerminalFailureV2> => {
        if (!current() || signal.aborted) return { ok: false, code: "E_VIEW_CHANGED", effect: "none" };
        const size = terminalBase64BytesV2(bytesB64);
        if (size === undefined || size > L.inputBytes || !["user", "terminal_response"].includes(kind))
          return { ok: false, code: "E_BAD_REQUEST", effect: "none" };
        if (!Number.isSafeInteger(++h.inputSeq)) {
          void this.cleanup(h);
          return { ok: false, code: "E_LIMIT", effect: "none" };
        }
        try {
          await boundedV2(
            h.backend!.input(h.inputSeq, Buffer.from(bytesB64, "base64"), kind),
            Date.now() + L.contextMs,
            signal,
          );
          return { ok: true };
        } catch {
          return { ok: false, code: "E_INPUT_UNKNOWN", effect: "unknown" };
        }
      },
      resize: async (cols: number, rows: number, signal: AbortSignal): Promise<{ ok: true } | TerminalFailureV2> => {
        if (!current() || signal.aborted) return { ok: false, code: "E_VIEW_CHANGED", effect: "none" };
        if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200)
          return { ok: false, code: "E_BAD_REQUEST", effect: "none" };
        if (!Number.isSafeInteger(++h.resizeSeq)) {
          void this.cleanup(h);
          return { ok: false, code: "E_LIMIT", effect: "none" };
        }
        try {
          await boundedV2(h.backend!.resize(h.resizeSeq, cols, rows), Date.now() + L.contextMs, signal);
          return { ok: true };
        } catch {
          return { ok: false, code: "E_BACKEND", effect: "unknown" };
        }
      },
    });
  }
  async runtime(auth: AuthIdentity, input: TerminalHttpRequestsV2["view"], signal: AbortSignal) {
    try {
      this.hub(input.hubInstance);
      this.check(auth, input.scope, this.deps.revision());
      if (signal.aborted) throw new TerminalFaultV2("E_DEADLINE");
      const h = this.hot.get(input.termId);
      if (!h || key(h.allocation.scope) !== key(input.scope)) {
        if (
          [...this.allocationsById.values()].some(
            (a) => a.termId === input.termId && a.quotaSessionKey === input.scope.sessionId,
          )
        )
          throw new TerminalFaultV2("E_CLEANUP_UNKNOWN");
        throw new TerminalFaultV2("E_NOT_FOUND");
      }
      if (!h.runtime || !h.runtime.current()) throw new TerminalFaultV2("E_NOT_READY");
      return { ok: true as const, runtime: h.runtime };
    } catch (e) {
      return failureV2(e);
    }
  }
  async creation(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["creation"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"creation">> {
    try {
      this.hub(input.hubInstance);
      this.check(auth, input.scope, this.deps.revision());
      if (signal.aborted) throw new TerminalFaultV2("E_DEADLINE");
      const i = this.intents.get(`${key(input.scope)}:${input.requestId}`);
      if (!i) return { ok: true, outcome: "unknown" };
      if (!i.result) return { ok: true, outcome: "pending" };
      if (i.result.ok) return { ok: true, outcome: "created", termId: i.result.termId };
      return i.result.effect === "unknown"
        ? { ok: true, outcome: "unknown" }
        : { ok: true, outcome: "failed", code: i.result.code };
    } catch (e) {
      return failureV2(e);
    }
  }
  async rename(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["rename"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"rename">> {
    try {
      this.hub(input.hubInstance);
      this.check(auth, input.scope, this.deps.revision());
      if (signal.aborted) throw new TerminalFaultV2("E_DEADLINE");
      const name = normalizeTerminalNameV2(input.name);
      if (!name) throw new TerminalFaultV2("E_BAD_REQUEST");
      const h = this.hot.get(input.termId);
      if (!h || key(h.allocation.scope) !== key(input.scope)) throw new TerminalFaultV2("E_NOT_FOUND");
      h.row.name = name;
      this.notify(h);
      return { ok: true, row: { ...h.row }, revision: this.revision };
    } catch (e) {
      return failureV2(e);
    }
  }
  async close(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["close"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"close">> {
    try {
      this.hub(input.hubInstance);
      this.check(auth, input.scope, this.deps.revision());
      const a = [...this.allocationsById.values()].find((a) => a.termId === input.termId);
      if (a && a.quotaSessionKey !== input.scope.sessionId) throw new TerminalFaultV2("E_NOT_FOUND");
      if (a && !this.hot.has(input.termId)) throw new TerminalFaultV2("E_CLEANUP_UNKNOWN");
      const h = this.hot.get(input.termId);
      if (!h || key(h.allocation.scope) !== key(input.scope)) {
        this.resources();
        const completed = this.completed.get(input.termId);
        if (completed?.scope === key(input.scope)) {
          if (!completed.hidden) {
            completed.hidden = true;
            this.revision++;
          }
          return { ok: true, state: "closed", revision: this.revision };
        }
        throw new TerminalFaultV2("E_NOT_FOUND");
      }
      // Explicit close dismisses the tab ONLY after exact proof+durable prune.
      // Keep bounded completed metadata for idempotent close, not as a visible tab.
      h.closeRequested = true;
      const work = this.cleanup(h);
      const clean = await boundedV2(work, Date.now() + L.reapMs, signal);
      return { ok: true, state: clean ? "closed" : "closing", revision: this.revision };
    } catch (e) {
      return failureV2(e);
    }
  }
  private seal(h: Hot) {
    if (h.sealed) return;
    h.sealed = true;
    h.invalidated.abort();
    h.row.state = "closing";
    h.life?.cancel();
    h.ring.clear();
    this.notify(h);
  }
  private proofComplete(p: TerminalPhysicalResult) {
    return p.outcome === "reaped" && p.spawnSettled && p.ptyClosed && p.helperReaped && p.managedGroupsGone;
  }
  private async prune(h: Hot, p: TerminalPhysicalResult): Promise<boolean> {
    if (!this.proofComplete(p)) return false;
    h.proof = p;
    return this.mutate(async () => {
      const a = this.allocationsById.get(h.allocation.allocationId);
      if (!a) return !this.hot.has(h.row.termId);
      if (a !== h.allocation) return false;
      const ledger = this.resources();
      await this.commit(
        {
          ...ledger,
          revision: ledger.revision + 1,
          allocations: ledger.allocations.filter((row) => row.allocationId !== a.allocationId),
        },
        new AbortController().signal,
      );
      this.allocationsById.delete(a.allocationId);
      this.hot.delete(h.row.termId);
      if (h.backend) this.physicalPrunes++;
      else this.unspawnedPrunes++;
      h.reaper?.stop();
      h.row.state = p.exitCode === undefined ? "failed" : "exited";
      if (p.exitCode !== undefined) h.exitCode = p.exitCode;
      this.completed.set(h.row.termId, {
        scope: key(h.allocation.scope),
        row: { ...h.row },
        hidden: h.closeRequested === true,
      });
      const same = [...this.completed].filter(([, c]) => c.scope === key(h.allocation.scope));
      while (same.length > L.scopeRows) {
        this.completed.delete(same.shift()![0]);
      }
      // Completed metadata is globally bounded too; live/unknown allocations are never evicted.
      while (this.completed.size > 2048) this.completed.delete(this.completed.keys().next().value!);
      for (const intent of this.intents.values())
        if (intent.allocationId === a.allocationId) intent.terminalAt = Date.now();
      this.notify(h);
      h.changed.clear();
      return true;
    }).catch(() => false);
  }
  private cleanup(h: Hot): Promise<boolean> {
    this.seal(h);
    if (h.closeWork) return h.closeWork;
    h.closeWork = Promise.resolve().then(async () => {
      h.backend?.close();
      if (!h.backend) {
        // Reservation committed but backend constructor never returned: factory must have zero
        // future fork on throw. Production Python constructor validates before spawn only.
        return this.prune(h, {
          outcome: "reaped",
          spawnSettled: true,
          ptyClosed: true,
          helperReaped: true,
          managedGroupsGone: true,
          identitiesChecked: [],
          waited: [],
        });
      }
      let result: TerminalPhysicalResult | undefined;
      try {
        result = await boundedV2(h.backend.done, Date.now() + L.reapMs, new AbortController().signal);
      } catch {
        /* unknown retains slot */
      }
      if (result && (await this.prune(h, result))) return true;
      h.row.state = "cleanup-unknown";
      this.notify(h);
      h.reaper = new TerminalReaper(async () => {
        const proof = await h.backend!.retryReap();
        return this.prune(h, proof);
      });
      h.reaper.start();
      return false;
    });
    return h.closeWork;
  }
  /** Link/declaration/privacy loss seals existing handles and futures. A later
   * trusted link/declaration for the SAME scope may create again; old handles never revive. */
  invalidateScope(scope: TerminalScopeV2): void {
    const k = key(scope);
    for (const i of this.intents.values()) if (i.scope === k) i.controller.abort();
    for (const h of this.hot.values()) if (key(h.allocation.scope) === k) void this.cleanup(h);
  }
  retireScope(scope: TerminalScopeV2): void {
    const k = key(scope);
    if (this.retired.size < L.intentsTotal || this.retired.has(k)) this.retired.add(k);
    else this.scopeAdmissionBlocked = true;
    this.invalidateScope(scope);
  }
  /** P2 synchronous invalidate callback: abort all in-flight creates conservatively, close
   * only matching creators. Caller must isolate exceptions; no IO is awaited here. */
  abortCreates(): void {
    for (const i of this.intents.values()) if (!i.result) i.controller.abort();
  }
  invalidateCreators(matches: (creator: Readonly<AuthIdentity>) => boolean): void {
    this.abortCreates();
    let fault = false;
    for (const h of this.hot.values()) {
      try {
        if (matches(h.creator))
          void this.cleanup(h).catch(() => {
            this.unavailable = true;
          });
      } catch {
        fault = true;
      }
    }
    if (fault) {
      this.unavailable = true;
      for (const h of this.hot.values()) void this.cleanup(h).catch(() => {});
    }
  }
  /** Internal read-only maintenance facts, never HTTP/wire or an authority to reset slots.
   * clean requires accepted futures settled + no hot handles + trustworthy empty allocation set. */
  maintenanceSnapshot() {
    return {
      stopped: this.disposed,
      resourceAvailable: !this.unavailable && !!this.ledger,
      pendingCreates: [...this.intents.values()].filter((i) => !i.result).length,
      contextFlights: this.contextFlights,
      mutationFlights: this.mutationFlights,
      runtimes: [...this.hot.values()].map((h) => ({
        termId: h.row.termId,
        sealed: h.sealed,
        spawnSettled: h.backend?.spawnSettled ?? true,
        proofComplete: !!h.proof && this.proofComplete(h.proof),
        pruned: !this.allocationsById.has(h.allocation.allocationId),
      })),
      ledger: this.ledger ? structuredClone(this.ledger) : undefined,
      allocationCount: this.allocationsById.size,
      consistent:
        !!this.ledger &&
        this.ledger.allocations.length === this.allocationsById.size &&
        this.ledger.allocations.every(
          (a) => JSON.stringify(a) === JSON.stringify(this.allocationsById.get(a.allocationId)),
        ),
      physicalPrunes: this.physicalPrunes,
      unspawnedPrunes: this.unspawnedPrunes,
    };
  }
  dispose(): Promise<{ clean: boolean; unresolved: number }> {
    if (this.disposeWork) return this.disposeWork;
    this.disposed = true;
    for (const i of this.intents.values()) i.controller.abort();
    for (const h of this.hot.values()) this.seal(h);
    this.disposeWork = (async () => {
      const wait = Promise.allSettled([...this.intents.values()].map((i) => i.promise));
      try {
        await boundedV2(wait, Date.now() + L.httpMs, new AbortController().signal);
      } catch {
        /* futures not falsely settled */
      }
      await Promise.all([...this.hot.values()].map((h) => this.cleanup(h)));
      try {
        await boundedV2(this.mutations, Date.now() + L.contextMs, new AbortController().signal);
      } catch {
        /* truthful pending writer below */
      }
      const pending =
        [...this.intents.values()].filter((i) => !i.result).length + this.contextFlights + this.mutationFlights;
      return {
        clean: !this.unavailable && this.initialized && !pending && !this.hot.size && !this.allocationsById.size,
        unresolved: this.allocationsById.size + pending,
      };
    })();
    return this.disposeWork;
  }
}
