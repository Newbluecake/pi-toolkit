/**
 * hub command router (plan §6.1/§6.3/§3.4/§3.5/§4.9, C3): the real implementation behind the
 * frozen `CommandRouter` port (`./ports.js`) — hub-side idempotency (§3.4's three-state LRU,
 * 2048 entries / 10 min, keyed `principal|agentKey|id`), agent-capability admission (§3.1's
 * compat matrix: a capability the agent never advertised in `hello.caps` is answered locally,
 * `E_UNSUPPORTED`, and *no frame is ever sent* — `registry.request()` is never called), effect
 * classification (§3.4/§3.5: only a successful or non-retryable result is cached; an
 * effect:"none" retryable failure is forgotten so a retry re-executes; an effect:"unknown"
 * result — a hub-side wait timeout, or the agent's own `E_DEADLINE` — is kept `unknown` until a
 * late `cmd_result`/`cmd_late` resolves it, per `registry.ts`'s `onLateResult` hook), `queryOnly`
 * (§3.4: hub answers a `done` entry directly without ever touching the agent; an `inflight` entry
 * is answered `state:"running"`; anything else is forwarded so the agent's own ledger gets the
 * final say), a drain gate for a future forced hub upgrade (v2.1 §6.7.3, C10), and a defense-in-
 * depth byte budget on `CommandOutputWire` (v2.1 §4.9) on top of whatever the agent itself already
 * truncated to.
 *
 * Rate limiting (§6.5) and the request-level `ReqDeadline` (§3.3) are deliberately *not* here —
 * they depend on the HTTP request itself (principal/IP/listener, and the browser-facing absolute
 * deadline) and live in `hub/http.ts`, which is the router's only real caller. This module only
 * ever sees an already-fully-formed `CmdFrame` (with `deadlineMs` already derived) plus the
 * `agentKey` to send it to.
 */
import { createHash } from "node:crypto";
import type {
  CmdArgs,
  CmdData,
  CmdErrorCode,
  CmdFrame,
  CmdOp,
  CmdOrigin,
  CmdResultBody,
  CmdResultFrame,
} from "../protocol/messages.js";
import { auditControl, type ControlAuditRecord } from "./audit.js";
import type { CommandRouter } from "./ports.js";
import type { HubLog } from "./ports.js";
import { HubError, type Registry } from "./registry.js";

export type { CommandRouter } from "./ports.js";

/** hub's own LRU cap/TTL (§3.4: "2048 / 10 min LRU（仅 hub 进程内）") — distinct from the agent's
 * own 512/30min process-level ledger (§4.5, C1's file). */
const MAX_ENTRIES = 2_048;
const TTL_MS = 10 * 60_000;
/** v2.1 §4.9/§6.3: defense-in-depth on top of the agent's own 32 KiB/64-entry truncation — a
 * deliberately larger ceiling (agent-side truncation is the real limit; this only guards against
 * a misbehaving/future agent implementation). */
const OUTPUT_MAX_BYTES = 40 * 1024;
/** v2.1 §6.7.3: how long `drain()` waits for in-flight forwards to settle before giving up (a
 * caller like the future supersede state machine, C10, races its *own* deadline against this one
 * too — this is just this module's own hard ceiling). */
const DRAIN_MAX_MS = 15_000;
/** Grace added on top of the frame's own `deadlineMs` before `registry.request()`'s wait times
 * out — §3.3 step ⑥'s `min(deadlineMs + 1000, remaining - 300)` simplified: `http.ts` already
 * derived `deadlineMs` conservatively against the *remaining* per-request budget, so this module
 * does not need `remaining` again to stay safely nested under it. */
const REGISTRY_WAIT_GRACE_MS = 1_000;

type LruState = "inflight" | "unknown" | "done";

