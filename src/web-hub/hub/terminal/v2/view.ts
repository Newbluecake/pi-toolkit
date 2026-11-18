/** Independent NDJSON view state. P1 remains the only PTY/ring/resource owner. */
import { randomBytes } from "node:crypto";
import type { AuthIdentity } from "../../auth-identity.js";
import type { AuthRevokeSelector } from "../../auth-revoke.js";
import type {
  TerminalAuthFenceV2,
  TerminalRuntimeV2,
  TerminalServiceV2,
  TerminalViewPortV2,
  TerminalViewV2,
  TerminalViewSinkV2,
} from "../../terminal-v2-ports.js";
import {
  terminalHttpRequestV2Ok,
  terminalViewFrameV2Ok,
  type TerminalHttpRequestsV2,
  type TerminalHttpResponseV2,
  type TerminalViewFrameV2,
  type TerminalFailureV2,
} from "../../../protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L, terminalBase64BytesV2 } from "../../../protocol/terminal-v2-values.js";
import {
  asFailure,
  clampSpanMs,
  deadline,
  fail,
  inputUnknown,
  requireLive,
  TerminalV2Fault,
  viewClock,
} from "./local.js";
import { matchesTerminalAuthV2, type TerminalAuthNotificationsV2 } from "./revocation-fence.js";

/** Auth authority supplies an already-resolved current identity or honest failure. No cookie
 * parsing here. E_DB/timeout detaches only this view; failures never alter resource health. */
export type TerminalAuthFailureV2 = TerminalFailureV2 & {
  code: "E_AUTH" | "E_REVOKING" | "E_DB" | "E_RATE" | "E_DEADLINE";
};
export type TerminalRevalidateV2 = (
  identity: Readonly<AuthIdentity>,
  signal: AbortSignal,
) => Promise<{ ok: true; identity: AuthIdentity } | TerminalAuthFailureV2>;
export interface TerminalViewsV2 extends TerminalViewPortV2 {
  invalidate(selector: AuthRevokeSelector): void;
  dispose(): void;
}
export interface TerminalViewDepsV2 {
  service: TerminalServiceV2;
  hubInstance: string;
  auth: TerminalAuthFenceV2;
  notifications: Pick<TerminalAuthNotificationsV2, "subscribe">;
  revalidate: TerminalRevalidateV2;
  now?: () => number;
}
type InputResult = TerminalHttpResponseV2<"input">;
type Entry = { payload: string; result: Promise<InputResult> };
type Queued = { frame: TerminalViewFrameV2; raw: number; size: number; replay: boolean };
function sameIdentity(a: Readonly<AuthIdentity>, b: Readonly<AuthIdentity>): boolean {
  return (
    a.listener === b.listener &&
    a.sidTag === b.sidTag &&
    a.principal === b.principal &&
    a.userId === b.userId &&
    a.lan?.epoch === b.lan?.epoch
  );
}
function sameScope(a: TerminalHttpRequestsV2["list"]["scope"], b: TerminalHttpRequestsV2["list"]["scope"]): boolean {
  return a.agentKey === b.agentKey && a.sessionId === b.sessionId && a.epoch === b.epoch;
}

