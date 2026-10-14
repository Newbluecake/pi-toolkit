import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_MAX_BYTES, createCatalogStore } from "../../src/external-agent/catalog-store.js";
import { catalogCachePath } from "../../src/external-agent/paths.js";
import type { ExternalCatalog } from "../../src/external-agent/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ptk-catalog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const cat = (over: Partial<ExternalCatalog> = {}): ExternalCatalog => ({
  provider: "droid",
  fetchedAt: 1_700_000_000_000,
  agentVersion: "0.241.1",
  protocolVersion: "1.264.0",
  binaryFingerprint: "/usr/bin/droid|1|2|3",
  models: [
    {
      id: "claude-sonnet-5",
      upstreamProvider: "anthropic",
      reasoningEfforts: ["low", "high"],
      defaultEffort: "low",
      deprecated: false,
      tokenMultiplier: 1.5,
    },
    { id: "auto", kind: "router", reasoningEfforts: [], deprecated: true },
  ],
  drift: { expected: "1.264.0", actual: "1.300.0" },
  ...over,
});

describe("catalog store", () => {
  it("round-trips including drift marker; file is 0600, dir 0700, no tmp left behind", () => {
    const s = createCatalogStore(dir);
    expect(s.read("droid")).toBeUndefined();
    s.write(cat());
    expect(s.read("droid")).toEqual(cat());
    const p = catalogCachePath(dir, "droid");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(p))).toEqual(["droid-catalog.json"]);
  });

  it("overwrite is atomic-replace (second write wins) and per-provider isolated", () => {
    const s = createCatalogStore(dir);
    s.write(cat());
    const { drift: _drift, ...noDrift } = cat();
    s.write({ ...noDrift, fetchedAt: 42 });
    expect(s.read("droid")?.fetchedAt).toBe(42);
    expect(s.read("droid")?.drift).toBeUndefined();
    expect(s.read("codex")).toBeUndefined();
  });

  it("corrupt / wrong-shape / wrong-provider / oversized files read as undefined", () => {
    const s = createCatalogStore(dir);
    const p = catalogCachePath(dir, "droid");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    expect(s.read("droid")).toBeUndefined();
    writeFileSync(p, JSON.stringify({ provider: "droid", fetchedAt: 1, models: [{ id: 5 }] }));
    expect(s.read("droid")).toBeUndefined();
    writeFileSync(p, JSON.stringify(cat({ provider: "other" })));
    expect(s.read("droid")).toBeUndefined();
    writeFileSync(p, JSON.stringify(cat({ drift: { expected: 1 } as never })));
    expect(s.read("droid")).toBeUndefined();
    writeFileSync(p, " ".repeat(CATALOG_MAX_BYTES + 1));
    expect(s.read("droid")).toBeUndefined();
    writeFileSync(p, JSON.stringify(cat()));
    expect(s.read("droid")).toEqual(cat());
  });

  it("oversized catalog is not written (warn once); failed writes are silent and warn once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = createCatalogStore(dir);
    const huge = cat({
      models: Array.from({ length: 4000 }, (_, i) => ({
        id: `m-${i}-${"x".repeat(60)}`,
        reasoningEfforts: ["low"],
        deprecated: false,
      })),
    });
    s.write(huge);
    s.write(huge);
    expect(s.read("droid")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // unwritable: agentDir is a regular file
    const f = join(dir, "file");
    writeFileSync(f, "x");
    const bad = createCatalogStore(f);
    expect(() => bad.write(cat())).not.toThrow();
    expect(() => bad.write(cat())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(readFileSync(f, "utf8")).toBe("x");
  });
});
