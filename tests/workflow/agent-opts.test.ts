import { describe, expect, it, vi } from "vitest";
import {
  AGENT_OPTS_HINTS,
  AGENT_OPTS_KEYS,
  snapshotAgentOpts,
  validateAgentOpts,
  type OptsSnapshot,
} from "../../src/workflow/agent-opts.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.1, §6 test list
 * A#1-9): pure unit coverage for the host-side structural snapshot +
 * validation layer, independent of host.ts's wiring. The worker-side JS
 * mirror (worker-source.ts) gets its own real-`vm` coverage in
 * worker-host-call.test.ts (accessors/Proxies/functions can only be
 * constructed meaningfully inside a real sandbox realm there — see that
 * file's module doc).
 */

describe("snapshotAgentOpts: shape classification (D2-D6)", () => {
  it("undefined/null opts are treated as empty (no defect, no unknown keys)", () => {
    expect(snapshotAgentOpts(undefined)).toEqual({ values: {}, unknownKeys: [] });
    expect(snapshotAgentOpts(null)).toEqual({ values: {}, unknownKeys: [] });
  });

  it("false / 0 / '' are rejected as not_plain_object (D4) — no longer silently treated as {}", () => {
    expect(snapshotAgentOpts(false).defect).toEqual({ code: "not_plain_object", detail: "boolean" });
    expect(snapshotAgentOpts(0).defect).toEqual({ code: "not_plain_object", detail: "number" });
    expect(snapshotAgentOpts("").defect).toEqual({ code: "not_plain_object", detail: "string" });
  });

  it("a function or an array as the whole opts value is not_plain_object", () => {
    expect(snapshotAgentOpts(() => {}).defect?.code).toBe("not_plain_object");
    expect(snapshotAgentOpts(["a"]).defect?.code).toBe("not_plain_object");
  });

  it("Object.create(null) is accepted (no prototype)", () => {
    const o = Object.create(null);
    o.label = "x";
    expect(snapshotAgentOpts(o)).toEqual({ values: { label: "x" }, unknownKeys: [] });
  });

  it("a custom prototype (class instance, Map, boxed String) is not_plain_object", () => {
    class Foo {
      label = "x";
    }
    expect(snapshotAgentOpts(new Foo()).defect?.code).toBe("not_plain_object");
    expect(snapshotAgentOpts(new Map([["label", "x"]])).defect?.code).toBe("not_plain_object");
    // eslint-disable-next-line no-new-wrappers
    expect(snapshotAgentOpts(new String("x")).defect?.code).toBe("not_plain_object");
  });

  it("a Proxy (empty target, or one whose traps throw, or a revoked proxy) is 'proxy' — traps never fire", () => {
    let trapCalls = 0;
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          trapCalls += 1;
          throw new Error("must not be reached");
        },
      },
    );
    expect(snapshotAgentOpts(new Proxy({}, {})).defect).toEqual({ code: "proxy" });
    expect(snapshotAgentOpts(throwing).defect).toEqual({ code: "proxy" });
    expect(trapCalls).toBe(0);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(snapshotAgentOpts(proxy).defect?.code).toBe("proxy");
  });

  it("an accessor on a known key is rejected without ever invoking the getter", () => {
    let getterCalls = 0;
    const opts: Record<string, unknown> = {};
    Object.defineProperty(opts, "label", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "sneaky";
      },
    });
    const snap = snapshotAgentOpts(opts);
    expect(snap.defect).toEqual({ code: "accessor", key: "label" });
    expect(getterCalls).toBe(0);
  });

  it("an accessor on an unknown key is just reported as unknown (its getter is still never invoked)", () => {
    let getterCalls = 0;
    const opts: Record<string, unknown> = {};
    Object.defineProperty(opts, "effort", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "low";
      },
    });
    const snap = snapshotAgentOpts(opts);
    expect(snap.defect).toBeUndefined();
    expect(snap.unknownKeys).toEqual(["effort"]);
    expect(getterCalls).toBe(0);
  });

  it("unknown keys are reported even with an undefined value, a Symbol key, or a non-enumerable key", () => {
    const sym = Symbol("mystery");
    const opts: Record<PropertyKey, unknown> = { effort: undefined, subagent_type: "explorer" };
    (opts as Record<PropertyKey, unknown>)[sym] = "x";
    Object.defineProperty(opts, "hidden", { value: "x", enumerable: false, configurable: true });
    const snap = snapshotAgentOpts(opts);
    expect(snap.defect).toBeUndefined();
    expect(snap.unknownKeys.sort()).toEqual(["Symbol(mystery)", "effort", "hidden", "subagent_type"].sort());
  });

  it("a known key explicitly set to undefined counts as not passed at all (no error, not in values)", () => {
    const snap = snapshotAgentOpts({ model: undefined, label: "x" });
    expect(snap.defect).toBeUndefined();
    expect(snap.unknownKeys).toEqual([]);
    expect(snap.values).toEqual({ label: "x" });
  });

  it("a function or symbol VALUE on a known key is a defect, never placed into values (N1)", () => {
    const snap1 = snapshotAgentOpts({ label: () => {} });
    expect(snap1.defect).toEqual({ code: "not_plain_object", key: "label" });
    expect(snap1.values).toEqual({});
    const snap2 = snapshotAgentOpts({ agentType: Symbol("x") });
    expect(snap2.defect?.code).toBe("not_plain_object");
    const snap3 = snapshotAgentOpts({ model: new Proxy({}, {}) });
    expect(snap3.defect).toEqual({ code: "proxy", key: "model" });
  });

  it("wrong-typed-but-clonable known-key values pass through into `values` verbatim (checked later, not a defect)", () => {
    const snap = snapshotAgentOpts({ agentType: 123, label: {}, fullResult: "yes", isolation: "x" });
    expect(snap.defect).toBeUndefined();
    expect(snap.values).toEqual({ agentType: 123, label: {}, fullResult: "yes", isolation: "x" });
  });
});

