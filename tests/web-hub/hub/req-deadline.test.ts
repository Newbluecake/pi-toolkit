import { describe, expect, it, vi } from "vitest";
import {
  createReqDeadline,
  deadlineRace,
  deriveBudget,
  raceDeadline,
  WRITE_TOTAL_MS,
} from "../../../src/web-hub/hub/req-deadline.js";

describe("createReqDeadline / remaining() / expired()", () => {
  it("remaining() counts down and clamps at 0; expired() flips once the deadline passes", () => {
    let t = 1_000;
    const now = () => t;
    const d = createReqDeadline(now, 1_000);
    expect(d.remaining()).toBe(1_000);
    expect(d.expired()).toBe(false);
    t += 400;
    expect(d.remaining()).toBe(600);
    t += 700;
    expect(d.remaining()).toBe(0); // clamped, never negative
    expect(d.expired()).toBe(true);
  });

  it("defaults to WRITE_TOTAL_MS when no totalMs is given", () => {
    const d = createReqDeadline(() => 0);
    expect(d.remaining()).toBe(WRITE_TOTAL_MS);
  });

  it("negative totalMs clamps to 0 remaining immediately", () => {
    const d = createReqDeadline(() => 0, -500);
    expect(d.remaining()).toBe(0);
    expect(d.expired()).toBe(true);
  });
});

describe("raceDeadline", () => {
  it("resolves with the promise's value when it settles first", async () => {
    await expect(raceDeadline(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });

  it("rejects once ms elapses if the promise never settles", async () => {
    await expect(raceDeadline(new Promise(() => {}), 10)).rejects.toThrow("E_DEADLINE");
  });
});

describe("deriveBudget", () => {
  it("is max(0, min(cap, remaining - reserve))", () => {
    expect(deriveBudget(10_000, 4_000, 5_000)).toBe(4_000); // capped
    expect(deriveBudget(6_000, 4_000, 5_000)).toBe(1_000); // remaining-reserve wins
    expect(deriveBudget(1_000, 4_000, 5_000)).toBe(0); // negative clamps to 0
    expect(deriveBudget(0, 4_000, 5_000)).toBe(0);
  });
});

/** Verbatim copy of the three pre-D3 private implementations' shared body (the baseline). */
function baselineRace<T>(p: Promise<T>, ms: number, mk: () => unknown, map?: (e: unknown) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(mk()), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(map ? map(e) : e);
      },
    );
  });
}

type Race = typeof baselineRace;
type Case = "resolve" | "reject" | "timeout";

async function trace(race: Race, kind: Case): Promise<string[]> {
  const ev: string[] = [];
  vi.useFakeTimers();
  try {
    let res!: (v: number) => void;
    let rej!: (e: unknown) => void;
    const p = new Promise<number>((a, b) => {
      res = a;
      rej = b;
    });
    const r = race(p, 5, () => new Error("t"));
    r.then(
      () => ev.push("resolved"),
      () => ev.push("rejected"),
    );
    queueMicrotask(() => {
      ev.push("q1");
      // Deterministic timeout: fire the (fake) timer inside q1, THEN enqueue q2. The relative
      // order of "rejected" vs q2 exposes how many microtask hops the timeout rejection takes.
      if (kind === "timeout") vi.advanceTimersByTime(5);
      queueMicrotask(() => ev.push("q2"));
    });
    if (kind === "resolve") res(1);
    if (kind === "reject") rej(new Error("x"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return ev;
  } finally {
    vi.useRealTimers();
  }
}

describe("deadlineRace", () => {
  // Sequences recorded on the baseline (pre-D3) implementation.
  const recorded: Record<Case, string[]> = {
    resolve: ["q1", "q2", "resolved"],
    reject: ["q1", "q2", "rejected"],
    // Timeout rejects `r` directly (no extra hop), so it lands BEFORE q2. A Promise.race-based
    // implementation adds a hop and yields ["q1","q2","rejected"] instead.
    timeout: ["q1", "rejected", "q2"],
  };
  for (const kind of ["resolve", "reject", "timeout"] as const) {
    it(`microtask interleaving matches the baseline (${kind})`, async () => {
      expect(await trace(baselineRace, kind)).toEqual(recorded[kind]);
      expect(await trace(deadlineRace, kind)).toEqual(recorded[kind]);
    });
  }

  it("onTimeout's return value becomes the rejection reason verbatim", async () => {
    vi.useFakeTimers();
    try {
      const reason = { code: "E_X" };
      const r = deadlineRace(new Promise<number>(() => undefined), 10, () => reason);
      const caught = r.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(await caught).toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mapReject maps p's rejection; without it the reason passes through", async () => {
    const boom = "not-an-error";
    await expect(deadlineRace(Promise.reject(boom), 50, () => new Error("t"))).rejects.toBe(boom);
    const mapped = new Error("mapped");
    const seen: unknown[] = [];
    await expect(
      deadlineRace(
        Promise.reject(boom),
        50,
        () => new Error("t"),
        (e) => {
          seen.push(e);
          return mapped;
        },
      ),
    ).rejects.toBe(mapped);
    expect(seen).toEqual([boom]);
  });

  it("clears the timer when p settles first, and the timer is unref'd", async () => {
    vi.useFakeTimers();
    try {
      expect(vi.getTimerCount()).toBe(0);
      const ok = deadlineRace(Promise.resolve(1), 1000, () => new Error("t"));
      expect(vi.getTimerCount()).toBe(1);
      await ok;
      expect(vi.getTimerCount()).toBe(0);
      const bad = deadlineRace(Promise.reject(new Error("x")), 1000, () => new Error("t"));
      await bad.catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);

      const spy = vi.spyOn(globalThis, "setTimeout");
      const pending = deadlineRace(new Promise<number>(() => undefined), 1000, () => new Error("t"));
      pending.catch(() => undefined);
      const handle = spy.mock.results[0]?.value as { hasRef(): boolean };
      expect(handle.hasRef()).toBe(false);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lifecycle.withDeadline (wrapped deadlineRace)", () => {
  it("timeout message carries the millisecond budget; non-Error rejections are wrapped", async () => {
    const { withDeadline } = await import("../../../src/web-hub/hub/lifecycle.js");
    await expect(withDeadline(new Promise<number>(() => undefined), 5)).rejects.toThrow("E_DEADLINE: exceeded 5ms");
    const wrapped = await withDeadline(Promise.reject("plain"), 50).catch((e: unknown) => e);
    expect(wrapped).toBeInstanceOf(Error);
    expect((wrapped as Error).message).toBe("plain");
    const orig = new Error("orig");
    expect(await withDeadline(Promise.reject(orig), 50).catch((e: unknown) => e)).toBe(orig);
  });
});