interface LruEntry {
  state: LruState;
  digest: string;
  op: CmdOp;
  agentKey: string;
  result: CmdResultBody | undefined;
  createdAt: number;
  updatedAt: number;
  waiters: Array<(body: CmdResultBody | undefined, err: unknown) => void>;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

function digestOf(cmd: CmdArgs): string {
  return createHash("sha256").update(stableStringify(cmd)).digest("hex");
}

function principalOf(origin: CmdOrigin): string {
  return origin.listener === "loopback" ? "token" : `lan:${origin.user ?? "?"}`;
}

/** §3.1 compat matrix: every op needs `cmd.v1`; `dialog_answer`/`dialog_cancel` additionally need
 * `dialog.v1`; `command` additionally needs `command.v1`. */
function requiredCaps(op: CmdOp): readonly string[] {
  switch (op) {
    case "dialog_answer":
    case "dialog_cancel":
      return ["cmd.v1", "dialog.v1"];
    case "command":
      return ["cmd.v1", "command.v1"];
    default:
      return ["cmd.v1"];
  }
}

function unsupported(): CmdResultBody {
  return { ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" };
}

/** A8 correlation (plan §6.4): `dialog_answer`/`dialog_cancel` go through `/api/dialog`, every
 * other op through `/api/cmd`. */
function endpointFor(op: CmdOp): "cmd" | "dialog" {
  return op === "dialog_answer" || op === "dialog_cancel" ? "dialog" : "cmd";
}

function toResultFrame(frame: CmdFrame, body: CmdResultBody): CmdResultFrame {
  return body.ok
    ? {
        t: "cmd_result",
        rid: frame.rid,
        id: frame.id,
        ok: true,
        data: body.data,
        ...(body.dup === true ? { dup: true as const } : {}),
      }
    : {
        t: "cmd_result",
        rid: frame.rid,
        id: frame.id,
        ok: false,
        code: body.code,
        retryable: body.retryable,
        effect: body.effect,
        ...(body.message === undefined ? {} : { message: body.message }),
      };
}

function toBody(reply: CmdResultFrame): CmdResultBody {
  return reply.ok
    ? { ok: true, data: reply.data, ...(reply.dup === true ? { dup: true as const } : {}) }
    : {
        ok: false,
        code: reply.code,
        retryable: reply.retryable,
        effect: reply.effect,
        ...(reply.message === undefined ? {} : { message: reply.message }),
      };
}

/** v2.1 §4.9/§6.3: defense-in-depth byte cap on a `command` op's `CommandOutputWire`, on top of
 * whatever the agent itself already truncated to. Never mutates `body` in place. */
function capOutputBudget(body: CmdResultBody): CmdResultBody {
  if (!body.ok) return body;
  const data = body.data;
  if (data.op !== "command" || data.output === undefined) return body;
  const entries = data.output.entries;
  let total = 0;
  let cut = -1;
  for (let i = 0; i < entries.length; i++) {
    total += Buffer.byteLength(entries[i]!.text, "utf8");
    if (total > OUTPUT_MAX_BYTES) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return body;
  const kept = entries.slice(0, cut);
  const droppedEntries = entries.length - kept.length;
  let droppedBytes = 0;
  for (let i = cut; i < entries.length; i++) droppedBytes += Buffer.byteLength(entries[i]!.text, "utf8");
  const prevTrunc = data.output.truncated;
  return {
    ...body,
    data: {
      ...data,
      output: {
        entries: kept,
        truncated: {
          droppedEntries: (prevTrunc?.droppedEntries ?? 0) + droppedEntries,
          droppedBytes: (prevTrunc?.droppedBytes ?? 0) + droppedBytes,
        },
        ...(data.output.needsTerminal === true ? { needsTerminal: true as const } : {}),
      },
    },
  };
}

/** Best-effort fields for a `cmd`-op-specific audit line, derived only from the frame itself
 * (never logging the free-text values — U7). */
function cmdFields(
  cmd: CmdArgs,
): Pick<ControlAuditRecord, "textLen" | "argsLen" | "deliver" | "runId" | "dialogId" | "name" | "confirmed"> {
  switch (cmd.op) {
    case "prompt":
      return { textLen: Buffer.byteLength(cmd.text, "utf8"), deliver: cmd.deliver };
    case "steer_subagent":
      return { textLen: Buffer.byteLength(cmd.text, "utf8"), runId: cmd.runId };
    case "abort_subagent":
      return { runId: cmd.runId };
    case "dialog_answer":
    case "dialog_cancel":
      return { dialogId: cmd.dialogId };
    case "command":
      return { argsLen: Buffer.byteLength(cmd.args, "utf8"), name: cmd.name, confirmed: cmd.confirm === true };
    default:
      return {};
  }
}

export function createCommandRouter(deps: { registry: Registry; log: HubLog; now: () => number }): CommandRouter {
  const { registry, log, now } = deps;
  const lru = new Map<string, LruEntry>();
  let draining = false;
  let inflightCount = 0;
  const zeroWaiters: Array<() => void> = [];

  // §3.4/§3.5 ("down() 时通知 router 清该 agentKey 的 LRU"): once an agent record is fully
  // retired (reap / pid dead / bye non-handover), any LRU entries still pinned to that agentKey
  // are permanently orphaned — a future reconnect of the same underlying process gets a brand new
  // agentKey (`registry.ts`'s `down()` deletes the `byAgentId` mapping too), so nothing will ever
  // query/retry against the old one again.
  registry.bus.subscribe((e) => {
    if (e.type !== "agent_down") return;
    for (const [k, entry] of lru) if (entry.agentKey === e.agentKey) lru.delete(k);
  });

  registry.setLateResultHandler((agentKey, frame) => {
    // Precise match: the LRU key format `${principal}|${agentKey}|${id}` always ends with the
    // frame's own `id` (globally unique per browser action), so a suffix match is exact even
    // though a late frame carries no `principal`/origin of its own.
    const suffix = `|${frame.id}`;
    for (const [key, entry] of lru) {
      if (entry.agentKey !== agentKey || entry.state !== "unknown" || !key.endsWith(suffix)) continue;
      const body: CmdResultBody = frame.ok
        ? { ok: true, data: frame.data }
        : {
            ok: false,
            code: frame.code,
            retryable: frame.retryable,
            effect: frame.effect,
            ...(frame.message === undefined ? {} : { message: frame.message }),
          };
      entry.state = "done";
      entry.result = body;
      entry.updatedAt = now();
      flushWaiters(entry, body, undefined);
    }
  });

  /** Every write() call site in this module already sets `op`/`agentKey` on the record it passes
   * in — this wraps `auditControl` once to also fold in the A8 correlation fields (plan §6.4:
   * `linkGen`/`agentPid`/`endpoint`) from those two, instead of repeating the lookup at every call
   * site. Best-effort: an already-retired agent (`registry.get` returns `undefined`) just omits
   * `agentPid`/`linkGen`, same as any other best-effort audit field. */
  function write(record: ControlAuditRecord): void {
    try {
      const view = record.agentKey === undefined ? undefined : registry.get(record.agentKey);
      const linkGen = record.agentKey === undefined ? undefined : registry.getLinkGen(record.agentKey);
      auditControl(log, {
        ...(record.op === undefined ? {} : { endpoint: endpointFor(record.op as CmdOp) }),
        ...(view === undefined ? {} : { agentPid: view.pid }),
        ...(linkGen === undefined ? {} : { linkGen }),
        ...record,
      });
    } catch (err) {
      log.error("web-hub commands: audit write threw", { error: String(err) });
    }
  }

  function evictIfNeeded(): void {
    const t = now();
    for (const [k, e] of lru) {
      if (e.state === "done" && t - e.updatedAt > TTL_MS) lru.delete(k);
    }
    if (lru.size <= MAX_ENTRIES) return;
    for (const [k, e] of lru) {
      if (lru.size <= MAX_ENTRIES) break;
      if (e.state === "done") lru.delete(k);
    }
  }

  function decInflight(): void {
    inflightCount = Math.max(0, inflightCount - 1);
    if (inflightCount === 0) {
      for (const w of zeroWaiters.splice(0)) w();
    }
  }

  function flushWaiters(entry: LruEntry, body: CmdResultBody | undefined, err: unknown): void {
    for (const w of entry.waiters.splice(0)) {
      try {
        w(body, err);
      } catch (e) {
        log.error("web-hub commands: LRU waiter threw", { error: String(e) });
      }
    }
  }

  /** Sends (or re-sends, on an "unknown" retry) `frame` to `agentKey`, classifies the effect,
   * updates `entry` in place, releases anyone waiting on the same key, and returns the resolved
   * body — or rethrows the `registry.request()` rejection (agent gone / hub-side wait timeout)
   * after marking `entry` unknown, letting the caller (the frozen `request()` below) decide how
   * to surface it (it is not part of `CmdErrorCode`, so it can never be a resolved `CmdResultBody`). */
  async function forward(frame: CmdFrame, agentKey: string, entry: LruEntry, retry: boolean): Promise<CmdResultBody> {
    inflightCount++;
    const waitMs = frame.deadlineMs + REGISTRY_WAIT_GRACE_MS;
    const outFrame: CmdFrame = retry ? { ...frame, retry: true } : frame;
    let body: CmdResultBody;
    try {
      const reply = await registry.request<CmdResultFrame>(agentKey, { ...outFrame, t: "cmd" }, waitMs);
      body = capOutputBudget(toBody(reply));
    } catch (err) {
      decInflight();
      entry.state = "unknown";
      entry.updatedAt = now();
      flushWaiters(entry, undefined, err);
      throw err;
    }
    decInflight();
    if (body.ok || !body.retryable) {
      entry.state = "done";
      entry.result = body;
    } else if (body.effect === "unknown") {
      entry.state = "unknown";
    }
    // else: effect:"none" retryable failure — left as-is; the caller (which owns the actual LRU
    // key, unlike this function) deletes the whole entry right after `forward()` returns so a
    // retry re-executes from scratch (§3.4/§3.5).
    entry.updatedAt = now();
    flushWaiters(entry, body, undefined);
    return body;
  }

  function waitOnEntry(entry: LruEntry, frame: CmdFrame): Promise<CmdResultFrame> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = entry.waiters.indexOf(waiter);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve(toResultFrame(frame, { ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" }));
      }, frame.deadlineMs);
      timer.unref?.();
      const waiter = (body: CmdResultBody | undefined, err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err !== undefined || body === undefined) {
          resolve(toResultFrame(frame, { ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" }));
          return;
        }
        resolve(toResultFrame(frame, body.ok ? { ok: true, dup: true, data: body.data } : body));
      };
      entry.waiters.push(waiter);
    });
  }

  async function handleQueryOnly(frame: CmdFrame, agentKey: string, key: string): Promise<CmdResultFrame> {
    const existing = lru.get(key);
    const t0 = now();
    if (existing !== undefined) {
      if (existing.state === "done") {
        const body: CmdResultBody = {
          ok: true,
          data: { op: "query", state: existing.result!.ok ? "ok" : "failed", result: existing.result! },
        };
        write({
          phase: "request",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          ip: frame.origin.ip,
          ...(frame.origin.user === undefined ? {} : { user: frame.origin.user }),
          agentKey,
          ok: true,
          queryOnly: true,
          ms: now() - t0,
        });
        return toResultFrame(frame, body);
      }
      if (existing.state === "inflight") {
        const body: CmdResultBody = { ok: true, data: { op: "query", state: "running" } };
        return toResultFrame(frame, body);
      }
    }
    const view = registry.get(agentKey);
    if (view === undefined) throw new HubError("E_AGENT_GONE");
    const waitMs = frame.deadlineMs + REGISTRY_WAIT_GRACE_MS;
    let reply: CmdResultFrame;
    try {
      reply = await registry.request<CmdResultFrame>(agentKey, { ...frame, t: "cmd" }, waitMs);
    } catch (err) {
      write({
        phase: "request",
        reqId: frame.origin.reqId,
        id: frame.id,
        op: frame.cmd.op,
        listener: frame.origin.listener,
        agentKey,
        ok: false,
        effect: "unknown",
        queryOnly: true,
      });
      throw err;
    }
    const body = toBody(reply);
    if (body.ok && body.data.op === "query") {
      if ((body.data.state === "ok" || body.data.state === "failed") && body.data.result !== undefined) {
        lru.set(key, {
          state: "done",
          digest: existing?.digest ?? digestOf(frame.cmd),
          op: existing?.op ?? frame.cmd.op,
          agentKey,
          result: body.data.result,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
          waiters: [],
        });
      }
    } else if (!body.ok && body.code === "E_UNKNOWN_ID" && existing !== undefined) {
      lru.delete(key);
    }
    write({
      phase: "request",
      reqId: frame.origin.reqId,
      id: frame.id,
      op: frame.cmd.op,
      listener: frame.origin.listener,
      ...(frame.origin.user === undefined ? {} : { user: frame.origin.user }),
      agentKey,
      ok: body.ok,
      ...(body.ok ? {} : { code: body.code, effect: body.effect }),
      queryOnly: true,
      ms: now() - t0,
    });
    return toResultFrame(frame, body);
  }

  return {
    async request(frame, agentKey) {
      const t0 = now();
      const principal = principalOf(frame.origin);
      const key = `${principal}|${agentKey}|${frame.id}`;

      if (draining) {
        const body: CmdResultBody = { ok: false, code: "E_HUB_RESTARTING", retryable: true, effect: "none" };
        write({
          phase: "reject",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          agentKey,
          ok: false,
          code: "E_HUB_RESTARTING",
          effect: "none",
        });
        return toResultFrame(frame, body);
      }

      if (frame.queryOnly === true) return handleQueryOnly(frame, agentKey, key);

      const digest = digestOf(frame.cmd);
      const existing = lru.get(key);
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          const body: CmdResultBody = {
            ok: false,
            code: "E_BAD_REQUEST",
            message: "id reused with a different payload",
            retryable: false,
            effect: "none",
          };
          write({
            phase: "reject",
            reqId: frame.origin.reqId,
            id: frame.id,
            op: frame.cmd.op,
            listener: frame.origin.listener,
            agentKey,
            ok: false,
            code: "E_BAD_REQUEST",
          });
          return toResultFrame(frame, body);
        }
        if (existing.state === "done") {
          const body: CmdResultBody = existing.result!.ok
            ? { ok: true, dup: true, data: existing.result!.data }
            : existing.result!;
          write({
            phase: "request",
            reqId: frame.origin.reqId,
            id: frame.id,
            op: frame.cmd.op,
            listener: frame.origin.listener,
            agentKey,
            ok: body.ok,
            dup: true,
            ...(body.ok ? {} : { code: body.code, effect: body.effect }),
          });
          return toResultFrame(frame, body);
        }
        if (existing.state === "inflight") return waitOnEntry(existing, frame);
        // "unknown": re-forward with retry:true, letting the agent's own ledger decide.
        existing.state = "inflight";
        let body: CmdResultBody;
        let err: unknown;
        try {
          body = await forward(frame, agentKey, existing, true);
        } catch (e) {
          err = e;
        }
        if (err !== undefined) {
          write({
            phase: "request",
            reqId: frame.origin.reqId,
            id: frame.id,
            op: frame.cmd.op,
            listener: frame.origin.listener,
            agentKey,
            ok: false,
            effect: "unknown",
            ms: now() - t0,
          });
          throw err;
        }
        if (body!.ok === false && body!.retryable && body!.effect === "none") lru.delete(key);
        write({
          phase: "request",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          agentKey,
          ok: body!.ok,
          ...(body!.ok ? {} : { code: body!.code, effect: body!.effect }),
          ms: now() - t0,
          ...cmdFields(frame.cmd),
        });
        return toResultFrame(frame, body!);
      }

      // Fresh dispatch: caps gate FIRST — an unsupported capability never sends a frame, never
      // builds an LRU entry (§3.1 compat matrix; C3 acceptance: "E_UNSUPPORTED 不发帧").
      const view = registry.get(agentKey);
      const caps = registry.getCaps(agentKey);
      if (view === undefined || caps === undefined) {
        write({
          phase: "reject",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          agentKey,
          ok: false,
        });
        throw new HubError("E_AGENT_GONE");
      }
      const need = requiredCaps(frame.cmd.op);
      if (!need.every((c) => caps.includes(c))) {
        const body = unsupported();
        write({
          phase: "reject",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          agentKey,
          ok: false,
          code: "E_UNSUPPORTED",
        });
        return toResultFrame(frame, body);
      }

      const entry: LruEntry = {
        state: "inflight",
        digest,
        op: frame.cmd.op,
        agentKey,
        result: undefined,
        createdAt: t0,
        updatedAt: t0,
        waiters: [],
      };
      lru.set(key, entry);
      let body: CmdResultBody;
      try {
        body = await forward(frame, agentKey, entry, false);
      } catch (err) {
        write({
          phase: "request",
          reqId: frame.origin.reqId,
          id: frame.id,
          op: frame.cmd.op,
          listener: frame.origin.listener,
          agentKey,
          ok: false,
          effect: "unknown",
          ms: now() - t0,
        });
        throw err;
      }
      if (body.ok === false && body.retryable && body.effect === "none") lru.delete(key);
      evictIfNeeded();
      write({
        phase: "request",
        reqId: frame.origin.reqId,
        id: frame.id,
        op: frame.cmd.op,
        listener: frame.origin.listener,
        ...(frame.origin.user === undefined ? {} : { user: frame.origin.user }),
        agentKey,
        ok: body.ok,
        ...(body.ok ? {} : { code: body.code, effect: body.effect }),
        ms: now() - t0,
        ...(body.ok && body.data.op === "command"
          ? { outputLen: outputBytes(body.data), outputEntries: body.data.output?.entries.length ?? null }
          : {}),
        ...cmdFields(frame.cmd),
      });
      return toResultFrame(frame, body);
    },

    async drain() {
      draining = true;
      if (inflightCount === 0) return { inflight: 0, timedOut: false };
      let timedOut = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, DRAIN_MAX_MS);
        timer.unref?.();
        zeroWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return { inflight: inflightCount, timedOut };
    },

    inflight() {
      return inflightCount;
    },

    peekIdempotent(origin, agentKey, id, cmd) {
      const key = `${principalOf(origin)}|${agentKey}|${id}`;
      const entry = lru.get(key);
      if (entry === undefined) return undefined;
      // Blocker #2 fix (plan \u00a73.4/\u00a76.3): a same-id-different-payload replay is never a real
      // dup \u2014 `request()` itself would reject it with `E_BAD_REQUEST` rather than reuse the cached
      // result, so the peek must not let it skip rate limiting either.
      if (entry.digest !== digestOf(cmd)) return undefined;
      return entry.state;
    },
  };
}

function outputBytes(data: Extract<CmdData, { op: "command" }>): number | null {
  if (data.output === undefined) return null;
  let total = 0;
  for (const e of data.output.entries) total += Buffer.byteLength(e.text, "utf8");
  return total;
}
