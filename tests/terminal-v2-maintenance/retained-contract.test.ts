import { expect, it } from "vitest";
import {
  createInitialTerminalLedgerV2,
  terminalInitialLedgerV2Ok,
  terminalLedgerV2Ok,
  type TerminalMarkerV2,
} from "../../src/web-hub/protocol/terminal-v2.js";
import { quotaV2, DEFAULT_TERMINAL_LIMITS_V2 } from "../../src/web-hub/hub/terminal/v2/limits.js";
import { mapRetainedObligations } from "../../scripts/web-hub/terminal-v2-retained/mapping.js";
const identity = {
  agentSessionId: "old-session",
  termId: "old-term",
  epoch: "old-epoch",
  ownerInstance: "old-owner",
  reservationId: "old-reservation",
};
const source = {
  identity,
  recordKey: "terminal-v1/terminal-resource-fence-v1.json#resources/0",
  sessionVerified: true,
};
const rows = () => mapRetainedObligations("a".repeat(64), "b".repeat(64), [source]);
const marker: TerminalMarkerV2 = {
  v: 2,
  storeId: "s".repeat(24),
  checkpointId: "c".repeat(24),
  initialization: "offline-retained-unknown",
};
it("declared retained initialization is separate; original two forms still require empty original shape", () => {
  const legacy = rows(),
    initial = createInitialTerminalLedgerV2(marker, legacy);
  expect(terminalInitialLedgerV2Ok(initial, marker)).toBe(true);
  expect(initial.legacyObligations).toEqual(legacy);
  expect(initial.allocations).toEqual([]);
  for (const initialization of ["fresh", "v1-clean-checkpoint"] as const) {
    const old = { ...marker, initialization };
    expect(createInitialTerminalLedgerV2(old)).toEqual({ v: 2, storeId: marker.storeId, revision: 0, allocations: [] });
    expect(() => createInitialTerminalLedgerV2(old, legacy)).toThrow();
    expect(terminalInitialLedgerV2Ok(initial, old)).toBe(false);
  }
  expect(terminalInitialLedgerV2Ok({ ...initial, revision: 1 }, marker)).toBe(false);
  expect(terminalLedgerV2Ok({ ...initial, revision: 7 })).toBe(true);
  expect(terminalInitialLedgerV2Ok({ v: 2, storeId: marker.storeId, revision: 0, allocations: [] }, marker)).toBe(
    false,
  );
});
it("mapping is stable per original identity, source-bound, deduplicates compatible locations and rejects conflicting boot facts", () => {
  const a = rows()[0]!,
    other = mapRetainedObligations("a".repeat(64), "c".repeat(64), [
      { ...source, recordKey: "terminal-v1/receipts/r.json#entry" },
    ])[0]!;
  expect(other.obligationId).toBe(a.obligationId);
  expect(other.sourceManifestSha256).not.toBe(a.sourceManifestSha256);
  const merged = mapRetainedObligations("a".repeat(64), "b".repeat(64), [
    source,
    { ...source, recordKey: "terminal-v1/receipts/r.json#entry" },
  ]);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.sourceRecordKeys).toHaveLength(2);
  expect(() =>
    mapRetainedObligations("a".repeat(64), "b".repeat(64), [
      { ...source, bootId: "11111111-1111-4111-8111-111111111111" },
      { ...source, bootId: "22222222-2222-4222-8222-222222222222" },
    ]),
  ).toThrow("E_SOURCE_IDENTITY_CONFLICT");
  expect(() =>
    mapRetainedObligations("a".repeat(64), "b".repeat(64), [{ ...source, recordKey: "../outside" }]),
  ).toThrow();
  expect(() =>
    mapRetainedObligations("a".repeat(64), "b".repeat(64), [source, { ...source, recordKey: "../outside" }]),
  ).toThrow();
});
it("cold contract rejects fabricated attribution/scope, duplicate identity/id, inconsistent session and source provenance", () => {
  const initial = createInitialTerminalLedgerV2(marker, rows()),
    row = initial.legacyObligations![0]!;
  for (const altered of [
    { ...row, principalKey: "loopback:legacy" },
    { ...row, creatorSidTag: "s".repeat(43) },
    { ...row, scope: { agentKey: "unknown", sessionId: "old-session", epoch: "old" } },
    { ...row, sessionBinding: { kind: "verified", sessionId: "other" } },
    { ...row, sourceRecordKeys: ["/outside"] },
  ])
    expect(terminalLedgerV2Ok({ ...initial, legacyObligations: [altered] })).toBe(false);
  expect(terminalLedgerV2Ok({ ...initial, legacyObligations: [row, row] })).toBe(false);
  expect(terminalLedgerV2Ok({ ...initial, legacyObligations: [row, { ...row, obligationId: "d".repeat(64) }] })).toBe(
    false,
  );
});
it("every principal pays every legacy obligation; known sessions exact, unknown sessions conservative; counts are not clamped", () => {
  const verified = rows();
  for (const principal of ["lan:u1", "lan:u2", "loopback:new"]) {
    const q = quotaV2([], new Set(), "different-session", principal, DEFAULT_TERMINAL_LIMITS_V2, verified);
    expect(q.principal).toEqual({ used: 1, unknown: 1, limit: 2 });
    expect(q.session.used).toBe(0);
    expect(q.total.used).toBe(1);
  }
  const unknown = mapRetainedObligations("a".repeat(64), "b".repeat(64), [{ ...source, sessionVerified: false }]);
  expect(quotaV2([], new Set(), "new-session", "lan:u1", DEFAULT_TERMINAL_LIMITS_V2, unknown).session.used).toBe(1);
  const many = mapRetainedObligations(
    "a".repeat(64),
    "b".repeat(64),
    Array.from({ length: 9 }, (_, n) => ({ ...source, identity: { ...identity, reservationId: `r${n}` } })),
  );
  const q = quotaV2([], new Set(), "old-session", "lan:u1", DEFAULT_TERMINAL_LIMITS_V2, many);
  expect(q.total).toEqual({ used: 9, unknown: 9, limit: 8 });
  expect(q.principal.used).toBe(9);
});
