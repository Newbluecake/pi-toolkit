/** F8 bounded ownership primitives. Production clocks unref every timer. */
import { createHash } from "node:crypto";
import { systemFeishuClock, type FeishuClock } from "./http.js";

export const feishuKey = (text: string): string => createHash("sha256").update(text).digest("base64url").slice(0, 40);
export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export function messageText(message: unknown): string {
  const m = object(message);
  if (typeof m?.["content"] === "string") return m["content"];
  if (!Array.isArray(m?.["content"])) return "";
  return m["content"]
    .map(object)
    .filter((x) => x?.["type"] === "text")
    .map((x) => (typeof x?.["text"] === "string" ? x["text"] : ""))
    .join("");
}
export async function bounded<T>(work: Promise<T>, ms: number, clock: FeishuClock = systemFeishuClock): Promise<T> {
  let timer: unknown;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error("feishu-deadline")), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}
/** Slots follow the REAL promise lifetime, not a timeout wrapper (zombie work cannot accumulate). */
export function createFeishuWork(clock: FeishuClock, onError: () => void, cap = 256) {
  const tasks = new Set<Promise<unknown>>();
  let closed = false;
  return {
    run(work: () => Promise<unknown>): boolean {
      if (closed || tasks.size >= cap) return false;
      const p = Promise.resolve().then(work);
      tasks.add(p);
      void p.catch(onError).finally(() => tasks.delete(p));
      return true;
    },
    async drain(ms: number) {
      try {
        await bounded(Promise.allSettled([...tasks]), ms, clock);
      } catch {
        /* budget */
      }
    },
    close() {
      closed = true;
    },
    get size() {
      return tasks.size;
    },
  };
}
