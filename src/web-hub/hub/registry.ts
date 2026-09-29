/**
 * hub agent registry (plan §包 B): records, bus, the claim window, stale/reap
 * and request/response correlation.
 *
 * Record lifecycle (external state in brackets):
 *   live [live] ──close w/o bye | bye{handover}──▶ claiming [live, silent]
 *   claiming ──same agentId reconnects──▶ live (silent rebind, agentKey kept;
 *             epoch changed ⇒ `gap`)
 *   claiming ──detachGraceMs──▶ stale [stale] (`agent_stale`)
 *   stale ──same agentId reconnects──▶ live (`agent_up`, agentKey kept)
 *   stale ──reapMs since disconnect──▶ down (`agent_down`)
 *   bye{quit|detach-timeout|…} ⇒ down immediately; pidAlive(pid)=false ⇒ down
 *   on the next tick, in any state.
 */
import type { AgentCard } from "../protocol/http-contract.js";
import {
  TIMING,
  type AgentFrame,
  type AgentId,
  type AgentKind,
  type CmdLateFrame,
  type CmdResultFrame,
  type CommandInfoWire,
  type DialogClosedWire,
  type DialogWire,
  type FleetRowWire,
  type HubFrame,
  type SessionInfo,
  type StatusInfo,
} from "../protocol/messages.js";
import { compareVersions } from "../protocol/version.js";
import type { AgentView, HubBus, HubEvent, HubLog, RegistryView } from "./ports.js";
import { pidAlive as defaultPidAlive } from "./singleton.js";

export interface Registry extends RegistryView {
  register(hello: Extract<AgentFrame, { t: "hello" }>, conn: AgentConn): { agentKey: string; reclaimed: boolean };
  onFrame(agentKey: string, frame: AgentFrame): void; // session/status/fleet/ev/gap/session_detached → 更新记录 + bus 广播；ev 维护 prompts（ui_prompt_*）
  onClose(agentKey: string, hadBye: boolean): void;
  tick(now: number): void; // stale/reap + pid 存活探测
  readonly bus: HubBus;
  request<R extends AgentFrame>(agentKey: string, frame: HubFrame & { rid: string }, deadlineMs: number): Promise<R>; // P2 cmd 复用
  /**
   * Addition to the plan signature: lets hub-internal producers (history's
   * `append` / compaction `gap`) publish on the same bus the frontend reads.
   */
  publish(e: HubEvent): void;
  /** plan §6.1/§3.1 (C3): raw caps this agent last declared in `hello.caps` (P2_AGENT_CAPS —
   * `cmd.v1`/`dialog.v1`/`command.v1` — plus whatever P1 caps it also sent); used by
   * `hub/commands.ts`'s router to gate `/api/cmd`/`/api/dialog` admission (§3.1 compat matrix,
   * §6.3 step 6) without widening the frozen `AgentView`/`AgentCard` surface in `ports.ts`. */
  getCaps(agentKey: string): readonly string[] | undefined;
  /** plan §3.5 (D17): hub-internal `Rec.linkGen`, incremented on every register()/reclaim; not
   * part of the frozen `AgentView` surface (audit/log field only). */
  getLinkGen(agentKey: string): number | undefined;
  /** plan §3.2/§3.5 (C3): post-construction hook -- `hub/commands.ts`'s router is built *from*
   * a `Registry` instance, so it cannot be one of `createRegistry()`'s own constructor deps
   * (that would be circular); this lets it register for late-arriving `cmd_result` (no matching
   * pending)/`cmd_late` frames after the fact. Overwrites any previous handler (at most one
   * router is ever attached in practice). */
  setLateResultHandler(handler: (agentKey: string, frame: CmdResultFrame | CmdLateFrame) => void): void;
  /** C10: send a control frame to every live agent; a factory may tailor it per agent. */
  broadcast(frame: HubFrame | ((agentKey: string, view: AgentView) => HubFrame)): void;
}

export interface AgentConn {
  send(frame: HubFrame): void;
  close(reason: string): void;
}

