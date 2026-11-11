/** Controller limits and terminal identity with REAL C/D/review/confirm/E.
 * Only interactive navigation/remote answers and clocks are injected. */
import { expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  startCommandFlow,
  parseRevisionFlowCommand,
  commandFlowPages,
  COMMAND_FLOW_LIMITS,
} from "../../src/memory/command-flow.js";
import { r4Host, r4Command, addR4History, until } from "./govern/revision-web-command-r4-helpers.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import { parseMemoryCommandFacts } from "../../src/web-hub/protocol/memory-command-facts.js";
import * as safeFs from "../../src/memory/safe-fs.js";
import type { CommandFlowChoice } from "../../src/memory/command-flow.js";
afterEach(() => vi.restoreAllMocks());
const next = (r: CommandFlowChoice) =>
  r.options.includes("keep") ? "keep" : r.options.includes("next") ? "next" : "continue";

it.each([
  "tidy",
  "expired",
  "review --run",
  "review --list --list",
  "review --list extra",
  "review --apply",
  "review rules.001",
  "review\n--run",
  "review --list\nextra",
])("strict grammar denies %s without legacy effects", (raw) => {
  expect(parseRevisionFlowCommand(raw)).toBeUndefined();
});
it("strict review grammar only, pages preserve FULL UTF8 bytes at exact boundary", () => {
  expect(parseRevisionFlowCommand("review")).toEqual({ kind: "review", listOnly: false });
  expect(parseRevisionFlowCommand("review --list")).toEqual({ kind: "review", listOnly: true });
  const text = "界".repeat(30000) + "\nENDING\n";
  const pages = commandFlowPages(text);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("")).toBe(text);
  expect(pages.every((p) => Buffer.byteLength(p) <= COMMAND_FLOW_LIMITS.pageBytes)).toBe(true);
});

