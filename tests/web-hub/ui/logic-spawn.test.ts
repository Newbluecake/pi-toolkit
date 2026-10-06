// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifySpawnError,
  isMine,
  managedFor,
  newSessionActions,
  pendingRows,
  spawnAvailability,
  spawnDeniedKey,
  spawnHintKey,
  spawnModelSupported,
} from "../../../src/web-hub/ui/src/logic/spawn.js";
import { SPAWN_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { SpawnPolicyWire, SpawnRecordPublic, SpawnsPayload } from "../../../src/web-hub/protocol/spawn.js";

/**
 * web-hub-spawn SP11: `@logic/spawn.js`'s truth tables — the capability gate
 * (`spawnAvailability`), arch §8.3's `NewSessionAction[]` mapping (`newSessionActions`), the
 * §3.2 error taxonomy (`classifySpawnError`), and the three record helpers
 * (`isMine`/`pendingRows`/`managedFor`). All pure, all table-driven.
 */

const policy = (extra: Partial<SpawnPolicyWire> = {}): SpawnPolicyWire => ({
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 4,
  maxPerPrincipal: 2,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
  ...extra,
});

const rec = (extra: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic => ({
  spawnId: "sp1",
  state: "starting",
  createdAt: 1000,
  updatedAt: 1000,
  cwdLabel: "proj",
  origin: { listener: "loopback", reqId: "req-1" },
  ...extra,
});

describe("spawnAvailability (arch §8.2 matrix + §8.3 404 rule)", () => {
  it("no spawn.v1 cap ⇒ no-cap, regardless of the list result", () => {
    expect(spawnAvailability({ hubCaps: [], listResult: undefined })).toEqual({ state: "no-cap" });
    expect(spawnAvailability({ hubCaps: ["cmd.v1"], listResult: { ok: true, policy: policy(), items: [] } })).toEqual({
      state: "no-cap",
    });
    expect(spawnAvailability({ hubCaps: undefined, listResult: undefined })).toEqual({ state: "no-cap" });
  });

  it("cap present but list never fetched ⇒ unknown", () => {
    expect(spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: undefined })).toEqual({ state: "unknown" });
    expect(spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: null })).toEqual({ state: "unknown" });
  });

  it('list 404 ⇒ not-found (feature off / LAN lan:"off" — the UI hides pick-dir, never an error)', () => {
    expect(
      spawnAvailability({
        hubCaps: [SPAWN_HUB_CAP],
        listResult: { ok: false, error: "E_NOT_FOUND", status: 404 },
      }),
    ).toEqual({ state: "not-found" });
  });

  it("list failure with any other status ⇒ error", () => {
    expect(
      spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: { ok: false, error: "E_AUTH", status: 401 } }),
    ).toEqual({ state: "error" });
    expect(
      spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: { ok: false, error: "E_NETWORK", status: 0 } }),
    ).toEqual({ state: "error" });
  });

  it("list ok + policy.allowed === false ⇒ denied (policy rides along, reason included)", () => {
    const denied = policy({ allowed: false, reason: "breaker", retryAfterS: 600 });
    const r = spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: { ok: true, policy: denied, items: [] } });
    expect(r).toEqual({ state: "denied", policy: denied });
  });

  it("list ok + policy.allowed === true ⇒ available", () => {
    const p = policy();
    expect(spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult: { ok: true, policy: p, items: [] } })).toEqual({
      state: "available",
      policy: p,
    });
  });

  it("list ok with a garbage policy ⇒ error (never crashes)", () => {
    expect(
      spawnAvailability({
        hubCaps: [SPAWN_HUB_CAP],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        listResult: { ok: true, policy: undefined as any, items: [] },
      }),
    ).toEqual({ state: "error" });
  });
});

