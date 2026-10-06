// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  currentModelOf,
  ctxBadge,
  filterModels,
  groupByProvider,
  isSpawnModelRef,
  knownModelRefs,
  modelsOf,
  readModelCache,
  shortModelLabel,
  snapshotAge,
  switchErrorKey,
  trackSwitch,
  writeModelCache,
  KNOWN_MODEL_REFS_CAP,
  SPAWN_MODELS_CACHE_KEY,
  SWITCH_TIMEOUT_MS,
} from "../../../src/web-hub/ui/src/logic/models.js";

/**
 * `@logic/models.js` (web-model-switch plan v2 §5.5, package M3a): defensive narrowing
 * (`modelsOf`), presentation helpers, the error-code mapping, and the §5.2 switch-convergence
 * machine (`trackSwitch`). Fixtures are IMPORTED from M1's frozen
 * `tests/fixtures/web-hub-models/*.json` (#19 — never copied).
 */

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/web-hub-models/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const V1 = fixture("v1-session");

describe("modelsOf (defensive narrowing, §5.5)", () => {
  it("parses the frozen M1 v1 fixture losslessly", () => {
    const m = modelsOf({ models: V1 })!;
    expect(m).not.toBeNull();
    expect(m.status).toBe("ok");
    expect(m.items).toEqual([
      { provider: "zai", id: "glm-5", name: "GLM 5", scoped: true },
      { provider: "openai", id: "gpt-5", name: "GPT 5", ctx: 400000, reasoning: true },
    ]);
    expect(m.total).toBe(2);
    expect(m.scoped).toBe(true);
    expect(m.policy).toEqual({ model: "allow", thinking: "confirm" });
    expect(m.sampledAt).toBe(1700000000000);
  });

  it("returns null when models is absent / null / not an object (§5.4 state ④ old agent)", () => {
    expect(modelsOf(undefined)).toBeNull();
    expect(modelsOf({})).toBeNull();
    expect(modelsOf({ models: null })).toBeNull();
    expect(modelsOf({ models: "nope" })).toBeNull();
    expect(modelsOf({ models: [] })).toBeNull();
    expect(modelsOf("not a session")).toBeNull();
  });

  it("future-field fixture: unknown keys ignored, unknown status kept (renders as ok), items narrowed", () => {
    const m = modelsOf({ models: fixture("future-field") })!;
    expect(m.status).toBe("future-status");
    expect(m.items).toEqual([{ provider: "openai", id: "gpt-5" }]); // futureOption dropped
    expect(m.policy).toEqual({ model: "allow", thinking: "allow" }); // futurePolicy dropped
    expect((m as Record<string, unknown>)["futureModelsField"]).toBeUndefined();
  });

  it("drops malformed items field-by-field; degrades scalars instead of failing", () => {
    const m = modelsOf({
      models: {
        status: 42, // wrong type ⇒ "ok"
        total: "lots", // wrong type ⇒ items.length
        sampledAt: "never", // wrong type ⇒ 0
        items: [
          null,
          "junk",
          { provider: "", id: "x" }, // empty provider dropped
          { provider: "p" }, // missing id dropped
          { provider: "p", id: "ok-1", name: 7, ctx: -5, reasoning: "yes", scoped: 1 },
          { provider: "p", id: "ok-2", name: "", ctx: 0, reasoning: true, scoped: true },
        ],
        policy: "deny-everything", // wrong type ⇒ allow/allow
        levels: ["low", "", 3, "high"],
        omitted: -3,
        invalid: 2,
        shadowed: { model: true, thinking: "yes" },
      },
    })!;
    expect(m.status).toBe("ok");
    expect(m.total).toBe(2);
    expect(m.sampledAt).toBe(0);
    expect(m.policy).toEqual({ model: "allow", thinking: "allow" });
    expect(m.items).toEqual([
      { provider: "p", id: "ok-1" }, // bad name/ctx/reasoning/scoped all dropped
      { provider: "p", id: "ok-2", ctx: 0, reasoning: true, scoped: true },
    ]);
    expect(m.levels).toEqual(["low", "high"]);
    expect(m.omitted).toBeUndefined(); // negative ⇒ dropped
    expect(m.invalid).toBe(2);
    expect(m.shadowed).toEqual({ model: true });
  });

  it("does not alias the input (narrowing builds fresh objects)", () => {
    const src = { models: V1 };
    const m = modelsOf(src)!;
    expect(m.items[0]).not.toBe((V1["items"] as unknown[])[0]);
  });
});