it("16 targets/16 effects retain EVERY successful result in fixed slots and fit frozen output budgets", async () => {
  const h = await r4Host();
  h.host.reset("session");
  await addR4History(h, 15);
  expect(h.rows()).toHaveLength(16);
  const f = r4Command(h),
    consume = vi.spyOn(f.kernel, "consume"),
    choose = vi.fn(async (r: CommandFlowChoice) => next(r));
  const task = startCommandFlow({ ...f, choose });
  const result = await task.done;
  expect(result.facts.effect).toBe("completed");
  expect(result.facts.rows).toHaveLength(16);
  expect(result.facts.rows.map((r) => r.step)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  expect(
    result.facts.rows.every((r) => r.outcome === "completed" && r.operation === "keep" && r.review === "changed"),
  ).toBe(true);
  expect(consume).toHaveBeenCalledTimes(16);
  expect(f.questions).toHaveLength(16);
  expect(choose).toHaveBeenCalledTimes(32);
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(16);
  expect(Buffer.byteLength(result.message)).toBeLessThanOrEqual(COMMAND_FLOW_LIMITS.terminalBytes);
  expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
  task.release();
});

it("17th target is never executed/rediscovered; omitted is honest unknown and first 16 successes stay", async () => {
  const h = await r4Host();
  h.host.reset("session");
  await addR4History(h, 16);
  const f = r4Command(h),
    task = startCommandFlow({ ...f, choose: async (r) => next(r) });
  const result = await task.done;
  expect(result.facts).toMatchObject({ effect: "unknown", omitted: 1 });
  expect(result.facts.rows).toHaveLength(16);
  expect(result.facts.rows.filter((r) => r.outcome === "completed")).toHaveLength(16);
  expect(readIndex(h.dir).index.review!.suggestions).toHaveLength(1);
  expect(f.questions).toHaveLength(16);
  expect(result.ok).toBe(false);
  task.release();
});

it("menu/view navigation and exactly 64 interactions mint NO receipts; 65th stops, no effects", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    confirm = vi.spyOn(f.kernel, "confirm"),
    consume = vi.spyOn(f.kernel, "consume");
  let requests = 0;
  const task = startCommandFlow({
    ...f,
    choose: async (r) => {
      requests++;
      return r.options.includes("view") ? "view" : "continue";
    },
  });
  const result = await task.done;
  expect(requests).toBe(64);
  expect(confirm).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
  expect(result.facts).toMatchObject({
    effect: "none",
    rows: [{ code: "E_MEM_PLAN_BUDGET", receipt: "not-consumed" }],
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe("E_DEADLINE");
  expect(h.rows()).toHaveLength(1);
  task.release();
});

it("long FULL domain presentation is navigated without mint, last question binds full plan and all text, not anchor-only", async () => {
  const h = await r4Host(),
    f = r4Command(h);
  const full = `Original raw:\n${"原文规则".repeat(10000)}\nNew body:\nend-of-unabridged-text`;
  // Extend PRESENTATION only at the domain/UI port; execute delegates actual
  // original prepared keep with the exact ORIGINAL confirmation. No fake effect.
  const base = f.domain,
    seen: string[] = [];
  const task = startCommandFlow({
    ...f,
    domain: {
      ...base,
      async view(t) {
        return full + (await base.view(t));
      },
    },
    choose: async (r) => {
      if (r.options.includes("view")) return seen.length ? "keep" : "view";
      seen.push(r.presentation);
      return r.options.includes("next") ? "next" : "continue";
    },
  });
  const result = await task.done;
  expect(seen.join("")).toContain(full);
  expect(seen.length).toBeGreaterThan(2);
  expect(result.facts.effect).toBe("completed");
  expect(f.questions).toHaveLength(1);
  expect(f.questions[0]).toContain("完整冻结原始文件");
  task.release();
});

it.each(["decline", "stale", "unknown"] as const)(
  "prior real keep success then %s stops later effects; no rollback, fixed slots partial/unknown",
  async (fault) => {
    const h = await r4Host();
    h.host.reset("session");
    await addR4History(h, 2);
    const before = h.rows(),
      f = r4Command(h, { autoAnswer: false });
    const task = startCommandFlow({ ...f, choose: async (r) => next(r) });
    await until(() => f.answers.length === 1);
    f.answers[0]!();
    await until(() => f.answers.length === 2);
    expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(1);
    if (fault === "stale") h.write(before[1]!.revision!.targetId, "Changed meanwhile.", "agent", 2);
    if (fault === "unknown")
      vi.spyOn(safeFs, "writeTempRegular").mockImplementation(() => {
        throw Error("real review I/O failure");
      });
    f.answers[1]!(fault === "decline" ? "拒绝（不执行）" : undefined);
    const result = await task.done;
    expect(result.facts.effect).toBe(fault === "unknown" ? "unknown" : "partial");
    expect(result.facts.rows.map((r) => r.outcome)).toEqual([
      "completed",
      fault === "unknown" ? "unknown" : "rejected",
      "skipped",
    ]);
    expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(1);
    expect(f.questions).toHaveLength(2);
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
    task.release();
  },
);

it("uncooperative navigation is bounded at 120s, command wall abort/late answer never revives", async () => {
  const h = await r4Host(),
    f = r4Command(h);
  let answer!: (v: string) => void;
  const choose = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const task = startCommandFlow({ ...f, choose });
  await until(() => choose.mock.calls.length === 1);
  f.clock.advance(120000);
  const result = await task.done;
  expect(result.facts.effect).toBe("none");
  expect(result.code).toBe("E_DEADLINE");
  expect(f.questions).toHaveLength(0);
  expect(f.clock.timers.size).toBe(0);
  answer("apply");
  await Promise.resolve();
  expect(task.cancel()).toBe(result);
  expect(f.questions).toHaveLength(0);
  task.release();
});

it("actual confirm 120s and total29min close waiting domain calls; late remote true has no authority", async () => {
  const h = await r4Host(),
    f = r4Command(h, { autoAnswer: false });
  const consume = vi.spyOn(f.kernel, "consume");
  const task = startCommandFlow({ ...f, choose: async (r) => next(r) });
  await until(() => f.answers.length === 1);
  f.clock.advance(120000);
  const result = await task.done;
  expect(result.facts.effect).toBe("none");
  expect(result.code).toBe("E_DEADLINE");
  expect(result.facts.rows[0]!.code).toBe("E_MEM_CONFIRM_TIMEOUT");
  expect(consume).not.toHaveBeenCalled();
  expect(f.answers[0]!()).toBe(false);
  f.clock.advance(29 * 60000);
  expect(task.cancel()).toBe(result);
  expect(f.clock.timers.size).toBe(0);
  task.release();
});

it("cancel BEFORE start microtask reports none/stale, no success, read, dialog, consume or write", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    snapshot = vi.spyOn(f.domain, "snapshot"),
    choose = vi.fn();
  const task = startCommandFlow({ ...f, choose });
  const result = task.cancel();
  expect(result.ok).toBe(false);
  expect(result.facts.effect).toBe("none");
  expect(await task.done).toBe(result);
  expect(snapshot).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  task.release();
});

it("same-name new cmdId has its own result slots; released old task/late choices never cover it", async () => {
  const h = await r4Host(),
    old = r4Command(h, { cmdId: "old-id" });
  let release!: (v: string) => void;
  const oldChoose = vi.fn(
    () =>
      new Promise<string>((r) => {
        release = r;
      }),
  );
  const a = startCommandFlow({ ...old, choose: oldChoose });
  await until(() => oldChoose.mock.calls.length === 1);
  const oldResult = a.cancel();
  a.release();
  const fresh = r4Command(h, { cmdId: "fresh-id" });
  const b = startCommandFlow({ ...fresh, choose: async (r) => next(r) });
  const result = await b.done;
  expect(result.facts.effect).toBe("completed");
  expect(result.facts.cmdId).toBe("fresh-id");
  release("apply");
  await Promise.resolve();
  expect(a.cancel()).toBe(oldResult);
  expect(b.cancel()).toBe(result);
  expect(parseMemoryCommandFacts(oldResult.message, "fresh-id").kind).toBe("invalid");
  expect(fresh.questions).toHaveLength(1);
  expect(old.questions).toHaveLength(0);
  b.release();
});

it("listed frozen set never grows from a new proposal during navigation", async () => {
  const h = await r4Host(),
    f = r4Command(h);
  let added = false;
  const task = startCommandFlow({
    ...f,
    choose: async (r) => {
      if (!added) {
        added = true;
        await addR4History(h, 1);
      }
      return next(r);
    },
  });
  const result = await task.done;
  expect(result.facts.rows).toHaveLength(1);
  expect(result.facts.effect).toBe("completed");
  expect(h.rows()).toHaveLength(1);
  expect(f.questions).toHaveLength(1);
  task.release();
});

it("long historical current raw is FULLY paged before exact keep confirm; real review write only, no anchor-only approval", async () => {
  const h = await r4Host(),
    p = h.rows()[0]!.revision!;
  h.host.reset("tree");
  const long = `FULL-BEGIN\n${"多行原文\n".repeat(8000)}FULL-END`;
  h.write(p.targetId, long, "agent", 2);
  const f = r4Command(h),
    seen: string[] = [],
    confirm = vi.spyOn(f.kernel, "confirm");
  const task = startCommandFlow({
    ...f,
    choose: async (r) => {
      if (r.options.includes("keep")) return "keep";
      expect(confirm).not.toHaveBeenCalled();
      seen.push(r.presentation);
      return r.options.includes("next") ? "next" : "continue";
    },
  });
  const result = await task.done;
  expect(seen.length).toBeGreaterThan(2);
  expect(seen.join("")).toContain(long);
  expect(seen.every((s) => Buffer.byteLength(s) <= COMMAND_FLOW_LIMITS.pageBytes)).toBe(true);
  expect(result.facts.effect).toBe("completed");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(f.questions[0]).toContain("已逐页展示完整原文");
  expect(Buffer.byteLength(f.questions[0]!)).toBeLessThan(24 * 1024);
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(1);
  expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`), "utf8")).toContain(long);
  task.release();
});

it("cancel halfway through long raw pages produces zero receipt/mutation, never offers anchor-only final confirm", async () => {
  const h = await r4Host(),
    p = h.rows()[0]!.revision!;
  h.host.reset("session");
  h.write(p.targetId, "long full text\n".repeat(7000), "agent", 2);
  const f = r4Command(h),
    consume = vi.spyOn(f.kernel, "consume");
  let page = 0;
  const task = startCommandFlow({
    ...f,
    choose: async (r) => (r.options.includes("keep") ? "keep" : ++page === 2 ? "cancel" : "next"),
  });
  const result = await task.done;
  expect(result.facts.effect).toBe("none");
  expect(f.questions).toHaveLength(0);
  expect(consume).not.toHaveBeenCalled();
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(0);
  task.release();
});

it("real E success followed by overlapping raw refusal is partial, later slots skipped, original C restores only first target", async () => {
  const h = await r4Host(3);
  expect(h.rows().length).toBeGreaterThanOrEqual(2);
  const f = r4Command(h),
    before = h
      .rows()
      .map((s) => ({ id: s.revision!.targetId, raw: fs.readFileSync(join(h.blocks, `${s.revision!.targetId}.md`)) }));
  const task = startCommandFlow({
    ...f,
    choose: async (r) => (r.options.includes("apply") ? "apply" : r.options.includes("keep") ? "keep" : "continue"),
  });
  const result = await task.done;
  expect(result.facts.effect).toBe("partial");
  expect(result.facts.rows[0]!.data).toBe("applied");
  expect(result.facts.rows[0]!.outcome).toBe("completed");
  expect(result.facts.rows[1]!.outcome).toBe("rejected");
  expect(result.facts.rows.slice(2).every((r) => r.outcome === "skipped")).toBe(true);
  expect(fs.readFileSync(join(h.blocks, `${before[0]!.id}.md`)).equals(before[0]!.raw)).toBe(false);
  expect(f.questions).toHaveLength(1);
  task.release();
});

it("29min total lease closes an uncooperative read; late resolution cannot open a menu or mint a receipt", async () => {
  const h = await r4Host(),
    f = r4Command(h);
  let resolve!: (s: Awaited<ReturnType<typeof f.domain.snapshot>>) => void;
  const stalled = new Promise<Awaited<ReturnType<typeof f.domain.snapshot>>>((r) => {
    resolve = r;
  });
  const choose = vi.fn(),
    snapshot = vi.fn(() => stalled);
  const task = startCommandFlow({ ...f, domain: { ...f.domain, snapshot }, choose });
  await until(() => snapshot.mock.calls.length === 1);
  f.clock.advance(29 * 60000);
  const result = await task.done;
  expect(result.ok).toBe(false);
  expect(result.facts.effect).toBe("none");
  resolve({ targets: [], omitted: 0 });
  await Promise.resolve();
  expect(choose).not.toHaveBeenCalled();
  expect(task.cancel()).toBe(result);
  expect(f.clock.timers.size).toBe(0);
  task.release();
});