describe("newSessionActions (arch §8.3 NewSessionAction[])", () => {
  const agent = (extra: Record<string, unknown> = {}) => ({
    key: "A",
    card: { cwd: "/home/u/proj", control: true, state: "live", ...((extra.card as object) ?? {}) },
    down: false,
    ...extra,
  });
  const okList = { ok: true as const, policy: policy(), items: [] as readonly SpawnRecordPublic[] };

  it("0 agents (no selected agent) ⇒ only the pick-dir action (EmptyState entry, arch §9.1)", () => {
    const actions = newSessionActions({
      hubCaps: [SPAWN_HUB_CAP],
      listResult: okList,
      selected: { hubControl: true, controlPresent: true },
    });
    expect(actions).toEqual([{ kind: "pick-dir", enabled: true }]);
  });

  it("no caps ⇒ spawn-cwd/pick-dir disabled with reason unavailable; same-cwd still follows its own formula", () => {
    const actions = newSessionActions({
      hubCaps: [],
      listResult: okList,
      selected: { agent: agent(), hubControl: true, controlPresent: true },
    });
    expect(actions).toEqual([
      { kind: "spawn-cwd", agentKey: "A", cwd: "/home/u/proj", enabled: false, reason: "unavailable" },
      { kind: "same-cwd", agentKey: "A", cwd: "/home/u/proj", enabled: true },
      { kind: "pick-dir", enabled: false, reason: "unavailable" },
    ]);
  });

  it("spawn available ⇒ spawn-cwd (the main button) enabled with the selected agent's cwd", () => {
    const actions = newSessionActions({
      hubCaps: [SPAWN_HUB_CAP],
      listResult: okList,
      selected: { agent: agent(), hubControl: false, controlPresent: false },
    });
    // spawn-cwd never touches the selected agent's control plane — availability alone decides
    expect(actions[0]).toEqual({ kind: "spawn-cwd", agentKey: "A", cwd: "/home/u/proj", enabled: true });
  });

  it("policy denied ⇒ spawn-cwd disabled carrying the policy reason", () => {
    const actions = newSessionActions({
      hubCaps: [SPAWN_HUB_CAP],
      listResult: { ok: true, policy: policy({ allowed: false, reason: "cooldown" }), items: [] },
      selected: { agent: agent(), hubControl: true, controlPresent: true },
    });
    expect(actions[0]).toEqual({
      kind: "spawn-cwd",
      agentKey: "A",
      cwd: "/home/u/proj",
      enabled: false,
      reason: "cooldown",
    });
  });

  it("list 404 ⇒ pick-dir unavailable (arch §8.3)", () => {
    const actions = newSessionActions({
      hubCaps: [SPAWN_HUB_CAP],
      listResult: { ok: false, error: "E_NOT_FOUND", status: 404 },
      selected: { agent: agent(), hubControl: true, controlPresent: true },
    });
    expect(actions.at(-1)).toEqual({ kind: "pick-dir", enabled: false, reason: "unavailable" });
  });

  it.each(["platform", "launcher", "persist", "reaper", "cooldown", "breaker"] as const)(
    "policy.allowed === false (reason %s) ⇒ pick-dir disabled with that reason",
    (reason) => {
      const actions = newSessionActions({
        hubCaps: [SPAWN_HUB_CAP],
        listResult: { ok: true, policy: policy({ allowed: false, reason }), items: [] },
        selected: { agent: agent(), hubControl: true, controlPresent: true },
      });
      expect(actions.at(-1)).toEqual({ kind: "pick-dir", enabled: false, reason });
    },
  );

  it("same-cwd enable formula is byte-identical to AgentList.vue's newSessionEnabled", () => {
    const run = (sel: Record<string, unknown>) =>
      newSessionActions({ hubCaps: [], listResult: undefined, selected: sel }).find((a) => a.kind === "same-cwd");
    // all good ⇒ enabled
    expect(run({ agent: agent(), hubControl: true, controlPresent: true })).toMatchObject({ enabled: true });
    // hub cmd.v1 missing ⇒ disabled
    expect(run({ agent: agent(), hubControl: false, controlPresent: true })).toMatchObject({ enabled: false });
    // no control handle ⇒ disabled
    expect(run({ agent: agent(), hubControl: true, controlPresent: false })).toMatchObject({ enabled: false });
    // card.control false ⇒ disabled
    expect(run({ agent: agent({ card: { control: false } }), hubControl: true, controlPresent: true })).toMatchObject({
      enabled: false,
    });
    // agent down ⇒ disabled
    expect(run({ agent: agent({ down: true }), hubControl: true, controlPresent: true })).toMatchObject({
      enabled: false,
    });
    // card stale ⇒ disabled
    expect(run({ agent: agent({ card: { state: "stale" } }), hubControl: true, controlPresent: true })).toMatchObject({
      enabled: false,
    });
    // cwd rides from the card
    expect(run({ agent: agent(), hubControl: true, controlPresent: true })).toMatchObject({
      kind: "same-cwd",
      agentKey: "A",
      cwd: "/home/u/proj",
    });
  });

  it("pick-dir never depends on the selected agent", () => {
    const withAgent = newSessionActions({
      hubCaps: [SPAWN_HUB_CAP],
      listResult: okList,
      selected: { agent: agent(), hubControl: false, controlPresent: false },
    });
    expect(withAgent.at(-1)).toEqual({ kind: "pick-dir", enabled: true });
  });
});

