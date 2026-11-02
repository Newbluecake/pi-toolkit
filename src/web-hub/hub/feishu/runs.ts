/** F8 causal run tracking: final-only (D2), token anchor + consumed, uninterrupted ev stream (R2-a/b). */
import type { CtlItemWire, WireEvent } from "../../protocol/messages.js";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import type { FeishuClock } from "./http.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuRequestRecord } from "./state.js";
import type { FeishuRequestEvent } from "./requests.js";
import { messageText, object } from "./runtime.js";

/** §8.1 结果竞争: fallback bound for a thread candidate whose result has not returned —
 *  `clampSpanMs(frameDeadlineMs + 5000)`. Local clamp (kdf-upgrade.ts precedent — hub code
 *  does not import core/deadline; the boundary test pins that). */
const CANDIDATE_MAX_SPAN_MS = 365 * 86_400_000;
function candidateClampSpan(ms: number): number | undefined {
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return Math.min(ms, CANDIDATE_MAX_SPAN_MS);
}

export type FeishuRunEvent =
  | { type: "ev"; agentKey: string; seq: number; e: WireEvent }
  | { type: "ctl"; agentKey: string; epoch: string; sessionId: string; items: CtlItemWire[] }
  | { type: "session"; agentKey: string; session: { sessionId: string } }
  | { type: "gap" | "agent_down" | "agent_stale" | "agent_up"; agentKey: string };
