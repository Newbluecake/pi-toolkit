/**
 * jev-reflex · #25 B0 evidence identity (BA §4.5, Major 7 / K8): which rows count as "the same
 * script" when promotion evidence accumulates. Identity = `lineage + templateHash` — renaming a
 * draft into the catalog (`lineage:"draft.x"`) keeps its repeat/correction history, while any
 * template change (even without a version bump) splits the evidence. Pure, pi-free.
 */

import { createHash } from "node:crypto";
import type { EvidenceIdentity, PortId, RScriptV1 } from "./types.js";

/** Stable key order for hashing: recursive JSON key sort (arrays keep order). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Matching-semantics hash: covers ONLY `{port.id, intent.strong/weak/exclude}` (BA §4.5).
 * Invariant: changing `id`/`version`/`origin`/`lineage`/render/agreement/examples leaves it;
 * changing ANY template source (or the port) changes it.
 */
export function templateHash(s: RScriptV1): string {
  return sha16(
    canonicalJson({
      port: { id: s.port.id },
      intent: {
        strong: [...s.intent.strong],
        weak: [...s.intent.weak],
        exclude: [...s.intent.exclude],
      },
    }),
  );
}

/** Whole-document hash (canonical JSON of the entire script) — audit only (BA §4.5): a hand edit
 *  without a version bump is visible as a draftHash change while templateHash may stay equal. */
export function draftHash(s: RScriptV1): string {
  return sha16(canonicalJson(s));
}

export const identityKey = (i: EvidenceIdentity): string => `${i.lineage}#${i.templateHash}`;

/** What the promotion fold knows about one row (BA §4.5 signature + the port fields V2 needs). */
export interface IdentityRow {
  scriptId: string;
  scriptVer: number;
  /** Present on draft rows and draft-targeted corrections (written only when drafts are enabled). */
  templateHash?: string;
  portId?: PortId;
  portVer?: number;
}

/**
 * Resolve a row's identity against the CURRENT catalog and loaded drafts (BA §4.5):
 *  - a row carrying `templateHash` (draft row / draft-targeted correction) binds to THAT hash —
 *    the recorded hash is authoritative even if the draft file is gone; lineage comes from the
 *    matching script when one is loaded, else from the row's own id;
 *  - a builtin row whose `id@ver` matches the current catalog takes the catalog's hash+lineage;
 *  - anything else (an old-version builtin, an unknown id) is a LEGACY identity
 *    `${id}@${ver}#legacy` (identityKey form) that never merges with any new identity.
 * Returns undefined only when not even the port can be determined.
 */
export function resolveIdentity(
  row: IdentityRow,
  catalog: readonly RScriptV1[],
  drafts: readonly RScriptV1[],
): EvidenceIdentity | undefined {
  const byId = [...drafts, ...catalog].find((s) => s.id === row.scriptId);
  const portId: PortId | undefined = row.portId ?? byId?.port.id;
  const exact = [...drafts, ...catalog].find((s) => s.id === row.scriptId && s.version === row.scriptVer) ?? undefined;
  if (row.templateHash !== undefined) {
    if (portId === undefined) return undefined;
    return {
      lineage: exact?.lineage ?? byId?.lineage ?? row.scriptId,
      templateHash: row.templateHash,
      portId,
      portVer: row.portVer ?? 0,
    };
  }
  if (exact !== undefined) {
    return {
      lineage: exact.lineage ?? exact.id,
      templateHash: templateHash(exact),
      portId: portId ?? exact.port.id,
      portVer: row.portVer ?? 0,
    };
  }
  // legacy: key `${id}@${ver}#legacy` (split into lineage/templateHash so identityKey renders it)
  if (portId === undefined) return undefined;
  return {
    lineage: `${row.scriptId}@${row.scriptVer}`,
    templateHash: "legacy",
    portId,
    portVer: row.portVer ?? 0,
  };
}