/** Error carrying an `API_ERRORS` code (`E_DEADLINE`, `E_AGENT_GONE`, `E_NOT_FOUND`, …). */
export class HubError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "HubError";
    this.code = code;
  }
}

type Prompt = AgentCard["prompts"][number];

interface Rec {
  agentKey: string;
  agentId: AgentId;
  epoch: string;
  kind: AgentKind;
  cwd: string;
  pluginVersion: string;
  buildId: string;
  phase: "live" | "claiming" | "stale";
  conn: AgentConn | undefined;
  byeReason: string | undefined;
  detached: boolean;
  session: SessionInfo | undefined;
  status: StatusInfo | undefined;
  fleet: FleetRowWire[];
  prompts: Prompt[];
  connectedAt: number;
  lastFrameAt: number;
  disconnectedAt: number;
  seq: number;
  /** plan §3.1/§6.1 (C3): raw `hello.caps`, updated on every register()/reclaim. */
  caps: string[];
  /** plan §3.5 (D17): hub-internal generation, bumped on every register()/reclaim. */
  linkGen: number;
  /** plan §3.2/§6.6 (C3): latest `dialogs` slot, surfaced on `AgentCard.dialogs` (§6.6 "AgentCard
   * 带 dialogs 当前值"). */
  dialogs: { epoch: string; open: DialogWire[]; closed: DialogClosedWire[] } | undefined;
  ctl: { epoch: string; sessionId: string } | undefined;
  commands: CommandInfoWire[] | undefined;
}

interface Pending {
  agentKey: string;
  resolve(frame: AgentFrame): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createRegistry(deps: {
  now: () => number;
  log: HubLog;
  pidAlive?: (pid: number) => boolean;
  /** Addition: hub plugin version, used for `AgentCard.outdated` (agent older than hub). */
  hubVersion?: string;
  /** C10 hooks; optional so older direct registry consumers remain unchanged.
   * acc32-B9: `agentKey` lets the supersede controller wait for THIS agent's own `dialogs` slot
   * frame before its first quiet judgment, instead of a same-tick/0ms guess. */
  onVersion?: (pluginVersion: string, agentKey: string) => void;
  onTick?: () => void;
}): Registry {
  const { now, log } = deps;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const records = new Map<string, Rec>();
  const byAgentId = new Map<string, string>();
  const listeners = new Set<(e: HubEvent) => void>();
  const pending = new Map<string, Pending>();
  let ridCounter = 0;
  /** plan section 3.2/3.5 (C3): late-arriving `cmd_result` (no matching pending)/`cmd_late`
   * handed to `hub/commands.ts`'s router so it can upgrade its own LRU/audit. Fired synchronously
   * from `onFrame`; exceptions are caught and logged, never rethrown. Set post-construction via
   * `setLateResultHandler()` below (not a constructor dep) since the router is built *from* this
   * registry instance. */
  let lateResultHandler: ((agentKey: string, frame: CmdResultFrame | CmdLateFrame) => void) | undefined;

  const bus: HubBus = {
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  function publish(e: HubEvent): void {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        log.error("bus listener threw", { type: e.type, error: String(err) });
      }
    }
  }

  function card(r: Rec): AgentCard {
    const c: AgentCard = {
      agentKey: r.agentKey,
      kind: r.kind,
      pid: r.agentId.pid,
      cwd: r.cwd,
      state: r.phase === "stale" ? "stale" : "live",
      pluginVersion: r.pluginVersion,
      outdated: deps.hubVersion !== undefined && compareVersions(r.pluginVersion, deps.hubVersion) < 0,
      prompts: r.prompts.map((p) => ({ ...p })),
      control: r.caps.includes("cmd.v1"),
      epoch: r.epoch,
    };
    if (r.session !== undefined) c.session = r.session;
    if (r.status !== undefined) c.status = r.status;
    if (r.dialogs !== undefined) c.dialogs = { ...r.dialogs };
    return c;
  }

  function view(r: Rec): AgentView {
    return {
      ...card(r),
      agentId: { ...r.agentId },
      connectedAt: r.connectedAt,
      lastFrameAt: r.lastFrameAt,
      seq: r.seq,
    };
  }

