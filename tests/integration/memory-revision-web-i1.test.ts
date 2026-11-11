/** Production I1 assembly gates, actual SDK + original scopes owner/client/host/D/C/E.
 * Only the LOCAL synthetic SDK HTTP boundary is replaced; no fake commit result. */
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRevisionWebHost } from "./memory-revision-web-harness.js";
import { parseMemoryCommandFacts } from "../../src/web-hub/protocol/memory-command-facts.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { RenderCache } from "../../src/memory/render.js";
import * as safeFs from "../../src/memory/safe-fs.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});
async function host(options: Parameters<typeof createRevisionWebHost>[0] = {}) {
  const h = await createRevisionWebHost(options);
  closes.push(() => h.dispose());
  return h;
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 5));
  if (!check()) throw Error(`state did not arrive: ${label}`);
}
const request = (h: Awaited<ReturnType<typeof host>>, id: string, args = "review") =>
  h.request({ id, op: "command", name: "mem", args, expect: { sessionId: h.manager.getSessionId() } });
async function answerFlow(
  h: Awaited<ReturnType<typeof host>>,
  id: string,
  second: "decline" | "approve" = "decline",
  waitForLedger = true,
) {
  let confirms = 0;
  const answered = new Set<string>();
  await until(() => h.ledger.query(id)?.state !== "running" || h.dialog.frame().open.length > 0, "first menu");
  const deadline = Date.now() + 8000;
  while (
    h.ledger.query(id)?.state === "running" &&
    (waitForLedger || !h.completionObserved()) &&
    Date.now() < deadline
  ) {
    const d = h.dialog.frame().open[0];
    if (d && !answered.has(d.dialogId)) {
      answered.add(d.dialogId);
      const q = d.questions[0]!;
      const labels = q.options.map((o) => o.label);
      let value: string;
      if (q.header === "MEMCMD") {
        confirms++;
        value = q.options[confirms === 2 && second === "decline" ? 0 : 1]!.label;
      } else
        value = labels.includes("apply")
          ? "apply"
          : labels.includes("continue")
            ? "continue"
            : labels.includes("next")
              ? "next"
              : "skip";
      const result = h.answer(value);
      expect(result.ok).toBe(true);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  if (waitForLedger) expect(h.ledger.query(id)?.state).toBe("failed");
  else expect(h.completionObserved()).toBe(true);
  return confirms;
}
function facts(h: Awaited<ReturnType<typeof host>>, id: string) {
  const row = h.ledger.query(id)!;
  const result = row.result!;
  if (result.ok || !result.message) throw Error("expected actual failure message");
  const parsed = parseMemoryCommandFacts(result.message, id);
  if (parsed.kind !== "facts") throw Error("actual R1 facts unavailable");
  return { row, result, facts: parsed.facts };
}
it.each([
  [true, false],
  [false, true],
  [false, false],
])("actual facade session=%s hub=%s reports independent caps without owner/kernel creation", async (session, hub) => {
  const h = await host({ session: session!, hub: hub! });
  expect(h.memory.webWrite?.capabilities(h.ctx) ?? { sessionAdd: false, revisionReview: false }).toEqual({
    sessionAdd: session,
    revisionReview: session || hub,
  });
  expect(h.scopes?.current()?.session !== undefined).toBe(session);
  expect(
    h.memory.webWrite?.capabilities({ ...h.ctx, sessionManager: SessionManager.inMemory(h.cwd) }) ?? {
      sessionAdd: false,
      revisionReview: false,
    },
  ).toEqual({ sessionAdd: false, revisionReview: false });
  expect(h.memory.webWrite?.capabilities(undefined) ?? { sessionAdd: false, revisionReview: false }).toEqual({
    sessionAdd: false,
    revisionReview: false,
  });
  expect(h.evidence().starts).toBe(0);
  expect(h.lab.calls).toEqual([]);
});
it("missing actual owner never creates a fallback owner/kernel", async () => {
  const h = await host();
  const old = h.scopes!.current()!;
  h.scopes!.dispose();
  expect(h.memory.webWrite!.capabilities(h.ctx)).toEqual({ sessionAdd: false, revisionReview: false });
  expect(old.signal.aborted).toBe(true);
  expect(h.scopes!.current()).toBeUndefined();
  const result = await request(h, "i1-owner-absent");
  expect(result).toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "none" });
  expect(h.evidence().starts).toBe(0);
  expect(h.dialog.frame().open).toEqual([]);
});
it.each([false, true])(
  "history=%s real first E success + second refusal produces partial once; direct duplicate/late/queryOnly preserve exact message",
  async (history) => {
    const h = await host({ history });
    const rows = await h.seed(),
      before = new Map(rows.map((r) => [r.revision!.targetId, h.raw(r.revision!.targetId)]));
    const invalidations = vi.spyOn(EntryIndex.prototype, "invalidate");
    const renderInvalidations = vi.spyOn(RenderCache.prototype, "delete");
    const id = `i1-partial-${history}`;
    const readBytes = safeFs.readRegularBytes;
    const domainReads = vi.spyOn(safeFs, "readRegularBytes").mockImplementation((dir, name, opts) => {
      if (dir === join(h.dir, "blocks", ".jev") && name === "index.json" && h.ledger.get(id))
        expect(
          h.trace.some(
            (event) =>
              event.event === "cmd_result" &&
              (event.frame as { id?: string; data?: { completion?: string } } | undefined)?.id === id &&
              (event.frame as { data?: { completion?: string } } | undefined)?.data?.completion === "async",
          ),
        ).toBe(true);
      return readBytes(dir, name, opts);
    });
    const frames: unknown[] = [];
    h.listen((event, data) => {
      if (event === "cmd_late") frames.push(data);
    });
    expect(await request(h, id)).toMatchObject({ ok: true, data: { completion: "async" } });
    expect(await answerFlow(h, id)).toBe(2);
    expect(domainReads).toHaveBeenCalled();
    const result = facts(h, id);
    expect(result.facts.effect).toBe("partial");
    expect(result.result).toMatchObject({ ok: false, effect: "unknown", retryable: false });
    expect(result.facts.rows.map((r) => [r.outcome, r.receipt, r.data])).toEqual([
      ["completed", "consumed", "applied"],
      ["rejected", "not-consumed", "not-called"],
    ]);
    expect(rows.filter((r) => !h.raw(r.revision!.targetId).equals(before.get(r.revision!.targetId)!))).toHaveLength(1);
    const starts = h.evidence().starts;
    const duplicate = await request(h, id);
    const query = await h.request({ id, queryOnly: true, op: "command", name: "mem", args: "" });
    expect(duplicate.message).toBe(result.result.message);
    expect(query.data.result.message).toBe(result.result.message);
    expect(frames).toHaveLength(1);
    expect(h.evidence()).toMatchObject({ starts, native: 0, sent: 0 });
    const release = h.trace.find((e) => e.event === "release")!;
    expect(release.ledger).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ cmdId: id, state: "late_failed" })]),
    });
    expect(h.dialog.frame().open).toEqual([]);
    expect(invalidations).toHaveBeenCalledTimes(1);
    expect(invalidations).toHaveBeenCalledWith(h.dir);
    expect(renderInvalidations).toHaveBeenCalledTimes(1);
    expect(renderInvalidations).toHaveBeenCalledWith(h.cwd);
    const invalidatedIndex = invalidations.mock.contexts[0];
    expect(invalidatedIndex).toBeInstanceOf(EntryIndex);
    if (!(invalidatedIndex instanceof EntryIndex)) throw Error("actual Jev EntryIndex invalidation missing");
    const fresh = invalidatedIndex.get(h.dir);
    const target = result.facts.rows.find((row) => row.data === "applied")!.targetId!;
    expect(fresh.find((entry) => entry.file === `${target}.md`)?.body).toBe(
      "Preserve the complete frozen constraints under the original directory lock.",
    );
    const generations = h.lab.calls.filter((call) => call.kind === "generation").length;
    const calls = h.lab.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    expect(h.lab.calls).toHaveLength(calls);
    expect(h.lab.calls.filter((call) => call.kind === "generation")).toHaveLength(generations);
  },
);
it("real first E success + second opaque post-rename failure keeps applied bytes and unknown, never none or rollback", async () => {
  const h = await host();
  const rows = await h.seed();
  const before = new Map(rows.map((r) => [r.revision!.targetId, h.raw(r.revision!.targetId)]));
  const actual = safeFs.replaceRevisionObserved;
  let replacements = 0;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    const result = actual(...args);
    const target = args[2].replace(/\.md$/, "");
    if (args[0] === join(h.dir, "blocks") && before.has(target) && ++replacements === 2)
      throw Error("owned opaque after real target rename");
    return result;
  });
  const id = "i1-real-unknown";
  await request(h, id);
  await answerFlow(h, id, "approve");
  const result = facts(h, id);
  expect(replacements).toBe(2);
  expect(result.facts.effect).toBe("unknown");
  expect(result.facts.rows[0]).toMatchObject({ outcome: "completed", data: "applied", receipt: "consumed" });
  expect(result.facts.rows[1]).toMatchObject({ outcome: "unknown", data: "unknown", receipt: "consumed" });
  expect(rows.every((r) => !h.raw(r.revision!.targetId).equals(before.get(r.revision!.targetId)!))).toBe(true);
  await request(h, id);
  await h.request({ id, queryOnly: true, op: "command", name: "mem", args: "" });
  expect(replacements).toBe(2);
});
it("29min terminal and late approve cannot revive the NEW command lease or mutate published custody", async () => {
  const h = await host();
  const rows = await h.seed();
  const before = rows.map((r) => h.raw(r.revision!.targetId));
  const id = "i1-wall";
  await request(h, id);
  await until(() => h.dialog.frame().open.length > 0, "navigation");
  const d = h.dialog.frame().open[0]!;
  h.advance(29 * 60000);
  await until(() => h.ledger.query(id)?.state === "failed", "29 minute settlement");
  expect(facts(h, id).facts.effect).toBe("none");
  expect(
    h.dialog.answer(
      d.dialogId,
      [{ selected: ["apply"], other: null }],
      { listener: "loopback", ip: "127.0.0.1", reqId: "late" },
      "late-answer",
      h.owner.epoch,
    ),
  ).toMatchObject({ ok: false });
  expect(rows.map((r) => h.raw(r.revision!.targetId))).toEqual(before);
  expect(h.evidence()).toMatchObject({ native: 0, sent: 0 });
});

