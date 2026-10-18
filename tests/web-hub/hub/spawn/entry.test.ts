import { describe, expect, it, vi } from "vitest";
import {
  createSpawnIdempotency,
  intentDigest,
  SPAWN_IDEMPOTENCY_MAX,
  SPAWN_IDEMPOTENCY_TTL_MS,
  startFresh,
  type FreshSpawnContext,
  type FreshSpawnIntent,
  type FreshSpawnOutcome,
} from "../../../../src/web-hub/hub/spawn/entry.js";
import { createCmdLimit } from "../../../../src/web-hub/hub/cmd-limit.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { FIRST_PROMPT_GRACE_MS } from "../../../../src/web-hub/protocol/spawn.js";
import { fakeDirs, fakeFirstPrompt, fakeSpawnPrefs, fakeSpawnSupervisor } from "../../http/spawn-kit.js";
import { fakeClock } from "../../http/lan-helpers.js";

const INTENT: FreshSpawnIntent = {
  id: "feishu-req-00000001",
  cwd: "/projects/a",
  confirmed: false,
  expectCwd: undefined,
  model: undefined,
  firstPrompt: undefined,
};
function harness() {
  const clock = fakeClock();
  const supervisor = fakeSpawnSupervisor();
  const dirs = fakeDirs();
  const firstPrompt = fakeFirstPrompt();
  const prefs = fakeSpawnPrefs();
  const principal = "feishu:installation-1:ou_sender";
  const audit = vi.fn<FreshSpawnContext["audit"]>();
  const rateReject = vi.fn();
  const ctx: FreshSpawnContext = {
    principal,
    owner: { listener: "lan", user: principal, reqId: INTENT.id },
    origin: { listener: "lan", ip: "feishu", user: principal, reqId: INTENT.id },
    policy: { scope: "known", confirm: "unknown-dir" },
    rate: { bucket: `${principal}:new`, capacity: 1, refillMs: 60_000, onReject: rateReject },
    limit: createCmdLimit(clock.now),
    idempotency: createSpawnIdempotency(clock.now),
    dirs,
    supervisor,
    firstPrompt,
    prefs,
    registerTimeoutS: 30,
    deadline: createReqDeadline(clock.now),
    now: clock.now,
    audit,
    reauthorize: vi.fn(async () => ({ ok: true })),
  };
  return { ctx, clock, supervisor, dirs, firstPrompt, prefs, audit, rateReject };
}

function accepted(outcome: FreshSpawnOutcome) {
  expect(outcome.kind).toBe("accepted");
  if (outcome.kind !== "accepted") throw new Error(`unexpected ${outcome.kind}`);
  return outcome;
}

