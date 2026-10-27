/**
 * #72 AF7 (§5.5): the `/new` alias handoff slot — a one-element, consume-once, TTL-bound process global (I4),
 * the twin of #70's membership slot. The assembly (shutdown stash / session_start adopt / fork never) is pinned by
 * `tests/integration/fabric-xs-alias-wiring.test.ts`; this file pins the slot's own contract.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  stashXsAliasHandoff,
  takeXsAliasHandoff,
  XS_ALIAS_HANDOFF_KEY,
  XS_ALIAS_HANDOFF_PENDING_MS,
  XS_ALIAS_HANDOFF_SLOT_TTL_MS,
} from "../../src/fabric/xs/alias-handoff.js";

const g = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete g[XS_ALIAS_HANDOFF_KEY];
});

describe("xs alias handoff slot", () => {
  it("is a Symbol.for global with the documented old-name key (I4 / I7)", () => {
    expect(XS_ALIAS_HANDOFF_KEY).toBe(Symbol.for("pi-subagent:xs-alias-handoff"));
    expect(XS_ALIAS_HANDOFF_PENDING_MS).toBeGreaterThanOrEqual(120_000); // ≥ the hub's succession-edge TTL
  });

  it("round-trips one shot and is consume-once", () => {
    stashXsAliasHandoff({ fromSessionId: "s1", alias: "front", decided: true, at: 1_000 });
    expect(takeXsAliasHandoff(2_000)).toEqual({ fromSessionId: "s1", alias: "front", decided: true, at: 1_000 });
    expect(takeXsAliasHandoff(2_000)).toBeUndefined();
    expect(g[XS_ALIAS_HANDOFF_KEY]).toBeUndefined();
  });

  it("nothing to carry (no alias, not decided) ⇒ nothing is written (pristine sessions stash nothing)", () => {
    stashXsAliasHandoff({ fromSessionId: "s1", decided: false, at: 1_000 });
    expect(g[XS_ALIAS_HANDOFF_KEY]).toBeUndefined();
    stashXsAliasHandoff({ fromSessionId: "s1", decided: true, at: 1_000 });
    expect(takeXsAliasHandoff(1_001)).toMatchObject({ decided: true });
  });

  it("capacity 1: a newer stash replaces the older one", () => {
    stashXsAliasHandoff({ fromSessionId: "s1", alias: "a", decided: false, at: 1_000 });
    stashXsAliasHandoff({ fromSessionId: "s2", alias: "b", decided: false, at: 1_100 });
    expect(takeXsAliasHandoff(1_200)?.fromSessionId).toBe("s2");
  });

  it("older than the TTL (or future-dated) is treated as absent — and still cleared", () => {
    stashXsAliasHandoff({ fromSessionId: "s1", alias: "a", decided: false, at: 1_000 });
    expect(takeXsAliasHandoff(1_000 + XS_ALIAS_HANDOFF_SLOT_TTL_MS + 1)).toBeUndefined();
    expect(g[XS_ALIAS_HANDOFF_KEY]).toBeUndefined();
    stashXsAliasHandoff({ fromSessionId: "s1", alias: "a", decided: false, at: 1_000 });
    expect(takeXsAliasHandoff(1_000 + XS_ALIAS_HANDOFF_SLOT_TTL_MS)).toBeDefined(); // boundary inclusive
    stashXsAliasHandoff({ fromSessionId: "s1", alias: "a", decided: false, at: 9_000 });
    expect(takeXsAliasHandoff(1_000)).toBeUndefined(); // clock went backwards
  });

  it("a corrupt slot value never throws", () => {
    g[XS_ALIAS_HANDOFF_KEY] = "garbage";
    expect(takeXsAliasHandoff(1)).toBeUndefined();
    g[XS_ALIAS_HANDOFF_KEY] = { fromSessionId: 1, at: "x" };
    expect(takeXsAliasHandoff(1)).toBeUndefined();
  });
});
