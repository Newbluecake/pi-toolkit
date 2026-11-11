import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryWebHost } from "./memory-web-command-harness.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function ready(h: Awaited<ReturnType<typeof createMemoryWebHost>>) {
  for (let i = 0; i < 30 && !h.dialog.frame().open.length; i++) await tick();
  expect(h.dialog.frame().open).toHaveLength(1);
}
async function settled(h: Awaited<ReturnType<typeof createMemoryWebHost>>, id: string) {
  for (let i = 0; i < 30 && h.ledger.query(id)?.state === "running"; i++) await tick();
  return h.ledger.query(id);
}
const write = (id: string) => ({ id, op: "command", name: "mem", args: "session add exact browser body" });
describe("#65 real SDK owner/facade/commands/store", () => {
  it.each(["memory", "buffered", "persisted"] as const)(
    "%s: exact append and same-domain hash, no native route",
    async (mode) => {
      const h = await createMemoryWebHost(mode);
      try {
        const id = `${mode}-${h.owner.epoch}`;
        const file = h.manager.getSessionFile();
        if (mode === "buffered") expect(file && existsSync(file)).toBe(false);
        expect(await h.request(write(id))).toMatchObject({ ok: true, data: { completion: "async" } });
        await ready(h);
        expect(h.ledger.query(id)?.state).toBe("running");
        expect(h.evidence().appendCount).toBe(0);
        expect(h.approve().ok).toBe(true);
        expect(await settled(h, id)).toMatchObject({ state: "ok", result: { ok: true } });
        const evidence = h.evidence();
        expect(evidence.appendCount).toBe(1);
        expect(evidence.plannedHash).toBe(evidence.observedHash);
        expect(evidence.poisoned).toBe(false);
        expect(evidence.nativeCalls).toBe(0);
        expect(evidence.modelCalls).toBe(mode === "persisted" ? 1 : 0);
        expect(h.ledger.query(id)).toMatchObject({ result: { ok: true, data: { memoryWrite: { id: "n1" } } } });
        if (mode === "buffered") {
          expect(existsSync(file!)).toBe(false);
          expect(JSON.stringify(h.ledger.query(id))).toContain("首次 conversation flush");
          await h.session.prompt("flush through actual SDK conversation");
        }
        if (file)
          expect(
            readFileSync(file, "utf8")
              .split("\n")
              .filter((line) => line.includes('"customType":"subagent:memory-session"')),
          ).toHaveLength(1);
        await h.request(write(id));
        expect(h.evidence().appendCount).toBe(1);
        expect(h.trace.filter((e) => e.event === "release")).toHaveLength(1);
      } finally {
        h.dispose();
      }
    },
  );
  it.each([false, true])(
    "abort before commit (approved=%s): cancel observation before release, once",
    async (approved) => {
      const h = await createMemoryWebHost();
      try {
        const id = h.owner.epoch;
        if (approved) h.holdCommit();
        await h.request(write(id));
        await ready(h);
        if (approved) {
          h.approve();
          await tick();
          expect(h.trace.some((e) => e.event === "commit-enqueued")).toBe(true);
        }
        await h.request({ id: `abort-${id}`, op: "abort", expect: { sessionId: h.owner.sessionId } });
        h.releaseCommit();
        await tick();
        expect(await settled(h, id)).toMatchObject({
          state: "failed",
          result: { ok: false, effect: "none", retryable: false },
        });
        expect(h.evidence().appendCount).toBe(0);
        const order = h.trace.map((e) => e.event);
        expect(order.indexOf("handleAbort-enter")).toBeLessThan(order.indexOf("cancel-observed"));
        expect(order.indexOf("cancel-observed")).toBeLessThan(order.indexOf("release"));
        expect(order.filter((e) => e === "release")).toHaveLength(1);
        expect(h.trace.filter((e) => e.event === "cmd_late")).toHaveLength(1);
      } finally {
        h.dispose();
      }
    },
  );
  it("29 minutes: deadline checked, final result retained, retryable=false", async () => {
    const h = await createMemoryWebHost();
    try {
      const id = h.owner.epoch;
      await h.request(write(id));
      await ready(h);
      h.advance(29 * 60000 - 1);
      expect(h.ledger.query(id)?.state).toBe("running");
      h.advance(1);
      await tick();
      expect(h.ledger.query(id)).toMatchObject({ state: "failed", result: { retryable: false, effect: "none" } });
      expect(h.evidence().appendCount).toBe(0);
      expect(h.dialog.frame().open).toHaveLength(0);
      expect(h.trace.filter((e) => e.event === "release")).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
  it("real append reentrant cancel is unknown; no optimistic success and no late upgrade", async () => {
    const h = await createMemoryWebHost();
    try {
      const id = h.owner.epoch;
      h.onAppend(() => {
        void h.request({ id: `abort-${id}`, op: "abort" });
      });
      await h.request(write(id));
      await ready(h);
      h.approve();
      await tick();
      expect(await settled(h, id)).toMatchObject({ state: "failed", result: { effect: "unknown", retryable: false } });
      expect(h.evidence().appendCount).toBe(1);
      expect(h.trace.filter((e) => e.event === "release")).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
  it("cancel after real store observation but before controller done reads completed, never none", async () => {
    const h = await createMemoryWebHost();
    try {
      const id = h.owner.epoch;
      h.onObserved(() => {
        void h.request({ id: `abort-${id}`, op: "abort" });
      });
      await h.request(write(id));
      await ready(h);
      h.approve();
      expect(await settled(h, id)).toMatchObject({ state: "ok", result: { ok: true } });
      expect(h.evidence()).toMatchObject({ appendCount: 1, poisoned: false });
      expect(h.trace.find((e) => e.event === "cancel-observed")?.outcome).toMatchObject({
        effect: "completed",
        id: "n1",
      });
      expect(h.ledger.query(id)).toMatchObject({ result: { ok: true, data: { memoryWrite: { id: "n1" } } } });
    } finally {
      h.dispose();
    }
  });
  it("facade binds the actual SDK manager per start and rejects a different real context", async () => {
    const a = await createMemoryWebHost(),
      b = await createMemoryWebHost();
    try {
      const request = {
        write: { kind: "session.add" as const, rawArgs: "session add identity", text: "identity" },
        cmdId: a.owner.epoch,
        commandOwner: a.owner.epoch,
        operationGeneration: 1,
        deadline: Date.now() + 60000,
        signal: new AbortController().signal,
        current: () => true,
      };
      expect(a.memory.webWrite!.start(request, b.ctx)).toMatchObject({ accepted: false, outcome: { effect: "none" } });
      expect(a.evidence().appendCount).toBe(0);
      expect(a.dialog.frame().open).toHaveLength(0);
      const started = a.memory.webWrite!.start(request, a.ctx);
      expect(started.accepted).toBe(true);
      expect(a.dialog.frame().open).toHaveLength(0); // no business work in the synchronous start prefix
      if (!started.accepted) throw Error("expected task");
      started.task.cancel("abort");
      started.task.release();
      started.task.release();
      expect(await started.task.done).toMatchObject({ ok: false, effect: "none" });
      await tick();
      expect(a.evidence().appendCount).toBe(0);
      expect(a.dialog.frame().open).toHaveLength(0);
      a.scopes.dispose();
      expect(a.memory.webWrite!.start(request, a.ctx)).toMatchObject({ accepted: false, outcome: { effect: "none" } });
    } finally {
      a.dispose();
      b.dispose();
    }
  });
  it("owner shutdown cancels before store disposal; commands can still observe then release", async () => {
    const h = await createMemoryWebHost();
    try {
      const id = h.owner.epoch;
      await h.request(write(id));
      await ready(h);
      h.scopes.dispose();
      h.handler.onSessionBoundary();
      expect(h.ledger.query(id)).toMatchObject({ state: "failed", result: { effect: "none", retryable: false } });
      expect(h.evidence().appendCount).toBe(0);
      expect(h.dialog.frame().open).toHaveLength(0);
      const events = h.trace.map((e) => e.event);
      expect(events.indexOf("cancel-observed")).toBeLessThan(events.indexOf("release"));
      expect(events.filter((e) => e === "release")).toHaveLength(1);
      await tick();
      expect(h.trace.filter((e) => e.event === "cmd_late")).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});
