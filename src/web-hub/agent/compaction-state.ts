export interface CompactionState {
  manualCompacting: boolean;
  dispose(): void;
}
export function createCompactionState(): CompactionState {
  return { manualCompacting: false, dispose() {} };
}
