/** Fork copies share envelope ids and timestamps. Caller owns the bounded scan lifetime. Pi-free. */
export interface RowDedupeKey {
  entryId?: string;
  at: number;
  digest: string;
  scriptKey: string;
}

/** Returns true exactly once per evidence row; absent ids use the conservative legacy key. */
export function createRowDeduper(): (row: RowDedupeKey) => boolean {
  const seen = new Set<string>();
  return (row) => {
    const key =
      row.entryId !== undefined
        ? `${row.entryId}\0${row.at}\0${row.digest}`
        : `${row.at}\0${row.digest}\0${row.scriptKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