  function rejectPendingFor(agentKey: string, code: string): void {
    for (const [rid, p] of pending) {
      if (p.agentKey !== agentKey) continue;
      pending.delete(rid);
      clearTimeout(p.timer);
      p.reject(new HubError(code));
    }
  }

  function down(r: Rec, reason: string): void {
    records.delete(r.agentKey);
    const idKey = agentIdKey(r.agentId);
    if (byAgentId.get(idKey) === r.agentKey) byAgentId.delete(idKey);
    rejectPendingFor(r.agentKey, "E_AGENT_GONE");
    const conn = r.conn;
    r.conn = undefined;
    if (conn !== undefined) {
      try {
        conn.close(`down:${reason}`);
      } catch {
        // ignore
      }
    }
    log.info("agent down", { agentKey: r.agentKey, reason });
    publish({ type: "agent_down", agentKey: r.agentKey, reason });
  }

  function newAgentKey(id: AgentId): string {
    const base = `a${id.pid}-${id.nonce.slice(0, 6)}`;
    if (!records.has(base)) return base;
    for (let i = 2; ; i++) {
      const k = `${base}-${i}`;
      if (!records.has(k)) return k;
    }
  }

  const registry: Registry = {
    bus,
    publish,

    setLateResultHandler(handler) {
      lateResultHandler = handler;
    },

    broadcast(frame) {
      for (const r of records.values()) {
        if (r.phase !== "live" || r.conn === undefined) continue;
        try {
          r.conn.send(typeof frame === "function" ? frame(r.agentKey, view(r)) : frame);
        } catch (err) {
          log.warn("agent broadcast failed", { agentKey: r.agentKey, error: String(err) });
        }
      }
    },

    list() {
      return [...records.values()].map(view);
    },

    get(agentKey) {
      const r = records.get(agentKey);
      return r === undefined ? undefined : view(r);
    },

    getCaps(agentKey) {
      return records.get(agentKey)?.caps;
    },

    getLinkGen(agentKey) {
      return records.get(agentKey)?.linkGen;
    },

    register(hello, conn) {
      const t = now();
      const idKey = agentIdKey(hello.agentId);
      const existingKey = byAgentId.get(idKey);
      const existing = existingKey === undefined ? undefined : records.get(existingKey);
      if (existing !== undefined) {
        const prevPhase = existing.phase;
        const oldConn = existing.conn;
        if (oldConn !== undefined && oldConn !== conn) {
          rejectPendingFor(existing.agentKey, "E_AGENT_GONE");
          try {
            oldConn.close("reclaimed");
          } catch {
            // ignore
          }
        }
        const epochChanged = existing.epoch !== hello.epoch;
        existing.conn = conn;
        existing.phase = "live";
        existing.byeReason = undefined;
        existing.detached = false;
        existing.epoch = hello.epoch;
        existing.kind = hello.kind;
        existing.cwd = hello.cwd;
        existing.pluginVersion = hello.pluginVersion;
        existing.buildId = hello.buildId;
        existing.connectedAt = t;
        existing.lastFrameAt = t;
        existing.caps = [...hello.caps];
        existing.linkGen++;
        if (epochChanged) existing.seq = 0;
        log.info("agent reclaimed", { agentKey: existing.agentKey, from: prevPhase, epochChanged });
        if (prevPhase === "stale") publish({ type: "agent_up", agent: card(existing) });
        if (epochChanged) publish({ type: "gap", agentKey: existing.agentKey, fromSeq: 0 });
        deps.onVersion?.(hello.pluginVersion, existing.agentKey);
        return { agentKey: existing.agentKey, reclaimed: true };
      }
      const agentKey = newAgentKey(hello.agentId);
      const r: Rec = {
        agentKey,
        agentId: { pid: hello.agentId.pid, nonce: hello.agentId.nonce },
        epoch: hello.epoch,
        kind: hello.kind,
        cwd: hello.cwd,
        pluginVersion: hello.pluginVersion,
        buildId: hello.buildId,
        phase: "live",
        conn,
        byeReason: undefined,
        detached: false,
        session: undefined,
        status: undefined,
        fleet: [],
        prompts: [],
        connectedAt: t,
        lastFrameAt: t,
        disconnectedAt: 0,
        seq: 0,
        caps: [...hello.caps],
        linkGen: 1,
        dialogs: undefined,
        ctl: undefined,
        commands: undefined,
      };
      records.set(agentKey, r);
      byAgentId.set(idKey, agentKey);
      log.info("agent up", { agentKey, pid: r.agentId.pid, kind: r.kind, cwd: r.cwd, version: r.pluginVersion });
      publish({ type: "agent_up", agent: card(r) });
      deps.onVersion?.(hello.pluginVersion, agentKey);
      return { agentKey, reclaimed: false };
    },

    onFrame(agentKey, frame) {
      const r = records.get(agentKey);
      if (r === undefined) return;
      r.lastFrameAt = now();
      switch (frame.t) {
        case "session": {
          const { t: _t, ...info } = frame;
          const hadSession = r.session !== undefined;
          r.session = info;
          r.detached = false;
          publish({ type: "session", agentKey, session: info });
          // Session replaced / re-sent (reconnect, /new, /resume …): subscribers must re-snapshot.
          if (hadSession) publish({ type: "gap", agentKey, fromSeq: r.seq + 1 });
          return;
        }
        case "session_detached":
          r.detached = true;
          log.info("agent session detached", { agentKey, reason: frame.reason });
          return;
        case "ev": {
          r.seq = frame.seq;
          const e = frame.e;
          if (e.type === "ui_prompt_start") {
            const p: Prompt = { kind: typeof e["kind"] === "string" ? e["kind"] : "unknown", since: now() };
            if (typeof e["title"] === "string") p.title = e["title"];
            r.prompts.push(p);
          } else if (e.type === "ui_prompt_end") {
            const kind = typeof e["kind"] === "string" ? e["kind"] : undefined;
            let idx = -1;
            for (let i = r.prompts.length - 1; i >= 0; i--) {
              if (kind === undefined || r.prompts[i]!.kind === kind) {
                idx = i;
                break;
              }
            }
            if (idx === -1 && r.prompts.length > 0) idx = r.prompts.length - 1;
            if (idx !== -1) r.prompts.splice(idx, 1);
          }
          publish({ type: "ev", agentKey, seq: frame.seq, e });
          if (e.type === "ui_prompt_start" || e.type === "ui_prompt_end") {
            publish({ type: "prompt", agentKey, prompts: r.prompts.map((p) => ({ ...p })) });
          }
          return;
        }
        case "status": {
          const { t: _t, ...status } = frame;
          r.status = status;
          publish({ type: "status", agentKey, status });
          return;
        }
        case "fleet":
          r.fleet = frame.runs;
          publish({ type: "fleet", agentKey, runs: frame.runs });
          return;
        case "gap":
          publish({ type: "gap", agentKey, fromSeq: frame.fromSeq });
          return;
        case "bye":
          r.byeReason = frame.reason;
          return;
        case "snapshot_reply":
        case "branch_reply": {
          const p = pending.get(frame.rid);
          if (p === undefined || p.agentKey !== agentKey) return;
          pending.delete(frame.rid);
          clearTimeout(p.timer);
          if (frame.t === "snapshot_reply") {
            r.seq = Math.max(r.seq, frame.seq);
            if (JSON.stringify(frame.prompts) !== JSON.stringify(r.prompts)) {
              r.prompts = frame.prompts.map((x) => ({ ...x }));
              publish({ type: "prompt", agentKey, prompts: r.prompts.map((x) => ({ ...x })) });
            }
          }
          p.resolve(frame);
          return;
        }
        // plan section 3.2/6.1 (C3): `cmd_result` normally resolves a pending `registry.request()`
        // (same rid-keyed dance as snapshot_reply/branch_reply above); a `cmd_result` whose rid has
        // no pending entry (hub's own wait already timed out, or a stray duplicate) is a late
        // result, handed to the late-result handler (section 3.5 table row: delayed cmd_result or
        // cmd_late). Unlike a genuine `cmd_late` wire frame, a late `cmd_result` carries no `op`,
        // so it cannot be re-shaped into the frozen `cmd_late` bus/SSE event (which requires one) -
        // only the handler (LRU/audit bookkeeping, keyed by `id` alone) observes it.
        case "cmd_result": {
          const p = pending.get(frame.rid);
          if (p !== undefined && p.agentKey === agentKey) {
            pending.delete(frame.rid);
            clearTimeout(p.timer);
            p.resolve(frame);
            return;
          }
          try {
            lateResultHandler?.(agentKey, frame);
          } catch (err) {
            log.error("onLateResult threw", { agentKey, error: String(err) });
          }
          return;
        }
        case "cmd_late": {
          try {
            lateResultHandler?.(agentKey, frame);
          } catch (err) {
            log.error("onLateResult threw", { agentKey, error: String(err) });
          }
          publish({
            type: "cmd_late",
            agentKey,
            id: frame.id,
            op: frame.op,
            ok: frame.ok,
            ...(frame.ok ? { data: frame.data } : { code: frame.code }),
          });
          return;
        }
        case "dialogs": {
          r.dialogs = { epoch: frame.epoch, open: frame.open, closed: frame.closed };
          publish({ type: "dialogs", agentKey, epoch: frame.epoch, open: frame.open, closed: frame.closed });
          return;
        }
        case "ctl": {
          r.ctl = { epoch: frame.epoch, sessionId: frame.sessionId };
          publish({ type: "ctl", agentKey, epoch: frame.epoch, sessionId: frame.sessionId, items: frame.items });
          return;
        }
        case "commands": {
          r.commands = frame.items;
          publish({ type: "commands", agentKey, epoch: frame.epoch, items: frame.items });
          return;
        }
        default:
          return; // hello (dup) / ping / pong: liveness only
      }
    },

    onClose(agentKey, hadBye) {
      const r = records.get(agentKey);
      if (r === undefined) return;
      r.conn = undefined;
      rejectPendingFor(agentKey, "E_AGENT_GONE");
      const reason = r.byeReason;
      if (hadBye && reason !== undefined && reason !== "handover") {
        down(r, reason);
        return;
      }
      if (r.phase === "live") {
        r.phase = "claiming";
        r.disconnectedAt = now();
        log.info("agent disconnected, claim window open", { agentKey, handover: reason === "handover" });
      }
    },

    tick(t) {
      for (const r of [...records.values()]) {
        let alive = true;
        try {
          alive = pidAlive(r.agentId.pid);
        } catch {
          alive = true;
        }
        if (!alive) {
          down(r, "pid-dead");
          continue;
        }
        if (r.phase === "claiming" && t - r.disconnectedAt >= TIMING.detachGraceMs) {
          r.phase = "stale";
          log.info("agent stale", { agentKey: r.agentKey });
          publish({ type: "agent_stale", agentKey: r.agentKey });
        }
        if (r.phase === "stale" && t - r.disconnectedAt >= TIMING.reapMs) {
          down(r, "reaped");
        }
      }
      deps.onTick?.();
    },

    request<R extends AgentFrame>(agentKey: string, frame: HubFrame & { rid: string }, deadlineMs: number) {
      return new Promise<R>((resolve, reject) => {
        const r = records.get(agentKey);
        const conn = r?.conn;
        if (r === undefined || conn === undefined) {
          reject(new HubError("E_AGENT_GONE"));
          return;
        }
        // The registry owns rid allocation (monotonic string); the caller's rid is replaced.
        const rid = `r${++ridCounter}`;
        const timer = setTimeout(
          () => {
            if (pending.delete(rid)) reject(new HubError("E_DEADLINE"));
          },
          Math.max(0, deadlineMs),
        );
        timer.unref();
        pending.set(rid, { agentKey, resolve: (f) => resolve(f as R), reject, timer });
        try {
          const out: HubFrame = Object.assign({}, frame, { rid });
          conn.send(out);
        } catch (err) {
          pending.delete(rid);
          clearTimeout(timer);
          reject(new HubError("E_AGENT_GONE", String(err)));
        }
      });
    },
  };
  return registry;
}

function agentIdKey(id: AgentId): string {
  return `${id.pid}:${id.nonce}`;
}