describe("currentModelOf", () => {
  it("reads session.model; null on absence/malformed", () => {
    expect(currentModelOf({ model: { provider: "zai", id: "glm-5" } })).toEqual({ provider: "zai", id: "glm-5" });
    expect(currentModelOf({})).toBeNull();
    expect(currentModelOf({ model: null })).toBeNull();
    expect(currentModelOf({ model: { provider: "zai" } })).toBeNull();
    expect(currentModelOf({ model: { provider: "", id: "x" } })).toBeNull();
    expect(currentModelOf(undefined)).toBeNull();
  });
});

describe("shortModelLabel", () => {
  it("strips only a trailing -YYYYMMDD", () => {
    expect(shortModelLabel("claude-opus-4-5-20250929")).toBe("claude-opus-4-5");
    expect(shortModelLabel("gpt-5")).toBe("gpt-5");
    expect(shortModelLabel("glm-5-20250101-extra")).toBe("glm-5-20250101-extra"); // not trailing
    expect(shortModelLabel("m-1234567")).toBe("m-1234567"); // 7 digits, not 8
    expect(shortModelLabel("m-20251340")).toBe("m"); // not a real date check — pattern only
  });
});

describe("filterModels / groupByProvider", () => {
  const items = modelsOf({ models: V1 })!.items;

  it("matches provider / id / name case-insensitively; blank query returns all", () => {
    expect(filterModels(items, "")).toHaveLength(2);
    expect(filterModels(items, "  ")).toHaveLength(2);
    expect(filterModels(items, "ZAI")).toEqual([items[0]]);
    expect(filterModels(items, "gpt")).toEqual([items[1]]);
    expect(filterModels(items, "glm 5")).toEqual([items[0]]); // name match
    expect(filterModels(items, "nope")).toEqual([]);
  });

  it("groups by provider in first-seen order, preserving item order", () => {
    const all = [
      { provider: "b", id: "b1" },
      { provider: "a", id: "a1" },
      { provider: "b", id: "b2" },
    ];
    expect(groupByProvider(all)).toEqual([
      { provider: "b", items: [all[0], all[2]] },
      { provider: "a", items: [all[1]] },
    ]);
    expect(groupByProvider([])).toEqual([]);
  });
});

describe("switchErrorKey (§5.2 code table)", () => {
  it("maps the known codes; everything else is generic", () => {
    expect(switchErrorKey("E_SUBAGENT_REJECTED")).toBe("modelErrRejected");
    expect(switchErrorKey("E_BAD_REQUEST")).toBe("modelErrUnknown");
    expect(switchErrorKey("E_COMMAND_DENIED")).toBe("modelErrDenied");
    expect(switchErrorKey("E_SESSION_CHANGED")).toBe("modelErrSession");
    expect(switchErrorKey("E_INVALID_REF")).toBe("modelErrInvalidRef");
    expect(switchErrorKey("E_NETWORK")).toBe("modelErrGeneric");
    expect(switchErrorKey(undefined)).toBe("modelErrGeneric");
  });
});

