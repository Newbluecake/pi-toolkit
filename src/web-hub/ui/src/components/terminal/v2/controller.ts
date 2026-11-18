import { reactive } from "vue";
import {
  TERMINAL_V2_LIMITS,
  normalizeTerminalNameV2,
  type TerminalHttpRequestsV2,
  type TerminalMetadataV2,
  type TerminalQuotaV2,
  type TerminalScopeV2,
  type TerminalStateV2,
  type TerminalTabRowV2,
  type TerminalHttpResultsV2,
  type TerminalUnknownResourceV2,
  type TerminalViewFrameV2,
} from "../protocol-v2.js";
import {
  loadTerminalV2Restore,
  saveTerminalV2Restore,
  terminalRequestV2Ok,
  terminalResponseV2Ok,
  type TerminalJsonOpV2,
  type TerminalRestoreStorageV2,
} from "../../../logic/terminal-v2.js";
import type { TerminalTransportV2, TerminalViewErrorV2 } from "../../../transport/terminal-v2.js";

export interface TerminalRendererPortV2 {
  write(bytes: Uint8Array): Promise<void>;
  reset(): void;
  dimensions(): { cols: number; rows: number };
}

export type TerminalPhaseV2 = "idle" | "loading" | "replaying" | "ready" | "disconnected";

type WithoutEnvelopeV2<R> = R extends unknown ? Omit<R, "scope" | "hubInstance"> : never;
type Fields<K extends TerminalJsonOpV2> = WithoutEnvelopeV2<TerminalHttpRequestsV2[K]>;

class ControllerFailureV2 extends Error {
  constructor(
    readonly code: string,
    readonly effect: "none" | "unknown",
  ) {
    super(effect === "unknown" ? `${code} · effect unknown` : code);
  }
}

interface ViewContextV2 {
  readonly generation: number;
  readonly termId: string;
  readonly abort: AbortController;
  readonly attached: Promise<void>;
  resolveAttached(): void;
  rejectAttached(error: Error): void;
  attachedFrame: boolean;
  viewId: string | null;
  offset: number;
  replayEnd: number;
  replayComplete: boolean;
  replayAcked: boolean;
  readyReceived: boolean;
  ready: boolean;
  renderedOffset: number;
  output: Promise<void>;
  queuedBytes: number;
  queuedItems: number;
  inputChain: Promise<void>;
  inputBytes: number;
  nextInputSeq: number;
  nextResizeSeq: number;
  resizeFlight: Promise<void> | null;
  resizeAgain: boolean;
  attachTimer: ReturnType<typeof setTimeout>;
}

interface IntentTokenV2 {
  readonly generation: number;
}

interface CallOptionsV2 {
  intent?: IntentTokenV2;
  view?: ViewContextV2;
  /** An already-sent create remains queryable after collapse/dispose, without UI authority. */
  creation?: { requestId: string; hubInstance: string };
}

interface CallAuthorityV2 {
  readonly lifecycle: number;
  readonly scope: TerminalScopeV2;
  readonly hubInstance: string | undefined;
  readonly intent?: IntentTokenV2;
  readonly view?: ViewContextV2;
  readonly creation?: { requestId: string; hubInstance: string };
}

const asFailure = (error: unknown): ControllerFailureV2 => {
  if (error instanceof ControllerFailureV2) return error;
  const viewError = error as Partial<TerminalViewErrorV2>;
  return new ControllerFailureV2(
    typeof viewError.code === "string" ? viewError.code : "E_DEADLINE",
    viewError.effect === "none" ? "none" : "unknown",
  );
};