describe("classifySpawnError (§3.2 DirPicker taxonomy)", () => {
  it.each([
    ["E_CONFIRM_REQUIRED", "confirm"],
    ["E_DIR", "dir"],
    ["E_BAD_REQUEST", "dir"],
    ["E_SPAWN_DENIED", "denied"],
    ["E_LIMIT", "limit"],
    ["E_RATE", "rate"],
    ["E_LAUNCHER", "launcher"],
    ["E_DEADLINE", "deadline"],
    ["E_NETWORK", "network"],
    ["E_NOT_IMPLEMENTED", "network"],
    ["HTTP 500", "network"],
  ] as const)("%s ⇒ %s", (error, kind) => {
    expect(classifySpawnError({ ok: false, error, retryable: false })).toBe(kind);
  });

  it("a success outcome (or garbage) is not an error ⇒ undefined", () => {
    expect(classifySpawnError({ ok: true, data: {} })).toBeUndefined();
    expect(classifySpawnError(undefined)).toBeUndefined();
    expect(classifySpawnError(null)).toBeUndefined();
    expect(classifySpawnError("x")).toBeUndefined();
  });

  // web-hub-delete-session plan v2 §2.5: the idempotent-replay-but-record-deleted rejection
  // gets its own "gone" bucket — checked BEFORE the generic E_BAD_REQUEST⇒"dir" fallback.
  it('E_BAD_REQUEST with reason:"spawn-gone" ⇒ "gone" (not the generic "dir")', () => {
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: "spawn-gone", retryable: false })).toBe(
      "gone",
    );
  });

  it('E_BAD_REQUEST with any OTHER reason (or none) still falls back to "dir"', () => {
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: "cwd-rejected", retryable: false })).toBe(
      "dir",
    );
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", retryable: false })).toBe("dir");
  });
});

// Anti-drift (verifier r1 #2, P2 打回): `SPAWN_GONE_REASON` has a real runtime export in
// `protocol/spawn.ts`, but `@logic/spawn.js` deliberately does NOT import it in production code
// (importing anything from that module drags `@sinclair/typebox` into the browser bundle — the
// rationale `SPAWN_GONE_REASON`'s own export comment documents), so the hardcoded `"spawn-gone"`
// literal is pinned HERE instead, by feeding the REAL protocol value through the function under
// test. A protocol rename trips this test (the literal comparison inside `classifySpawnError`
// would stop matching and fall through to the generic "dir" bucket).
describe("classifySpawnError × protocol/spawn.ts's SPAWN_GONE_REASON (anti-drift pin)", () => {
  it('the real protocol constant, fed through classifySpawnError, still resolves to "gone"', async () => {
    const { SPAWN_GONE_REASON } = await import("../../../src/web-hub/protocol/spawn.js");
    expect(SPAWN_GONE_REASON).toBe("spawn-gone"); // the value @logic/spawn.js's literal must track
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: SPAWN_GONE_REASON, retryable: false })).toBe(
      "gone",
    );
  });
});

