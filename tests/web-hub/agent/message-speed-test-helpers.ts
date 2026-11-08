import { expect } from "vitest";

/** Verify all three fail-closed surfaces after the assistant message has been projected. */
export function expectHidden(events: Array<{ type: string; message?: unknown }>, endResult: unknown, writes: number) {
  const event = events.findLast(
    (e) => e.type === "message_end" && (e.message as { role?: unknown } | undefined)?.role === "assistant",
  );
  expect(event).toBeDefined();
  expect(event?.message).toBeDefined();
  expect(endResult).toBeUndefined();
  expect(event!.message).not.toHaveProperty("piToolkitGeneration");
  expect(writes).toBe(0);
}
