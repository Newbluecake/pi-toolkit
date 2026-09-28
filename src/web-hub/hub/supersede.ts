export interface SupersedeState {
  nextVersion: string;
  since: number;
  deadlineAt: number;
  forced?: boolean;
}
export function createSupersede(): { state(): SupersedeState | undefined; dispose(): void } {
  return { state: () => undefined, dispose() {} };
}