export interface FeishuRunResult {
  request: FeishuRequestRecord;
  kind: "done" | "failed" | "unattributed" | "rejected" | "expired";
  text: string;
  truncated: boolean;
  continued: boolean;
  stopReason?: string;
}
export interface FeishuRunsDeps {
  clock?: FeishuClock;
  finish(result: FeishuRunResult): void;
  reaction(request: FeishuRequestRecord, add: boolean): void;
  transfer(request: FeishuRequestRecord, sessionId: string): void;
  /** §8.1: the dispatch deadline the candidate fallback timer derives from (admission's
   *  `deadlineMs`, default 8000 — service passes the same value). */
  frameDeadlineMs?: number;
}
interface Run {
  request: FeishuRequestRecord;
  text: string;
  sessionId: string;
  epoch: string | undefined;
  consumed: boolean;
  anchor: boolean;
  accepted: boolean;
  settled: boolean;
  cut: boolean;
  output: string;
  truncated: boolean;
  stopReason: string | undefined;
  anchorTimer?: unknown;
  ttl: unknown;
  /** fabric-thread §8.1: the hub attached `cmd.thread` without bypass. */
  threadCandidate: boolean;
  /** §8.1: the RESULT decided the race is over (a plain ok after a real stream break ⇒
   *  unattributed, same as today). Set only by gap/disconnect/epoch paths. */
  streamBroken: boolean;
  /** §8.1: a gap/epoch/session/consumed race landed BEFORE the result — the result now decides. */
  gapBeforeResult: boolean;
  gapTimer?: unknown;
}
export function createFeishuRuns(deps: FeishuRunsDeps) {
  const clock = deps.clock ?? systemFeishuClock;
  const runs = new Map<string, Run>();
  const streams = new Map<string, { seq?: number; epoch?: string; sessionId?: string }>();
  let disposed = false;
  function finish(r: Run, kind: FeishuRunResult["kind"]) {
    if (!runs.delete(r.request.id)) return;
    clock.clearTimeout(r.anchorTimer);
    clock.clearTimeout(r.ttl);
    clock.clearTimeout(r.gapTimer);
    deps.reaction(r.request, false);
    deps.finish({
      request: r.request,
      kind,
      text: kind === "done" || kind === "failed" ? r.output : "",
      truncated: r.truncated,
      continued: r.cut,
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
    });
  }
  function maybe(r: Run) {
    if (r.accepted && r.anchor && r.settled)
      finish(
        r,
        r.consumed && r.anchor
          ? r.stopReason === "error" || r.stopReason === "aborted"
            ? "failed"
            : "done"
          : "unattributed",
      );
  }
  /** §8.1 结果竞争: a thread candidate whose result has not returned does NOT finish on a
   *  gap/agent_down/agent_stale/agent_up, epoch/session change or the consumed-no-anchor
   *  timer — it defers to the result under an unref'd fallback bound. `brokeStream` marks the
   *  REAL stream breaks (a later plain-ok finalizes unattributed, same as today); the
   *  consumed-before-result postponement only arms the bound. */
  function postpone(r: Run, brokeStream: boolean) {
    if (r.gapBeforeResult || r.accepted) return;
    r.gapBeforeResult = true;
    if (brokeStream) r.streamBroken = true;
    clock.clearTimeout(r.anchorTimer);
    r.anchorTimer = undefined;
    const span = candidateClampSpan((deps.frameDeadlineMs ?? 8_000) + 5_000);
    if (span === undefined) {
      finish(r, "unattributed");
      return;
    }
    r.gapTimer = clock.setTimeout(() => {
      r.gapTimer = undefined;
      if (!r.accepted) finish(r, "unattributed");
    }, span);
  }
  /** §8.1 step 2: clear a candidate's timers and delete the tracker WITHOUT finishing it —
   *  the routed branch calls this BEFORE migrating the request, so no tracker spans the commit. */
  function detach(id: string) {
    const r = runs.get(id);
    if (r === undefined) return;
    clock.clearTimeout(r.anchorTimer);
    clock.clearTimeout(r.ttl);
    clock.clearTimeout(r.gapTimer);
    runs.delete(id);
  }
  function disconnect(agentKey: string) {
    streams.delete(agentKey);
    for (const r of [...runs.values()])
      if (r.request.agentKey === agentKey) {
        if (r.threadCandidate && !r.accepted) postpone(r, true);
        else finish(r, "unattributed");
      }
  }
  return {
    request(event: FeishuRequestEvent) {
      if (disposed || event.type === "merged") return;
      const id = event.request.id;
      if (event.type === "dispatching") {
        if (runs.has(id) || runs.size >= FEISHU_CAPS.requestsNonTerminal) return;
        const s = streams.get(event.request.agentKey ?? "");
        const r: Run = {
          request: event.request,
          text: event.text,
          sessionId: event.request.sessionId,
          epoch: s?.epoch,
          consumed: false,
          anchor: false,
          accepted: false,
          settled: false,
          cut: false,
          output: "",
          truncated: false,
          stopReason: undefined,
          ttl: undefined,
          threadCandidate: event.thread === true,
          gapBeforeResult: false,
          streamBroken: false,
        };
        r.ttl = clock.setTimeout(
          () => finish(r, "expired"),
          Math.max(0, event.request.createdAt + 24 * 3_600_000 - clock.now()),
        );
        runs.set(id, r);
      } else if (event.type === "accepted") {
        const r = runs.get(id);
        if (event.recovered || !r) {
          deps.finish({ request: event.request, kind: "unattributed", text: "", truncated: false, continued: false });
          deps.reaction(event.request, false);
          return;
        }
        // §8.1: a plain-ok result AFTER a real stream break means the stream already broke —
        // same unattributed as today (the routed case never reaches here: detach removed the
        // tracker first; a consumed-before-result postponement is NOT a break).
        if (r.streamBroken && !r.anchor) {
          finish(r, "unattributed");
          return;
        }
        r.request = event.request;
        r.accepted = true;
        // §8.1: a candidate whose result arrived late still gets the standard consumed-no-anchor
        // bound restored (the fallback timer never fires past `accepted`).
        if (r.threadCandidate && r.consumed && !r.anchor && r.anchorTimer === undefined)
          r.anchorTimer = clock.setTimeout(() => {
            if (!r.anchor) finish(r, "unattributed");
          }, 60_000);
        if (event.reactionEligible && !r.settled) deps.reaction(r.request, true);
        maybe(r);
      } else {
        const r = runs.get(id);
        if (r) {
          clock.clearTimeout(r.anchorTimer);
          clock.clearTimeout(r.ttl);
          runs.delete(id);
          deps.reaction(r.request, false);
        }
      }
    },
    event(event: FeishuRunEvent) {
      if (disposed) return;
      const key = event.agentKey;
      if (["gap", "agent_down", "agent_stale", "agent_up"].includes(event.type)) {
        disconnect(key);
        return;
      }
      const stream = streams.get(key) ?? {};
      // Registry can contain many offline cards; do not retain unbounded stream state.
      if (!streams.has(key) && streams.size >= 512) return;
      streams.set(key, stream);
      if (event.type === "session") {
        stream.sessionId = event.session.sessionId;
        for (const r of [...runs.values()])
          if (r.request.agentKey === key && r.anchor && r.sessionId !== event.session.sessionId)
            finish(r, "unattributed");
      } else if (event.type === "ctl") {
        if (stream.epoch !== undefined && stream.epoch !== event.epoch) {
          disconnect(key);
          streams.set(key, { epoch: event.epoch, sessionId: event.sessionId });
          return;
        }
        stream.epoch = event.epoch;
        stream.sessionId = event.sessionId;
        for (const r of [...runs.values()]) {
          if (r.request.agentKey !== key) continue;
          if (r.epoch !== undefined && r.epoch !== event.epoch) {
            if (r.threadCandidate && !r.accepted) postpone(r, true);
            else finish(r, "unattributed");
            continue;
          }
          r.epoch = event.epoch;
          const item = event.items.find((x) => x.cmdId === r.request.id);
          if (!item) continue;
          if (["dropped", "recalled", "returned"].includes(item.state) || item.reason === "session") {
            finish(r, "rejected");
            continue;
          }
          if (item.state === "consumed" && !r.consumed) {
            r.consumed = true;
            if (r.threadCandidate && !r.accepted) {
              // §8.1: ctl consumed may legitimately precede the routed cmd_result — defer to the
              // result under the fallback bound instead of the 60 s anchor timer.
              postpone(r, false);
            } else {
              r.anchorTimer = clock.setTimeout(() => {
                if (!r.anchor) finish(r, "unattributed");
              }, 60_000);
            }
          }
          maybe(r);
        }
      } else if (event.type === "ev") {
        if (stream.seq !== undefined && event.seq !== stream.seq + 1) {
          disconnect(key);
          streams.set(key, { seq: event.seq });
          return;
        }
        stream.seq = event.seq;
        const msg = object(event.e["message"]);
        for (const r of [...runs.values()]) {
          if (r.request.agentKey !== key) continue;
          if (event.e.type === "message_start" && msg?.["role"] === "user") {
            const text = messageText(msg);
            if (!r.anchor && text === r.text && msg["truncated"] !== true) {
              r.anchor = true;
              clock.clearTimeout(r.anchorTimer);
              if (stream.sessionId && stream.sessionId !== r.sessionId) {
                r.sessionId = stream.sessionId;
                deps.transfer(r.request, r.sessionId);
              }
            } else if (r.anchor) r.cut = true;
          } else if (r.anchor && !r.cut && event.e.type === "message_end" && msg?.["role"] === "assistant") {
            const text = messageText(msg);
            // Bounded content buffer. Mark incomplete rather than silently dropping overflow.
            const room = 1_000_000 - r.output.length;
            r.output += (r.output && text ? "\n\n" : "") + text.slice(0, Math.max(0, room));
            r.truncated ||= text.length > room || msg["truncated"] === true || event.e["truncated"] === true;
            if (typeof msg["stopReason"] === "string") r.stopReason = msg["stopReason"];
          } else if (event.e.type === "agent_settled" && r.anchor) {
            r.settled = true;
            maybe(r);
          }
        }
      }
    },
    has(requestId: string) {
      return runs.has(requestId);
    },
    detach,
    owns(agentKey: string) {
      return [...runs.values()].some((r) => r.request.agentKey === agentKey);
    },
    disconnect,
    dispose() {
      disposed = true;
      for (const r of runs.values()) {
        clock.clearTimeout(r.anchorTimer);
        clock.clearTimeout(r.ttl);
        clock.clearTimeout(r.gapTimer);
      }
      runs.clear();
      streams.clear();
    },
    get size() {
      return runs.size;
    },
  };
}
export type FeishuRuns = ReturnType<typeof createFeishuRuns>;
