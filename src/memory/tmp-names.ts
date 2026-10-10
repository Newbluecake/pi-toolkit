/**
 * The single transaction temporary-name grammar from tidy-batch §9.1.
 * This module is deliberately pi-free and does not touch the filesystem.
 */

export const TMP_KINDS = {
  b: "op-backup",
  c: "op-content",
  m: "manifest",
  l: "lock",
  e: "lease",
  p: "probe",
  o: "epoch",
} as const;

export type TmpKind = keyof typeof TMP_KINDS;

/** All transaction tmp names must match this expression; callers must not
 * derive names from memory filenames. */
export const TMP_RE = /^\.pt-([0-9a-f]{8})-(\d{1,6})-([bcmlepo])\.tmp$/;

const TMP_KIND_RE = /^[bcmlepo]$/;
const NON_OPERATION_KINDS: readonly TmpKind[] = ["m", "l", "e", "p", "o"];

function validNonce(nonce8: string): boolean {
  return /^[0-9a-f]{8}$/.test(nonce8);
}

function validSequence(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 0 && seq <= 999_999;
}

/** Build a grammar-checked temporary name. Non-operation kinds use sequence
 * zero; operation backup/content names carry their operation sequence. */
export function tmpNameFor(nonce8: string, seq: number, kind: TmpKind): string {
  if (!validNonce(nonce8)) throw new Error("invalid tmp nonce: expected 8 lowercase hex characters");
  if (!validSequence(seq)) throw new Error("invalid tmp sequence: expected an integer from 0 to 999999");
  if (!TMP_KIND_RE.test(kind) || !Object.prototype.hasOwnProperty.call(TMP_KINDS, kind)) {
    throw new Error(`invalid tmp kind: ${String(kind)}`);
  }
  if (NON_OPERATION_KINDS.includes(kind) && seq !== 0) {
    throw new Error(`tmp kind ${kind} requires sequence 0`);
  }
  const name = `.pt-${nonce8}-${String(seq)}-${kind}.tmp`;
  if (!TMP_RE.test(name)) throw new Error("generated tmp name does not match TMP_RE");
  return name;
}

/** Parse a grammar-checked transaction tmp name, returning undefined for all
 * legacy or otherwise unrelated temporary names. */
export function parseTmpName(name: string): { nonce8: string; seq: number; kind: TmpKind } | undefined {
  const match = TMP_RE.exec(name);
  if (!match) return undefined;
  const nonce8 = match[1];
  const rawSeq = match[2];
  const kind = match[3];
  if (nonce8 === undefined || rawSeq === undefined || kind === undefined || !TMP_KIND_RE.test(kind)) return undefined;
  const seq = Number(rawSeq);
  if (!validSequence(seq) || !Object.prototype.hasOwnProperty.call(TMP_KINDS, kind)) return undefined;
  if (NON_OPERATION_KINDS.includes(kind as TmpKind) && seq !== 0) return undefined;
  return { nonce8, seq, kind: kind as TmpKind };
}