describe("trackSwitch (§5.2 convergence machine)", () => {
  const track = {
    id: "cmd-1",
    sessionId: "s1",
    target: { provider: "zai", id: "glm-5" },
    startedAt: 1_000,
  };
  const session = { sessionId: "s1", model: { provider: "openai", id: "gpt-5" } };
  const sending = { id: "cmd-1", kind: "command", name: "model", state: "sending", at: 1_000 };

  it("local item still sending/running ⇒ pending; timeout with no conclusion ⇒ unknown", () => {
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: [], session, now: 5_000 })).toEqual({ kind: "pending" });
    expect(
      trackSwitch(track, { pendingCtl: [{ ...sending, state: "running" }], ctl: [], session, now: 5_000 }),
    ).toEqual({ kind: "pending" });
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: [], session, now: 1_000 + SWITCH_TIMEOUT_MS + 1 })).toEqual(
      { kind: "unknown" },
    );
    // no local list at all: timeout still fires
    expect(trackSwitch(track, { session, now: 1_000 + SWITCH_TIMEOUT_MS + 1 })).toEqual({ kind: "unknown" });
  });

  it("local item failed ⇒ error(error/message); unknown/querying ⇒ unknown; notExecuted ⇒ idle (retry unlocked)", () => {
    expect(
      trackSwitch(track, {
        pendingCtl: [{ ...sending, state: "failed", error: "E_BAD_REQUEST" }],
        session,
        now: 2_000,
      }),
    ).toEqual({ kind: "error", code: "E_BAD_REQUEST" });
    expect(
      trackSwitch(track, {
        pendingCtl: [{ ...sending, state: "failed", error: "E_SUBAGENT_REJECTED", message: "no auth" }],
        session,
        now: 2_000,
      }),
    ).toEqual({ kind: "error", code: "E_SUBAGENT_REJECTED", message: "no auth" });
    expect(trackSwitch(track, { pendingCtl: [{ ...sending, state: "failed" }], session, now: 2_000 })).toEqual({
      kind: "error",
      code: "E_FAILED",
    });
    expect(trackSwitch(track, { pendingCtl: [{ ...sending, state: "unknown" }], session, now: 2_000 })).toEqual({
      kind: "unknown",
    });
    expect(trackSwitch(track, { pendingCtl: [{ ...sending, state: "querying" }], session, now: 2_000 })).toEqual({
      kind: "unknown",
    });
    // query E_UNKNOWN_ID ⇒ pendingTransition's notExecuted ⇒ provably never ran ⇒ idle
    expect(trackSwitch(track, { pendingCtl: [{ ...sending, state: "notExecuted" }], session, now: 2_000 })).toEqual({
      kind: "idle",
    });
  });

  it("item REMOVED from pendingCtl (cmd_late ok path) ⇒ idle", () => {
    expect(trackSwitch(track, { pendingCtl: [], ctl: [], session, now: 2_000 })).toEqual({ kind: "idle" });
  });

  it("ctl ledger slot converges by cmdId: ok/late_ok ⇒ idle; failed/late_failed ⇒ error(code)", () => {
    const ledger = (state: string, code?: string) => [
      { cmdId: "cmd-1", op: "command", state, ...(code ? { code } : {}) },
    ];
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: ledger("ok"), session, now: 2_000 })).toEqual({
      kind: "idle",
    });
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: ledger("late_ok"), session, now: 2_000 })).toEqual({
      kind: "idle",
    });
    expect(
      trackSwitch(track, {
        pendingCtl: [sending],
        ctl: ledger("late_failed", "E_SUBAGENT_REJECTED"),
        session,
        now: 2_000,
      }),
    ).toEqual({ kind: "error", code: "E_SUBAGENT_REJECTED" });
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: ledger("failed"), session, now: 2_000 })).toEqual({
      kind: "error",
      code: "E_FAILED",
    });
    // non-terminal ledger states keep it pending
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: ledger("running"), session, now: 2_000 })).toEqual({
      kind: "pending",
    });
  });

  it("session.model already at the target ⇒ idle (proof of execution, wins over timeout)", () => {
    const switched = { sessionId: "s1", model: { provider: "zai", id: "glm-5" } };
    expect(
      trackSwitch(track, { pendingCtl: [sending], ctl: [], session: switched, now: 1_000 + SWITCH_TIMEOUT_MS + 1 }),
    ).toEqual({ kind: "idle" });
  });

  it("results for OTHER ids never affect the tracked state", () => {
    const foreign = [
      { cmdId: "cmd-other", op: "command", state: "late_failed", code: "E_BAD_REQUEST" },
      { cmdId: "cmd-other-2", op: "command", state: "ok" },
    ];
    const items = [sending, { ...sending, id: "cmd-other", state: "failed", error: "E_BAD_REQUEST" }];
    expect(trackSwitch(track, { pendingCtl: items, ctl: foreign, session, now: 2_000 })).toEqual({ kind: "pending" });
  });

  it("session switch (sessionId changed / session gone) ⇒ drop to idle", () => {
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: [], session: { sessionId: "s2" }, now: 2_000 })).toEqual({
      kind: "idle",
    });
    expect(trackSwitch(track, { pendingCtl: [sending], ctl: [], session: undefined, now: 2_000 })).toEqual({
      kind: "idle",
    });
  });
});