export function createTerminalViewsV2(deps: TerminalViewDepsV2): TerminalViewsV2 {
  const now = deps.now ?? Date.now;
  const clock = viewClock(now);
  const views = new Map<string, View>();
  const writers = new Map<TerminalRuntimeV2, View>();
  let flights = new AbortController();
  let disposed = false;
  let creditAt = now();
  let globalCredit = L.hubRateBytes as number;
  let liveCredit = L.hubRateBytes - L.replayRateBytes;
  let scheduler: ReturnType<typeof clock.setTimer> | undefined;
  const replenish = () => {
    const elapsed = clampSpanMs(now() - creditAt);
    creditAt = now();
    globalCredit = Math.min(L.hubRateBytes, globalCredit + (elapsed * L.hubRateBytes) / 1000);
    liveCredit = Math.min(
      L.hubRateBytes - L.replayRateBytes,
      liveCredit + (elapsed * (L.hubRateBytes - L.replayRateBytes)) / 1000,
    );
    for (const view of views.values())
      view.credit = Math.min(L.viewRateBytes, view.credit + (elapsed * L.viewRateBytes) / 1000);
  };
  function schedule(delay = 0) {
    if (scheduler || disposed) return;
    scheduler = clock.setTimer(clampSpanMs(delay), drain);
  }
  function drain() {
    scheduler = undefined;
    replenish();
    let next = Infinity;
    // One frame per view per pass; zero-delay clock yields between bounded passes.
    for (const view of [...views.values()]) {
      const item = view.queue[0];
      if (!item || !view.sink || view.closed) continue;
      const available = Math.min(globalCredit, view.credit, item.replay ? globalCredit : liveCredit);
      if (item.raw > available) {
        next = Math.min(
          next,
          Math.max(
            1,
            Math.ceil(((item.raw - available) * 1000) / Math.min(L.viewRateBytes, L.hubRateBytes - L.replayRateBytes)),
          ),
        );
        continue;
      }
      globalCredit -= item.raw;
      if (!item.replay) liveCredit -= item.raw;
      view.credit -= item.raw;
      view.queue.shift();
      view.queuedRaw -= item.raw;
      view.queuedSize -= item.size;
      view.deliver(item.frame);
      if (view.queue.length) next = 0;
    }
    if (Number.isFinite(next)) schedule(next);
  }
  class View implements TerminalViewV2 {
    readonly viewId = randomBytes(24).toString("base64url");
    readonly controller = new AbortController();
    readonly queue: Queued[] = [];
    readonly inputs = new Map<number, Entry>();
    readonly resizes = new Map<number, Entry>();
    readonly identity: Readonly<AuthIdentity>;
    sink: TerminalViewSinkV2 | undefined;
    closed = false;
    started = false;
    ready = false;
    readyQueued = false;
    replaySent = false;
    queuedRaw = 0;
    queuedSize = 0;
    credit = L.viewRateBytes as number;
    sent: number;
    consumed: number;
    cursor: number;
    readonly replayEnd: number;
    private pendingInput = 0;
    private pendingWrites = 0;
    private inputMax = -1;
    private resizeMax = -1;
    private resizeActive = false;
    private resizePending:
      { cols: number; rows: number; seq: number; complete: Array<(result: InputResult) => void> } | undefined;
    private sentRaw: Array<{ start: number; end: number }> = [];
    private sentFrames: Array<{ offset: number; size: number }> = [];
    private sentSize = 0;
    private lastProgress = now();
    private lastAck = now();
    private lastPing = now();
    private lastAuth = now();
    private checking = false;
    private offRuntime: (() => void) | undefined;
    private timer: ReturnType<typeof clock.setTimer> | undefined;
    private stateKey = "";
    constructor(
      readonly runtime: TerminalRuntimeV2,
      readonly request: TerminalHttpRequestsV2["view"],
      id: AuthIdentity,
    ) {
      this.identity = Object.freeze({ ...id, ...(id.lan ? { lan: Object.freeze({ ...id.lan }) } : {}) });
      const snapshot = runtime.snapshot();
      const requested = request.offset ?? snapshot.start;
      if (requested > snapshot.end) throw new TerminalV2Fault(fail("E_BAD_REQUEST"));
      const replay = runtime.read(requested, L.replayBytes);
      this.sent = requested;
      this.consumed = requested;
      this.cursor = replay.end;
      this.replayEnd = replay.end;
      this.enqueue(
        {
          t: "attached",
          hubInstance: deps.hubInstance,
          viewId: this.viewId,
          termId: runtime.termId,
          start: replay.start,
          end: replay.end,
          metadata: { ...runtime.metadata },
        },
        true,
      );
      this.capture(replay, requested, true);
      this.enqueue({ t: "replay-end", offset: replay.end }, true);
    }
    current(
      id: AuthIdentity,
      input: { hubInstance: string; termId: string; viewId: string; scope: TerminalHttpRequestsV2["list"]["scope"] },
    ): void {
      deps.auth.check(id, deps.auth.revision);
      if (input.hubInstance !== deps.hubInstance) throw new TerminalV2Fault(fail("E_HUB_CHANGED"));
      if (
        disposed ||
        this.closed ||
        !this.started ||
        writers.get(this.runtime) !== this ||
        !this.runtime.current() ||
        this.runtime.invalidated.aborted ||
        input.termId !== this.runtime.termId ||
        !sameScope(input.scope, this.request.scope) ||
        !sameIdentity(this.identity, id) ||
        now() >= this.identity.parentExpiresAt
      )
        throw new TerminalV2Fault(fail("E_VIEW_CHANGED"));
    }
    enqueue(frame: TerminalViewFrameV2, replay = false): void {
      if (this.closed) return;
      const raw = frame.t === "output" ? (terminalBase64BytesV2(frame.bytesB64) ?? Infinity) : 0;
      const size = Buffer.byteLength(JSON.stringify(frame)) + 1;
      const unacked = this.sentRaw.reduce((sum, part) => sum + part.end - part.start, 0);
      if (
        !terminalViewFrameV2Ok(frame) ||
        size > L.frameBytes ||
        this.queue.length + this.sentFrames.length >= L.viewPendingItems ||
        this.queuedRaw + unacked + raw > L.viewPendingBytes ||
        this.queuedSize + this.sentSize + size > L.viewSerializedBytes
      ) {
        this.detach();
        return;
      }
      if (raw > 0 && this.queuedRaw === 0 && unacked === 0) this.lastProgress = now();
      this.queue.push({ frame, raw, size, replay });
      this.queuedRaw += raw;
      this.queuedSize += size;
      if (this.sink) {
        schedule();
        if (this.timer) clock.clearTimer(this.timer);
        this.arm();
      }
    }
    capture(read: ReturnType<TerminalRuntimeV2["read"]>, requested: number, replay: boolean): void {
      let offset = requested;
      if (read.start < requested || read.end < read.start || !Number.isSafeInteger(read.end)) {
        this.detach();
        return;
      }
      if (read.start > requested) {
        this.enqueue({ t: "gap", from: requested, to: read.start }, replay);
        offset = read.start;
      }
      let bytes = 0;
      for (const chunk of read.chunks) {
        if (this.closed) return; // A malformed producer cannot keep scanning after the cap trips.
        const n = terminalBase64BytesV2(chunk.bytesB64);
        if (n === undefined || n > L.outputChunkBytes || chunk.offset !== offset || !Number.isSafeInteger(offset + n)) {
          this.detach();
          return;
        }
        bytes += n;
        if (bytes > (replay ? L.replayBytes : L.viewPendingBytes)) {
          this.detach();
          return;
        }
        this.enqueue({ t: "output", offset, bytesB64: chunk.bytesB64 }, replay);
        offset += n;
      }
      if (offset !== read.end) this.detach();
    }
    deliver(frame: TerminalViewFrameV2): void {
      try {
        deps.auth.check(this.identity, deps.auth.revision);
        if (!this.runtime.current() || this.runtime.invalidated.aborted || now() >= this.identity.parentExpiresAt) {
          this.detach();
          return;
        }
        const accepted = this.sink?.send(frame);
        if (!accepted || this.closed) {
          this.detach();
          return;
        }
        if (frame.t === "output") {
          const end = frame.offset + terminalBase64BytesV2(frame.bytesB64)!;
          if (end > frame.offset) this.sentRaw.push({ start: frame.offset, end });
          if (this.sentRaw.length > L.viewPendingItems) {
            this.detach();
            return;
          }
          this.sent = end;
        } else if (frame.t === "gap") this.sent = frame.to;
        else if (frame.t === "replay-end") this.replaySent = true;
        else if (frame.t === "ready") this.ready = true;
        // Includes zero-byte controls until the next renderer ACK, so the view FIFO +
        // response FIFO are not two independent 128-item/128KiB allowances.
        const size = Buffer.byteLength(JSON.stringify(frame)) + 1;
        this.sentFrames.push({ offset: this.sent, size });
        this.sentSize += size;
      } catch {
        this.detach();
      }
    }
    prepare(): void {
      this.runtime.invalidated.addEventListener("abort", this.detach, { once: true });
      this.timer = clock.setTimer(L.contextMs, this.detach);
    }
    start(sink: TerminalViewSinkV2): void {
      if (this.closed || this.started) {
        sink.close();
        return;
      }
      if (this.timer) clock.clearTimer(this.timer);
      this.timer = undefined;
      this.started = true;
      this.sink = sink;
      try {
        if (this.runtime.invalidated.aborted || !this.runtime.current()) {
          this.detach();
          return;
        }
        const unsubscribe = this.runtime.subscribe(this.changed);
        if (this.closed) {
          unsubscribe();
          return;
        }
        this.offRuntime = unsubscribe;
        this.changed();
        schedule();
        this.arm();
      } catch {
        this.detach();
      }
    }
    changed = (): void => {
      if (this.closed) return;
      try {
        const snapshot = this.runtime.snapshot();
        if (snapshot.end > this.cursor) {
          const read = this.runtime.read(this.cursor, L.viewPendingBytes);
          this.capture(read, this.cursor, false);
          this.cursor = read.end;
        }
        const stateKey = `${snapshot.state}:${snapshot.exitCode ?? ""}`;
        if (this.stateKey !== stateKey) {
          this.stateKey = stateKey;
          this.enqueue({
            t: "state",
            termId: this.runtime.termId,
            state: snapshot.state,
            ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
          });
        }
      } catch {
        this.detach();
      }
    };
    private arm(): void {
      if (this.timer) clock.clearTimer(this.timer);
      this.timer = undefined;
      if (this.closed) return;
      const due = Math.min(
        this.identity.parentExpiresAt,
        this.lastAck + L.writerIdleMs,
        this.lastPing + L.pingMs,
        this.lastAuth + L.authRecheckMs,
        this.sentRaw.length || this.queue.some((item) => item.raw > 0) ? this.lastProgress + L.viewerMs : Infinity,
      );
      this.timer = clock.setTimer(clampSpanMs(due - now()), () => this.tick());
    }
    private tick(): void {
      this.timer = undefined;
      if (this.closed) return;
      if (
        now() >= this.identity.parentExpiresAt ||
        now() - this.lastAck >= L.writerIdleMs ||
        ((this.sentRaw.length || this.queue.some((item) => item.raw > 0)) && now() - this.lastProgress >= L.viewerMs)
      ) {
        this.detach();
        return;
      }
      if (now() - this.lastPing >= L.pingMs) {
        this.lastPing = now();
        this.enqueue({ t: "ping" });
        void this.tabs();
      }
      if (!this.checking && now() - this.lastAuth >= L.authRecheckMs) {
        this.lastAuth = now();
        void this.recheck();
      }
      this.arm();
    }
    private async tabs(): Promise<void> {
      const revision = deps.auth.revision;
      const wait = deadline(now, L.contextMs, [this.controller.signal]);
      try {
        requireLive(wait.signal);
        const result = await wait.wait(deps.service.list(this.identity, this.request.scope, wait.signal));
        // An unrelated auth mutation must not close an established nonmatching view.
        // Discard stale tabs rather than publishing them under a later revision.
        deps.auth.check(this.identity, deps.auth.revision);
        if (this.closed || revision !== deps.auth.revision) return;
        if (!result.ok) {
          this.detach();
          return;
        }
        const { ok: _ok, hubInstance: _hub, ...tabs } = result;
        this.enqueue({ t: "tabs", ...tabs });
      } catch {
        this.detach();
      } finally {
        wait.dispose();
      }
    }
    private async recheck(): Promise<void> {
      this.checking = true;
      const wait = deadline(now, L.contextMs, [this.controller.signal]);
      try {
        // Revalidation is causal (not a sleep/poll loop), and ALL attempts share 2s.
        // A revision changed during the await invalidates that fact, not another user's view.
        for (let attempt = 0; attempt < 32; attempt++) {
          const revision = deps.auth.revision;
          requireLive(wait.signal);
          const result = await wait.wait(deps.revalidate(this.identity, wait.signal));
          deps.auth.check(this.identity, deps.auth.revision);
          if (revision !== deps.auth.revision) continue;
          if (!result.ok || !sameIdentity(this.identity, result.identity)) {
            this.detach();
            return;
          }
          deps.auth.check(result.identity, revision);
          return;
        }
        this.detach();
      } catch {
        this.detach();
      } finally {
        this.checking = false;
        wait.dispose();
      }
    }
    acknowledge(input: TerminalHttpRequestsV2["ack"]): TerminalHttpResponseV2<"ack"> {
      if (
        input.offset < this.consumed ||
        input.offset > this.sent ||
        (input.replayComplete && (!this.replaySent || input.offset < this.replayEnd))
      )
        return fail("E_BAD_REQUEST");
      this.lastAck = now();
      if (input.offset > this.consumed) this.lastProgress = now();
      this.consumed = input.offset;
      this.sentFrames = this.sentFrames.filter((frame) => frame.offset > input.offset);
      this.sentSize = this.sentFrames.reduce((sum, frame) => sum + frame.size, 0);
      this.sentRaw = this.sentRaw
        .filter((part) => part.end > input.offset)
        .map((part) => ({ start: Math.max(part.start, input.offset), end: part.end }));
      if (input.replayComplete && !this.readyQueued) {
        this.readyQueued = true;
        this.enqueue({ t: "ready", offset: input.offset });
      }
      if (this.timer) clock.clearTimer(this.timer);
      this.arm();
      return { ok: true, offset: input.offset };
    }
    async input(id: AuthIdentity, input: TerminalHttpRequestsV2["input"], signal: AbortSignal): Promise<InputResult> {
      this.current(id, input);
      if ("queryOnly" in input) return this.inputs.get(input.seq)?.result ?? inputUnknown();
      const payload = JSON.stringify([input.kind, input.bytesB64]);
      const old = this.inputs.get(input.seq);
      if (old) return old.payload === payload ? old.result : fail("E_IDEMPOTENCY_CONFLICT");
      if (input.seq <= this.inputMax) return inputUnknown();
      if (!this.ready) return fail("E_NOT_READY");
      const bytes = terminalBase64BytesV2(input.bytesB64)!;
      if (this.pendingInput + bytes > L.inputPendingBytes || this.pendingWrites >= L.viewPendingItems)
        return fail("E_RATE");
      const revision = deps.auth.revision;
      const wait = deadline(now, L.contextMs, [signal, this.controller.signal, flights.signal]);
      requireLive(wait.signal);
      this.inputMax = input.seq;
      this.pendingInput += bytes;
      this.pendingWrites++;
      // Pin before the backend await, including concurrent duplicate/query calls.
      const result: Promise<InputResult> = Promise.resolve().then(async () => {
        let attempted = false;
        try {
          requireLive(wait.signal);
          deps.auth.check(id, revision);
          this.current(id, input);
          const physical = this.runtime.write(input.bytesB64, input.kind, wait.signal);
          attempted = true;
          // Budget remains pinned until actual backend settlement, not logical cancellation.
          void physical.then(
            () => {
              this.pendingInput -= bytes;
              this.pendingWrites--;
            },
            () => {
              this.pendingInput -= bytes;
              this.pendingWrites--;
            },
          );
          const result = await wait.wait(physical);
          deps.auth.check(id, revision);
          this.current(id, input);
          return result.ok ? { ok: true, acceptedThrough: input.seq } : result;
        } catch {
          return inputUnknown();
        } finally {
          if (!attempted) {
            this.pendingInput -= bytes;
            this.pendingWrites--;
          }
          wait.dispose();
        }
      });
      this.inputs.set(input.seq, { payload, result });
      while (this.inputs.size > L.inputResults) this.inputs.delete(this.inputs.keys().next().value!);
      return result;
    }
    resize(id: AuthIdentity, input: TerminalHttpRequestsV2["resize"], signal: AbortSignal): Promise<InputResult> {
      this.current(id, input);
      const payload = JSON.stringify([input.cols, input.rows]);
      const old = this.resizes.get(input.seq);
      if (old) return Promise.resolve(old.payload === payload ? old.result : fail("E_IDEMPOTENCY_CONFLICT"));
      if (input.seq <= this.resizeMax) return Promise.resolve(fail("E_IDEMPOTENCY_CONFLICT"));
      if (!this.ready) return Promise.resolve(fail("E_NOT_READY"));
      requireLive(signal);
      this.resizeMax = input.seq;
      let complete!: (value: InputResult) => void;
      const result = new Promise<InputResult>((resolve) => {
        complete = resolve;
      });
      if (this.resizePending) {
        this.resizePending.cols = input.cols;
        this.resizePending.rows = input.rows;
        this.resizePending.seq = input.seq;
        this.resizePending.complete.push(complete);
      } else this.resizePending = { cols: input.cols, rows: input.rows, seq: input.seq, complete: [complete] };
      this.resizes.set(input.seq, { payload, result });
      while (this.resizes.size > L.inputResults) this.resizes.delete(this.resizes.keys().next().value!);
      if (this.resizePending.complete.length > L.inputResults) this.detach();
      if (!this.resizeActive) void this.flushResize();
      return result;
    }
    private async flushResize(): Promise<void> {
      const pending = this.resizePending;
      if (!pending || this.closed) return;
      this.resizePending = undefined;
      this.resizeActive = true;
      const revision = deps.auth.revision;
      const wait = deadline(now, L.contextMs, [this.controller.signal, flights.signal]);
      let result: InputResult;
      try {
        requireLive(wait.signal);
        deps.auth.check(this.identity, revision);
        const resized = await wait.wait(this.runtime.resize(pending.cols, pending.rows, wait.signal));
        deps.auth.check(this.identity, revision);
        if (this.closed || !this.runtime.current()) throw new TerminalV2Fault(fail("E_VIEW_CHANGED", "unknown"));
        result = resized.ok ? { ok: true, acceptedThrough: pending.seq } : resized;
      } catch (error) {
        result = asFailure(error);
      } finally {
        wait.dispose();
      }
      for (const complete of pending.complete) complete(result);
      this.resizeActive = false;
      if (this.resizePending && !this.closed) void this.flushResize();
    }
    detach = (): void => {
      if (this.closed) return;
      this.closed = true;
      this.controller.abort();
      this.runtime.invalidated.removeEventListener("abort", this.detach);
      try {
        this.offRuntime?.();
      } catch {
        /* local detach is fail-soft */
      }
      this.offRuntime = undefined;
      if (this.timer) clock.clearTimer(this.timer);
      this.timer = undefined;
      this.queue.length = 0;
      this.sentRaw.length = 0;
      this.sentFrames.length = 0;
      this.queuedRaw = 0;
      this.queuedSize = 0;
      this.sentSize = 0;
      this.inputs.clear();
      this.resizes.clear();
      for (const complete of this.resizePending?.complete ?? []) complete(fail("E_VIEW_CHANGED", "unknown"));
      this.resizePending = undefined;
      views.delete(this.viewId);
      // Exact runtime object and original view CAS; old detach cannot release a successor.
      if (writers.get(this.runtime) === this) writers.delete(this.runtime);
      try {
        this.sink?.close();
      } catch {
        /* never close any other response */
      }
      this.sink = undefined;
    };
  }
  function invalidate(selector: AuthRevokeSelector): void {
    flights.abort();
    flights = new AbortController();
    for (const view of [...views.values()]) if (matchesTerminalAuthV2(selector, view.identity)) view.detach();
  }
  const off = deps.notifications.subscribe(invalidate);
  function resolve(
    id: AuthIdentity,
    request: TerminalHttpRequestsV2["input"] | TerminalHttpRequestsV2["resize"] | TerminalHttpRequestsV2["ack"],
  ): View {
    deps.auth.check(id, deps.auth.revision);
    const view = views.get(request.viewId);
    if (!view) throw new TerminalV2Fault(fail("E_VIEW_CHANGED"));
    view.current(id, request);
    return view;
  }
  return {
    async open(id, input, signal) {
      let view: View | undefined;
      const revision = deps.auth.revision;
      const wait = deadline(now, L.contextMs, [signal, flights.signal]);
      try {
        if (!terminalHttpRequestV2Ok("view", input)) return fail("E_BAD_REQUEST");
        deps.auth.check(id, revision);
        requireLive(wait.signal);
        if (disposed) return fail("E_OFF");
        if (input.hubInstance !== deps.hubInstance) return fail("E_HUB_CHANGED");
        const result = await wait.wait(deps.service.runtime(id, input, wait.signal));
        deps.auth.check(id, revision);
        if (disposed) return fail("E_OFF");
        if (!result.ok) return result;
        if (!result.runtime.current() || result.runtime.invalidated.aborted) return fail("E_SESSION_CHANGED");
        if (result.runtime.termId !== input.termId) return fail("E_SESSION_CHANGED");
        if (writers.has(result.runtime)) return fail("E_WRITER_BUSY");
        if (views.size >= L.hardTotal) return fail("E_LIMIT");
        view = new View(result.runtime, { ...input, scope: { ...input.scope } }, id);
        if (view.closed) return fail("E_UNAVAILABLE");
        writers.set(result.runtime, view);
        views.set(view.viewId, view);
        view.prepare();
        return { ok: true, view };
      } catch (error) {
        view?.detach();
        return asFailure(error);
      } finally {
        wait.dispose();
      }
    },
    async input(id, input, signal) {
      try {
        if (!terminalHttpRequestV2Ok("input", input)) return fail("E_BAD_REQUEST");
        requireLive(signal);
        const view = resolve(id, input);
        const revision = deps.auth.revision;
        const result = await view.input(id, input, signal);
        deps.auth.check(id, revision);
        view.current(id, input);
        return result;
      } catch (error) {
        return asFailure(error);
      }
    },
    async resize(id, input, signal) {
      try {
        if (!terminalHttpRequestV2Ok("resize", input)) return fail("E_BAD_REQUEST");
        const view = resolve(id, input);
        const revision = deps.auth.revision;
        const result = await view.resize(id, input, signal);
        deps.auth.check(id, revision);
        view.current(id, input);
        return result;
      } catch (error) {
        return asFailure(error);
      }
    },
    async ack(id, input, signal) {
      try {
        if (!terminalHttpRequestV2Ok("ack", input)) return fail("E_BAD_REQUEST");
        requireLive(signal);
        return resolve(id, input).acknowledge(input);
      } catch (error) {
        return asFailure(error);
      }
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      flights.abort();
      for (const view of [...views.values()]) view.detach();
      if (scheduler) clock.clearTimer(scheduler);
      scheduler = undefined;
    },
  };
}
