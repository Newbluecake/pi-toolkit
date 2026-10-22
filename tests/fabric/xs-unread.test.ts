import { beforeEach, describe, expect, it, vi } from "vitest";
import * as U from "../../src/fabric/xs/unread.js";

const S = "sess-a";
beforeEach(() => U.resetUnreadForTests());

describe("xs-unread basics", () => {
  it("counts writes and dedups ids", () => {
    U.written(S, "a");
    U.written(S, "b");
    U.written(S, "a");
    expect(U.count(S)).toBe(2);
    expect(U.count("other")).toBe(0);
  });

  it("synthesizes distinct ids when none given", () => {
    U.written(S);
    U.written(S);
    expect(U.count(S)).toBe(2);
  });

  it("first turn clears messages written before turn_start", () => {
    U.written(S, "a");
    U.turnStart(S);
    expect(U.count(S)).toBe(1);
    U.turnEnd(S);
    expect(U.count(S)).toBe(0);
  });

  it("written during a turn survives that turn_end, cleared by next completed turn", () => {
    U.turnStart(S);
    U.written(S, "busy");
    U.turnEnd(S);
    expect(U.count(S)).toBe(1);
    U.turnStart(S);
    U.turnEnd(S);
    expect(U.count(S)).toBe(0);
  });

  it("turn_end without turnStart clears nothing", () => {
    U.written(S, "a");
    U.turnEnd(S);
    expect(U.count(S)).toBe(1);
  });

  it("agent_end fallback clears like turn_end and is idempotent", () => {
    U.written(S, "a");
    U.turnStart(S);
    U.written(S, "late");
    U.agentEnd(S);
    expect(U.count(S)).toBe(1);
    U.agentEnd(S);
    U.turnEnd(S);
    expect(U.count(S)).toBe(1);
  });

  it("no completed turn (run start failure) keeps the count", () => {
    U.written(S, "a");
    U.written(S, "b");
    expect(U.count(S)).toBe(2);
  });

  it("display caps at 99+", () => {
    expect(U.display(0)).toBe("0");
    expect(U.display(99)).toBe("99");
    expect(U.display(100)).toBe("99+");
    expect(U.display(5000)).toBe("99+");
  });
});

describe("overflow (cap 128)", () => {
  const fill = (n: number, p = "i") => {
    for (let i = 0; i < n; i++) U.written(S, `${p}${i}`);
  };

  it("caps ids at 128 while count keeps the spilled ones", () => {
    fill(130);
    expect(U.count(S)).toBe(130);
  });

  it("eviction with no active turn ⇒ pending: survives the next turn_end? no — promoted at turn_start, cleared at its end", () => {
    fill(130); // 2 spilled to pending
    U.turnStart(S);
    U.turnEnd(S);
    expect(U.count(S)).toBe(0);
  });

  it("no-active-turn eviction is NOT cleared by a turn_end lacking turn_start", () => {
    fill(130);
    U.turnEnd(S);
    expect(U.count(S)).toBe(130);
  });

  it("eviction of an old item during a turn ⇒ eligible, cleared by this turn's end", () => {
    fill(128);
    U.turnStart(S);
    U.written(S, "new1"); // evicts i0 (seq < turnStart)
    expect(U.count(S)).toBe(129);
    U.turnEnd(S);
    // i* all older than turnStart cleared, eligible cleared; new1 stays
    expect(U.count(S)).toBe(1);
  });

  it("eviction of an in-turn item ⇒ pending, survives this turn_end, cleared by the next", () => {
    U.turnStart(S);
    fill(130, "t"); // all written during the turn; 2 evicted ⇒ pending
    expect(U.count(S)).toBe(130);
    U.turnEnd(S);
    expect(U.count(S)).toBe(130); // none older than turnStart
    U.turnStart(S);
    U.turnEnd(S);
    expect(U.count(S)).toBe(0);
  });

  it("turn_start without paired turn_end, agent_end backstop clears eligible/old", () => {
    fill(129); // 1 pending
    U.turnStart(S); // promote ⇒ eligible 1
    U.agentEnd(S);
    expect(U.count(S)).toBe(0);
  });

  it("continuous overflow across turns never starves clearing", () => {
    for (let round = 0; round < 5; round++) {
      fill(150, `r${round}-`);
      U.turnStart(S);
      U.turnEnd(S);
    }
    expect(U.count(S)).toBe(0);
  });
});