describe("ctxBadge / snapshotAge (compact English tokens)", () => {
  it("ctxBadge formats k/M; null on missing/non-positive", () => {
    expect(ctxBadge(400000)).toBe("400k");
    expect(ctxBadge(200000)).toBe("200k");
    expect(ctxBadge(1000000)).toBe("1M");
    expect(ctxBadge(1500000)).toBe("1.5M");
    expect(ctxBadge(999)).toBe("999");
    expect(ctxBadge(undefined)).toBeNull();
    expect(ctxBadge(0)).toBeNull();
  });

  it("snapshotAge buckets s/m/h/d; 'now' under 5s; '?' on garbage", () => {
    const t0 = 1_700_000_000_000;
    expect(snapshotAge(t0 + 2_000, t0)).toBe("now");
    expect(snapshotAge(t0 + 30_000, t0)).toBe("30s");
    expect(snapshotAge(t0 + 5 * 60_000, t0)).toBe("5m");
    expect(snapshotAge(t0 + 3 * 3_600_000, t0)).toBe("3h");
    expect(snapshotAge(t0 + 2 * 86_400_000, t0)).toBe("2d");
    expect(snapshotAge(t0, 0)).toBe("?");
    expect(snapshotAge("x", t0)).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// default-model plan F1 (D7): knownModelRefs / model cache / isSpawnModelRef
// ---------------------------------------------------------------------------

describe("knownModelRefs (D7 union of online agents' session.models.items)", () => {
  const agent = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    down: false,
    session: {
      models: {
        status: "ok",
        items,
        total: (items as unknown[]).length,
        policy: { model: "allow", thinking: "allow" },
        sampledAt: 1,
      },
    },
    ...extra,
  });
  const opt = (provider: string, id: string, name?: string) => ({
    provider,
    id,
    ...(name !== undefined ? { name } : {}),
  });

  it("unions across agents, dedupes by provider/id (first-seen wins), keeps {provider,id,name?} only", () => {
    const agents = new Map([
      ["A", agent([opt("anthropic", "claude-opus-4-5", "Opus"), opt("openai", "gpt-5")])],
      ["B", agent([opt("openai", "gpt-5", "GPT 5 (other name)"), opt("zai", "glm-5")])],
    ]);
    expect(knownModelRefs(agents)).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" },
      { provider: "openai", id: "gpt-5" },
      { provider: "zai", id: "glm-5" },
    ]);
  });

  it("skips offline (down) and models-less agents; accepts a plain array too", () => {
    const online = agent([opt("p1", "m1")]);
    expect(knownModelRefs([agent([opt("p0", "m0")], { down: true }), online, { down: false }, null])).toEqual([
      { provider: "p1", id: "m1" },
    ]);
  });

  it("caps at KNOWN_MODEL_REFS_CAP (160)", () => {
    expect(KNOWN_MODEL_REFS_CAP).toBe(160); // plan D7's frozen cap
    const items = Array.from({ length: 200 }, (_, i) => opt("p", `m${i}`));
    expect(knownModelRefs([agent(items)])).toHaveLength(160);
  });

  it("garbage in ⇒ []", () => {
    expect(knownModelRefs(undefined)).toEqual([]);
    expect(knownModelRefs(null)).toEqual([]);
    expect(knownModelRefs(42)).toEqual([]);
    expect(knownModelRefs("agents")).toEqual([]);
  });
});

