// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifySpawnError,
  isMine,
  managedFor,
  newSessionActions,
  pendingRows,
  spawnAvailability,
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

  it("no caps ⇒ pick-dir disabled with reason unavailable; same-cwd still follows its own formula", () => {
    const actions = newSessionActions({
      hubCaps: [],
      listResult: okList,
      selected: { agent: agent(), hubControl: true, controlPresent: true },
    });
    expect(actions).toEqual([
      { kind: "same-cwd", agentKey: "A", cwd: "/home/u/proj", enabled: true },
      { kind: "pick-dir", enabled: false, reason: "unavailable" },
    ]);
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
      newSessionActions({ hubCaps: [], listResult: undefined, selected: sel })[0];
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