describe("isMine (§3.2 「我发起的」)", () => {
  it("origin.reqId ∈ local ids ⇒ true (Set and array forms)", () => {
    const r = rec({ origin: { listener: "loopback", reqId: "req-9" } });
    expect(isMine(r, new Set(["req-9"]))).toBe(true);
    expect(isMine(r, ["req-8", "req-9"])).toBe(true);
    expect(isMine(r, new Set(["req-8"]))).toBe(false);
  });

  it("missing origin/reqId or garbage records ⇒ false, never throws", () => {
    expect(isMine(rec({ origin: undefined as unknown as SpawnRecordPublic["origin"] }), new Set(["req-1"]))).toBe(
      false,
    );
    expect(isMine(null, new Set(["req-1"]))).toBe(false);
    expect(isMine("sp1", new Set(["req-1"]))).toBe(false);
  });
});

describe("pendingRows (SpawnRow model: starting/failed, newest first)", () => {
  it("keeps starting+failed, drops live/stopping/exited, sorts createdAt desc", () => {
    const spawns: SpawnsPayload = {
      active: 2,
      max: 4,
      items: [
        rec({ spawnId: "s-old-failed", state: "failed", createdAt: 100 }),
        rec({ spawnId: "s-live", state: "live", createdAt: 500, agentKey: "A" }),
        rec({ spawnId: "s-new-starting", state: "starting", createdAt: 900 }),
        rec({ spawnId: "s-stopping", state: "stopping", createdAt: 800, agentKey: "A" }),
        rec({ spawnId: "s-exited", state: "exited", createdAt: 700 }),
        rec({ spawnId: "s-mid-failed", state: "failed", createdAt: 400 }),
      ],
    };
    expect(pendingRows(spawns).map((r) => r.spawnId)).toEqual(["s-new-starting", "s-mid-failed", "s-old-failed"]);
  });

  it("null/garbage payloads ⇒ []", () => {
    expect(pendingRows(null)).toEqual([]);
    expect(pendingRows(undefined)).toEqual([]);
    expect(pendingRows({} as unknown as SpawnsPayload)).toEqual([]);
  });
});

describe("spawnDeniedKey (policy reason → spawn.denied* i18n key)", () => {
  it("known reasons map to their key; unknown/missing ⇒ deniedUnknown", () => {
    expect(spawnDeniedKey("platform")).toBe("spawn.deniedPlatform");
    expect(spawnDeniedKey("cooldown")).toBe("spawn.deniedCooldown");
    expect(spawnDeniedKey("breaker")).toBe("spawn.deniedBreaker");
    expect(spawnDeniedKey("something-new")).toBe("spawn.deniedUnknown");
    expect(spawnDeniedKey(undefined)).toBe("spawn.deniedUnknown");
  });
});

