/** F8 causal run tracking: final-only (D2), token anchor + consumed, uninterrupted ev stream (R2-a/b). */
import type { CtlItemWire, WireEvent } from "../../protocol/messages.js";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import type { FeishuClock } from "./http.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuRequestRecord } from "./state.js";
import type { FeishuRequestEvent } from "./requests.js";
import { messageText, object } from "./runtime.js";

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
  function disconnect(agentKey: string) {
    streams.delete(agentKey);
    for (const r of [...runs.values()]) if (r.request.agentKey === agentKey) finish(r, "unattributed");
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
        r.request = event.request;
        r.accepted = true;
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
            finish(r, "unattributed");
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
            r.anchorTimer = clock.setTimeout(() => {
              if (!r.anchor) finish(r, "unattributed");
            }, 60_000);
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
    owns(agentKey: string) {
      return [...runs.values()].some((r) => r.request.agentKey === agentKey);
    },
    disconnect,
    dispose() {
      disposed = true;
      for (const r of runs.values()) {
        clock.clearTimeout(r.anchorTimer);
        clock.clearTimeout(r.ttl);
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