it("the real original activity owner rejects while SDK ctx.isIdle is true; a NEW settled activity lease can see original LIVE proposals", async () => {
  const h = await host();
  await h.seed();
  const activity = h.scopes!.current()!.proof.activity!;
  expect(h.ctx.isIdle()).toBe(true);
  activity.noteToolCall("i1-real-owner-tool", Date.now());
  const refused = await request(h, "i1-activity-busy");
  expect(refused).toMatchObject({ ok: false, code: "E_STALE_CTX", effect: "none" });
  expect(h.dialog.frame().open).toEqual([]);
  activity.noteToolResult("i1-real-owner-tool", Date.now());
  await request(h, "i1-new-real-lease");
  await until(() => h.dialog.frame().open.length > 0, "fresh live menu");
  expect(h.dialog.frame().open[0]!.questions[0]!.options.map((o) => o.label)).toContain("apply");
  h.handler.dispose();
});

it.each(["tree", "reload", "newSession"] as const)(
  "actual SDK %s revokes old custody; new owner history offers view/keep only and no model/E effects",
  async (boundary) => {
    const h = await host();
    const rows = await h.seed();
    const before = rows.map((row) => h.raw(row.revision!.targetId));
    const old = await h[boundary]();
    expect(old?.signal.aborted).toBe(true);
    expect(h.scopes!.current()).not.toBe(old);
    expect(h.memory.webWrite!.capabilities(h.ctx).revisionReview).toBe(true);
    const generationCalls = h.lab.calls.filter((call) => call.kind === "generation").length;
    const id = `i1-history-${boundary}`;
    await request(h, id);
    let menus = 0,
      confirms = 0,
      viewed = false;
    const answered = new Set<string>();
    const deadline = Date.now() + 8000;
    while (h.ledger.query(id)?.state === "running" && Date.now() < deadline) {
      const d = h.dialog.frame().open[0];
      if (d && !answered.has(d.dialogId)) {
        answered.add(d.dialogId);
        const q = d.questions[0]!,
          labels = q.options.map((option) => option.label);
        let value: string;
        if (q.header === "MEMCMD") {
          confirms++;
          value = q.options[1]!.label;
        } else if (labels.includes("keep")) {
          menus++;
          expect(labels).not.toContain("apply");
          expect(q.question).toContain("history (view/keep only)");
          value = !viewed ? "view" : "keep";
          viewed = true;
        } else value = labels.includes("continue") ? "continue" : "next";
        expect(h.answer(value)).toMatchObject({ ok: true });
      }
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(menus).toBe(3);
    expect(confirms).toBe(2);
    const result = h.ledger.query(id)!.result!;
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.message);
    if (result.data.op !== "command") throw Error("expected command result");
    const message = result.data.output!.entries[0]!;
    if (message.kind !== "text") throw Error("expected original encoded result");
    const parsed = parseMemoryCommandFacts(message.text, id);
    expect(parsed.kind).toBe("facts");
    if (parsed.kind !== "facts") throw Error("expected history facts");
    expect(parsed.facts.rows.map((row) => [row.operation, row.receipt, row.data, row.review])).toEqual([
      ["keep", "consumed", "not-called", "changed"],
      ["keep", "consumed", "not-called", "changed"],
    ]);
    expect(rows.map((row) => h.raw(row.revision!.targetId))).toEqual(before);
    expect(h.lab.calls.filter((call) => call.kind === "generation")).toHaveLength(generationCalls);
    expect(h.evidence()).toMatchObject({ native: 0, sent: 0 });
  },
);

