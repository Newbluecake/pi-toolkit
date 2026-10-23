import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { freePort, freePortRange } from "./free-port.js";

async function bindable(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

describe("tests/helpers/free-port", () => {
  it("returns ports inside the sub-ephemeral region, bindable on 127.0.0.1 and 0.0.0.0", async () => {
    for (let i = 0; i < 8; i++) {
      const port = await freePort();
      expect(port).toBeGreaterThanOrEqual(10_000);
      expect(port).toBeLessThan(32_000);
      expect(await bindable(port, "127.0.0.1")).toBe(true);
      expect(await bindable(port, "0.0.0.0")).toBe(true);
    }
  });

  it("never returns the same port twice in one process", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) seen.add(await freePort());
    expect(seen.size).toBe(64);
  });

  it("skips candidates that are already bound", async () => {
    // Occupy a swath of the region; the allocator must route around every occupied port.
    const blockers = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const port = await freePort(); // allocated ⇒ marked, but also REALLY bind it now
        const srv = createServer();
        await new Promise<void>((resolve, reject) => {
          srv.once("error", reject);
          srv.listen(port, "0.0.0.0", () => resolve());
        });
        return { srv, port };
      }),
    );
    try {
      // Rebinding a held port must fail (sanity), and fresh allocations still succeed.
      for (const { port } of blockers) expect(await bindable(port, "0.0.0.0")).toBe(false);
      const next = await freePort();
      expect(blockers.some((b) => b.port === next)).toBe(false);
      expect(await bindable(next, "0.0.0.0")).toBe(true);
    } finally {
      for (const { srv } of blockers) await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("freePortRange returns n contiguous bindable ports that never overlap a prior allocation", async () => {
    const single = await freePort();
    const [base, last] = await freePortRange(16);
    expect(last - base).toBe(15);
    expect(single < base || single > last).toBe(true);
    const [base2, last2] = await freePortRange(4);
    expect(last2 - base2).toBe(3);
    expect(last2 < base || base2 > last).toBe(true);
    for (let p = base; p <= last; p++) expect(await bindable(p, "0.0.0.0")).toBe(true);
    for (let p = base2; p <= last2; p++) expect(await bindable(p, "127.0.0.1")).toBe(true);
  });

  it("freePortRange rejects a non-positive or oversized n", async () => {
    await expect(freePortRange(0)).rejects.toBeInstanceOf(RangeError);
    await expect(freePortRange(100_000)).rejects.toBeInstanceOf(RangeError);
  });
});
