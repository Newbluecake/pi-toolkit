// User-order guard pairing (Q4, v4.1 §3.2 adopted per jev-arch §6.2.5 /
// jev-plan J1). Pure function; pi-free root; no module state (I4).
//
// Pairing is CONTENT-hash based — line numbers are only an ordering hint.
// For every distinct guardHash held by `before`'s user-authority entries,
// `after` (any authority — flipping `user` to `lesson` changes the raw text
// and therefore the hash) must contain at least as many occurrences; every
// missing copy marks one user entry as touched. Pure insertions and pure
// line shifts never trigger (§3.2's three canonical cases:
// top-of-file insert ⇒ no confirm; one character edited ⇒ confirm; one of
// two identical duplicate rows deleted ⇒ confirm).

import { splitEntries } from "./entries.js";
import type { MemEntry } from "./contracts.js";

export function touchedUserEntries(before: string, after: string, handWritten: boolean): MemEntry[] {
  const beforeEntries = splitEntries("file.md", before, { status: "active", handWritten }).filter(
    (e) => e.authority === "user",
  );
  if (beforeEntries.length === 0) return [];
  const afterCounts = new Map<string, number>();
  for (const entry of splitEntries("file.md", after, { status: "active", handWritten })) {
    afterCounts.set(entry.guardHash, (afterCounts.get(entry.guardHash) ?? 0) + 1);
  }
  const touched: MemEntry[] = [];
  const consumed = new Map<string, number>();
  for (const entry of beforeEntries) {
    const used = consumed.get(entry.guardHash) ?? 0;
    consumed.set(entry.guardHash, used + 1);
    if (used >= (afterCounts.get(entry.guardHash) ?? 0)) touched.push(entry);
  }
  return touched;
}
