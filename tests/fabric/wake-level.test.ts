import { describe, expect, it } from "vitest";
import type { FabricRecord, MessageKey } from "../../src/core/message.js";
import { createCausalLevel, readRootLevel, WAKE_LEVEL_CUSTOM_TYPE } from "../../src/fabric/wake-level.js";
import { createWakeInputHook } from "../../src/fabric/wake-input.js";

const A = "r_AAAAAAAA";
const B = "r_BBBBBBBB";

function make(opts: { maxLevel?: number; initialRoot?: number; runs?: Record<string, number> } = {}) {
  const runs: Record<string, number> = { ...opts.runs };
  const persisted: number[] = [];
  const level = createCausalLevel({
    maxLevel: opts.maxLevel ?? 2,
    initialRoot: opts.initialRoot ?? 0,
    runLevel: (id) => runs[id],
    raiseRun: (id, to) => {
      runs[id] = Math.max(runs[id] ?? 0, to);
    },
    persistRoot: (v) => persisted.push(v),
  });
  return { level, runs, persisted };
}
const rec = (patch: Partial<FabricRecord>): FabricRecord => ({
  key: `${A}:root:1:1` as MessageKey,
  from: A,
  to: "root",
  kind: "finding",
  seq: 1,
  generation: 1 as never,
  payload: { text: "x" },
  ttlMs: 1000,
  createdAt: 0,
  updatedAt: 0,
  state: "delivered",
  attempts: 1,
  ...patch,
});

describe("CausalLevel (plan §3.3)", () => {
  it("levelOf: run ⇒ its diag level (default 0), root ⇒ root, system ⇒ 0", () => {
    const { level } = make({ initialRoot: 1, runs: { [A]: 2 } });
    expect(level.levelOf(A)).toBe(2);
    expect(level.levelOf(B)).toBe(0);
    expect(level.levelOf("root")).toBe(1);
    expect(level.levelOf("system")).toBe(0);
  });

  it("L5 hopAllowed: L+1 ≤ maxLevel", () => {
    const { level } = make({ maxLevel: 2 });
    expect([0, 1, 2, 3].map((l) => level.hopAllowed(l))).toEqual([true, true, false, false]);
    expect(make({ maxLevel: 0 }).level.hopAllowed(0)).toBe(false);
  });

  describe("L3 onDelivered", () => {
    it("root context delivery with wake omitted (legacy turn) or wake:true counts a hop: raise(root, L+1)", () => {
      for (const wake of [undefined, true]) {
        const { level, persisted } = make();
        level.onDelivered(rec({ level: 1, ...(wake === undefined ? {} : { wake }) }), "context");
        expect(level.root).toBe(2);
        expect(persisted).toEqual([2]);
      }
    });
    it("root wake:false carries the level WITHOUT counting: raise(root, L)", () => {
      const { level, persisted } = make();
      level.onDelivered(rec({ level: 1, wake: false }), "context");
      expect(level.root).toBe(1);
      expect(persisted).toEqual([1]);
    });
    it("a root display-channel delivery never reaches the model ⇒ raises nothing", () => {
      const { level, persisted } = make({ initialRoot: 0 });
      level.onDelivered(rec({ level: 2, kind: "progress" }), "display");
      expect(level.root).toBe(0);
      expect(persisted).toEqual([]);
    });
    it("a steer into a run (any wake) raises it to L, never L+1", () => {
      const { level, runs } = make();
      level.onDelivered(rec({ level: 1, to: B, wake: true }), "context");
      expect(runs[B]).toBe(1);
      level.onDelivered(rec({ level: 0, to: B }), "context");
      expect(runs[B]).toBe(1); // monotonic
    });
    it("records without a stamped level (wake off / old records) are ignored", () => {
      const { level, runs, persisted } = make();
      level.onDelivered(rec({}), "context");
      level.onDelivered(rec({ to: B }), "context");
      expect(level.root).toBe(0);
      expect(runs[B]).toBeUndefined();
      expect(persisted).toEqual([]);
    });
    it("a wake_result-style system record carries its stamped level into the waker (seam C shape)", () => {
      const { level, runs } = make();
      level.onDelivered(
        rec({ from: "system", to: A, kind: "result", level: 2, route: { kind: "wake_result", runId: B } }),
        "context",
      );
      expect(runs[A]).toBe(2);
    });
  });

  describe("seam B onSteered", () => {
    it("omitted origin ⇒ raised to the ROOT's current level (autonomous root steer_subagent)", () => {
      const { level, runs } = make({ initialRoot: 1 });
      level.onSteered(A, undefined);
      expect(runs[A]).toBe(1);
    });
    it("human origin level 0 never raises", () => {
      const { level, runs } = make({ initialRoot: 2 });
      level.onSteered(A, 0);
      expect(runs[A] ?? 0).toBe(0);
    });
  });

  it("raise(root) is monotonic and persists only real changes", () => {
    const { level, persisted } = make();
    level.raise("root", 1);
    level.raise("root", 1);
    level.raise("root", 0);
    expect(persisted).toEqual([1]);
  });

  it("resetRoot zeroes the root (persisting 0) only when it was non-zero; runs are never reset", () => {
    const { level, persisted, runs } = make({ initialRoot: 2, runs: { [A]: 2 } });
    level.resetRoot();
    expect(level.root).toBe(0);
    level.resetRoot();
    expect(persisted).toEqual([0]);
    expect(runs[A]).toBe(2);
  });

  it("sanitizes non-finite/negative levels to 0", () => {
    const { level, runs } = make();
    level.raise(A, Number.NaN);
    level.raise(A, -3);
    expect(runs[A]).toBe(0);
  });

  it("a throwing persistence/run port never escapes", () => {
    const level = createCausalLevel({
      maxLevel: 2,
      initialRoot: 0,
      runLevel: () => undefined,
      raiseRun: () => {
        throw new Error("gone");
      },
      persistRoot: () => {
        throw new Error("disk");
      },
    });
    expect(() => level.raise("root", 1)).not.toThrow();
    expect(level.root).toBe(1);
    expect(() => level.raise(A, 1)).not.toThrow();
    expect(() => level.resetRoot()).not.toThrow();
  });
});

