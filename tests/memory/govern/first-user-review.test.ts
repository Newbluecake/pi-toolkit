import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import { firstUserReviewPass, firstReviewFingerprintRow } from "../../../src/memory/govern/review-lite.js";
import { createFirstUserReviewHost } from "../../../src/memory/jev/first-user-review.js";
import type { JevClient, JevRequest } from "../../../src/memory/jev/contracts.js";
import * as lock from "../../../src/memory/lock.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { handleReviewLite } from "../../../src/memory/govern/review-lite.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";

class ManualClock extends FakeClock {}
const roots: string[] = [];
const date = new Date("2026-11-08T09:00:00.000Z");
function fixture(n = 0) {
  const dir = mkdtempSync(join(tmpdir(), "first-review-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(
    join(dir, "blocks/.layout.json"),
    JSON.stringify({ v: 1, source: "migrate", gen: 1, runId: "20261108T090000000Z-123-abcdef" }),
  );
  const blocks = Array.from({ length: n }, (_, i) =>
    createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, `body ${i}`, date),
  );
  return { dir, blocks };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function client(ask: JevClient["ask"]): JevClient {
  return { ask, status: () => ({ kind: "full", model: "fake" }), probe: async () => ({ kind: "full", model: "fake" }) };
}
function valid(req: JevRequest) {
  return {
    ok: true as const,
    model: "fake",
    missing: [],
    costUsd: 0,
    latencyMs: 0,
    answers: Object.fromEntries(
      Object.keys(req.questions).map((id) => [id, { type: "bool" as const, probability: 0.9 }]),
    ),
  };
}
function host(dir: string, c: JevClient, extra: Partial<Parameters<typeof createFirstUserReviewHost>[0]> = {}) {
  return createFirstUserReviewHost({
    memDir: dir,
    enabled: true,
    jevEnabled: true,
    isChild: false,
    client: c,
    registry: {
      getAvailableOfType: async () => [],
      getModelOfType: () => ({}),
      classify: async () => {
        throw new Error("no real model");
      },
    },
    isCurrent: () => true,
    ...extra,
  });
}
const marker = (dir: string) => existsSync(join(dir, "blocks/.jev/governance-markers.json"));

it("sends only aliases and redacted excerpts, batches 61 pairs in four requests, persists and deduplicates", async () => {
  const { dir } = fixture(33);
  const requests: JevRequest[] = [];
  const h = host(
    dir,
    client(async (r) => {
      requests.push(r);
      return valid(r);
    }),
  );
  const result = await h.run();
  expect(result.status).toBe("completed");
  expect(result.review?.plan).toMatchObject({ eligibleUsers: 33, selectedUsers: 32, plannedPairs: 61 });
  expect(requests.map((r) => Object.keys(r.questions).length)).toEqual([16, 16, 16, 13]);
  for (const r of requests) {
    expect(Object.keys(r.state)).toEqual(Object.keys(r.questions));
    expect(JSON.stringify(r.state)).not.toContain("rule.");
    for (const [id, excerpts] of Object.entries(r.state)) {
      expect(id).toMatch(/^p\d+$/);
      expect(excerpts).toHaveLength(2);
      expect((excerpts as string[]).every((s) => Array.from(s).length <= 400)).toBe(true);
    }
  }
  expect(marker(dir)).toBe(true);
  expect((await h.run()).status).toBe("skipped");
  expect(requests).toHaveLength(4);
});

it("zero pairs complete without model calls; off and fresh do not create markers", async () => {
  const { dir } = fixture();
  let calls = 0;
  const c = client(async (r) => {
    calls++;
    return valid(r);
  });
  expect((await host(dir, c, { enabled: false }).run()).status).toBe("skipped");
  expect(marker(dir)).toBe(false);
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  expect((await host(dir, c).run()).status).toBe("skipped");
  expect(marker(dir)).toBe(false);
  writeFileSync(
    join(dir, "blocks/.layout.json"),
    JSON.stringify({ v: 1, source: "migrate", gen: 1, runId: "20261108T090000000Z-123-abcdef" }),
  );
  expect((await host(dir, c).run()).status).toBe("completed");
  expect(calls).toBe(0);
  expect(marker(dir)).toBe(true);
});

it.each(["missing", "duplicate", "unknown", "invalid", "exception", "cas"])(
  "core rejects %s without completeness",
  async (mode) => {
    const { dir, blocks } = fixture(2);
    const r = await firstUserReviewPass(dir, async (plan) => {
      const pair = plan.pairs[0]!;
      const answer = { a: pair.a, b: pair.b, p: 0.9 };
      if (mode === "missing") return [];
      if (mode === "duplicate") return [answer, answer];
      if (mode === "unknown") return [{ ...answer, b: "unknown" }];
      if (mode === "invalid") return [{ ...answer, p: NaN }];
      if (mode === "exception") throw new Error("failure");
      const b = blocks[0]!;
      replaceBlockLocked(join(dir, "blocks"), b.id, b.rev, { meta: b.meta, body: "changed" }, date);
      return [answer];
    });
    expect(r.complete).toBe(false);
    expect(r.suggestionsWritten).toBe(false);
    if (mode === "cas") expect(r.casFailures).toEqual([{ a: blocks[0]!.id, b: blocks[1]!.id }]);
    expect(readIndex(dir).index.review).toBeUndefined();
  },
);

it("33rd eligible revision changes full fingerprint", async () => {
  const { dir, blocks } = fixture(33);
  const run = () => firstUserReviewPass(dir, async (p) => p.pairs.map(({ a, b }) => ({ a, b, p: 0 })));
  const a = await run();
  const b = blocks[32]!;
  replaceBlockLocked(join(dir, "blocks"), b.id, b.rev, { meta: b.meta, body: "changed outside selected" }, date);
  const c = await run();
  expect(a.complete).toBe(true);
  expect(c.complete).toBe(true);
  expect(c.plan?.corpusFp).not.toBe(a.plan?.corpusFp);
});

it("timeout cancels an uncooperative provider and never writes a marker", async () => {
  const { dir } = fixture(2);
  const clock = new ManualClock(date.getTime());
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const h = host(
    dir,
    client(async () => {
      entered();
      return new Promise(() => {});
    }),
    { clock },
  );
  const pending = h.run();
  await started;
  clock.advance(6000);
  expect((await pending).status).toBe("incomplete");
  expect(marker(dir)).toBe(false);
  expect(clock.pendingTimers).toBe(0);
});

it("filters private, secrets, agents, residue and masks eligible excerpts", async () => {
  const { dir } = fixture();
  const add = (meta: Parameters<typeof createBlockLocked>[2], body: string) =>
    createBlockLocked(join(dir, "blocks"), "rule", meta, body, date);
  add({ authority: "user" }, "contact alice@example.com");
  add({ authority: "user", expires: "2020-01-01" }, "public second");
  add({ authority: "user", private: true }, "private content");
  add({ authority: "user" }, "api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890");
  add({ authority: "agent" }, "agent text");
  add({ authority: "user", residue: true }, "residue text");
  let captured = "";
  const result = await host(
    dir,
    client(async (r) => {
      captured += JSON.stringify(r.state);
      return valid(r);
    }),
  ).run();
  expect(result.status).toBe("completed");
  expect(result.review?.plan?.eligibleUsers).toBe(2);
  expect(captured).toContain("[EMAIL]");
  expect(captured).not.toContain("alice@example.com");
  for (const text of ["private content", "abcdefghijklmnopqrstuvwxyz", "agent text", "residue text"])
    expect(captured).not.toContain(text);
});

it("permanently dismissed pairs are skipped before asking and count as complete", async () => {
  const { dir } = fixture(2);
  const c = client(async (r) => valid(r));
  expect((await host(dir, c).run()).status).toBe("completed");
  await handleReviewLite(
    dir,
    "",
    {
      notify() {},
      confirm: async () => false,
      select: async (_title, options) => options.find((o) => o.value === "keep")?.value,
    },
    { interactive: true, enabled: true, residentBudget: 512 },
  );
  let calls = 0;
  const r = await firstUserReviewPass(dir, async (p) => {
    calls++;
    expect(p.pairs).toEqual([]);
    expect(p.dismissed).toHaveLength(1);
    return [];
  });
  expect(r.complete).toBe(true);
  expect(r.plan?.plannedPairs).toBe(1);
  expect(calls).toBe(1);
});

it.each(["disabled", "jev", "child", "registry", "gate", "owner", "signal"])(
  "admission %s cannot mark completed",
  async (mode) => {
    const { dir } = fixture(2);
    const controller = new AbortController();
    if (mode === "signal") controller.abort();
    const r = await host(
      dir,
      client(async (req) => valid(req)),
      {
        enabled: mode !== "disabled",
        jevEnabled: mode !== "jev",
        isChild: mode === "child",
        ...(mode === "registry" ? { registry: {} } : {}),
        ...(mode === "gate"
          ? { gate: { check: () => ({ ok: false as const, reason: "locked" as const }), capture() {} } }
          : {}),
        isCurrent: () => mode !== "owner",
        signal: controller.signal,
      },
    ).run();
    expect(r.status).not.toBe("completed");
    expect(marker(dir)).toBe(false);
  },
);

it.each(["cancel", "dispose", "signal", "owner", "migration"])("%s during request revokes commit", async (mode) => {
  const { dir } = fixture(2);
  let release!: (r: ReturnType<typeof valid>) => void, seen!: (r: JevRequest) => void;
  const started = new Promise<JevRequest>((r) => {
    seen = r;
  });
  let current = true;
  const controller = new AbortController();
  const h = host(
    dir,
    client(async (r) => {
      seen(r);
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
    { signal: controller.signal, isCurrent: () => current },
  );
  const pending = h.run();
  const req = await started;
  if (mode === "cancel") h.cancel();
  if (mode === "dispose") h.dispose();
  if (mode === "signal") controller.abort();
  if (mode === "owner") current = false;
  if (mode === "migration")
    writeFileSync(
      join(dir, "blocks/.layout.json"),
      JSON.stringify({ v: 1, source: "migrate", gen: 2, runId: "20261108T090000000Z-123-abcdef" }),
    );
  release(valid(req));
  expect((await pending).status).not.toBe("completed");
  expect(marker(dir)).toBe(false);
});

it("a marker write failure after suggestion commit remains incomplete and retry is idempotent", async () => {
  const { dir } = fixture(2);
  const original = safeFs.replaceAtomic;
  const spy = vi.spyOn(safeFs, "replaceAtomic").mockImplementation((...args) => {
    if (args[2] === "governance-markers.json") throw new Error("injected marker failure");
    return original(...args);
  });
  const h = host(
    dir,
    client(async (r) => valid(r)),
  );
  expect((await h.run()).status).toBe("incomplete");
  expect(marker(dir)).toBe(false);
  expect(readIndex(dir).index.review?.suggestions).toHaveLength(1);
  spy.mockRestore();
  expect((await h.run()).status).toBe("completed");
  expect(readIndex(dir).index.review?.suggestions).toHaveLength(1);
});

it("fingerprint row ignores an unrelated inherited projection field", () => {
  const { blocks } = fixture(1);
  const block = blocks[0]!;
  expect(firstReviewFingerprintRow({ ...block, inherited: true } as typeof block)).toBe(
    firstReviewFingerprintRow(block),
  );
  expect(firstReviewFingerprintRow({ ...block, rev: `${block.rev}-changed` })).not.toBe(
    firstReviewFingerprintRow(block),
  );
});

it("all dismissed pairs cause no model request and still permit completion", async () => {
  const { dir } = fixture(2);
  const c = client(async (r) => valid(r));
  expect((await host(dir, c).run()).status).toBe("completed");
  await handleReviewLite(
    dir,
    "",
    {
      notify() {},
      confirm: async () => false,
      select: async (_title, options) => options.find((o) => o.value === "keep")?.value,
    },
    { interactive: true, enabled: true, residentBudget: 512 },
  );
  unlinkSync(join(dir, "blocks/.jev/governance-markers.json"));
  let calls = 0;
  const r = await host(
    dir,
    client(async (req) => {
      calls++;
      return valid(req);
    }),
  ).run();
  expect(r.status).toBe("completed");
  expect(r.review?.plan?.dismissed).toHaveLength(1);
  expect(r.review?.answeredPairs).toBe(0);
  expect(calls).toBe(0);
});

it("low confidence is complete without suggestions", async () => {
  const { dir } = fixture(2);
  const r = await host(
    dir,
    client(async (req) => ({
      ...valid(req),
      answers: Object.fromEntries(
        Object.keys(req.questions).map((k) => [k, { type: "bool" as const, probability: 0.2 }]),
      ),
    })),
  ).run();
  expect(r.status).toBe("completed");
  expect(r.review?.answeredPairs).toBe(1);
  expect(r.review?.suggestionsWritten).toBe(true);
  expect(r.review?.added).toBe(0);
  expect(marker(dir)).toBe(true);
});

it.each(["missing", "unknown", "invalid", "budget", "throw"])("model %s leaves marker absent", async (mode) => {
  const { dir } = fixture(2);
  const r = await host(
    dir,
    client(async (req) => {
      if (mode === "throw") throw new Error("provider error");
      if (mode === "budget") return { ok: false, reason: "budget", detail: "cap" };
      const response = valid(req);
      if (mode === "missing") return { ...response, answers: {}, missing: ["p1"] };
      if (mode === "unknown") return { ...response, answers: { nope: { type: "bool", probability: 1 } } };
      return { ...response, answers: { p1: { type: "bool", probability: Infinity } } };
    }),
  ).run();
  expect(r.status).toBe("incomplete");
  expect(marker(dir)).toBe(false);
  expect(readIndex(dir).index.review).toBeUndefined();
});

it("shrinks each batch deadline against one manual-clock pass budget", async () => {
  const { dir } = fixture(33);
  const clock = new ManualClock(date.getTime());
  const budgets: number[] = [];
  const r = await host(
    dir,
    client(async (req) => {
      budgets.push(req.budgetMs);
      clock.advance(1000);
      return valid(req);
    }),
    { clock },
  ).run();
  expect(r.status).toBe("completed");
  expect(budgets).toEqual([6000, 5000, 4000, 3000]);
});

it("suggestion write failure prevents marker", async () => {
  const { dir } = fixture(2);
  const original = safeFs.replaceAtomic;
  vi.spyOn(safeFs, "replaceAtomic").mockImplementation((...args) => {
    if (args[2] === "index.json") throw new Error("injected index failure");
    return original(...args);
  });
  const r = await host(
    dir,
    client(async (req) => valid(req)),
  ).run();
  expect(r.status).toBe("incomplete");
  expect(r.review?.suggestionsWritten).toBe(false);
  expect(marker(dir)).toBe(false);
});

it("manual-clock timeout during scanning prevents any model or marker write", async () => {
  const { dir } = fixture(2);
  const clock = new ManualClock(date.getTime());
  const original = safeFs.readRegular;
  let advanced = false;
  let calls = 0;
  vi.spyOn(safeFs, "readRegular").mockImplementation((...args) => {
    const r = original(...args);
    if (!advanced && args[1].endsWith(".md")) {
      advanced = true;
      clock.advance(6000);
    }
    return r;
  });
  const result = await host(
    dir,
    client(async (req) => {
      calls++;
      return valid(req);
    }),
    { clock },
  ).run();
  expect(result.status).not.toBe("completed");
  expect(advanced).toBe(true);
  expect(calls).toBe(0);
  expect(marker(dir)).toBe(false);
});

it("zero-pair pass still verifies classifier availability", async () => {
  const { dir } = fixture();
  let asked = 0;
  const c: JevClient = {
    status: () => ({ kind: "full", model: "stale" }),
    probe: async () => ({ kind: "partial", reason: "no-auth", inactive: true }),
    ask: async (r) => {
      asked++;
      return valid(r);
    },
  };
  const r = await host(dir, c).run();
  expect(r.status).toBe("skipped");
  expect(asked).toBe(0);
  expect(marker(dir)).toBe(false);
});

it("a synchronously aborted uncooperative probe cannot hang the pass", async () => {
  const { dir } = fixture();
  const clock = new ManualClock(date.getTime());
  const c: JevClient = {
    status: () => ({ kind: "probing" }),
    probe: async () => {
      clock.advance(6000);
      return new Promise(() => {});
    },
    ask: async (req) => valid(req),
  };
  const r = await host(dir, c, { clock }).run();
  expect(r.status).toBe("incomplete");
  expect(marker(dir)).toBe(false);
});

it("a change outside the selected 32 while judging prevents completion", async () => {
  const { dir, blocks } = fixture(33);
  const r = await firstUserReviewPass(dir, async (p) => {
    const b = blocks[32]!;
    replaceBlockLocked(join(dir, "blocks"), b.id, b.rev, { meta: b.meta, body: "changed during judge" }, date);
    return p.pairs.map(({ a, b }) => ({ a, b, p: 0.9 }));
  });
  expect(r.complete).toBe(false);
  expect(r.reason).toBe("corpus changed");
  expect(r.suggestionsWritten).toBe(false);
});

it("refuses more than four token-constrained batches before making any model call", async () => {
  const { dir, blocks } = fixture(32);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    writeFileSync(join(dir, "blocks", `${b.id}.md`), b.raw.replace(`body ${i}`, "界".repeat(400)));
  }
  let calls = 0;
  const result = await host(
    dir,
    client(async (req) => {
      calls++;
      return valid(req);
    }),
  ).run();
  expect(result.status).toBe("incomplete");
  expect(result.reason).toBe("batch limit");
  expect(calls).toBe(0);
  expect(marker(dir)).toBe(false);
});

it("deadline while marker waits for lock revokes its late commit", async () => {
  const { dir } = fixture(2);
  const clock = new ManualClock(date.getTime());
  const original = lock.withMemoryDirLock;
  let calls = 0,
    release!: () => void,
    waiting!: () => void;
  const reached = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  vi.spyOn(lock, "withMemoryDirLock").mockImplementation((dir, body, opts) => {
    calls++;
    if (calls === 1) return original(dir, body, opts);
    return new Promise((resolve, reject) => {
      release = () => {
        try {
          resolve(body());
        } catch (e) {
          reject(e);
        }
      };
      waiting();
    });
  });
  const pending = host(
    dir,
    client(async (req) => valid(req)),
    { clock },
  ).run();
  await reached;
  expect(readIndex(dir).index.review?.suggestions).toHaveLength(1);
  clock.advance(6000);
  expect((await pending).status).toBe("incomplete");
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(marker(dir)).toBe(false);
});

it("replacing the blocks directory during a request invalidates the old owner", async () => {
  const { dir } = fixture(2);
  let release!: (r: ReturnType<typeof valid>) => void, started!: (r: JevRequest) => void;
  const seen = new Promise<JevRequest>((resolve) => {
    started = resolve;
  });
  const h = host(
    dir,
    client(async (req) => {
      started(req);
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
  );
  const pending = h.run(),
    req = await seen;
  renameSync(join(dir, "blocks"), join(dir, "old-blocks"));
  mkdirSync(join(dir, "blocks"));
  writeFileSync(
    join(dir, "blocks/.layout.json"),
    JSON.stringify({ v: 1, source: "migrate", gen: 1, runId: "20261108T090000000Z-123-abcdef" }),
  );
  release(valid(req));
  expect((await pending).status).toBe("incomplete");
  expect(marker(dir)).toBe(false);
  expect(existsSync(join(dir, "old-blocks/.jev/governance-markers.json"))).toBe(false);
});

it("fails closed on a corrupt index rather than losing dismissed relations", async () => {
  const { dir } = fixture(2);
  mkdirSync(join(dir, "blocks/.jev"));
  writeFileSync(join(dir, "blocks/.jev/index.json"), "broken-json");
  let calls = 0;
  const result = await host(
    dir,
    client(async (r) => {
      calls++;
      return valid(r);
    }),
  ).run();
  expect(result.status).toBe("incomplete");
  expect(result.reason).toBe("review: invalid index");
  expect(calls).toBe(0);
  expect(marker(dir)).toBe(false);
});

it("retains verified first-batch answers and usage when the second batch exceeds budget", async () => {
  const { dir } = fixture(33);
  const clock = new ManualClock(date.getTime());
  let calls = 0;
  const h = host(
    dir,
    client(async (req) => {
      calls++;
      if (calls === 1) {
        clock.advance(250);
        return { ...valid(req), costUsd: 0.125 };
      }
      return { ok: false, reason: "budget", detail: "cap" };
    }),
    { clock },
  );
  const result = await h.run();
  expect(result.status).toBe("incomplete");
  expect(result.review?.complete).toBe(false);
  expect(result.review?.plan?.plannedPairs).toBe(61);
  expect(result.review?.answeredPairs).toBe(16);
  expect(result.metrics).toEqual({
    elapsedMs: 250,
    batchesAttempted: 2,
    requestedBudgetsMs: [6000, 5750],
    reportedCostUsd: 0.125,
  });
  expect(marker(dir)).toBe(false);
  expect(readIndex(dir).index.review).toBeUndefined();
});

it.each(["cancel", "dispose", "abort"])(
  "%s between batches retains verified progress without a marker",
  async (mode) => {
    const { dir } = fixture(33);
    const clock = new ManualClock(date.getTime());
    const controller = new AbortController();
    let calls = 0;
    const h = host(
      dir,
      client(async (req) => {
        calls++;
        if (calls === 1) {
          clock.advance(100);
          return { ...valid(req), costUsd: 0.25 };
        }
        if (mode === "cancel") h.cancel();
        else if (mode === "dispose") h.dispose();
        else controller.abort();
        return new Promise(() => {});
      }),
      { clock, signal: controller.signal },
    );
    const result = await h.run();
    expect(result.status).toBe("incomplete");
    expect(result.review?.complete).toBe(false);
    expect(result.review?.answeredPairs).toBe(16);
    expect(result.review?.plan?.plannedPairs).toBe(61);
    expect(result.metrics).toEqual({
      elapsedMs: 100,
      batchesAttempted: 2,
      requestedBudgetsMs: [6000, 5900],
      reportedCostUsd: 0.25,
    });
    expect(marker(dir)).toBe(false);
    expect(readIndex(dir).index.review).toBeUndefined();
  },
);

it("counts valid answers from an incomplete second model response without committing", async () => {
  const { dir } = fixture(33);
  let calls = 0;
  const h = host(
    dir,
    client(async (req) => {
      calls++;
      if (calls === 1) return valid(req);
      const response = valid(req);
      return {
        ...response,
        answers: Object.fromEntries(Object.entries(response.answers).slice(0, 3)),
        missing: ["p4"],
      };
    }),
  );
  const result = await h.run();
  expect(result.status).toBe("incomplete");
  expect(result.review?.answeredPairs).toBe(19);
  expect(result.metrics?.batchesAttempted).toBe(2);
  expect(marker(dir)).toBe(false);
  expect(readIndex(dir).index.review).toBeUndefined();
});

it("legacy numeric facade rejects partial judge output rather than returning a partial count", async () => {
  const { dir } = fixture(3);
  const { firstUserReviewCount } = await import("../../../src/memory/govern/review-lite.js");
  await expect(
    firstUserReviewCount(dir, async (pairs) => pairs.slice(0, 1).map((p) => ({ ...p, p: 1 }))),
  ).rejects.toThrow("missing pair answer");
  expect(readIndex(dir).index.review).toBeUndefined();
});
