// §4.3 v2 edit-command helpers (str_replace / insert / delete / rename) —
// STUB (todo #22 P0-b's frozen-surface commit; real implementation lands in
// package P2, §14.1).

export interface StrReplaceMatch {
  line: number;
}

/** Not implemented yet (P2). Pure function — locates `oldStr` occurrences by
 *  line for the "exactly one match" / "ambiguous, list line numbers" rules. */
export function findStrReplaceMatches(_body: string, _oldStr: string): StrReplaceMatch[] {
  throw new Error("findStrReplaceMatches: not implemented yet (todo #22 P2)");
}

export interface InsertTarget {
  afterLine: number;
  note?: string;
}

/** Not implemented yet (P2). Pure function — §4.3's frontmatter-aware
 *  `insert_line`/`section` resolution. */
export function resolveInsertTarget(_body: string, _opts: { insertLine?: number; section?: string }): InsertTarget {
  throw new Error("resolveInsertTarget: not implemented yet (todo #22 P2)");
}
