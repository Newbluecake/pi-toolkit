import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  linuxFlockAcquire,
  SCHED_LOCK_RETRY_MS,
  SCHED_LOCK_SHUTDOWN_TIMEOUT_MS,
  SCHED_LOCK_TIMEOUT_MS,
} from "../../../src/schedule/core/lock.js";
import { fdPath, linuxPathBackend, lstatAt } from "../../../src/schedule/core/paths.js";
import {
  judgeHolder,
  procLivenessProbe,
  SCHED_EPOCH_MS_FLOOR,
  startDomainOf,
  type LivenessProbe,
} from "../../../src/schedule/core/recovery.js";
import { FDPATH_MANIFEST } from "./fdpath-manifest.js";

const ROOT = join(import.meta.dirname, "../../..");

describe("schedule P0 seams", () => {
  it("keeps Linux path formatting and lstat delegation byte-compatible", () => {
    for (const fd of [0, 3, 4096]) {
      for (const name of [undefined, "a", "a/b", "reports/x", "x y"]) {
        expect(fdPath(fd, name)).toBe(name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);
      }
    }
    expect(linuxPathBackend.platform).toBe("linux");
    expect(lstatAt).toBeTypeOf("function");
  });

  it("classifies start domains and rejects cross-domain liveness comparisons", () => {
    expect(startDomainOf(SCHED_EPOCH_MS_FLOOR - 1)).toBe("ticks");
    expect(startDomainOf(SCHED_EPOCH_MS_FLOOR)).toBe("epoch-ms");
    const probe: LivenessProbe = { startDomain: "ticks", startOf: () => 123, pidMayExist: () => true };
    expect(
      judgeHolder(
        { pid: 44, start: SCHED_EPOCH_MS_FLOOR, host: "h", boot: "b" },
        { pid: 1, start: 2, host: "h", boot: "b" },
        { probe },
      ),
    ).toEqual({ liveness: "unprovable" });
    expect(procLivenessProbe.startDomain).toBeUndefined();
  });

  it("preserves flock invocation parameters and lock timing constants", () => {
    let invocation: unknown;
    const acquire = linuxFlockAcquire("flock", {
      spawn: ((...args: unknown[]) => {
        invocation = args;
        return { status: 0, signal: null, pid: 1, output: [], stdout: null, stderr: null } as never;
      }) as never,
    });
    expect(acquire(19)).toBe("held");
    expect(invocation).toEqual([
      "flock",
      ["-x", "-n", "-E", "75", "3"],
      {
        stdio: ["ignore", "ignore", "ignore", 19],
        timeout: 5_000,
      },
    ]);
    expect(SCHED_LOCK_RETRY_MS).toBe(25);
    expect(SCHED_LOCK_TIMEOUT_MS).toBe(2_000);
    expect(SCHED_LOCK_SHUTDOWN_TIMEOUT_MS).toBe(500);
  });

  it("keeps the fdPath expression inventory pinned", () => {
    const counts = new Map<string, number>();
    for (const file of ["lock.ts", "paths.ts", "reader.ts", "writer.ts"]) {
      const source = readFileSync(join(ROOT, `src/schedule/core/${file}`), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = source.split("\n");
      let fn = "";
      for (const line of lines) {
        const declaration = line.match(/(?:async\s+)?function\s+(\w+)/);
        if (declaration) fn = declaration[1]!;
        const matches = [...line.matchAll(/\bfdPath\(/g)].length;
        if (matches) counts.set(`${file}:${fn}`, (counts.get(`${file}:${fn}`) ?? 0) + matches);
      }
    }
    const expected = new Map(FDPATH_MANIFEST.map(([file, fn, n]) => [`${file}:${fn}`, n]));
    const actualTotal = [...counts.values()].reduce((a, b) => a + b, 0);
    const expectedTotal = [...expected.values()].reduce((a, b) => a + b, 0);
    expect(actualTotal).toBe(expectedTotal);
    // Per-key comparison for every file, including paths.ts: the declaration line
    // `export function fdPath(` counts as its own "paths.ts:fdPath" bucket (fn is set
    // before the same-line match), so a moved/renamed call site is caught exactly.
    for (const file of ["lock.ts", "paths.ts", "reader.ts", "writer.ts"]) {
      const actual = [...counts].filter(([key]) => key.startsWith(`${file}:`)).map(([key, n]) => [key, n]);
      const declared = [...expected].filter(([key]) => key.startsWith(`${file}:`)).map(([key, n]) => [key, n]);
      expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(declared));
    }
  });
});
