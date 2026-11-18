/** Tool-only data parser for EXACT O7239, not execution/ACK/admission compatibility.
 * Mirrors its closed on-disk values; no import of legacy runtime into production N. */
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LegacyResourceIdentityV1Schema } from "../../../src/web-hub/protocol/terminal-v2.js";
export const OLD_RETAINED_SOURCE = "7239dd115ac66039e2c4f80308ea5d08520aa6af";
const closed = <T extends TProperties>(p: T) => Type.Object(p, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  token = Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" });
const uint = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  pos = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const literals = (values: string[]) => Type.Union(values.map((v) => Type.Literal(v)));
const process = closed({ bootId: id, pid: pos, starttime: Type.String({ pattern: "^[0-9]{1,32}$" }), uid: uint });
const managed = closed({
  ...process.properties,
  sid: pos,
  pgid: pos,
  role: literals(["helper", "shell", "foreground", "background", "descendant"]),
});
const entry = closed({
  identity: LegacyResourceIdentityV1Schema,
  agentProcessIdentity: process,
  managed: Type.Array(managed, { maxItems: 256 }),
  spawnState: literals(["pending", "settled"]),
  state: literals(["reserved", "starting", "live", "closing", "reaping", "poison"]),
});
const receiptReference = closed({ recordId: token, nonce: token, sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) });
const proof = closed({
  hubBootId: id,
  challengeId: id,
  linkGen: pos,
  inventoryId: id,
  revision: uint,
  identity: LegacyResourceIdentityV1Schema,
  agentProcessIdentity: process,
  proofId: id,
  receipt: Type.Optional(receiptReference),
  spawnSettled: Type.Literal(true),
  ptyClosed: Type.Literal(true),
  helperReaped: Type.Literal(true),
  managedGroupsGone: Type.Literal(true),
  identitiesChecked: Type.Array(managed, { maxItems: 256 }),
  outcome: Type.Literal("reaped"),
});
const journal = closed({
  v: Type.Literal(1),
  revision: uint,
  resources: Type.Array(closed({ entry, status: literals(["unresolved", "resolved"]), proof: Type.Optional(proof) }), {
    maxItems: 32,
  }),
});
const text = Type.String({ minLength: 1, maxLength: 256 });
const authority = closed({
  v: Type.Literal(1),
  recordId: token,
  nonce: token,
  storeId: token,
  agentNonce: text,
  sessionId: text,
  epoch: text,
  ownerInstance: text,
  process,
  namespaces: closed({ pid: text, mnt: text, user: text }),
  domain: literals(["plain", "secure", "unknown"]),
  main: Type.Boolean(),
  active: Type.Boolean(),
  createdAt: Type.Integer({ minimum: 0 }),
});
const receipt = closed({
  v: Type.Literal(1),
  recordId: token,
  nonce: token,
  storeId: token,
  ownerRecordId: token,
  identity: LegacyResourceIdentityV1Schema,
  agentProcessIdentity: process,
  physical: closed({
    outcome: Type.Literal("reaped"),
    spawnSettled: Type.Literal(true),
    ptyClosed: Type.Literal(true),
    helperReaped: Type.Literal(true),
    managedGroupsGone: Type.Literal(true),
    identitiesChecked: Type.Array(managed, { maxItems: 256 }),
    waited: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 256 }),
  }),
});
const marker = closed({ v: Type.Literal(1), storeId: token });
const fingerprint = closed({
  dev: uint,
  ino: uint,
  size: uint,
  mtimeMs: Type.Number(),
  ctimeMs: Type.Number(),
  hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
const archiveManifest = closed({
  v: Type.Literal(1),
  kind: Type.Literal("authority-retirement-only"),
  transaction: token,
  storeId: token,
  currentBoot: process,
  journalRevision: uint,
  journalHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  candidates: Type.Array(
    closed({ name: Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}\\.json$" }), process, fingerprint }),
    { maxItems: 256 },
  ),
});
export type OldProcessIdentity = Static<typeof process>;
export type OldJournal = Static<typeof journal>;
export type OldAuthority = Static<typeof authority>;
export type OldReceipt = Static<typeof receipt>;
const check = <T>(schema: Parameters<typeof Value.Check>[0], raw: unknown): T => {
  if (!Value.Check(schema, raw)) throw new Error("E_LEGACY_SOURCE_SHAPE");
  return raw as T;
};
export function parseOldJournal(raw: unknown): OldJournal {
  const result = check<OldJournal>(journal, raw),
    identities = new Set<string>(),
    reservations = new Set<string>();
  for (const row of result.resources) {
    const i = row.entry.identity,
      k = JSON.stringify([i.agentSessionId, i.termId, i.epoch, i.ownerInstance, i.reservationId]);
    if (identities.has(k) || reservations.has(i.reservationId)) throw new Error("E_LEGACY_DUPLICATE_RESOURCE");
    if (row.status === "resolved" && !row.proof) throw new Error("E_LEGACY_PROOF_IDENTITY");
    if (
      row.proof &&
      ["agentSessionId", "termId", "epoch", "ownerInstance", "reservationId"].some(
        (key) => row.proof!.identity[key as keyof typeof i] !== i[key as keyof typeof i],
      )
    )
      throw new Error("E_LEGACY_PROOF_IDENTITY");
    identities.add(k);
    reservations.add(i.reservationId);
  }
  return result;
}
export const parseOldMarker = (raw: unknown) => check<Static<typeof marker>>(marker, raw);
export const parseOldAuthority = (raw: unknown) => check<OldAuthority>(authority, raw);
export const parseOldReceipt = (raw: unknown) => check<OldReceipt>(receipt, raw);
export const parseOldArchiveManifest = (raw: unknown) => check<Static<typeof archiveManifest>>(archiveManifest, raw);
