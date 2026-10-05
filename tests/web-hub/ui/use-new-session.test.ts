// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createNewSession } from "../../../src/web-hub/ui/src/composables/useNewSession.js";
import type { SpawnOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { ControlHandle, NewSessionFlow, NewSessionInput } from "../../../src/web-hub/ui/src/types.js";
import type {
  SpawnPolicyWire,
  SpawnRecordPublic,
  SpawnRequestBody,
  SpawnsPayload,
} from "../../../src/web-hub/protocol/spawn.js";

/**
 * web-hub-spawn SP11 **hard gate (#15)**: the plan §3.2 orchestrator's seven acceptance
 * cases — (a) reconnect snapshot `delivered` ⇒ no refill, no resend; (b) pre-202 network
 * error ⇒ SAME id resent once (`dup:true` hub-side, one record); (c) live ⇒ disconnect ⇒
 * reconnect ⇒ snapshot is authoritative; (d) `expired{never_live}` ⇒ body back to the
 * DirPicker; (e) `failed{E_SESSION_CHANGED}` ⇒ exactly one `setDraft(agentKey, text)`;
 * (f) double submit ⇒ one wire request; (g) the retention Map empties on deliver AND on
 * every refill — plus the confirm flow, the local watchdog's 状态未知, and retry-under-new-id.
 */

function fakeClock() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
    pending: () => timers.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const policy: SpawnPolicyWire = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 4,
  maxPerPrincipal: 2,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
};

function rec(extra: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp1",
    state: "starting",
    createdAt: 1000,
    updatedAt: 1000,
    cwdLabel: "proj",
    origin: { listener: "loopback", reqId: "req-1-aaaaaaaaaaaa" },
    ...extra,
  };
}

function payload(...items: SpawnRecordPublic[]): SpawnsPayload {
  return { items, active: items.length, max: 4 };
}

interface Harness {
  readonly ns: ReturnType<typeof createNewSession>;
  readonly starts: SpawnRequestBody[];
  readonly drafts: Array<{ agentKey: string; text: string }>;
  readonly navigations: string[];
  readonly clock: ReturnType<typeof fakeClock>;
  setStartImpl(impl: (req: SpawnRequestBody) => Promise<SpawnOutcome>): void;
  flow(): NewSessionFlow;
}

function make(): Harness {
  const clock = fakeClock();
  const starts: SpawnRequestBody[] = [];
  const drafts: Array<{ agentKey: string; text: string }> = [];
  const navigations: string[] = [];
  let startImpl: (req: SpawnRequestBody) => Promise<SpawnOutcome> = async () => ({
    ok: true,
    data: { spawnId: "sp1", state: "starting", cwd: "/real/proj" },
  });
  let idSeq = 0;
  const control = {
    setDraft: (agentKey: string, text: string) => void drafts.push({ agentKey, text }),
  } as unknown as ControlHandle;
  const ns = createNewSession({
    start: (req) => {
      starts.push(req);
      return startImpl(req);
    },
    policy: () => policy,
    control,
    navigate: (agentKey) => navigations.push(agentKey),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newId: () => `req-${++idSeq}-aaaaaaaaaaaa`,
  });
  return {
    ns,
    starts,
    drafts,
    navigations,
    clock,
    setStartImpl: (impl) => (startImpl = impl),
    flow: () => ns.flow.value,
  };
}

const input = (text?: string): NewSessionInput =>
  text === undefined ? { cwd: "~/proj" } : { cwd: "~/proj", firstPrompt: { text, deliver: "steer" } };

