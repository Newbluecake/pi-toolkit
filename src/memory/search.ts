// §4.3 `search` command — STUB (todo #22 P0-b's frozen-surface commit; real
// implementation lands in package P2, §14.1).

export interface MemorySearchHit {
  file: string;
  line: number;
  section?: string;
  text: string;
}

/** Not implemented yet (P2). Pure function over already-read file bodies —
 *  §4.3's whitespace-tokenized, case-insensitive, literal (never regex)
 *  multi-word scoring. */
export function searchMemory(_files: readonly { name: string; body: string }[], _query: string): MemorySearchHit[] {
  throw new Error("searchMemory: not implemented yet (todo #22 P2)");
}
