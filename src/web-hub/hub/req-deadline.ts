export interface ReqDeadline {
  readonly at: number;
  remaining(): number;
  expired(): boolean;
}
export function createReqDeadline(now: () => number, totalMs: number): ReqDeadline {
  const at = now() + Math.max(0, totalMs);
  return { at, remaining: () => Math.max(0, at - now()), expired: () => now() >= at };
}
export async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error("E_DEADLINE")), Math.max(0, ms));
      t.unref();
    }),
  ]);
}
