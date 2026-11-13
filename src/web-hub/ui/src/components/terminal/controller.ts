import { reactive } from "vue";
import { TERMINAL_UI_SCHEMAS } from "./protocol-schema.js";
import { terminalSchemaCheck } from "./schema-check.js";
import type {
  TerminalHttpRequests,
  TerminalHttpResults,
  TerminalSseEvent,
  TerminalAgentDisplayMetadata,
} from "@protocol/terminal.js";
const TerminalConnectionEventSchema = TERMINAL_UI_SCHEMAS.connection;
const TerminalSseEventSchema = TERMINAL_UI_SCHEMAS.event;
const TERMINAL_HTTP_SUCCESS_SCHEMAS = TERMINAL_UI_SCHEMAS.results;
const TERMINAL_OP_ERROR_CODES = TERMINAL_UI_SCHEMAS.errors;
function terminalHttpRequestOk<K extends keyof TerminalHttpRequests>(
  op: K,
  raw: unknown,
): raw is TerminalHttpRequests[K] {
  if (!terminalSchemaCheck(TERMINAL_UI_SCHEMAS.requests[op], raw)) return false;
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 16384) return false;
  if (op === "input") {
    const b64 = (raw as TerminalHttpRequests["input"]).bytesB64;
    try {
      if (btoa(atob(b64)) !== b64) return false;
    } catch {
      return false;
    }
  }
  return true;
}
import type { TerminalTransport } from "../../transport/terminal.js";
export type TerminalRow = TerminalHttpResults["list"]["rows"][number];
export interface TerminalScope {
  agentKey: string;
  expect: { sessionId: string; epoch: string };
}
export interface RendererPort {
  write(bytes: Uint8Array): Promise<void>;
  reset(): void;
  dimensions(): { cols: number; rows: number };
}
/** Owns only one attachment. Raw output is non-reactive, bounded and ACKed after write callback. */
export function createTerminalController(deps: {
  transport: TerminalTransport;
  scope: TerminalScope;
  clientId(): string | null;
  renderer: RendererPort;
  revoked?(): void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const state = reactive({
    rows: [] as TerminalRow[],
    busy: false,
    writable: false,
    error: "",
    gap: "",
    current: null as (TerminalRow & TerminalAgentDisplayMetadata) | null,
  });
  let disposed = false;
  let accepting = false;
  let earlyEvents: unknown[] = [];
  let earlyBytes = 0;
  let replayReady = false;
  let connection: { connectionInstance: string; connectionToken: string; expiresAt: number } | undefined;
  let attachment: TerminalHttpResults["attach"] | undefined;
  let generation = 0,
    queued = 0,
    inputBytes = 0,
    resizeSeq = 0;
  let stream = "",
    offset = 0,
    replay: { attemptId: string; replayEpoch: string; N0: number; deadlineAt: number } | undefined;
  let output = Promise.resolve(),
    inputs = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryGeneration = 0;
  let replayTimer: ReturnType<typeof setTimeout> | undefined, renewTimer: ReturnType<typeof setInterval> | undefined;
  let generationAbort = new AbortController();
  let authorityRevision = 0,
    actionRevision = 0;
  let attachmentAuthority: Authority | undefined;
  const id = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tabId = id();
  type Authority = {
    generation: number;
    revision: number;
    connection: NonNullable<typeof connection>;
    clientId: string;
    scope: TerminalScope;
    signal: AbortSignal;
  };
  class StaleAuthority extends Error {
    constructor() {
      super("E_TERMINAL_AUTHORITY_CHANGED");
    }
  }
  class RequestFailure extends Error {
    readonly #authority: Authority;
    constructor(message: string, authority: Authority) {
      super(message);
      this.#authority = authority;
    }
    current(): boolean {
      return owns(this.#authority);
    }
  }
  function owns(a: Authority, writerGeneration = true): boolean {
    return (
      !disposed &&
      a.revision === authorityRevision &&
      connection === a.connection &&
      deps.clientId() === a.clientId &&
      now() < a.connection.expiresAt &&
      deps.scope.agentKey === a.scope.agentKey &&
      deps.scope.expect.sessionId === a.scope.expect.sessionId &&
      deps.scope.expect.epoch === a.scope.expect.epoch &&
      (!writerGeneration || (generation === a.generation && !a.signal.aborted))
    );
  }
  function assertAuthority(a: Authority, writerGeneration = true): void {
    if (!owns(a, writerGeneration)) {
      // A delayed expiry timer is not permission to commit. Expire only the same authority,
      // never a successor that happened to receive an old response.
      if (
        !disposed &&
        a.revision === authorityRevision &&
        connection === a.connection &&
        now() >= a.connection.expiresAt
      ) {
        state.error = "登录授权已到期，请重新登录。";
        connection = undefined;
        clearTimeout(expiryTimer);
        expiryGeneration++;
        revoke();
      }
      throw new StaleAuthority();
    }
  }
  function capture(): Authority {
    if (disposed) throw new StaleAuthority();
    const identity = connection,
      clientId = deps.clientId();
    if (!identity || now() >= identity.expiresAt || !clientId) throw new StaleAuthority();
    return {
      generation,
      revision: authorityRevision,
      connection: identity,
      clientId,
      scope: { agentKey: deps.scope.agentKey, expect: { ...deps.scope.expect } },
      signal: generationAbort.signal,
    };
  }
  async function call<K extends keyof TerminalHttpRequests>(
    op: K,
    fields: Omit<
      TerminalHttpRequests[K],
      "agentKey" | "expect" | "clientId" | "connectionInstance" | "connectionToken"
    >,
    authority: Authority = capture(),
  ): Promise<TerminalHttpResults[K]> {
    assertAuthority(authority);
    const body = {
      ...authority.scope,
      clientId: authority.clientId,
      connectionInstance: authority.connection.connectionInstance,
      connectionToken: authority.connection.connectionToken,
      ...fields,
    } as TerminalHttpRequests[K];
    if (!terminalHttpRequestOk(op, body)) throw new RequestFailure("E_BAD_REQUEST", authority);
    let result: Awaited<ReturnType<TerminalTransport["request"]>>;
    try {
      result = await deps.transport.request(op, body, authority.signal);
    } catch (error) {
      assertAuthority(authority); // A rejected old request cannot revoke/report into a successor.
      throw new RequestFailure(error instanceof Error ? error.message : "E_UNAVAILABLE", authority);
    }
    assertAuthority(authority); // POST_AWAIT_AUTHORITY_GUARD — required even when transport ignores abort.
    if (!result || typeof result !== "object" || !("ok" in result))
      throw new RequestFailure("E_BAD_RESPONSE", authority);
    if (!result.ok) {
      if (
        !(TERMINAL_OP_ERROR_CODES[op] as readonly unknown[]).includes(result.code) ||
        !["none", "unknown"].includes(result.effect)
      )
        throw new RequestFailure("E_BAD_RESPONSE", authority);
      const message = `${result.code}${result.effect === "unknown" ? " · effect unknown" : ""}`;
      if (
        ["E_AUTH", "E_AUTH_REVOKING", "E_SESSION_CHANGED", "E_PRIVACY_LOCKED", "E_SECURE", "E_LEASE_EXPIRED"].includes(
          result.code,
        )
      ) {
        // Only this still-current authority may revoke. No writes after the revoke callback.
        state.error = message;
        assertAuthority(authority);
        if (result.code !== "E_LEASE_EXPIRED") {
          connection = undefined;
          clearTimeout(expiryTimer);
          expiryGeneration++;
        }
        revoke();
      }
      throw new RequestFailure(message, authority);
    }
    if (!terminalSchemaCheck(TERMINAL_HTTP_SUCCESS_SCHEMAS[op], result))
      throw new RequestFailure("E_BAD_RESPONSE", authority);
    return result as TerminalHttpResults[K];
  }
  function writer() {
    if (!attachment) throw new Error("E_LEASE_EXPIRED");
    return { termId: attachment.termId, attachmentId: attachment.attachmentId, writerLease: attachment.writerLease };
  }
  function cancelAction() {
    actionRevision++;
    state.busy = false;
  }
  function revoke() {
    authorityRevision++;
    cancelAction();
    invalidate();
    state.rows = [];
    state.current = null;
    state.gap = "";
    deps.revoked?.();
  }
  function invalidate() {
    generation++;
    const oldAbort = generationAbort;
    generationAbort = new AbortController();
    output = Promise.resolve();
    inputs = Promise.resolve();
    state.writable = false;
    attachment = undefined;
    attachmentAuthority = undefined;
    replay = undefined;
    stream = "";
    queued = inputBytes = 0;
    clearTimeout(replayTimer);
    clearInterval(renewTimer);
    earlyEvents = [];
    earlyBytes = 0;
    accepting = false;
    replayReady = false;
    oldAbort.abort();
  }
  function beginDetach() {
    const before = capture(),
      old = attachment;
    invalidate();
    assertAuthority(before, false); // Same identity, intentional local writer-generation change.
    const authority = capture();
    return {
      authority,
      done: old
        ? call(
            "detach",
            { termId: old.termId, attachmentId: old.attachmentId, writerLease: old.writerLease },
            authority,
          )
        : Promise.resolve(),
    };
  }
  async function detach() {
    const pending = beginDetach();
    await pending.done;
    assertAuthority(pending.authority);
  }
  async function fail(error: unknown) {
    if (disposed || error instanceof StaleAuthority || (error instanceof RequestFailure && !error.current())) return;
    // Every asynchronous request failure carries its original authority; renderer failures
    // enter synchronously and are guarded by the renderer/write generation at their caller.
    let authority: Authority;
    try {
      authority = capture();
    } catch {
      return;
    }
    state.error = error instanceof Error ? error.message : "终端连接已中断，请接回原终端。";
    try {
      assertAuthority(authority);
      await detach();
    } catch {
      /* no retry/close; the old lease expires server-side */
    }
  }
  async function refreshList(authority: Authority) {
    const result = await call("list", {}, authority);
    assertAuthority(authority);
    state.rows = result.rows;
  }
  async function list() {
    await refreshList(capture());
  }
  function adopt(a: TerminalHttpResults["attach"], authority: Authority) {
    assertAuthority(authority);
    accepting = false;
    attachment = a;
    attachmentAuthority = authority;
    state.current = a;
    offset = a.baseOffset;
    state.writable = false;
    assertAuthority(authority);
    clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      if (owns(authority)) void call("renew", writer(), authority).catch(fail);
    }, 5000);
    const pending = earlyEvents;
    earlyEvents = [];
    earlyBytes = 0;
    for (const message of pending) {
      assertAuthority(authority);
      event("terminal", message);
    }
  }
  function finishAccepting(authority: Authority) {
    if (!owns(authority)) return; // An old finally must not erase a new attach's early events.
    accepting = false;
    earlyEvents = [];
    earlyBytes = 0;
  }
  async function attach(row: TerminalRow) {
    const pending = beginDetach(),
      authority = pending.authority;
    await pending.done;
    assertAuthority(authority);
    accepting = true;
    try {
      const result = await call(
        "attach",
        { termId: row.termId, attachId: id(), tabId, ...deps.renderer.dimensions() },
        authority,
      );
      assertAuthority(authority);
      adopt(result, authority);
    } finally {
      finishAccepting(authority);
    }
  }
  async function open() {
    const pending = beginDetach(),
      authority = pending.authority;
    await pending.done;
    assertAuthority(authority);
    const dimensions = deps.renderer.dimensions();
    const ticket = await call("prepare", dimensions, authority);
    assertAuthority(authority);
    accepting = true;
    try {
      const result = await call(
        "open",
        { openId: ticket.openId, createTicket: ticket.createTicket, tabId, ...dimensions },
        authority,
      );
      assertAuthority(authority);
      adopt(result, authority);
    } catch (error) {
      assertAuthority(authority); // A stale prepare/open can never query/retry on a new connection.
      const fact = await call(
        "state",
        { target: { openId: ticket.openId, createTicket: ticket.createTicket } },
        authority,
      );
      assertAuthority(authority);
      if ("termId" in fact.fact) {
        state.current = fact.fact;
        await refreshList(authority);
        assertAuthority(authority);
      }
      throw error;
    } finally {
      finishAccepting(authority);
    }
  }
  async function close(row: TerminalRow) {
    let authority = capture();
    if (attachment?.termId === row.termId) {
      invalidate();
      assertAuthority(authority, false);
      authority = capture();
    }
    await call("close", { termId: row.termId, closeId: id(), expectedRevision: row.revision }, authority);
    assertAuthority(authority);
    await refreshList(authority);
  }
  async function resize() {
    // A mounted renderer can resize before replay/cutover; the agent correctly refuses
    // controls in that phase. Cutover sends the latest dimensions once writable.
    if (attachment && state.writable) {
      const authority = capture();
      await call("resize", { ...writer(), resizeSeq: ++resizeSeq, ...deps.renderer.dimensions() }, authority);
      assertAuthority(authority);
    }
  }
  function input(bytes: Uint8Array, kind: "user" | "terminal_response" = "user") {
    if (!state.writable || !attachment || !stream || inputBytes + bytes.length > 32768) return;
    if (bytes.length > 4096) {
      for (let start = 0; start < bytes.length; start += 4096) input(bytes.slice(start, start + 4096), kind);
      return;
    }
    const authority = capture();
    const mine = generation,
      epoch = stream;
    inputBytes += bytes.length;
    inputs = inputs
      .then(async () => {
        if (mine !== generation || !state.writable || epoch !== stream || !attachment) return;
        assertAuthority(authority);
        const inputSeq = attachment.nextInputSeq;
        const result = await call(
          "input",
          {
            ...writer(),
            inputSeq,
            bytesB64: btoa(String.fromCharCode(...bytes)),
            inputKind: kind,
            streamEpoch: epoch,
          },
          authority,
        );
        assertAuthority(authority);
        if (mine === generation && attachment) attachment.nextInputSeq = result.acceptedThrough + 1;
      })
      .catch((error) => {
        if (owns(authority)) return fail(error);
      })
      .finally(() => {
        if (mine === generation) inputBytes -= bytes.length;
      });
  }
  function event(name: string, raw: unknown) {
    if (disposed) return;
    if (name === "disconnected") {
      connection = undefined;
      clearTimeout(expiryTimer);
      expiryGeneration++;
      revoke();
      state.error = "连接已中断。后台终端可在重新登录后接回。";
      return;
    }
    if (name === "terminal_connection") {
      if (
        !terminalSchemaCheck<{ connectionInstance: string; connectionToken: string; expiresAt: number }>(
          TerminalConnectionEventSchema,
          raw,
        )
      )
        return;
      if (
        connection &&
        connection.connectionInstance === raw.connectionInstance &&
        connection.connectionToken === raw.connectionToken &&
        connection.expiresAt === raw.expiresAt &&
        now() < connection.expiresAt
      )
        return;
      if (connection) revoke();
      authorityRevision++;
      connection = { ...raw };
      clearTimeout(expiryTimer);
      const mine = ++expiryGeneration;
      expiryTimer = setTimeout(
        () => {
          if (mine === expiryGeneration) {
            connection = undefined;
            revoke();
            state.error = "登录授权已到期，请重新登录。";
          }
        },
        Math.max(0, Math.min(2147483647, raw.expiresAt - now())),
      );
      return;
    }
    if (connection && now() >= connection.expiresAt) {
      connection = undefined;
      revoke();
      return;
    }
    if (name !== "terminal" || !terminalSchemaCheck<TerminalSseEvent>(TerminalSseEventSchema, raw)) return;
    if (!attachment && accepting) {
      const size = new TextEncoder().encode(JSON.stringify(raw)).length;
      if (earlyEvents.length >= 16 || earlyBytes + size > 65536) {
        accepting = false;
        void fail(new Error("E_REPLAY_DEADLINE"));
        return;
      }
      earlyBytes += size;
      earlyEvents.push(raw);
      return;
    }
    const message = raw as TerminalSseEvent,
      e = message.event;
    if (
      !attachment ||
      message.agentKey !== deps.scope.agentKey ||
      message.connectionInstance !== connection?.connectionInstance ||
      message.attachmentId !== attachment.attachmentId ||
      e.termId !== attachment.termId ||
      e.sessionId !== deps.scope.expect.sessionId ||
      e.epoch !== deps.scope.expect.epoch
    )
      return;
    if (e.kind === "replay_begin") {
      if (replay || e.N0 < e.S || e.N0 - e.S > 16384 || e.deadlineAt <= now() || e.deadlineAt > now() + 3000) {
        void fail(new Error("E_REPLAY_DEADLINE"));
        return;
      }
      state.writable = false;
      replayReady = false;
      deps.renderer.reset();
      offset = e.S;
      stream = e.replayEpoch;
      replay = e;
      const authority = capture();
      replayTimer = setTimeout(() => {
        if (owns(authority)) void fail(new RequestFailure("E_REPLAY_DEADLINE", authority));
      }, e.deadlineAt - now());
      if (e.S === e.N0) enqueueReady();
    } else if (e.kind === "output") {
      const bytes = Uint8Array.from(atob(e.bytesB64), (c) => c.charCodeAt(0));
      if (
        btoa(String.fromCharCode(...bytes)) !== e.bytesB64 ||
        bytes.length > 8192 ||
        !Number.isSafeInteger(e.offset + bytes.length) ||
        e.streamEpoch !== stream ||
        e.offset !== offset ||
        queued + bytes.length > 65536
      ) {
        void fail(new Error("终端输出不连续，请接回原终端。"));
        return;
      }
      if (replay && offset + bytes.length > replay.N0) {
        void fail(new Error("E_REPLAY_DEADLINE"));
        return;
      }
      offset += bytes.length;
      queued += bytes.length;
      const authority = capture();
      const mine = generation,
        renderedThrough = offset;
      output = output
        .then(async () => {
          if (mine !== generation) return;
          assertAuthority(authority);
          await deps.renderer.write(bytes);
          assertAuthority(authority);
          if (mine !== generation) return;
          if (replay) {
            if (renderedThrough === replay.N0) await ready(authority);
          } else await call("ack", { ...writer(), ack: { phase: "live", renderedThrough } }, authority);
        })
        .catch((error) => {
          if (owns(authority)) return fail(error);
        })
        .finally(() => {
          if (mine === generation) queued -= bytes.length;
        });
    } else if (e.kind === "cutover") {
      if (
        !replay ||
        !replayReady ||
        replay.attemptId !== e.attemptId ||
        e.replayEnd !== replay.N0 ||
        offset !== replay.N0 ||
        now() >= replay.deadlineAt ||
        e.gap.from !== e.replayEnd ||
        e.gap.to !== e.liveFrom
      ) {
        void fail(new Error("E_REPLAY_DEADLINE"));
        return;
      }
      clearTimeout(replayTimer);
      replay = undefined;
      deps.renderer.reset();
      state.gap = `[${e.gap.from}, ${e.gap.to}) · VT snapshot unavailable`;
      stream = e.newLiveEpoch;
      offset = e.liveFrom;
      state.writable = true;
      void resize().catch(fail);
    } else if (e.kind === "gap") state.gap = `[${e.requestedOffset}, ${e.baseOffset}) · output dropped`;
    else if (e.kind === "exit") {
      if (state.current) {
        state.current.state = e.reap === "reaped" ? "exited" : "reap_incomplete";
        state.current.revision = e.revision;
      }
      invalidate();
      state.error = e.reap === "reaped" ? "终端已退出。" : "终端回收未确认。";
    } else if (e.kind === "state") {
      if (state.current && e.revision < state.current.revision) return;
      if (state.current) {
        state.current.writerPresent = e.writerPresent;
        state.current.nextInputSeq = e.nextInputSeq;
        state.current.state = e.state;
        state.current.revision = e.revision;
        state.current.deadlines = e.deadlines;
      }
      if (e.state !== "live" || !e.writerPresent) invalidate();
    }
  }
  async function ready(authority: Authority) {
    assertAuthority(authority);
    if (!replay || now() >= replay.deadlineAt) throw new RequestFailure("E_REPLAY_DEADLINE", authority);
    if (replayReady) return;
    replayReady = true;
    await call(
      "ack",
      {
        ...writer(),
        ack: {
          phase: "replay_ready",
          attemptId: replay.attemptId,
          replayEpoch: replay.replayEpoch,
          renderedThrough: replay.N0,
        },
      },
      authority,
    );
    assertAuthority(authority);
  }
  function enqueueReady() {
    const authority = capture();
    output = output.then(() => ready(authority)).catch(fail);
  }
  return {
    state,
    event,
    list,
    open,
    attach,
    close,
    detach,
    input,
    resize,
    fail,
    invalidate,
    async action(run: (guard: () => void) => Promise<void>) {
      if (state.busy || disposed) return false;
      let authority: Authority;
      try {
        authority = capture();
      } catch {
        state.error = "请重新登录并连接 WebHub 以启用终端。";
        return false;
      }
      const mine = ++actionRevision;
      state.busy = true;
      state.error = "";
      const guard = () => {
        if (mine !== actionRevision) throw new StaleAuthority();
        assertAuthority(authority, false);
      };
      try {
        await run(guard);
        guard();
        return true;
      } catch (error) {
        if (
          mine === actionRevision &&
          owns(authority, false) &&
          !(error instanceof StaleAuthority) &&
          (!(error instanceof RequestFailure) || error.current())
        )
          state.error = error instanceof Error ? error.message : "E_UNAVAILABLE";
        return false;
      } finally {
        if (mine === actionRevision) state.busy = false;
      }
    },
    dispose() {
      if (disposed) return;
      const old = attachment,
        authority = attachmentAuthority;
      const release =
        old && authority && owns(authority)
          ? {
              ...authority.scope,
              clientId: authority.clientId,
              connectionInstance: authority.connection.connectionInstance,
              connectionToken: authority.connection.connectionToken,
              termId: old.termId,
              attachmentId: old.attachmentId,
              writerLease: old.writerLease,
            }
          : undefined;
      disposed = true;
      authorityRevision++;
      cancelAction();
      invalidate();
      generationAbort.abort();
      clearTimeout(expiryTimer);
      expiryGeneration++;
      state.rows = [];
      state.current = null;
      state.gap = "";
      connection = undefined;
      // Separate immutable permission snapshot, deliberately no generation-aborted signal.
      if (release) void deps.transport.request("detach", release).catch(() => {});
    },
  };
}