describe("useNewSession (plan §3.2 — #15 hard gate)", () => {
  it("(a) 202 ⇒ SSE disconnect ⇒ reconnect snapshot shows delivered: no refill, no resend, navigates once", async () => {
    const h = make();
    await h.ns.submit(input("hello world"));
    expect(h.flow().phase).toBe("awaiting");
    expect(h.starts).toHaveLength(1);

    // SSE drops; snapshots are empty while disconnected (noteSpawns tolerates null).
    h.ns.noteSpawns(null);
    h.ns.noteSpawns(payload());

    // Reconnect: the hub's snapshot shows the record live + first prompt delivered.
    h.ns.noteSpawns(
      payload(
        rec({
          state: "live",
          agentKey: "agent-9",
          firstPrompt: { state: "delivered" },
          origin: { listener: "loopback", reqId: "req-1-aaaaaaaaaaaa" },
        }),
      ),
    );
    expect(h.flow()).toMatchObject({ phase: "done", spawnId: "sp1", agentKey: "agent-9" });
    expect(h.starts).toHaveLength(1); // never resent
    expect(h.drafts).toHaveLength(0); // never refilled on success
    expect(h.navigations).toEqual(["agent-9"]); // 「我发起的」⇒ 跳转
    expect(h.ns.stats().retainedTexts).toBe(0); // (g) Map emptied on deliver
  });

  it("(b) network error before the 202 ⇒ SAME id resent once; hub dedupes (dup:true) into one record", async () => {
    const h = make();
    let attempt = 0;
    h.setStartImpl(async () => {
      attempt++;
      if (attempt === 1) return { ok: false, error: "E_NETWORK", message: "socket hangup", retryable: true };
      // hub idempotency LRU: the same id already created the record ⇒ dup, still ONE record.
      return { ok: true, data: { spawnId: "sp1", state: "starting", cwd: "/real/proj", dup: true } };
    });
    await h.ns.submit(input("first prompt"));
    expect(h.starts).toHaveLength(2);
    expect(h.starts[1]!.id).toBe(h.starts[0]!.id); // 同一个 id 重发一次
    expect(h.starts[1]!.firstPrompt).toEqual(h.starts[0]!.firstPrompt);
    expect(h.flow().phase).toBe("awaiting");
  });

  it("(b') both attempts fail ⇒ failed(kind network), input retained for the DirPicker", async () => {
    const h = make();
    h.setStartImpl(async () => ({ ok: false, error: "E_NETWORK", message: "down", retryable: true }));
    await h.ns.submit(input("first prompt"));
    expect(h.starts).toHaveLength(2); // one retry, then it surfaces
    expect(h.flow()).toMatchObject({ phase: "failed", kind: "network", message: "down" });
    expect((h.flow() as { input?: NewSessionInput }).input).toEqual(input("first prompt"));
  });

  it("(c) live ⇒ disconnect ⇒ reconnect: the snapshot is authoritative (delivered settles the flow)", async () => {
    const h = make();
    await h.ns.submit(input("body"));
    h.ns.noteSpawns(payload(rec({ state: "live", agentKey: "A", firstPrompt: { state: "sending" } })));
    expect(h.flow()).toMatchObject({ phase: "awaiting", firstPrompt: { state: "sending" } });

    // Disconnect: nothing to merge; reconnect snapshot says delivered ⇒ done.
    h.ns.noteSpawns(null);
    h.ns.noteSpawns(payload(rec({ state: "live", agentKey: "A", firstPrompt: { state: "delivered" } })));
    expect(h.flow()).toMatchObject({ phase: "done", agentKey: "A" });
    expect(h.ns.stats().retainedTexts).toBe(0);
  });

  it("(d) expired{never_live} (record failed before live, no agentKey) ⇒ body back to the DirPicker", async () => {
    const h = make();
    await h.ns.submit(input("precious body"));
    h.ns.noteSpawns(
      payload(
        rec({
          state: "failed",
          endReason: "register_timeout",
          hint: "register-timeout-hello",
          firstPrompt: { state: "expired", code: "never_live" },
        }),
      ),
    );
    expect(h.flow()).toMatchObject({
      phase: "failed",
      kind: "first-prompt",
      code: "never_live",
      refilled: "picker",
    });
    // 正文回填到 DirPicker: the flow's input still carries the body; the retention Map is empty ((g)).
    expect((h.flow() as { input?: NewSessionInput }).input?.firstPrompt?.text).toBe("precious body");
    expect(h.drafts).toHaveLength(0); // no agentKey ⇒ never a draft refill
    expect(h.ns.stats().retainedTexts).toBe(0);
  });

  it("(e) failed{E_SESSION_CHANGED} on a live record ⇒ setDraft(agentKey, text) exactly once", async () => {
    const h = make();
    await h.ns.submit(input("draft me"));
    h.ns.noteSpawns(payload(rec({ state: "live", agentKey: "agent-3", firstPrompt: { state: "sending" } })));
    h.ns.noteSpawns(
      payload(rec({ state: "live", agentKey: "agent-3", firstPrompt: { state: "failed", code: "E_SESSION_CHANGED" } })),
    );
    expect(h.drafts).toEqual([{ agentKey: "agent-3", text: "draft me" }]);
    expect(h.flow()).toMatchObject({
      phase: "done",
      agentKey: "agent-3",
      firstPrompt: { state: "failed", code: "E_SESSION_CHANGED", refilled: "draft" },
    });
    expect(h.ns.stats().retainedTexts).toBe(0); // (g) Map emptied on refill
    // a repeated identical snapshot must not refill twice
    h.ns.noteSpawns(
      payload(rec({ state: "live", agentKey: "agent-3", firstPrompt: { state: "failed", code: "E_SESSION_CHANGED" } })),
    );
    expect(h.drafts).toHaveLength(1);
  });

  it("(f) double-click submit ⇒ exactly one wire request", async () => {
    const h = make();
    let resolveStart: ((o: SpawnOutcome) => void) | undefined;
    h.setStartImpl(
      () =>
        new Promise<SpawnOutcome>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const p1 = h.ns.submit(input());
    const p2 = h.ns.submit(input()); // ignored — a submit is in flight
    expect(await p2).toBe(false);
    expect(h.starts).toHaveLength(1);
    resolveStart!({ ok: true, data: { spawnId: "sp1", state: "starting", cwd: "/real/proj" } });
    expect(await p1).toBe(true);
    expect(h.starts).toHaveLength(1);
  });

  it("(g) cancel from confirming also empties the retention Map", async () => {
    const h = make();
    h.setStartImpl(async () => ({
      ok: false,
      error: "E_CONFIRM_REQUIRED",
      retryable: false,
      resolvedCwd: "/real/proj",
      reason: "unknown-dir",
    }));
    await h.ns.submit(input("held body"));
    expect(h.flow()).toMatchObject({ phase: "confirming", resolvedCwd: "/real/proj", reason: "unknown-dir" });
    expect(h.ns.stats().retainedTexts).toBe(1);
    h.ns.cancel();
    expect(h.flow().phase).toBe("idle");
    expect(h.ns.stats().retainedTexts).toBe(0);
  });

  it("confirm flow: confirming ⇒ confirm() resends the SAME id with confirm:true + expectCwd ⇒ 202 ⇒ awaiting", async () => {
    const h = make();
    let confirmSeen: SpawnRequestBody | undefined;
    h.setStartImpl(async (req) => {
      if (req.confirm === true) {
        confirmSeen = req;
        return { ok: true, data: { spawnId: "sp1", state: "starting", cwd: "/real/proj" } };
      }
      return { ok: false, error: "E_CONFIRM_REQUIRED", retryable: false, resolvedCwd: "/real/proj" };
    });
    await h.ns.submit(input("go"));
    await h.ns.confirm();
    expect(h.starts).toHaveLength(2);
    expect(confirmSeen).toMatchObject({ id: h.starts[0]!.id, confirm: true, expectCwd: "/real/proj" });
    expect(h.flow().phase).toBe("awaiting");
  });

  it("local watchdog (registerTimeoutS*1000 + 15s) ⇒ 状态未知, keeps listening; a late snapshot still settles", async () => {
    const h = make();
    await h.ns.submit(input("body"));
    expect(h.clock.pending()).toBe(1);
    h.clock.advance(30_000 + 15_000);
    expect(h.flow().phase).toBe("unknown");
    expect(h.clock.pending()).toBe(0); // the watchdog fired once, nothing re-armed

    // SSE reconnect snapshot arrives later — the flow still settles (继续监听).
    h.ns.noteSpawns(payload(rec({ state: "live", agentKey: "A", firstPrompt: { state: "delivered" } })));
    expect(h.flow()).toMatchObject({ phase: "done", agentKey: "A" });
  });

  it("record failed (no first prompt involved) ⇒ failed(kind spawn) with hint for SpawnRow's 详情", async () => {
    const h = make();
    await h.ns.submit(input("body"));
    h.ns.noteSpawns(payload(rec({ state: "failed", endReason: "register_timeout", hint: "register-timeout-session" })));
    expect(h.flow()).toMatchObject({
      phase: "failed",
      kind: "spawn",
      hint: "register-timeout-session",
      code: "register_timeout",
      refilled: "picker", // the first-prompt body goes back to the DirPicker (no agentKey)
    });
    expect(h.ns.stats().retainedTexts).toBe(0);
  });

  it("retry() after failure ⇒ resubmits the same input under a NEW id (§3.2 失败后重试)", async () => {
    const h = make();
    h.setStartImpl(async () => ({ ok: false, error: "E_DIR", message: "not a directory", retryable: false }));
    await h.ns.submit(input("body"));
    expect(h.flow()).toMatchObject({ phase: "failed", kind: "dir" });

    h.setStartImpl(async () => ({ ok: true, data: { spawnId: "sp2", state: "starting", cwd: "/real/proj" } }));
    const ok = await h.ns.retry();
    expect(ok).toBe(true);
    expect(h.starts).toHaveLength(2);
    expect(h.starts[1]!.id).not.toBe(h.starts[0]!.id); // 新的 id
    expect(h.starts[1]!.firstPrompt).toEqual(h.starts[0]!.firstPrompt); // same body though
    expect(h.flow()).toMatchObject({ phase: "awaiting", spawnId: "sp2" });
  });

  it("another tab's record (origin.reqId not mine) never navigates this tab", async () => {
    const h = make();
    await h.ns.submit(input());
    h.ns.noteSpawns(
      payload(rec({ state: "live", agentKey: "A", origin: { listener: "loopback", reqId: "someone-else" } })),
    );
    expect(h.navigations).toHaveLength(0);
    expect(h.flow().phase).toBe("done"); // still settles (no firstPrompt), just no hijack
  });

  it("dispose() clears the watchdog and the retention Map; late snapshots are inert", async () => {
    const h = make();
    await h.ns.submit(input("body"));
    expect(h.clock.pending()).toBe(1);
    h.ns.dispose();
    expect(h.clock.pending()).toBe(0);
    expect(h.ns.stats().retainedTexts).toBe(0);
    h.ns.noteSpawns(payload(rec({ state: "live", agentKey: "A", firstPrompt: { state: "delivered" } })));
    expect(h.flow().phase).toBe("awaiting"); // untouched
    expect(await h.ns.submit(input())).toBe(false); // disposed ⇒ never submits again
  });
});