describe("sessions", () => {
  it("restores count after switching away and back; forks start at 0", () => {
    U.written("a", "x");
    U.written("b", "y");
    U.turnStart("b");
    U.turnEnd("b");
    expect(U.count("a")).toBe(1);
    expect(U.count("a-fork")).toBe(0);
  });

  it("32-session FIFO evicts the least recently touched", () => {
    for (let i = 0; i < 32; i++) U.written(`s${i}`, "x");
    U.written("s0", "y"); // touch s0 ⇒ s1 is stalest
    U.written("s32", "x");
    expect(U.count("s1")).toBe(0);
    expect(U.count("s0")).toBe(2);
    expect(U.count("s32")).toBe(1);
    expect(U.count("s2")).toBe(1);
  });

  it("forget drops a bucket", () => {
    U.written(S, "a");
    U.forget(S);
    expect(U.count(S)).toBe(0);
  });

  it("createUnreadTap writes via the live session id and swallows errors", () => {
    let sid: string | undefined = "t1";
    const tap = U.createUnreadTap(() => sid);
    tap.written("a");
    sid = undefined;
    tap.written("b");
    expect(U.count("t1")).toBe(1);
    const bad = U.createUnreadTap(() => {
      throw new Error("x");
    });
    expect(() => bad.written("z")).not.toThrow();
  });

  it("is shared across module instances (/reload) via the Symbol.for global", async () => {
    U.written(S, "a");
    vi.resetModules();
    const U2 = await import("../../src/fabric/xs/unread.js");
    expect(U2).not.toBe(U);
    expect(U2.count(S)).toBe(1);
    U2.written(S, "b");
    expect(U.count(S)).toBe(2);
    expect(U.XS_UNREAD_KEY).toBe(Symbol.for("pi-subagent:xs-unread"));
  });
});

describe("property: random event sequences", () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("bounded, per-session isolated, and any entry is cleared once a later-started turn completes", () => {
    for (let seed = 1; seed <= 60; seed++) {
      U.resetUnreadForTests();
      const r = rng(seed);
      const sessions = ["p", "q", "r"];
      // model: per session list of (writeIndex) and turn tracking
      type M = { n: number; started?: number; live: Set<number>; ids: Set<string> };
      const m: Record<string, M> = {};
      for (const s of sessions) m[s] = { n: 0, live: new Set(), ids: new Set() };
      let clock = 0;
      const writeAt = new Map<string, number>(); // `${s}:${id}` → clock
      let uid = 0;
      for (let step = 0; step < 600; step++) {
        const s = sessions[Math.floor(r() * sessions.length)]!;
        const mm = m[s]!;
        const op = r();
        if (op < 0.5) {
          const id = `${s}-${uid++}`;
          U.written(s, id);
          writeAt.set(id, ++clock);
          mm.live.add(clock);
        } else if (op < 0.65) {
          U.turnStart(s);
          mm.started = ++clock;
        } else if (op < 0.85) {
          U.turnEnd(s);
          if (mm.started !== undefined) {
            for (const t of [...mm.live]) if (t < mm.started) mm.live.delete(t);
            mm.started = undefined;
          }
        } else if (op < 0.95) {
          U.agentEnd(s);
          if (mm.started !== undefined) {
            for (const t of [...mm.live]) if (t < mm.started) mm.live.delete(t);
            mm.started = undefined;
          }
        }
        for (const x of sessions) {
          const c = U.count(x);
          expect(c).toBeGreaterThanOrEqual(0);
          // liveness+no-extra: count never exceeds model's live entries (spilled ones are still model-live)
          expect(c).toBeLessThanOrEqual(m[x]!.live.size);
        }
      }
      // after a full turn on every session everything started before it is gone
      for (const s of sessions) {
        U.turnStart(s);
        U.turnEnd(s);
        expect(U.count(s)).toBe(0);
      }
    }
  });
});