describe("removed experts option", () => {
  it("has exactly seven allowed keys", () => {
    expect(AGENT_OPTS_KEYS).toEqual(["label", "agentType", "phase", "fullResult", "model", "thinking", "isolation"]);
  });

  it.each([undefined, [], ["main"], "dev", [() => {}], new Proxy([], {})])(
    "rejects experts regardless of value (%s)",
    (experts) => {
      const snap = snapshotAgentOpts({ experts });
      expect(snap).toEqual({ values: {}, unknownKeys: ["experts"] });
      const result = validateAgentOpts(snap);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.message).toContain("opts.experts is no longer supported");
      expect(result.message).toContain("message_agent");
      expect(result.message).toContain("allowed: " + AGENT_OPTS_KEYS.join(", "));
    },
  );

  it("does not inspect a removed experts accessor", () => {
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    const opts = Object.defineProperty({}, "experts", { get: getter });
    expect(validateAgentOpts(snapshotAgentOpts(opts)).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("honors a worker report for experts even when the snapshot dropped its value", () => {
    const result = validateAgentOpts({ values: {}, unknownKeys: [] }, { unknownKeys: ["experts"] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("opts.experts is no longer supported");
  });
});

describe("validateAgentOpts: unknown keys (D5/D7)", () => {
  const empty: OptsSnapshot = { values: {}, unknownKeys: [] };

  it("lists every misspelled key with its hint, and the full allowed-key set", () => {
    const r = validateAgentOpts({ ...empty, unknownKeys: ["effort", "subagent_type"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    for (const k of AGENT_OPTS_KEYS) expect(r.message).toContain(k);
    expect(r.message).toContain('"effort"');
    expect(r.message).toContain('"subagent_type"');
    expect(r.message).toContain(AGENT_OPTS_HINTS.effort);
    expect(r.message).toContain("use agentType");
  });

  it("covers every documented mistaken-key hint (timeout_ms/timeout_s/schema/resume/run_in_background/expert/full_result/description/name)", () => {
    const keys = [
      "timeout_ms",
      "timeout_s",
      "schema",
      "resume",
      "run_in_background",
      "expert",
      "full_result",
      "description",
      "name",
    ];
    for (const k of keys) {
      const r = validateAgentOpts({ ...empty, unknownKeys: [k] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected failure");
      expect(r.message).toContain(`"${k}"`);
    }
  });

  it("a case-different spelling of a real key gets a 'did you mean' suggestion", () => {
    const r = validateAgentOpts({ ...empty, unknownKeys: ["AgentType"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("did you mean agentType");
  });

  it("unknownKeys is the union of host and worker reports", () => {
    const r = validateAgentOpts({ ...empty, unknownKeys: ["a"] }, { unknownKeys: ["b"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain('"a"');
    expect(r.message).toContain('"b"');
  });

  it("a defect (from either side) wins outright over any unknownKeys reporting", () => {
    const r = validateAgentOpts({ values: {}, unknownKeys: ["a"], defect: { code: "proxy" } }, { unknownKeys: ["b"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.message).not.toContain('"a"');
    expect(r.message).not.toContain('"b"');
  });

  it("the worker's own defect is honored even when the host's independent re-snapshot sees nothing wrong", () => {
    const r = validateAgentOpts({ values: {}, unknownKeys: [] }, { defect: { code: "accessor", key: "label" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.message).toContain("label");
    expect(r.message).toContain("accessors are not allowed");
  });
});

describe("validateAgentOpts: known-key type errors (D6) — model/thinking wording is byte-identical to pre-existing host.ts checks", () => {
  const wrap = (values: OptsSnapshot["values"]): OptsSnapshot => ({ values, unknownKeys: [] });

  it("opts.model must be a string (exact pre-existing wording)", () => {
    const r = validateAgentOpts(wrap({ model: true }));
    expect(r).toEqual({ ok: false, message: "agent(prompt, opts?): opts.model must be a string" });
  });

  it("opts.thinking must be one of the four levels (exact pre-existing wording)", () => {
    const r = validateAgentOpts(wrap({ thinking: "max" as never }));
    expect(r).toEqual({
      ok: false,
      message: "agent(prompt, opts?): opts.thinking must be one of 'off' | 'low' | 'medium' | 'high'",
    });
  });

  it("opts.label / opts.agentType / opts.phase must be strings; opts.fullResult must be a boolean", () => {
    expect(validateAgentOpts(wrap({ label: 1 })).ok).toBe(false);
    expect(validateAgentOpts(wrap({ agentType: {} as never })).ok).toBe(false);
    expect(validateAgentOpts(wrap({ phase: false })).ok).toBe(false);
    expect(validateAgentOpts(wrap({ fullResult: "yes" })).ok).toBe(false);
  });

  it('opts.isolation must be exactly "worktree"', () => {
    const bad = validateAgentOpts(wrap({ isolation: "x" as never }));
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expect(bad.message).toContain('must be "worktree"');
    const good = validateAgentOpts(wrap({ isolation: "worktree" }));
    expect(good).toEqual({ ok: true, opts: { isolation: "worktree" } });
  });
});

describe("validateAgentOpts: the full valid set round-trips (D8, all keys including phase from the worker merge)", () => {
  it("every allowed key together produces a matching ValidatedAgentOpts", () => {
    const r = validateAgentOpts({
      values: {
        label: "L",
        agentType: "explorer",
        phase: "p1",
        fullResult: true,
        model: "cr-anthropic/claude-sonnet-5",
        thinking: "high",
        isolation: "worktree",
      },
      unknownKeys: [],
    });
    expect(r).toEqual({
      ok: true,
      opts: {
        label: "L",
        agentType: "explorer",
        phase: "p1",
        fullResult: true,
        model: "cr-anthropic/claude-sonnet-5",
        thinking: "high",
        isolation: "worktree",
      },
    });
  });
});

describe("D3: accessor detection never invokes getters even when the value is spied on", () => {
  it("a getter spy is called zero times across a full validate pass", () => {
    const getter = vi.fn(() => "sneaky");
    const opts: Record<string, unknown> = {};
    Object.defineProperty(opts, "model", { enumerable: true, configurable: true, get: getter });
    const snap = snapshotAgentOpts(opts);
    validateAgentOpts(snap);
    expect(getter).not.toHaveBeenCalled();
  });
});