describe("startFresh — non-HTTP caller", () => {
  it("uses exact Feishu dedup principal, own rate bucket and caller scope, not LAN policy", async () => {
    const h = harness();
    h.ctx.policy.scope = "roots";
    const admit = vi.spyOn(h.ctx.limit, "admit");
    const out = accepted(await startFresh(INTENT, h.ctx));
    expect(out.value).toEqual({
      spawnId: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      state: "starting",
      cwd: INTENT.cwd,
    });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith("feishu:installation-1:ou_sender:new", 1, 60_000);
    expect(h.dirs.admitCalls).toEqual([{ raw: INTENT.cwd, scope: "roots" }]);
    expect(h.supervisor.policyCalls).toEqual([]);
    expect(h.supervisor.startCalls[0]).toMatchObject({ owner: h.ctx.owner, admitted: { dev: 11, ino: 22 } });
    expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)?.spawnId).toBe(out.value.spawnId);
    expect(h.ctx.idempotency.get(`lan:${h.ctx.principal}|${INTENT.id}`)).toBeUndefined();
  });

  it("returns a bound realpath confirm; no LRU/start/prompt; changed expectCwd refuses again", async () => {
    const h = harness();
    h.ctx.rate.capacity = 4;
    h.dirs.setAdmitResult({ ok: true, realpath: "/canonical/a", dev: 1, ino: 2, known: false });
    expect(await startFresh(INTENT, h.ctx)).toEqual({
      kind: "confirm",
      resolvedCwd: "/canonical/a",
      reason: "unknown-dir",
    });
    expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)).toBeUndefined();
    expect(h.supervisor.startCalls).toEqual([]);
    expect(h.firstPrompt.accepts).toEqual([]);
    expect(h.ctx.reauthorize).not.toHaveBeenCalled();
    expect(await startFresh({ ...INTENT, confirmed: true, expectCwd: "/old/a" }, h.ctx)).toEqual({
      kind: "confirm",
      resolvedCwd: "/canonical/a",
      reason: "changed",
    });
    const out = accepted(await startFresh({ ...INTENT, confirmed: true, expectCwd: "/canonical/a" }, h.ctx));
    expect(out.value.cwd).toBe("/canonical/a");
    expect(h.supervisor.startCalls).toHaveLength(1);
  });

  it("duplicate/conflict/deleted-record refusals spend no rate token and never refork", async () => {
    const h = harness();
    const first = accepted(await startFresh(INTENT, h.ctx));
    h.prefs.setValue("provider/changed");
    const rate = vi.spyOn(h.ctx.limit, "admit");
    const rec = h.supervisor.recordsOut[0]!;
    rec.state = "live";
    rec.agentKey = "agent-123";
    rec.sessionId = "session-123";
    const dup = accepted(await startFresh({ ...INTENT, confirmed: true, expectCwd: INTENT.cwd }, h.ctx));
    expect(dup).toEqual({
      kind: "accepted",
      value: { ...first.value, state: "live", dup: true },
      agentKey: "agent-123",
      sessionId: "session-123",
    });
    expect(await startFresh({ ...INTENT, model: "provider/other" }, h.ctx)).toEqual({
      kind: "refused",
      code: "E_BAD_REQUEST",
      message: "id reused with different intent",
    });
    h.supervisor.recordsOut.splice(0);
    expect(await startFresh(INTENT, h.ctx)).toEqual({ kind: "refused", code: "E_BAD_REQUEST", reason: "spawn-gone" });
    expect(rate).not.toHaveBeenCalled();
    expect(h.supervisor.startCalls).toHaveLength(1);
    expect(h.dirs.admitCalls).toHaveLength(1);
  });

  it("separates sender/install principals, charges confirmation retries and returns original rate delay", async () => {
    const h = harness();
    h.dirs.setAdmitResult({ ok: true, realpath: INTENT.cwd, dev: 1, ino: 2, known: false });
    await startFresh(INTENT, h.ctx);
    expect(await startFresh(INTENT, h.ctx)).toEqual({ kind: "rate-limited", code: "E_RATE", retryAfterMs: 60_000 });
    expect(h.rateReject).toHaveBeenCalledTimes(1);
    for (const principal of ["feishu:installation-1:ou_other", "feishu:installation-2:ou_sender"]) {
      const ctx = { ...h.ctx, principal, rate: { ...h.ctx.rate, bucket: `${principal}:new` } };
      expect((await startFresh(INTENT, ctx)).kind).toBe("confirm");
    }
    expect(h.dirs.admitCalls).toHaveLength(3);
  });

  it("preserves the 2s admit cap / 3s reserve and fails before filesystem at zero budget", async () => {
    const h = harness();
    h.ctx.rate.capacity = 4;
    const admit = vi.spyOn(h.dirs, "admit");
    await startFresh(INTENT, { ...h.ctx, deadline: createReqDeadline(h.clock.now, 4_000) });
    expect(admit.mock.calls[0]?.[2].remaining()).toBe(1_000);
    expect(
      await startFresh(
        { ...INTENT, id: "request-000000002" },
        { ...h.ctx, deadline: createReqDeadline(h.clock.now, 3_000) },
      ),
    ).toEqual({ kind: "refused", code: "E_DEADLINE" });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("passes directory refusals without start or a cached intent", async () => {
    const h = harness();
    h.dirs.setAdmitResult({ ok: false, reason: "not-allowed" });
    expect(await startFresh(INTENT, h.ctx)).toEqual({ kind: "refused", code: "E_DIR", reason: "not-allowed" });
    expect(h.supervisor.startCalls).toEqual([]);
    expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)).toBeUndefined();
  });

  it("rechecks revoked authorization after admission; handled HTTP denial is not audited twice", async () => {
    const h = harness();
    h.ctx.rate.capacity = 2;
    h.ctx.reauthorize = async () => ({ ok: false, code: "E_AUTH" });
    expect(await startFresh(INTENT, h.ctx)).toEqual({ kind: "unauthorized", code: "E_AUTH" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ phase: "reject", code: "E_AUTH" }));
    h.audit.mockClear();
    h.ctx.reauthorize = async () => ({ ok: false, code: "E_RATE", handled: true });
    expect(await startFresh(INTENT, h.ctx)).toEqual({ kind: "unauthorized", code: "E_RATE", handled: true });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.supervisor.startCalls).toEqual([]);
    expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)).toBeUndefined();
  });

  it.each([
    { ok: false as const, code: "E_LIMIT" as const, limit: "principal" as const, active: 2, max: 2 },
    { ok: false as const, code: "E_LAUNCHER" as const, reason: "breaker", retryAfterS: 600 },
    { ok: false as const, code: "E_SPAWN_DENIED" as const, reason: "platform" },
    { ok: false as const, code: "E_DIR" as const, reason: "changed" },
    { ok: false as const, code: "E_DEADLINE" as const },
  ])("preserves supervisor refusal $code; no first-prompt handoff or dedup commit", async (failure) => {
    const h = harness();
    h.supervisor.setStartResult(failure);
    expect(await startFresh(INTENT, h.ctx)).toMatchObject({ kind: "refused", ...failure });
    expect(h.firstPrompt.accepts).toEqual([]);
    expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)).toBeUndefined();
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ code: failure.code }));
  });

  it.each([undefined, "", "provider/body"])(
    "model tri-state %s resolves at auth2, and prompt body stays memory-only",
    async (model) => {
      const h = harness();
      const secret = "private-中文";
      h.ctx.reauthorize = async () => {
        h.prefs.setValue("provider/new-pref");
        return { ok: true };
      };
      const accept = vi.spyOn(h.firstPrompt, "accept");
      const out = accepted(
        await startFresh({ ...INTENT, model, firstPrompt: { text: secret, deliver: "followUp" } }, h.ctx),
      );
      const effective = model ?? "provider/new-pref";
      expect(out.value.model).toBe(effective === "" ? undefined : effective);
      expect(h.supervisor.startCalls[0]?.model).toBe(out.value.model);
      expect(h.supervisor.startCalls[0]?.firstPrompt).toEqual({
        textLen: Buffer.byteLength(secret),
        deliver: "followUp",
      });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenCalledWith(
        out.value.spawnId,
        { text: secret, deliver: "followUp" },
        h.ctx.origin,
        h.clock.now() + 30_000 + FIRST_PROMPT_GRACE_MS,
      );
      expect(JSON.stringify(h.supervisor.startCalls)).not.toContain(secret);
      expect(JSON.stringify(h.audit.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
    },
  );

  it("sends synchronously before any microtask queued by start, after prompt/LRU/audit", async () => {
    const h = harness();
    const events: string[] = [];
    const start = h.supervisor.start;
    h.supervisor.start = (req, deadline) => {
      events.push("start");
      queueMicrotask(() => events.push("microtask"));
      return start(req, deadline);
    };
    h.ctx.onResult = (out) => {
      const result = accepted(out);
      expect(h.firstPrompt.accepts).toHaveLength(1);
      expect(h.ctx.idempotency.get(`${h.ctx.principal}|${INTENT.id}`)?.spawnId).toBe(result.value.spawnId);
      expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "request" }));
      events.push("response");
    };
    await startFresh({ ...INTENT, firstPrompt: { text: "hello", deliver: "followUp" } }, h.ctx);
    expect(events).toEqual(["start", "response", "microtask"]);
  });
});