describe("managedFor (web badge / 停止会话 lookup)", () => {
  it("matches live/stopping records by agentKey; latest updatedAt wins", () => {
    const spawns: SpawnsPayload = {
      active: 2,
      max: 4,
      items: [
        rec({ spawnId: "s1", state: "live", agentKey: "A", updatedAt: 100 }),
        rec({ spawnId: "s2", state: "stopping", agentKey: "A", updatedAt: 200 }),
        rec({ spawnId: "s3", state: "live", agentKey: "B", updatedAt: 300 }),
        rec({ spawnId: "s4", state: "exited", agentKey: "A", updatedAt: 400 }),
      ],
    };
    expect(managedFor(spawns, "A")?.spawnId).toBe("s2");
    expect(managedFor(spawns, "B")?.spawnId).toBe("s3");
    expect(managedFor(spawns, "C")).toBeUndefined();
  });

  it("a starting record never matches (no agentKey until bind, arch §7.5)", () => {
    const spawns: SpawnsPayload = { active: 1, max: 4, items: [rec({ spawnId: "s1", state: "starting" })] };
    expect(managedFor(spawns, "A")).toBeUndefined();
  });

  it("null/garbage payloads ⇒ undefined", () => {
    expect(managedFor(null, "A")).toBeUndefined();
    expect(managedFor({} as unknown as SpawnsPayload, "A")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// default-model plan F1: spawnModelSupported / model-invalid bucket / spawnHintKey
// ---------------------------------------------------------------------------

describe("spawnModelSupported (default-model plan D4 — the spawn.model.v1 gate)", () => {
  it("true iff the hub caps include spawn.model.v1 (the real protocol constant)", async () => {
    const { SPAWN_MODEL_HUB_CAP } = await import("../../../src/web-hub/protocol/version.js");
    expect(SPAWN_MODEL_HUB_CAP).toBe("spawn.model.v1"); // the literal spawnModelSupported must track
    expect(spawnModelSupported([SPAWN_MODEL_HUB_CAP])).toBe(true);
    expect(spawnModelSupported([SPAWN_HUB_CAP, SPAWN_MODEL_HUB_CAP])).toBe(true);
    expect(spawnModelSupported([SPAWN_HUB_CAP])).toBe(false);
    expect(spawnModelSupported([])).toBe(false);
    expect(spawnModelSupported(undefined)).toBe(false);
    expect(spawnModelSupported("spawn.model.v1")).toBe(false);
  });

  it("an extra UNKNOWN cap changes nothing (D4: old UI on a new hub ignores it)", () => {
    const listResult = { ok: true as const, policy: policy(), items: [] as readonly SpawnRecordPublic[] };
    expect(spawnAvailability({ hubCaps: [SPAWN_HUB_CAP, "spawn.future.v9"], listResult })).toEqual(
      spawnAvailability({ hubCaps: [SPAWN_HUB_CAP], listResult }),
    );
    // ...and spawnModelSupported ignores unknowns both ways
    expect(spawnModelSupported(["spawn.future.v9"])).toBe(false);
  });
});

describe("classifySpawnError — model-invalid (default-model plan F1)", () => {
  it('E_BAD_REQUEST with reason:"model-invalid" ⇒ "model" (not the generic "dir")', () => {
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: "model-invalid", retryable: false })).toBe(
      "model",
    );
  });

  it("the other E_BAD_REQUEST reasons still resolve to their own buckets", () => {
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: "spawn-gone", retryable: false })).toBe(
      "gone",
    );
    expect(classifySpawnError({ ok: false, error: "E_BAD_REQUEST", reason: "cwd-rejected", retryable: false })).toBe(
      "dir",
    );
  });
});

describe("spawnHintKey (SpawnHint → spawn.hint* i18n key; F1 adds model-rejected)", () => {
  it("maps every frozen SpawnHint, including model-rejected", async () => {
    const proto = await import("../../../src/web-hub/protocol/spawn.js");
    // The full frozen union, exercised by value (a protocol rename trips the mapped key).
    const hints = [
      "register-timeout-hello",
      "register-timeout-session",
      "control-off",
      "newer-plugin",
      "cwd-mismatch",
      "protocol-error",
      "launcher-changed",
      "model-rejected",
    ] as const;
    for (const h of hints) expect(spawnHintKey(h), h).toMatch(/^spawn\.hint/);
    expect(spawnHintKey("model-rejected")).toBe("spawn.hintModelRejected");
    void proto;
  });

  it("unknown hints degrade safely to undefined (callers fall back to the raw string)", () => {
    expect(spawnHintKey("some-future-hint")).toBeUndefined();
    expect(spawnHintKey(undefined)).toBeUndefined();
    expect(spawnHintKey(42)).toBeUndefined();
  });
});
