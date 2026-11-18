import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkpointTerminalV2 } from "../../scripts/web-hub/terminal-v2-checkpoint.js";
import {
  MaintenanceError,
  type MaintenanceAuditPort,
  type MaintenanceEvidence,
  type MaintenanceOptions,
} from "../../scripts/web-hub/terminal-v2-maintenance/audit.js";
import { setup, tree } from "./helpers.js";

describe("tool-only trust and production boundary", () => {
  it("production source has no maintenance reader/entry import, including dynamic references", () => {
    const matches: string[] = [];
    for (const path of globSync("src/**/*.{ts,js,vue}")) {
      const text = readFileSync(path, "utf8");
      if (/terminal-v2-(?:maintenance|checkpoint|rollback|retained)/.test(text)) matches.push(path);
    }
    expect(matches).toEqual([]);
  });

  it("no audit means no file read/write or implied drain", async () => {
    const h = setup(),
      before = tree(h.base);
    await expect(
      checkpointTerminalV2("fresh", { stateDir: h.stateDir, evidenceDir: h.evidenceDir } as MaintenanceOptions),
    ).rejects.toMatchObject({ code: "trusted-adapter-required" });
    expect(tree(h.base)).toEqual(before);
  });

  it("current only accepts own exact observations, never clones/another lease/old generations", async () => {
    const h = setup();
    const input = {
      stateDir: h.stateDir,
      operation: "fresh" as const,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
    };
    const a = await h.audit.acquire(input),
      snapshot = await a.observe();
    expect(a.current(snapshot)).toBe(true);
    expect(a.current({ ...snapshot })).toBe(false);
    await a.release();
    const b = await h.audit.acquire(input),
      next = await b.observe();
    expect(b.current(snapshot)).toBe(false);
    expect(b.current(next)).toBe(true);
    h.audit.generation++;
    expect(b.current(next)).toBe(false);
    await expect(b.revalidate(next)).rejects.toMatchObject({ code: "snapshot-not-current" });
    await b.release();
  });

  it("engine refuses forged observation not registered by a lease", async () => {
    const h = setup(),
      before = tree(h.base);
    const acquire = h.audit.acquire.bind(h.audit);
    const audit: MaintenanceAuditPort = {
      async acquire(input) {
        const lease = await acquire(input),
          observe = lease.observe;
        lease.observe = async () => ({ ...(await observe()) });
        return lease;
      },
    };
    await expect(checkpointTerminalV2("fresh", { ...h.options, audit })).rejects.toMatchObject({
      code: "lease-invalidated",
    });
    expect(tree(h.base)).toEqual(before);
  });

  it("stale generation after asynchronous observation cannot mutate", async () => {
    const h = setup(),
      before = tree(h.base);
    h.audit.onRevalidate = () => {
      h.audit.generation++;
    };
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toBeInstanceOf(MaintenanceError);
    expect(tree(h.base)).toEqual(before);
  });

  it("late acquire is released, never adopted after abort", async () => {
    const h = setup(),
      before = tree(h.base),
      c = new AbortController();
    let deliver!: () => void;
    const acquire = h.audit.acquire.bind(h.audit);
    const audit: MaintenanceAuditPort = {
      async acquire(input) {
        const lease = await acquire(input);
        await new Promise<void>((resolve) => {
          deliver = resolve;
        });
        return lease;
      },
    };
    const pending = checkpointTerminalV2("fresh", { ...h.options, audit, signal: c.signal });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(deliver).toBeTypeOf("function");
    c.abort();
    await expect(pending).rejects.toMatchObject({ code: "maintenance-deadline" });
    expect(h.audit.locked).toBe(true);
    deliver();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.audit.releaseCount).toBe(1);
    expect(h.audit.observations).toBe(0);
    expect(tree(h.base)).toEqual(before);
  });

  it("pre-aborted operation never acquires or touches paths", async () => {
    const h = setup(),
      before = tree(h.base),
      c = new AbortController();
    c.abort();
    await expect(checkpointTerminalV2("fresh", { ...h.options, signal: c.signal })).rejects.toMatchObject({
      code: "maintenance-deadline",
    });
    expect(h.audit.observations).toBe(0);
    expect(tree(h.base)).toEqual(before);
  });

  it("abort at in-flight observation seals late success and releases lease without state mutation", async () => {
    const h = setup(),
      before = tree(h.base),
      c = new AbortController();
    let resolveObservation!: (evidence: MaintenanceEvidence) => void, observed!: MaintenanceEvidence;
    const acquire = h.audit.acquire.bind(h.audit);
    const audit: MaintenanceAuditPort = {
      async acquire(input) {
        const lease = await acquire(input);
        observed = await lease.observe();
        lease.observe = () =>
          new Promise((resolve) => {
            resolveObservation = resolve;
          });
        return lease;
      },
    };
    const result = checkpointTerminalV2("fresh", { ...h.options, signal: c.signal, audit });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(resolveObservation).toBeTypeOf("function");
    c.abort();
    await expect(result).rejects.toMatchObject({ code: "maintenance-deadline" });
    resolveObservation(observed);
    await Promise.resolve();
    expect(tree(h.base)).toEqual(before);
    expect(h.audit.locked).toBe(false);
  });
});