describe("shared spawn idempotency (fresh + history)", () => {
  it("strict >10min expiry; peek does not renew TTL or insertion order; put refreshes", () => {
    const clock = fakeClock();
    const store = createSpawnIdempotency(clock.now);
    store.put("first", "s1", "d1");
    clock.advance(SPAWN_IDEMPOTENCY_TTL_MS);
    expect(store.get("first")?.spawnId).toBe("s1");
    clock.advance(1);
    expect(store.get("first")).toBeUndefined();
    for (let i = 0; i < SPAWN_IDEMPOTENCY_MAX; i++) store.put(`k${i}`, `s${i}`, `d${i}`);
    expect(store.get("k0")?.spawnId).toBe("s0");
    store.put("k1", "new", "updated");
    store.put("overflow", "extra", "digest");
    expect(store.get("k0")).toBeUndefined();
    expect(store.get("k1")).toMatchObject({ spawnId: "new", digest: "updated" });
    expect(store.get("k2")?.spawnId).toBe("s2");
  });

  it("confirmation fields never change digest; session/model/prompt intent does", () => {
    const base = { ...INTENT, session: undefined };
    expect(intentDigest(base)).toBe(intentDigest({ ...base, confirmed: true, expectCwd: "/other" }));
    for (const changed of [
      { ...base, model: "" },
      { ...base, session: { key: "key", id: "session", mode: "resume" as const } },
      { ...base, firstPrompt: { text: "hello", deliver: "followUp" as const } },
    ])
      expect(intentDigest(changed)).not.toBe(intentDigest(base));
  });
});
