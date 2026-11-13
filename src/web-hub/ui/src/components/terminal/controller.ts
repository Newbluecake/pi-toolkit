import { reactive } from "vue";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalConnectionEventSchema,
  TerminalSseEventSchema,
  TERMINAL_HTTP_SUCCESS_SCHEMAS,
  TERMINAL_OP_ERROR_CODES,
  terminalHttpRequestOk,
  type TerminalHttpRequests,
  type TerminalHttpResults,
  type TerminalSseEvent,
  type TerminalAgentDisplayMetadata,
} from "@protocol/terminal.js";
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
  const abort = new AbortController();
  const id = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tabId = id();
  async function call<K extends keyof TerminalHttpRequests>(
    op: K,
    fields: Omit<
      TerminalHttpRequests[K],
      "agentKey" | "expect" | "clientId" | "connectionInstance" | "connectionToken"
    >,
  ): Promise<TerminalHttpResults[K]> {
    if (disposed) throw new Error("E_UNAVAILABLE");
    if (!connection || now() >= connection.expiresAt || !deps.clientId())
      throw new Error("请重新登录并连接 WebHub 以启用终端。");
    const body = {
      ...deps.scope,
      clientId: deps.clientId(),
      connectionInstance: connection.connectionInstance,
      connectionToken: connection.connectionToken,
      ...fields,
    } as TerminalHttpRequests[K];
    if (!terminalHttpRequestOk(op, body)) throw new Error("E_BAD_REQUEST");
    const result = await deps.transport.request(op, body, abort.signal);
    if (!result || typeof result !== "object" || !("ok" in result)) throw new Error("E_BAD_RESPONSE");
    if (!result.ok) {
      if (
        !(TERMINAL_OP_ERROR_CODES[op] as readonly unknown[]).includes(result.code) ||
        !["none", "unknown"].includes(result.effect)
      )
        throw new Error("E_BAD_RESPONSE");
      if (
        ["E_AUTH", "E_AUTH_REVOKING", "E_SESSION_CHANGED", "E_PRIVACY_LOCKED", "E_SECURE", "E_LEASE_EXPIRED"].includes(
          result.code,
        )
      ) {
        if (result.code !== "E_LEASE_EXPIRED") {
          connection = undefined;
          clearTimeout(expiryTimer);
          expiryGeneration++;
        }
        revoke();
      }
      throw new Error(`${result.code}${result.effect === "unknown" ? " · effect unknown" : ""}`);
    }
    if (!Value.Check(TERMINAL_HTTP_SUCCESS_SCHEMAS[op], result)) throw new Error("E_BAD_RESPONSE");
    return result as TerminalHttpResults[K];
  }
  function writer() {
    if (!attachment) throw new Error("E_LEASE_EXPIRED");
    return { termId: attachment.termId, attachmentId: attachment.attachmentId, writerLease: attachment.writerLease };
  }
  function revoke() {
    invalidate();
    state.rows = [];
    state.current = null;
    state.gap = "";
    deps.revoked?.();
  }
  function invalidate() {
    generation++;
    output = Promise.resolve();
    inputs = Promise.resolve();
    state.writable = false;
    attachment = undefined;
    replay = undefined;
    stream = "";
    queued = inputBytes = 0;
    clearTimeout(replayTimer);
    clearInterval(renewTimer);
    earlyEvents = [];
    earlyBytes = 0;
    accepting = false;
    replayReady = false;
  }
  async function detach() {
    const old = attachment;
    invalidate();
    if (old) await call("detach", { termId: old.termId, attachmentId: old.attachmentId, writerLease: old.writerLease });
  }
  async function fail(error: unknown) {
    state.error = error instanceof Error ? error.message : "终端连接已中断，请接回原终端。";
    try {
      await detach();
    } catch {
      /* lease expires server-side; never close shell */
    }
  }
  async function list() {
    state.rows = (await call("list", {})).rows;
  }
  function adopt(a: TerminalHttpResults["attach"]) {
    accepting = false;
    attachment = a;
    state.current = a;
    offset = a.baseOffset;
    state.writable = false;
    clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      void call("renew", writer()).catch(fail);
    }, 5000);
    const pending = earlyEvents;
    earlyEvents = [];
    earlyBytes = 0;
    for (const message of pending) event("terminal", message);
  }
  async function attach(row: TerminalRow) {
    await detach();
    accepting = true;
    try {
      adopt(await call("attach", { termId: row.termId, attachId: id(), tabId, ...deps.renderer.dimensions() }));
    } finally {
      accepting = false;
      earlyEvents = [];
      earlyBytes = 0;
    }
  }
  async function open() {
    await detach();
    const dimensions = deps.renderer.dimensions();
    const ticket = await call("prepare", dimensions);
    accepting = true;
    try {
      adopt(await call("open", { openId: ticket.openId, createTicket: ticket.createTicket, tabId, ...dimensions }));
    } catch (error) {
      // A timeout is never a second create. Query the original server-signed operation.
      const fact = await call("state", { target: { openId: ticket.openId, createTicket: ticket.createTicket } });
      if ("termId" in fact.fact) {
        state.current = fact.fact;
        await list();
      }
      throw error;
    } finally {
      accepting = false;
      earlyEvents = [];
      earlyBytes = 0;
    }
  }
  async function close(row: TerminalRow) {
    if (attachment?.termId === row.termId) invalidate();
    await call("close", { termId: row.termId, closeId: id(), expectedRevision: row.revision });
    await list();
  }
  async function resize() {
    if (attachment) await call("resize", { ...writer(), resizeSeq: ++resizeSeq, ...deps.renderer.dimensions() });
  }
  function input(bytes: Uint8Array, kind: "user" | "terminal_response" = "user") {
    if (!state.writable || !attachment || !stream || inputBytes + bytes.length > 32768) return;
    if (bytes.length > 4096) {
      for (let start = 0; start < bytes.length; start += 4096) input(bytes.slice(start, start + 4096), kind);
      return;
    }
    const mine = generation,
      epoch = stream;
    inputBytes += bytes.length;
    inputs = inputs
      .then(async () => {
        if (mine !== generation || !state.writable || epoch !== stream || !attachment) return;
        const inputSeq = attachment.nextInputSeq;
        const result = await call("input", {
          ...writer(),
          inputSeq,
          bytesB64: btoa(String.fromCharCode(...bytes)),
          inputKind: kind,
          streamEpoch: epoch,
        });
        if (mine === generation && attachment) attachment.nextInputSeq = result.acceptedThrough + 1;
      })
      .catch((error) => {
        if (mine === generation) return fail(error);
      })
      .finally(() => {
        if (mine === generation) inputBytes -= bytes.length;
      });
  }
  function event(name: string, raw: unknown) {
    if (name === "disconnected") {
      connection = undefined;
      clearTimeout(expiryTimer);
      expiryGeneration++;
      revoke();
      state.error = "连接已中断。后台终端可在重新登录后接回。";
      return;
    }
    if (name === "terminal_connection") {
      if (!Value.Check(TerminalConnectionEventSchema, raw)) return;
      if (connection && connection.connectionInstance !== raw.connectionInstance) revoke();
      connection = raw;
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
    if (name !== "terminal" || !Value.Check(TerminalSseEventSchema, raw)) return;
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
      replayTimer = setTimeout(() => {
        void fail(new Error("E_REPLAY_DEADLINE"));
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
      const mine = generation,
        renderedThrough = offset;
      output = output
        .then(async () => {
          if (mine !== generation) return;
          await deps.renderer.write(bytes);
          if (mine !== generation) return;
          if (replay) {
            if (renderedThrough === replay.N0) await ready();
          } else await call("ack", { ...writer(), ack: { phase: "live", renderedThrough } });
        })
        .catch((error) => {
          if (mine === generation) return fail(error);
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
  async function ready() {
    if (!replay || now() >= replay.deadlineAt) throw new Error("E_REPLAY_DEADLINE");
    if (replayReady) return;
    replayReady = true;
    await call("ack", {
      ...writer(),
      ack: {
        phase: "replay_ready",
        attemptId: replay.attemptId,
        replayEpoch: replay.replayEpoch,
        renderedThrough: replay.N0,
      },
    });
  }
  function enqueueReady() {
    output = output.then(ready).catch(fail);
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
    async action(run: () => Promise<void>) {
      if (state.busy) return;
      state.busy = true;
      state.error = "";
      try {
        await run();
      } catch (e) {
        state.error = e instanceof Error ? e.message : "E_UNAVAILABLE";
      } finally {
        state.busy = false;
      }
    },
    dispose() {
      const old = attachment,
        identity = connection,
        clientId = deps.clientId();
      disposed = true;
      invalidate();
      clearTimeout(expiryTimer);
      expiryGeneration++;
      state.rows = [];
      state.current = null;
      state.gap = "";
      abort.abort();
      connection = undefined;
      // Unmount cancels pending input/replay, but must not cancel its own best-effort detach.
      if (old && identity && clientId && now() < identity.expiresAt)
        void deps.transport
          .request("detach", {
            ...deps.scope,
            clientId,
            connectionInstance: identity.connectionInstance,
            connectionToken: identity.connectionToken,
            termId: old.termId,
            attachmentId: old.attachmentId,
            writerLease: old.writerLease,
          })
          .catch(() => {});
    },
  };
}
