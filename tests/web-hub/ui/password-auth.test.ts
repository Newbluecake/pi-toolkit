import { describe, expect, it } from "vitest";
import { usePasswordAuth } from "../../../src/web-hub/ui/src/composables/usePasswordAuth.js";
import type { LoginResult } from "../../../src/web-hub/ui/src/transport/types.js";

/** Deterministic fake timer queue (see render-gate.test.ts for the same shape). */
function fakeClock() {
  let now = 0;
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

class NoopEventSource {
  readyState = 0;
  addEventListener(): void {}
  close(): void {}
}

/** Fakes `@logic/password-client.js`'s wire responses closely enough to drive `usePasswordAuth`
 * without a real HTTP server — the transport layer itself (`transport/password.ts`, i.e. the
 * exact 78dd76b regression surface) stays covered by `transport-contract.test.ts` /
 * `hub-http-integration.test.ts`; this file only exercises `usePasswordAuth`'s own state
 * machine (busy/error/countdown/hint mapping). */
function fakeFetch(result: LoginResult) {
  return async (
    url: string,
  ): Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }> => {
    if (url !== "/api/login") {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    if (result.ok) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ initialPassword: result.initialPassword }),
      };
    }
    switch (result.kind) {
      case "invalid":
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: "E_AUTH" }) };
      case "not-allowed":
        return { ok: false, status: 421, headers: { get: () => null }, json: async () => ({}) };
      case "network":
        throw new Error("network down");
      case "busy-exhausted":
        return { ok: false, status: 503, headers: { get: () => "0" }, json: async () => ({ error: "E_DB" }) };
      case "saturated":
        return {
          ok: false,
          status: 429,
          headers: { get: (n) => (n === "Retry-After" ? String(result.retryAfterS) : null) },
          json: async () => ({ error: "E_RATE", saturated: true }),
        };
      case "throttled":
        return {
          ok: false,
          status: 429,
          headers: { get: (n) => (n === "Retry-After" ? String(result.retryAfterS) : null) },
          json: async () => ({}),
        };
      default:
        return { ok: false, status: 418, headers: { get: () => null }, json: async () => ({}) };
    }
  };
}

function makeAuth(fetchImpl: ReturnType<typeof fakeFetch>, clock = fakeClock()) {
  const auth = usePasswordAuth({
    deps: {
      fetch: fetchImpl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      EventSource: NoopEventSource as any,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  auth.createTransport({ onMessage: () => {}, onConn: () => {} });
  return { auth, clock };
}

describe("usePasswordAuth (vue-plan.md v2.1 §3.8, §3.9, §5.2 — P1)", () => {
  it("success: busy toggles, error clears, initialPasswordHint set from the response", async () => {
    const { auth } = makeAuth(fakeFetch({ ok: true, initialPassword: true }));
    const p = auth.submit({ username: "alice", password: "s3cret" });
    expect(auth.busy.value).toBe(true);
    await p;
    expect(auth.busy.value).toBe(false);
    expect(auth.error.value).toBeNull();
    expect(auth.initialPasswordHint.value).toBe(true);
  });

  it("invalid: errors.invalid, busy cleared", async () => {
    const { auth } = makeAuth(fakeFetch({ ok: false, kind: "invalid" }));
    await auth.submit({ username: "alice", password: "wrong" });
    expect(auth.busy.value).toBe(false);
    expect(auth.error.value).toEqual({ key: "errors.invalid" });
  });

  it("not-allowed: errors.notAllowed", async () => {
    const { auth } = makeAuth(fakeFetch({ ok: false, kind: "not-allowed" }));
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.error.value).toEqual({ key: "errors.notAllowed" });
  });

  it("network error: errors.network", async () => {
    const { auth } = makeAuth(fakeFetch({ ok: false, kind: "network" }));
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.error.value).toEqual({ key: "errors.network" });
  });

  it("saturated: errors.saturated, no retry", async () => {
    const { auth } = makeAuth(fakeFetch({ ok: false, kind: "saturated", retryAfterS: 60 }));
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.busy.value).toBe(false);
    expect(auth.error.value).toEqual({ key: "errors.saturated" });
  });

  it("throttled: countdown ticks every second via errors.throttled, then clears and re-enables the form", async () => {
    const { auth, clock } = makeAuth(fakeFetch({ ok: false, kind: "throttled", retryAfterS: 3 }));
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.busy.value).toBe(true); // stays busy until the countdown clears it
    expect(auth.error.value).toEqual({ key: "errors.throttled", countdownS: 3 });
    clock.advance(1_000);
    expect(auth.error.value).toEqual({ key: "errors.throttled", countdownS: 2 });
    clock.advance(1_000);
    expect(auth.error.value).toEqual({ key: "errors.throttled", countdownS: 1 });
    clock.advance(1_000);
    expect(auth.error.value).toBeNull();
    expect(auth.busy.value).toBe(false);
  });

  it("a second submit() cancels any running countdown from a previous attempt", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async (url: string) => {
      if (url !== "/api/login") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
      n++;
      if (n === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h === "Retry-After" ? "5" : null) },
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ initialPassword: false }) };
    };
    const { auth } = makeAuth(fetchImpl, clock);
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.error.value).toEqual({ key: "errors.throttled", countdownS: 5 });
    expect(clock.pending()).toBeGreaterThan(0);
    await auth.submit({ username: "alice", password: "x" });
    expect(auth.error.value).toBeNull();
    expect(auth.busy.value).toBe(false);
    // the stale countdown timer must not resurrect the old error later
    clock.advance(10_000);
    expect(auth.error.value).toBeNull();
  });

  it("dispose(): stops a pending countdown", async () => {
    const { auth, clock } = makeAuth(fakeFetch({ ok: false, kind: "throttled", retryAfterS: 5 }));
    await auth.submit({ username: "alice", password: "x" });
    expect(clock.pending()).toBeGreaterThan(0);
    auth.dispose();
    expect(clock.pending()).toBe(0);
  });

  it("createTransport() returns a real PasswordTransport whose extra auth hooks are wired", () => {
    const clock = fakeClock();
    const auth = usePasswordAuth({
      deps: {
        fetch: fakeFetch({ ok: true, initialPassword: false }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        EventSource: NoopEventSource as any,
        location: { hash: "", pathname: "/", search: "" },
        history: { replaceState: () => {} },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        now: clock.now,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const transport = auth.createTransport({ onMessage: () => {}, onConn: () => {} });
    expect(transport.mode).toBe("password");
    expect(typeof transport.login).toBe("function");
    expect(typeof transport.logout).toBe("function");
    expect(typeof transport.subscribe).toBe("function");
    expect(typeof transport.unsubscribe).toBe("function");
    expect(typeof transport.page).toBe("function");
  });
});