describe("readRootLevel (plan §3.3 L6)", () => {
  const e = (data: unknown, customType = WAKE_LEVEL_CUSTOM_TYPE) => ({ type: "custom", customType, data });
  it("takes the LAST valid entry on the branch (a later reset to 0 wins)", () => {
    expect(readRootLevel([e({ v: 1, level: 2 }), e({ v: 1, level: 0 })])).toBe(0);
    expect(readRootLevel([e({ v: 1, level: 1 }), { type: "message" }, e({ v: 1, level: 2 })])).toBe(2);
  });
  it("ignores other custom types and malformed/foreign-version entries; empty ⇒ 0", () => {
    expect(readRootLevel([])).toBe(0);
    expect(readRootLevel([e({ v: 1, level: 3 }, "other")])).toBe(0);
    expect(readRootLevel([e({ v: 2, level: 3 }), e({ v: 1, level: -1 }), e({ v: 1, level: "3" }), e(undefined)])).toBe(
      0,
    );
    expect(readRootLevel([e({ v: 1, level: 1 }), e({ v: 1, level: Number.NaN })])).toBe(1);
  });
});

describe("input hook: only PROVEN human input resets the root (plan §3.3 L7)", () => {
  function hookFor(web?: (text: string) => "web_prompt" | undefined, withLevel = true) {
    const { level, persisted } = make({ initialRoot: 2 });
    const hook = createWakeInputHook({
      level: () => (withLevel ? level : undefined),
      attributeInput: () => web,
    });
    return { hook, level, persisted };
  }
  it("terminal (interactive) and rpc input reset", () => {
    for (const source of ["interactive", "rpc"] as const) {
      const h = hookFor();
      expect(h.hook({ text: "hi", source })).toEqual({ action: "continue" });
      expect(h.level.root).toBe(0);
    }
  });
  it("extension input does NOT reset without a web attribution (topic-switch re-injection, goal loop, reload fire)", () => {
    const h = hookFor();
    for (const text of ["reinjected", "/goal continue", "/agent reload fire"])
      expect(h.hook({ text, source: "extension" })).toEqual({ action: "continue" });
    expect(h.level.root).toBe(2);
  });
  it("extension input resets iff the web ledger attributes THAT text to a web prompt", () => {
    const h = hookFor((t) => (t === "from the browser" ? "web_prompt" : undefined));
    h.hook({ text: "something else", source: "extension" });
    expect(h.level.root).toBe(2);
    h.hook({ text: "from the browser", source: "extension" });
    expect(h.level.root).toBe(0);
  });
  it("wake off (no level) ⇒ inert; a throwing port never breaks input", () => {
    const off = hookFor(undefined, false);
    expect(off.hook({ text: "hi", source: "interactive" })).toEqual({ action: "continue" });
    expect(off.level.root).toBe(2);
    const boom = createWakeInputHook({
      level: () => {
        throw new Error("x");
      },
      attributeInput: () => undefined,
    });
    expect(boom({ text: "hi", source: "interactive" })).toEqual({ action: "continue" });
  });
});
