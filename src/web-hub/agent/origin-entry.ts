export interface OriginEntry {
  cmdId: string;
  op: string;
  reqId8: string;
}
export function createOriginEntry(): { append(entry: OriginEntry): void; dispose(): void } {
  return { append() {}, dispose() {} };
}