it("cancel observes consumed unknown before ledger release; delayed done cannot downgrade or publish a second terminal", async () => {
  const h = await host();
  const rows = await h.seed();
  const targets = new Set(rows.map((row) => `${row.revision!.targetId}.md`));
  const actual = safeFs.replaceRevisionObserved;
  let writes = 0;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    const result = actual(...args);
    if (args[0] === join(h.dir, "blocks") && targets.has(args[2]) && ++writes === 2)
      throw Error("owned opaque post-rename fault");
    return result;
  });
  const late: unknown[] = [];
  h.listen((event, data) => {
    if (event === "cmd_late") late.push(data);
  });
  h.holdCompletion();
  const id = "i1-consumed-unknown-cancel";
  await request(h, id);
  expect(await answerFlow(h, id, "approve", false)).toBe(2);
  expect(h.ledger.query(id)?.state).toBe("running");
  await h.request({ id: "i1-cancel-control", op: "abort" });
  await until(() => h.ledger.query(id)?.state === "failed", "actual cancellation observation");
  const observed = facts(h, id);
  expect(observed.facts.effect).toBe("unknown");
  expect(observed.facts.rows.map((row) => [row.outcome, row.receipt, row.data])).toEqual([
    ["completed", "consumed", "applied"],
    ["unknown", "consumed", "unknown"],
  ]);
  const message = observed.result.message;
  h.releaseCompletion();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(facts(h, id).result.message).toBe(message);
  expect(writes).toBe(2);
  expect(late).toHaveLength(1);
  const release = h.trace.find((event) => event.event === "release")!;
  expect(release.ledger).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ cmdId: id, state: "late_failed" })]),
  });
});