/** One scope, one active view/renderer. Construction itself performs no IO or create. */
export function createTerminalControllerV2(deps: {
  transport: TerminalTransportV2;
  scope: TerminalScopeV2;
  renderer: TerminalRendererPortV2;
  storage?: TerminalRestoreStorageV2;
  revoked?(): void;
  now?(): number;
  id?(): string;
  hidden?(): boolean;
}) {
  const scope = Object.freeze({ ...deps.scope });
  const now = deps.now ?? Date.now;
  const makeId =
    deps.id ??
    (() =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  const state = reactive({
    open: false,
    busy: false,
    writable: false,
    phase: "idle" as TerminalPhaseV2,
    rows: [] as TerminalTabRowV2[],
    unknownResources: [] as TerminalUnknownResourceV2[],
    quota: undefined as TerminalQuotaV2 | undefined,
    revision: 0,
    hubInstance: undefined as string | undefined,
    activeTermId: null as string | null,
    metadata: null as TerminalMetadataV2 | null,
    error: "",
    notice: "",
    gap: null as { from: number; to: number } | null,
    exitCode: null as number | null,
    creating: false,
    creationUnsettled: false,
  });
  let disposed = false;
  let lifecycleGeneration = 0;
  let view: ViewContextV2 | undefined;
  let viewGeneration = 0;
  let opening: Promise<boolean> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let reconnectPending = false;
  let pendingRequestIds = new Set<string>();

  function persist(): void {
    if (disposed) return;
    state.creationUnsettled = pendingRequestIds.size > 0;
    saveTerminalV2Restore(
      deps.storage,
      scope,
      {
        open: state.open,
        hubInstance: state.hubInstance ?? null,
        activeTermId: state.activeTermId,
        pendingRequestIds: [...pendingRequestIds],
      },
      now(),
    );
  }

  function currentRow(termId = state.activeTermId): TerminalTabRowV2 | undefined {
    return state.rows.find((row) => row.termId === termId);
  }

  function owns(context: ViewContextV2): boolean {
    return !disposed && view === context && context.generation === viewGeneration && !context.abort.signal.aborted;
  }

  function setError(error: unknown): void {
    const failure = asFailure(error);
    state.error = failure.effect === "unknown" ? `${failure.code} · effect unknown` : failure.code;
  }

  function intentCurrent(token: IntentTokenV2): boolean {
    return !disposed && state.open && token.generation === lifecycleGeneration;
  }

  function captureIntent(): IntentTokenV2 {
    return { generation: lifecycleGeneration };
  }

  function revoke(): void {
    if (disposed) return;
    lifecycleGeneration++;
    opening = undefined;
    state.open = false;
    clearTimeout(reconnectTimer);
    reconnectPending = false;
    invalidateView();
    state.rows = [];
    state.unknownResources = [];
    state.activeTermId = null;
    state.metadata = null;
    state.gap = null;
    // Keep unresolved create IDs as resource facts; auth revocation is not proof of no fork.
    persist();
    deps.revoked?.();
  }

  function authorityCurrent(authority: CallAuthorityV2): boolean {
    if (authority.scope !== scope) return false;
    if (authority.creation) {
      return (
        pendingRequestIds.has(authority.creation.requestId) && state.hubInstance === authority.creation.hubInstance
      );
    }
    if (
      disposed ||
      authority.lifecycle !== lifecycleGeneration ||
      state.hubInstance !== authority.hubInstance ||
      (authority.intent !== undefined && !intentCurrent(authority.intent)) ||
      (authority.view !== undefined && !owns(authority.view))
    )
      return false;
    return true;
  }

  async function call<K extends TerminalJsonOpV2>(
    op: K,
    fields: Fields<K>,
    options: CallOptionsV2 = {},
  ): Promise<TerminalHttpResultsV2[K]> {
    const hubInstance = options.creation?.hubInstance ?? state.hubInstance;
    const authority: CallAuthorityV2 = {
      lifecycle: lifecycleGeneration,
      scope,
      hubInstance,
      ...(options.intent !== undefined ? { intent: options.intent } : {}),
      ...(options.view !== undefined ? { view: options.view } : {}),
      ...(options.creation !== undefined ? { creation: { ...options.creation } } : {}),
    };
    if (!authorityCurrent(authority)) throw new ControllerFailureV2("E_STALE", "none");
    const body = {
      scope: authority.scope,
      ...(op === "list" ? {} : { hubInstance }),
      ...fields,
    } as unknown as TerminalHttpRequestsV2[K];
    if (!terminalRequestV2Ok(op, body) || (op !== "list" && !hubInstance))
      throw new ControllerFailureV2("E_BAD_REQUEST", "none");
    let raw: unknown;
    try {
      raw = await deps.transport.request(op, body);
    } catch (error) {
      if (!authorityCurrent(authority)) throw new ControllerFailureV2("E_STALE", "unknown");
      throw asFailure(error);
    }
    // Two connections have no global ordering. Current is checked before ANY error/revoke/state effect.
    if (!authorityCurrent(authority)) throw new ControllerFailureV2("E_STALE", "unknown");
    if (!terminalResponseV2Ok(op, raw)) throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
    if (!raw.ok) {
      if (!authority.creation) {
        if (["E_AUTH", "E_REVOKING", "E_SESSION_CHANGED", "E_PRIVACY"].includes(raw.code)) revoke();
        if (raw.code === "E_HUB_CHANGED") invalidateView();
      }
      throw new ControllerFailureV2(raw.code, raw.effect);
    }
    return raw;
  }

  function applyTabs(
    tabs: {
      revision: number;
      rows: TerminalTabRowV2[];
      unknownResources: TerminalUnknownResourceV2[];
      quota: TerminalQuotaV2;
    },
    hubInstance?: string,
  ): boolean {
    const hubChanged =
      hubInstance !== undefined && state.hubInstance !== undefined && state.hubInstance !== hubInstance;
    if (!hubChanged && tabs.revision < state.revision) return false;
    if (hubChanged) {
      invalidateView();
      state.activeTermId = null;
      pendingRequestIds.clear();
      state.notice = "hubChanged";
    }
    if (hubInstance !== undefined) state.hubInstance = hubInstance;
    state.rows = [...tabs.rows];
    state.unknownResources = [...tabs.unknownResources];
    state.quota = {
      session: { ...tabs.quota.session },
      principal: { ...tabs.quota.principal },
      total: { ...tabs.quota.total },
    };
    state.revision = tabs.revision;
    if (state.activeTermId && !currentRow()) {
      invalidateView();
      state.activeTermId = null;
    }
    persist();
    return true;
  }

  async function refreshList(intent?: IntentTokenV2): Promise<void> {
    const result = await call("list", {}, intent ? { intent } : {});
    applyTabs(result, result.hubInstance);
  }

  function invalidateView(): void {
    const old = view;
    view = undefined;
    viewGeneration++;
    if (old) {
      clearTimeout(old.attachTimer);
      old.abort.abort();
      if (!old.attachedFrame) old.rejectAttached(new ControllerFailureV2("E_VIEW_CHANGED", "none"));
    }
    state.writable = false;
    state.metadata = null;
    state.gap = null;
    if (state.phase !== "loading") state.phase = state.open ? "disconnected" : "idle";
    deps.renderer.reset();
  }

  function scheduleReconnect(termId: string): void {
    if (disposed || !state.open || reconnectPending || !currentRow(termId)) return;
    const row = currentRow(termId);
    if (!row || !["starting", "live"].includes(row.state)) return;
    state.phase = "disconnected";
    state.writable = false;
    if (reconnectAttempts >= 5) {
      state.error = "E_VIEW_DISCONNECTED";
      return;
    }
    reconnectPending = true;
    if (state.notice !== "inputUnknown") state.notice = "reconnecting";
    const schedule = () => {
      clearTimeout(reconnectTimer);
      if (deps.hidden?.()) return;
      const delay = [1000, 2000, 4000, 8000, 16000][Math.min(reconnectAttempts, 4)] ?? 30_000;
      reconnectTimer = setTimeout(() => {
        if (disposed || !state.open || state.activeTermId !== termId) {
          reconnectPending = false;
          return;
        }
        // The event may have been missed while the timer was queued; recheck at fire time.
        if (deps.hidden?.()) {
          reconnectPending = true;
          return;
        }
        reconnectPending = false;
        reconnectAttempts++;
        void attachActive(termId, true).catch(() => {});
      }, delay);
    };
    schedule();
  }

  function failView(context: ViewContextV2, error: unknown): void {
    if (!owns(context)) return;
    setError(error);
    state.writable = false;
    context.abort.abort();
  }

  function decodeOutput(frame: Extract<TerminalViewFrameV2, { t: "output" }>): Uint8Array {
    return Uint8Array.from(atob(frame.bytesB64), (character) => character.charCodeAt(0));
  }

  async function acknowledge(context: ViewContextV2, offset: number, replayComplete = false): Promise<void> {
    if (!context.viewId) throw new ControllerFailureV2("E_VIEW_CHANGED", "unknown");
    const result = await call(
      "ack",
      {
        termId: context.termId,
        viewId: context.viewId,
        offset,
        ...(replayComplete ? { replayComplete: true as const } : {}),
      },
      { view: context },
    );
    if (!owns(context) || result.offset !== offset) throw new ControllerFailureV2("E_VIEW_CHANGED", "unknown");
  }

  function enqueueReplayAck(context: ViewContextV2): void {
    const work = context.output.then(async () => {
      if (!owns(context) || context.replayAcked) return;
      await acknowledge(context, context.replayEnd, true);
      if (!owns(context)) return;
      context.replayAcked = true;
      maybeReady(context);
    });
    // Do not park the renderer queue behind an independent ACK HTTP response.
    void work.catch((error) => failView(context, error));
  }

  function maybeReady(context: ViewContextV2): void {
    if (!owns(context) || context.ready || !context.replayAcked || !context.readyReceived) return;
    context.ready = true;
    state.phase = "ready";
    state.writable = currentRow(context.termId)?.state === "live";
    state.notice = "";
    state.error = "";
    reconnectAttempts = 0;
    reconnectPending = false;
    clearTimeout(reconnectTimer);
    // Live frames may have arrived behind early ready while the replay ACK response was in flight.
    if (context.renderedOffset > context.replayEnd) {
      const work = context.output.then(async () => {
        if (owns(context)) await acknowledge(context, context.renderedOffset);
      });
      context.output = work.catch(() => {});
      void work.catch((error) => failView(context, error));
    }
    void resize().catch((error) => failView(context, error));
  }

  function handleFrame(context: ViewContextV2, frame: TerminalViewFrameV2): void {
    if (!owns(context)) return;
    if (!context.attachedFrame) {
      if (frame.t !== "attached" || frame.termId !== context.termId || frame.hubInstance !== state.hubInstance)
        throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
      context.attachedFrame = true;
      context.viewId = frame.viewId;
      context.offset = frame.start;
      context.replayEnd = frame.end;
      context.renderedOffset = frame.start;
      state.metadata = frame.metadata ? { ...frame.metadata } : null;
      state.exitCode = null;
      state.phase = "replaying";
      state.gap = null;
      deps.renderer.reset();
      clearTimeout(context.attachTimer);
      context.resolveAttached();
      return;
    }
    if (frame.t === "attached") throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
    if (frame.t === "output") {
      const bytes = decodeOutput(frame);
      if (
        frame.offset !== context.offset ||
        (context.replayComplete && !context.readyReceived) ||
        context.queuedBytes + bytes.byteLength > TERMINAL_V2_LIMITS.viewPendingBytes ||
        context.queuedItems >= 128 ||
        (!context.readyReceived && context.offset + bytes.byteLength > context.replayEnd)
      )
        throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
      context.offset += bytes.byteLength;
      const renderedThrough = context.offset;
      context.queuedBytes += bytes.byteLength;
      context.queuedItems++;
      const work = context.output.then(async () => {
        if (!owns(context)) return;
        await deps.renderer.write(bytes);
        if (!owns(context)) return;
        context.renderedOffset = renderedThrough;
        if (context.ready) await acknowledge(context, renderedThrough);
      });
      context.output = work.catch(() => {});
      void work.catch((error) => failView(context, error));
      void work.then(
        () => {
          context.queuedBytes -= bytes.byteLength;
          context.queuedItems--;
        },
        () => {
          context.queuedBytes -= bytes.byteLength;
          context.queuedItems--;
        },
      );
      return;
    }
    if (frame.t === "gap") {
      if (frame.from !== context.offset) throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
      context.offset = frame.to;
      state.gap = { from: frame.from, to: frame.to };
      const work = context.output.then(() => {
        if (owns(context)) context.renderedOffset = frame.to;
      });
      context.output = work.catch(() => {});
      void work.catch((error) => failView(context, error));
      return;
    }
    if (frame.t === "replay-end") {
      if (context.replayComplete || frame.offset !== context.replayEnd || context.offset !== frame.offset)
        throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
      context.replayComplete = true;
      enqueueReplayAck(context);
      return;
    }
    if (frame.t === "ready") {
      if (!context.replayComplete || frame.offset !== context.replayEnd || context.readyReceived)
        throw new ControllerFailureV2("E_NOT_READY", "unknown");
      // NDJSON and ACK HTTP are independent; receiving ready first is valid and bounded.
      context.readyReceived = true;
      maybeReady(context);
      return;
    }
    if (frame.t === "tabs") {
      applyTabs(frame);
      return;
    }
    if (frame.t === "state") {
      const row = currentRow(frame.termId);
      if (row) row.state = frame.state;
      if (frame.termId === context.termId && frame.state === "live" && context.ready) state.writable = true;
      if (frame.termId === context.termId && frame.exitCode !== undefined) state.exitCode = frame.exitCode;
      if (frame.termId === context.termId && frame.state !== "live") {
        state.writable = false;
        if (frame.state === "exited") state.notice = "exited";
        else if (frame.state === "failed") state.notice = "failed";
        else if (frame.state === "closing") state.notice = "closing";
      }
      return;
    }
    if (frame.t === "ping" && context.ready) {
      const work = context.output.then(async () => {
        if (owns(context)) await acknowledge(context, context.renderedOffset);
      });
      context.output = work.catch(() => {});
      void work.catch((error) => failView(context, error));
      return;
    }
    if (frame.t === "error") throw new ControllerFailureV2(frame.code, "unknown");
  }

  async function attachActive(termId: string, reconnect = false): Promise<void> {
    if (disposed || !state.open || !state.hubInstance || !currentRow(termId)) return;
    const hubInstance = state.hubInstance;
    if (!reconnect) {
      reconnectAttempts = 0;
      state.error = "";
    }
    clearTimeout(reconnectTimer);
    reconnectPending = false;
    invalidateView();
    state.activeTermId = termId;
    state.phase = "loading";
    state.notice = reconnect ? "reconnecting" : "";
    persist();
    const generation = viewGeneration;
    const abort = new AbortController();
    let resolveAttached!: () => void;
    let rejectAttached!: (error: Error) => void;
    const attached = new Promise<void>((resolve, reject) => {
      resolveAttached = resolve;
      rejectAttached = reject;
    });
    const context = {} as ViewContextV2;
    const attachTimer = setTimeout(() => {
      if (owns(context)) failView(context, new ControllerFailureV2("E_DEADLINE", "unknown"));
    }, TERMINAL_V2_LIMITS.httpMs);
    Object.assign(context, {
      generation,
      termId,
      abort,
      attached,
      resolveAttached,
      rejectAttached,
      attachedFrame: false,
      viewId: null,
      offset: 0,
      replayEnd: 0,
      replayComplete: false,
      replayAcked: false,
      readyReceived: false,
      ready: false,
      renderedOffset: 0,
      output: Promise.resolve(),
      queuedBytes: 0,
      queuedItems: 0,
      inputChain: Promise.resolve(),
      inputBytes: 0,
      nextInputSeq: 0,
      nextResizeSeq: 0,
      resizeFlight: null,
      resizeAgain: false,
      attachTimer,
    } satisfies ViewContextV2);
    view = context;
    const stream = deps.transport.view(
      { scope, hubInstance, termId },
      (frame) => {
        try {
          handleFrame(context, frame);
        } catch (error) {
          failView(context, error);
          throw error;
        }
      },
      abort.signal,
    );
    const observed = stream.then(
      () => {
        throw new ControllerFailureV2("E_VIEW_DISCONNECTED", "unknown");
      },
      (error: unknown) => {
        throw asFailure(error);
      },
    );
    void observed.catch((error) => {
      clearTimeout(context.attachTimer);
      if (!context.attachedFrame) context.rejectAttached(asFailure(error));
      if (view !== context || context.generation !== viewGeneration || disposed) return;
      const failure = asFailure(error);
      if (["E_AUTH", "E_REVOKING", "E_SESSION_CHANGED", "E_PRIVACY"].includes(failure.code)) {
        setError(failure);
        revoke();
        return;
      }
      view = undefined;
      state.writable = false;
      state.metadata = null;
      state.phase = "disconnected";
      const preserveInputUnknown = state.notice === "inputUnknown";
      if (!preserveInputUnknown) {
        state.notice = "disconnected";
        setError(failure);
      }
      scheduleReconnect(termId);
    });
    await Promise.race([attached, observed]);
    if (!owns(context)) throw new ControllerFailureV2("E_VIEW_CHANGED", "none");
  }

  async function queryCreation(requestId: string, intent: IntentTokenV2): Promise<string | undefined> {
    const hubInstance = state.hubInstance;
    if (!hubInstance) return undefined;
    const result = await call("creation", { requestId }, { creation: { requestId, hubInstance } });
    const recordCurrent = pendingRequestIds.has(requestId) && state.hubInstance === hubInstance;
    if (result.outcome === "created") {
      if (recordCurrent) {
        pendingRequestIds.delete(requestId);
        persist();
      }
      return result.termId;
    }
    if (result.outcome === "failed") {
      if (recordCurrent) {
        pendingRequestIds.delete(requestId);
        persist();
      }
      if (intentCurrent(intent)) state.error = result.code;
      return undefined;
    }
    if (intentCurrent(intent)) state.notice = result.outcome === "pending" ? "createPending" : "createUnknown";
    if (recordCurrent) persist();
    return undefined;
  }

  async function reconcilePending(intent: IntentTokenV2): Promise<string | undefined> {
    if (!intentCurrent(intent) || !state.hubInstance) return undefined;
    const restore = loadTerminalV2Restore(deps.storage, scope, now());
    if (restore?.hubInstance === state.hubInstance) {
      for (const id of restore.pendingRequestIds) pendingRequestIds.add(id);
    }
    for (const requestId of [...pendingRequestIds]) {
      try {
        const termId = await queryCreation(requestId, intent);
        if (!intentCurrent(intent)) return undefined;
        if (termId) {
          await refreshList(intent);
          return intentCurrent(intent) ? termId : undefined;
        }
        if (pendingRequestIds.has(requestId)) return undefined;
      } catch (error) {
        if (intentCurrent(intent)) {
          setError(error);
          state.notice = "createUnknown";
        }
        return undefined;
      }
    }
    return undefined;
  }

  async function create(mode: "ensure-empty" | "new", intent: IntentTokenV2): Promise<boolean> {
    if (state.creating || !state.hubInstance || !intentCurrent(intent) || pendingRequestIds.size > 0) return false;
    state.creating = true;
    const requestId = makeId();
    const hubInstance = state.hubInstance;
    pendingRequestIds.add(requestId);
    persist();
    try {
      let termId: string | undefined;
      try {
        const result = await call("create", { requestId, mode, ...deps.renderer.dimensions() }, { intent });
        if (result.requestId !== requestId) throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
        termId = result.termId;
      } catch (error) {
        const failure = asFailure(error);
        if (failure.effect !== "unknown") {
          pendingRequestIds.delete(requestId);
          persist();
          throw failure;
        }
        // The POST may have been accepted even if this panel collapsed or unmounted.
        if (intentCurrent(intent)) state.notice = "createUnknown";
        termId = await queryCreation(requestId, intent);
      }
      if (!intentCurrent(intent)) return false;
      if (!termId) {
        persist();
        return false;
      }
      pendingRequestIds.delete(requestId);
      persist();
      await refreshList(intent);
      if (!intentCurrent(intent) || state.hubInstance !== hubInstance) return false;
      state.activeTermId = termId;
      persist();
      if (currentRow(termId)) await attachActive(termId);
      return true;
    } finally {
      state.creating = false;
      persist();
    }
  }

  async function openOrRestore(allowCreate: boolean): Promise<boolean> {
    if (opening) return opening;
    if (disposed) return false;
    state.open = true;
    const intent = captureIntent();
    const flight = (async () => {
      const restore = loadTerminalV2Restore(deps.storage, scope, now());
      state.busy = true;
      state.error = "";
      state.notice = "";
      state.phase = "loading";
      reconnectAttempts = 0;
      if (restore?.hubInstance && (!state.hubInstance || restore.hubInstance === state.hubInstance)) {
        if (!state.activeTermId) state.activeTermId = restore.activeTermId;
        // Merge before refreshList(): applyTabs persists and must not erase the original IDs first.
        for (const requestId of restore.pendingRequestIds) pendingRequestIds.add(requestId);
      } else if (restore && restore.hubInstance !== state.hubInstance) {
        state.activeTermId = null;
      }
      try {
        await refreshList(intent);
        if (!intentCurrent(intent)) return false;
        const restoredOtherHub = restore?.hubInstance != null && restore.hubInstance !== state.hubInstance;
        if (restoredOtherHub) {
          state.activeTermId = null;
          pendingRequestIds.clear();
          state.notice = "hubChanged";
        }
        const hadUnresolved = pendingRequestIds.size > 0;
        const restoredId = restoredOtherHub ? undefined : await reconcilePending(intent);
        if (!intentCurrent(intent)) return false;
        if (restoredId) state.activeTermId = restoredId;
        if (state.activeTermId && !currentRow()) state.activeTermId = null;
        if (
          !state.activeTermId &&
          restore !== undefined &&
          restore.hubInstance === state.hubInstance &&
          restore.activeTermId
        )
          state.activeTermId = currentRow(restore.activeTermId)?.termId ?? null;
        if (!state.activeTermId && !restoredOtherHub && state.rows.length > 0)
          state.activeTermId = state.rows[0]!.termId;
        if (restoredOtherHub && !allowCreate) {
          state.phase = "idle";
          persist();
          return true;
        }
        if (state.activeTermId) {
          await attachActive(state.activeTermId);
          return true;
        }
        // Querying/failing an old intent never becomes permission to mint a replacement in the same action.
        if (allowCreate && !hadUnresolved && pendingRequestIds.size === 0) return await create("ensure-empty", intent);
        state.phase = "idle";
        persist();
        return true;
      } catch (error) {
        if (intentCurrent(intent)) {
          setError(error);
          state.phase = "disconnected";
        }
        return false;
      } finally {
        if (intentCurrent(intent)) {
          state.busy = false;
          persist();
        }
      }
    })();
    opening = flight;
    return flight.finally(() => {
      if (opening === flight) opening = undefined;
    });
  }

  async function newTerminal(): Promise<boolean> {
    if (state.busy || disposed || !state.open) return false;
    const intent = captureIntent();
    state.busy = true;
    state.error = "";
    state.notice = "";
    try {
      if (!state.hubInstance) await refreshList(intent);
      if (!intentCurrent(intent)) return false;
      if (pendingRequestIds.size > 0 || state.creating) {
        await reconcilePending(intent);
        return false;
      }
      return await create("new", intent);
    } catch (error) {
      if (intentCurrent(intent)) setError(error);
      return false;
    } finally {
      if (intentCurrent(intent)) {
        state.busy = false;
        persist();
      }
    }
  }

  async function select(termId: string): Promise<boolean> {
    if (state.busy || !currentRow(termId) || disposed) return false;
    state.busy = true;
    state.error = "";
    try {
      await attachActive(termId);
      return true;
    } catch (error) {
      if (state.activeTermId === termId) setError(error);
      return false;
    } finally {
      state.busy = false;
    }
  }

  async function rename(termId: string, rawName: string): Promise<boolean> {
    const name = normalizeTerminalNameV2(rawName);
    const row = currentRow(termId);
    if (!name || !row || state.busy || disposed) return false;
    const actionGeneration = lifecycleGeneration;
    state.busy = true;
    state.error = "";
    try {
      const result = await call("rename", { termId, name });
      if (result.revision < state.revision) return false;
      const index = state.rows.findIndex((item) => item.termId === termId);
      if (index >= 0) state.rows[index] = result.row;
      state.revision = result.revision;
      return true;
    } catch (error) {
      if (!disposed && actionGeneration === lifecycleGeneration) setError(error);
      return false;
    } finally {
      if (!disposed && actionGeneration === lifecycleGeneration) state.busy = false;
    }
  }

  async function close(termId: string): Promise<boolean> {
    if (state.busy || disposed) return false;
    const actionGeneration = lifecycleGeneration;
    state.busy = true;
    state.error = "";
    try {
      if (state.activeTermId === termId) invalidateView();
      await call("close", { termId });
      await refreshList();
      if (disposed || !state.open) return false;
      if (state.activeTermId === termId) state.activeTermId = null;
      state.phase = "idle";
      persist();
      return true;
    } catch (error) {
      if (!disposed && actionGeneration === lifecycleGeneration) setError(error);
      return false;
    } finally {
      if (!disposed && actionGeneration === lifecycleGeneration) state.busy = false;
    }
  }

  async function queryInput(context: ViewContextV2, seq: number): Promise<boolean> {
    if (!context.viewId || !owns(context)) return false;
    // Closed query branch: deliberately no bytesB64/kind, no new seq/view and no PTY replay.
    const result = await call(
      "input",
      { termId: context.termId, viewId: context.viewId, seq, queryOnly: true },
      { view: context },
    );
    if (!owns(context) || result.acceptedThrough < seq) return false;
    context.nextInputSeq = result.acceptedThrough + 1;
    return true;
  }

  function inputChunk(context: ViewContextV2, bytes: Uint8Array, kind: "user" | "terminal_response"): void {
    if (bytes.byteLength === 0 || context.inputBytes + bytes.byteLength > TERMINAL_V2_LIMITS.inputPendingBytes) return;
    context.inputBytes += bytes.byteLength;
    const work = context.inputChain.then(async () => {
      if (!owns(context) || !context.ready || !state.writable || !context.viewId) return;
      const seq = context.nextInputSeq;
      try {
        const result = await call(
          "input",
          {
            termId: context.termId,
            viewId: context.viewId,
            seq,
            bytesB64: btoa(String.fromCharCode(...bytes)),
            kind,
          },
          { view: context },
        );
        if (!owns(context) || result.acceptedThrough < seq) return;
        context.nextInputSeq = result.acceptedThrough + 1;
      } catch (error) {
        const failure = asFailure(error);
        if (failure.effect === "unknown" && owns(context)) {
          try {
            if (await queryInput(context, seq)) return;
          } catch (queryError) {
            const queryFailure = asFailure(queryError);
            if (queryFailure.code === "E_INPUT_UNKNOWN") state.notice = "inputUnknown";
            failView(context, queryFailure);
            return;
          }
        }
        if (failure.code === "E_INPUT_UNKNOWN") state.notice = "inputUnknown";
        failView(context, failure);
      }
    });
    context.inputChain = work.catch(() => {});
    void work.then(
      () => {
        context.inputBytes -= bytes.byteLength;
      },
      () => {
        context.inputBytes -= bytes.byteLength;
      },
    );
  }

  function input(bytes: Uint8Array, kind: "user" | "terminal_response" = "user"): void {
    const context = view;
    if (!context || !context.ready || !state.writable || bytes.byteLength === 0) return;
    for (let start = 0; start < bytes.byteLength; start += TERMINAL_V2_LIMITS.inputBytes)
      inputChunk(context, bytes.slice(start, start + TERMINAL_V2_LIMITS.inputBytes), kind);
  }

  async function resize(): Promise<void> {
    const context = view;
    if (!context || !context.ready || !state.writable || !context.viewId) return;
    if (context.resizeFlight) {
      context.resizeAgain = true;
      return context.resizeFlight;
    }
    const flight = (async () => {
      do {
        context.resizeAgain = false;
        if (!owns(context) || !context.ready || !context.viewId) return;
        const seq = context.nextResizeSeq++;
        try {
          const result = await call(
            "resize",
            {
              termId: context.termId,
              viewId: context.viewId,
              seq,
              ...deps.renderer.dimensions(),
            },
            { view: context },
          );
          if (result.acceptedThrough < seq) throw new ControllerFailureV2("E_UNAVAILABLE", "unknown");
        } catch (error) {
          failView(context, error);
          throw error;
        }
      } while (context.resizeAgain);
    })();
    context.resizeFlight = flight;
    try {
      await flight;
    } finally {
      if (context.resizeFlight === flight) context.resizeFlight = null;
    }
  }

  function collapse(): void {
    if (disposed) return;
    lifecycleGeneration++;
    opening = undefined;
    state.open = false;
    state.busy = false;
    clearTimeout(reconnectTimer);
    reconnectPending = false;
    invalidateView();
    state.phase = "idle";
    persist();
  }

  function visibilityChanged(): void {
    if (!reconnectPending || !state.open || !state.activeTermId) return;
    clearTimeout(reconnectTimer);
    if (deps.hidden?.()) return;
    const termId = state.activeTermId;
    reconnectPending = false;
    reconnectAttempts++;
    void attachActive(termId, true).catch(() => {});
  }

  return {
    state,
    currentRow,
    open: () => openOrRestore(true),
    restore: () => openOrRestore(false),
    newTerminal,
    select,
    rename,
    close,
    input,
    resize,
    collapse,
    detach() {
      clearTimeout(reconnectTimer);
      reconnectPending = false;
      invalidateView();
    },
    visibilityChanged,
    reconnect() {
      const termId = state.activeTermId;
      if (!termId || state.busy) return Promise.resolve(false);
      reconnectAttempts = 0;
      return select(termId);
    },
    cancelIntent() {
      if (disposed) return;
      lifecycleGeneration++;
      opening = undefined;
      state.open = false;
      state.busy = false;
      clearTimeout(reconnectTimer);
      reconnectPending = false;
      invalidateView();
      state.phase = "idle";
      persist();
    },
    dispose() {
      if (disposed) return;
      persist();
      lifecycleGeneration++;
      opening = undefined;
      disposed = true;
      clearTimeout(reconnectTimer);
      invalidateView();
      state.open = false;
      state.writable = false;
    },
  };
}

export type TerminalControllerV2 = ReturnType<typeof createTerminalControllerV2>;
export type { TerminalStateV2 };
