/** Real pi settled-window source regression: no mem text enters SDK dispatch or native handler. */
import { describe, expect, it } from "vitest";
import { createMemoryWebHost } from "../integration/memory-web-command-harness.js";

describe("#65 real SDK delayed settled/source", () => {
  it("Web seam completes while SDK settled is parked past the 5s capture fallback TTL; drain never runs native mem", async () => {
    const h = await createMemoryWebHost();
    let turn: Promise<void> | undefined;
    try {
      h.holdSettled();
      turn = h.session.prompt("offline conformance turn");
      for (let i = 0; i < 100 && !h.settledEntered(); i++) await new Promise<void>((r) => setImmediate(r));
      expect(h.settledEntered()).toBe(true);
      expect(h.ctx.isIdle()).toBe(true);
      const id = h.owner.epoch;
      const req = { id, op: "command", name: "mem", args: "session add settled window exact body" };
      expect(await h.request(req)).toMatchObject({ ok: true, data: { completion: "async" } });
      for (let i = 0; i < 30 && !h.dialog.frame().open.length; i++) await new Promise<void>((r) => setImmediate(r));
      expect(h.approve().ok).toBe(true);
      for (let i = 0; i < 30 && h.ledger.query(id)?.state === "running"; i++)
        await new Promise<void>((r) => setImmediate(r));
      expect(h.ledger.query(id)?.state).toBe("ok");
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 5100);
        timer.unref();
      });
      h.releaseSettled();
      await turn;
      expect(h.evidence()).toMatchObject({
        appendCount: 1,
        nativeCalls: 0,
        memSendUserMessage: 0,
        modelCalls: 1,
        poisoned: false,
      });
      expect(
        h.manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("settled window exact body")),
      ).toBe(false);
      await h.request(req);
      expect(h.evidence().appendCount).toBe(1);
    } finally {
      h.releaseSettled();
      await turn;
      h.dispose();
    }
  }, 15000);
});
