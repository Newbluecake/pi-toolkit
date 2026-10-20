import { describe, expect, it, vi } from "vitest";
import { createQueryService } from "../../src/service/query-service.js";
import type { RunRegistry, Runner } from "../../src/service/ports.js";
import type { RunSnapshot } from "../../src/core/types.js";

/**
 * fabric-cross-session plan §3.3 seam B (W1): `QueryService.steer(id, text, origin?)` reports the ACCEPTED steer's origin
 * level through `deps.onSteered` — and only then. Origin omitted ⇒ undefined (the wiring resolves it to the root level).
 */
const id = "r_TARGET01";
const snap = (status: RunSnapshot["status"]) => ({ runId: id, status }) as RunSnapshot;
function make(
  status: RunSnapshot["status"],
  steer: Runner["steer"],
  onSteered?: (id: string, l: number | undefined) => void,
) {
  const registry: RunRegistry = { get: (r) => (r === id ? snap(status) : undefined), list: () => [] };
  const runner = { run: vi.fn(), ...(steer ? { steer } : {}) } as unknown as Runner;
  return createQueryService({ registry, runner, ...(onSteered ? { onSteered } : {}) });
}

describe("QueryService.steer origin (seam B)", () => {
  it("reports the caller's origin level after an accepted steer; omitted origin ⇒ undefined", async () => {
    const seen: Array<[string, number | undefined]> = [];
    const q = make(
      "running",
      async () => undefined,
      (r, l) => void seen.push([r, l]),
    );
    expect(await q.steer(id, "a")).toEqual({ ok: true });
    expect(await q.steer(id, "b", { level: 0 })).toEqual({ ok: true });
    expect(await q.steer(id, "c", { level: 2 })).toEqual({ ok: true });
    expect(seen).toEqual([
      [id, undefined],
      [id, 0],
      [id, 2],
    ]);
  });

  it("never reports for a refused steer (not running / runner rejects)", async () => {
    const seen: unknown[] = [];
    const onSteered = (r: string) => void seen.push(r);
    expect(await make("completed", async () => undefined, onSteered).steer(id, "x", { level: 1 })).toEqual({
      ok: false,
      reason: "not_running",
    });
    const rejected = make("running", async () => Promise.reject(new Error("no active session")), onSteered);
    expect(await rejected.steer(id, "x", { level: 1 })).toMatchObject({ ok: false, reason: "steer_rejected" });
    expect(seen).toEqual([]);
  });

  it("a throwing onSteered never turns an accepted steer into a failure; no dep ⇒ unchanged", async () => {
    const boom = make(
      "running",
      async () => undefined,
      () => {
        throw new Error("level exploded");
      },
    );
    expect(await boom.steer(id, "x")).toEqual({ ok: true });
    expect(await make("running", async () => undefined).steer(id, "x", { level: 3 })).toEqual({ ok: true });
  });
});