describe("readModelCache / writeModelCache (D7 pwh_spawn_models_cache)", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("round-trips a non-empty list, stripping extra fields", () => {
    const s = fakeStorage();
    const written = writeModelCache(s, [
      { provider: "anthropic", id: "claude-opus-4-5", name: "Opus", ctx: 200000, reasoning: true },
      { provider: "openai", id: "gpt-5" },
    ] as never);
    expect(written).toBe(true);
    expect(JSON.parse(s.map.get(SPAWN_MODELS_CACHE_KEY)!)).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" },
      { provider: "openai", id: "gpt-5" },
    ]);
    expect(readModelCache(s)).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" },
      { provider: "openai", id: "gpt-5" },
    ]);
  });

  it("an empty list is NEVER written (D7: must not clobber the last good cache)", () => {
    const s = fakeStorage({ [SPAWN_MODELS_CACHE_KEY]: JSON.stringify([{ provider: "p", id: "m" }]) });
    expect(writeModelCache(s, [])).toBe(false);
    expect(readModelCache(s)).toEqual([{ provider: "p", id: "m" }]);
  });

  it("read tolerates a missing key, bad JSON, non-array, and invalid entries (dropped individually)", () => {
    expect(readModelCache(fakeStorage())).toEqual([]);
    expect(readModelCache(fakeStorage({ [SPAWN_MODELS_CACHE_KEY]: "not json" }))).toEqual([]);
    expect(readModelCache(fakeStorage({ [SPAWN_MODELS_CACHE_KEY]: "{}" }))).toEqual([]);
    const mixed = fakeStorage({
      [SPAWN_MODELS_CACHE_KEY]: JSON.stringify([
        { provider: "p", id: "m" },
        { provider: "bad provider", id: "m" }, // whitespace ⇒ parseSpawnModelRef rejects
        { provider: "p2" }, // no id
        "garbage",
        { provider: "p3", id: "m3", name: 42 }, // non-string name dropped
      ]),
    });
    expect(readModelCache(mixed)).toEqual([
      { provider: "p", id: "m" },
      { provider: "p3", id: "m3" },
    ]);
  });

  it("a throwing storage degrades both ways (never throws)", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readModelCache(boom)).toEqual([]);
    expect(writeModelCache(boom, [{ provider: "p", id: "m" }])).toBe(false);
    expect(readModelCache(null)).toEqual([]);
    expect(writeModelCache(undefined, [{ provider: "p", id: "m" }])).toBe(false);
  });
});

describe("isSpawnModelRef (the hub's own parseSpawnModelRef, reused via @protocol)", () => {
  it("accepts real refs and rejects exactly what the hub would", () => {
    expect(isSpawnModelRef("anthropic/claude-opus-4-5")).toBe(true);
    expect(isSpawnModelRef("openrouter/openai/gpt-4o:extended")).toBe(true);
    expect(isSpawnModelRef("")).toBe(false); // "" is the tri-state clear, handled BEFORE this call
    expect(isSpawnModelRef("no-slash")).toBe(false);
    expect(isSpawnModelRef("-x/y")).toBe(false); // leading-dash provider (argv-flag confusion)
    expect(isSpawnModelRef("a/ b")).toBe(false);
    expect(isSpawnModelRef("a/b\n")).toBe(false);
    expect(isSpawnModelRef(undefined)).toBe(false);
    expect(isSpawnModelRef(42)).toBe(false);
  });
});
