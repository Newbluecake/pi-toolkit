/** Fixed retained contract mapping. Never invent a principal/sid/agentKey or infer release.
 * Inputs are captured by the tool's pinned O reader, not CLI proof JSON. */
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  LegacyResourceIdentityV1Schema,
  LegacyUnattributedObligationV1Schema,
  type LegacyResourceIdentityV1,
  type LegacyUnattributedObligationV1,
} from "../../../src/web-hub/protocol/terminal-v2.js";
export interface CapturedLegacyResource {
  identity: LegacyResourceIdentityV1;
  recordKey: string;
  sessionVerified: boolean;
  bootId?: string;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export function canonicalLegacyIdentity(identity: LegacyResourceIdentityV1): string {
  if (!Value.Check(LegacyResourceIdentityV1Schema, identity)) throw new Error("E_LEGACY_IDENTITY");
  return JSON.stringify([
    identity.agentSessionId,
    identity.termId,
    identity.epoch,
    identity.ownerInstance,
    identity.reservationId,
  ]);
}
export function mapRetainedObligations(
  installation: string,
  manifest: string,
  records: readonly CapturedLegacyResource[],
): LegacyUnattributedObligationV1[] {
  if (!/^[a-f0-9]{64}$/.test(installation) || !/^[a-f0-9]{64}$/.test(manifest)) throw new Error("E_SOURCE_BINDING");
  const mapped = new Map<string, LegacyUnattributedObligationV1>();
  for (const record of records) {
    const identity = canonicalLegacyIdentity(record.identity);
    if (
      record.recordKey.startsWith("/") ||
      record.recordKey.split("/").includes("..") ||
      record.recordKey.includes("\\")
    )
      throw new Error("E_SOURCE_RECORD");
    if (
      record.bootId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.bootId)
    )
      throw new Error("E_SOURCE_BOOT");
    const old = mapped.get(identity);
    if (old) {
      if (
        record.bootId !== undefined &&
        old.kernelBinding.kind === "known" &&
        old.kernelBinding.bootId !== record.bootId
      )
        throw new Error("E_SOURCE_IDENTITY_CONFLICT");
      if (record.bootId !== undefined) old.kernelBinding = { kind: "known", bootId: record.bootId };
      if (!record.sessionVerified) old.sessionBinding = { kind: "unattributed" };
      if (!old.sourceRecordKeys.includes(record.recordKey)) old.sourceRecordKeys.push(record.recordKey);
      old.sourceRecordKeys.sort();
      if (!Value.Check(LegacyUnattributedObligationV1Schema, old)) throw new Error("E_SOURCE_RECORD");
      continue;
    }
    const row: LegacyUnattributedObligationV1 = {
      kind: "legacy-unattributed",
      obligationId: sha(`pi-subagent:legacy-obligation:1\0${installation}\0${identity}`),
      sourceInstallationId: installation,
      legacyIdentity: structuredClone(record.identity),
      sourceManifestSha256: manifest,
      sourceRecordKeys: [record.recordKey],
      sessionBinding: record.sessionVerified
        ? { kind: "verified", sessionId: record.identity.agentSessionId }
        : { kind: "unattributed" },
      kernelBinding: record.bootId === undefined ? { kind: "unknown" } : { kind: "known", bootId: record.bootId },
    };
    if (
      !Value.Check(LegacyUnattributedObligationV1Schema, row) ||
      record.recordKey.startsWith("/") ||
      record.recordKey.split("/").includes("..") ||
      record.recordKey.includes("\\")
    )
      throw new Error("E_SOURCE_RECORD");
    mapped.set(identity, row);
  }
  return [...mapped.values()].sort((a, b) => a.obligationId.localeCompare(b.obligationId));
}
