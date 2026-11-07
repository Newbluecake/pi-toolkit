/**
 * jev-reflex · #25 B4 (Tier 2 — needs `mkfifo`): a FIFO named like a draft must not block the loader.
 * `open(O_RDONLY|O_NONBLOCK)` on a FIFO with no writer returns at once; the same-fd stat then says
 * "not a regular file" ⇒ `not-regular`. A blocking open would hang until the 500 ms budget (or forever).
 */
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../../src/core/clock.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { loadDrafts } from "../../../src/reflex/drafts/load.js";
import { queueDraft, tmpAgent, type TmpAgent } from "./helpers.js";

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
let agent: TmpAgent;
beforeEach(() => {
  agent = tmpAgent();
});
afterEach(() => agent.cleanup());

function mkfifo(path: string): boolean {
  try {
    execFileSync("mkfifo", [path], { stdio: "ignore" });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

describe("FIFO in the drafts directory", () => {
  it("open does not block; the entry is rejected not-regular; siblings still load", async (ctx) => {
    if (!mkfifo(join(agent.draftsDir, "pipe.json"))) ctx.skip();
    agent.write("good.json", queueDraft("draft.good"));
    const t0 = Date.now();
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, systemClock, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(400); // far below the 500 ms budget: nothing waited
    expect(r.failure).toBeUndefined(); // not a `timeout`
    expect(r.rejected).toEqual([{ file: "pipe.json", code: "not-regular" }]);
    expect(r.loaded.map((d) => d.script.id)).toEqual(["draft.good"]);
  });
});
