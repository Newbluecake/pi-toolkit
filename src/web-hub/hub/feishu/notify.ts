/** F8 notices: owner health + conservative proactive completion (R2-h). No listener/timer. */
import { FEISHU_NOTIFY_LIMITS } from "../../protocol/feishu.js";
import type { FeishuState, FeishuBinding } from "./state.js";
import type { OutboxTarget } from "./outbox.js";
import { renderNotice } from "./render.js";
import { feishuKey } from "./runtime.js";

export interface FeishuIdleEvidence {
  at: number;
  fleet: { complete: boolean; terminal: readonly boolean[] } | undefined;
  bash: { complete: boolean; running: number } | undefined;
}
export interface FeishuNotifyDeps {
  state: FeishuState;
  now(): number;
  owner(): string | undefined;
  enabled: boolean;
  label(sessionId: string): string;
  target(binding: FeishuBinding): OutboxTarget | undefined;
  send(input: {
    target: OutboxTarget;
    message: { msgType: "text" | "interactive"; content: string };
    key: string;
    laneKey?: string;
  }): Promise<unknown>;
}
export function feishuBackgroundIdle(evidence: FeishuIdleEvidence | undefined, now: number): boolean {
  return (
    evidence !== undefined &&
    now >= evidence.at &&
    now - evidence.at <= 10_000 &&
    evidence.fleet?.complete === true &&
    evidence.bash?.complete === true &&
    evidence.fleet.terminal.every(Boolean) &&
    evidence.bash.running === 0
  );
}
export function createFeishuNotify(deps: FeishuNotifyDeps) {
  const last = new Map<string, number>();
  let windowAt = deps.now(),
    count = 0,
    disposed = false;
  function reserve(key: string, gap: number): boolean {
    if (disposed) return false;
    const now = deps.now();
    if (now - windowAt >= 60_000) {
      windowAt = now;
      count = 0;
    }
    if (count >= FEISHU_NOTIFY_LIMITS.globalPerMin || now - (last.get(key) ?? -Infinity) < gap) return false;
    if (!last.has(key) && last.size >= 1_024) return false;
    count++;
    last.set(key, now);
    return true;
  }
  return {
    /**
     * Owner health notice. Debounced per reason: `opts.gapMs` (default 1 h) gates both the in-memory
     * reserve and the stable outbox key window (`owner-<reason>-<floor(now/gap)>`), so the outbox's
     * persisted dedup also suppresses repeat notices across a hub restart inside the same window.
     */
    async owner(reason: string, opts?: { gapMs?: number }) {
      const gapMs =
        opts?.gapMs !== undefined && Number.isFinite(opts.gapMs) && opts.gapMs > 0 ? Math.floor(opts.gapMs) : 3_600_000;
      const owner = deps.owner();
      // Caller supplies static enumerated reasons only, never API/server error messages.
      if (!owner || !/^[a-z0-9:._-]{1,80}$/.test(reason) || !reserve(`owner:${reason}`, gapMs)) return;
      await deps.send({
        target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: owner },
        message: renderNotice({
          label: "bot",
          text: `飞书机器人状态：${reason}。请在终端运行 /webhub feishu status 查看。`,
        }),
        key: `owner-${reason}-${Math.floor(deps.now() / gapMs)}`,
      });
    },
    async session(input: {
      sessionId: string;
      kind: "done" | "failed" | "waiting";
      text: string;
      evidence?: FeishuIdleEvidence;
      feishuInitiated: boolean;
    }) {
      if (
        !deps.enabled ||
        input.feishuInitiated ||
        (input.kind === "done" && !feishuBackgroundIdle(input.evidence, deps.now()))
      )
        return;
      const bindings = deps.state.bindings
        .list()
        .filter((b) => b.sessionId === input.sessionId && b.offline === undefined);
      if (!bindings.length || !reserve(`${input.kind}:${input.sessionId}`, input.kind === "done" ? 60_000 : 300_000))
        return;
      for (const binding of bindings) {
        const target = deps.target(binding);
        if (!target) continue;
        await deps.send({
          target,
          message: renderNotice({
            label: deps.label(input.sessionId),
            text: `${input.kind}: ${input.text.slice(0, 1_500)}`,
          }),
          key: feishuKey(`${binding.key}:${input.kind}:${deps.now()}`),
          laneKey: binding.chatId,
        });
      }
    },
    dispose() {
      disposed = true;
      last.clear();
    },
  };
}
export type FeishuNotify = ReturnType<typeof createFeishuNotify>;
