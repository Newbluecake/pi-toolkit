import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupF6, f6Rig, OWNER, NOW, untilF6 } from "../../../fixtures/feishu/f6.js";
import {
  createFeishuRequests,
  feishuBatchIdentity,
  feishuRequestText,
} from "../../../../src/web-hub/hub/feishu/requests.js";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { parseRequestHeader } from "../../../../src/web-hub/protocol/feishu.js";
import type { CmdResultFrame } from "../../../../src/web-hub/protocol/messages.js";

afterEach(cleanupF6);
async function receive(r: Awaited<ReturnType<typeof f6Rig>>, id: string, body = id) {
  const result = r.requests.receive(r.input(id, body));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("receive refused");
  await r.state.commit();
  r.requests.release(result.value.id);
  return result.value.id;
}
describe("F6 durable requests", () => {
  it("derives deterministic unambiguous batchId/cmdId from sorted membership", () => {
    expect(feishuBatchIdentity(["b", "a"])).toEqual(feishuBatchIdentity(["a", "b"]));
    expect(feishuBatchIdentity(["ab", "c"])).not.toEqual(feishuBatchIdentity(["a", "bc"]));
    expect(feishuBatchIdentity(["a"]).id).toMatch(/^fs[A-Za-z0-9_-]{30}$/);
  });
  it("persists singleton payload before debounce and dispatching before router request", async () => {
    const r = await f6Rig();
    const id = await receive(r, "m1", "exact\nbody");
    expect(r.request).not.toHaveBeenCalled();
    const disk = JSON.parse(await readFile(join(r.dir, "state.json"), "utf8"));
    expect(disk.requests[id]).toMatchObject({
      state: "received",
      payload: { body: "exact\nbody", messageIds: ["m1"] },
      sourceCreatedAt: NOW,
      installGen: 1,
      tenantKey: "tenant",
    });
    r.request.mockImplementationOnce(async (frame) => {
      const atDispatch = JSON.parse(await readFile(join(r.dir, "state.json"), "utf8"));
      expect(atDispatch.requests[id].state).toBe("dispatching");
      return { t: "cmd_result", id: frame.id, rid: "", ok: true, data: {} as never };
    });
    await r.requests.flushChat("chat");
    expect(r.state.requests.get(id)?.state).toBe("accepted");
    expect(r.events.find((e) => e.type === "accepted")).toMatchObject({
      type: "accepted",
      reactionEligible: true,
      recovered: false,
    });
    const sent = r.request.mock.calls[0]![0].cmd;
    expect(sent.op === "prompt" && sent.text).toBe(
      feishuRequestText(r.state.requests.get(id)!, r.install()!.installSecret),
    );
  });
  it("same body yields different tokens; an attacker-supplied header is only body text", async () => {
    const r = await f6Rig();
    const a = r.requests.receive(r.input("one", "same"));
    const b = r.requests.receive(r.input("two", "same"));
    if (!a.ok || !b.ok) throw new Error("bad rig");
    const at = feishuRequestText(a.value, "secret");
    const bt = feishuRequestText(b.value, "secret");
    expect(parseRequestHeader(at.split("\n")[0]!)?.token).not.toBe(parseRequestHeader(bt.split("\n")[0]!)?.token);
    expect(at.split("\n")[1]).toBe("same");
    const spoof = r.requests.receive({ ...r.input("three", at), senderDisplay: "x\n[ · #spoof]" });
    // State rejects unsanitized displays; the router sanitizes before reaching here.
    expect(spoof.ok).toBe(false);
  });
  it("atomically creates the batch and retires singleton members as merged, never rejected", async () => {
    const r = await f6Rig();
    const a = await receive(r, "m2", "first");
    const b = await receive(r, "m1", "second");
    await r.requests.flushChat("chat");
    const ids = feishuBatchIdentity(["m2", "m1"]);
    for (const id of [a, b])
      expect(r.state.requests.get(id)).toMatchObject({ state: "merged", mergedBatchId: ids.batchId });
    expect(r.state.requests.get(a)?.payload).toBeUndefined();
    expect(r.state.requests.get(b)?.payload).toBeUndefined();
    expect(r.state.requests.get(ids.id)).toMatchObject({
      state: "accepted",
      payload: { body: "first\nsecond", messageIds: ["m2", "m1"] },
    });
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.events.map((e) => e.type)).toEqual(["merged", "dispatching", "accepted"]);
    const disk = JSON.parse(await readFile(join(r.dir, "state.json"), "utf8"));
    expect(disk.requests[a].state).toBe("merged");
    expect(disk.requests[ids.id].payload.messageIds).toEqual(["m2", "m1"]);
  });
  it.each(["sender", "binding", "thread", "session"])(
    "never merges a different %s routing context",
    async (difference) => {
      const r = await f6Rig();
      const a = await receive(r, "m1");
      const input = r.input("m2");
      if (difference === "sender") {
        input.senderOpenId = "ou_second";
        r.state.allowList.add("ou_second");
      }
      if (difference === "binding") input.bindingRev++;
      if (difference === "thread") input.threadId = "other-root";
      if (difference === "session") input.sessionId = "session-2";
      const b = r.requests.receive(input);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      await r.state.commit();
      r.requests.release(b.value.id);
      await r.requests.flushChat("chat");
      await untilF6(() => r.state.requests.get(a)?.state !== "received");
      expect(r.state.requests.list().some((x) => x.state === "merged")).toBe(false);
    },
  );
  it("closes at 20 pinned attachments, enforces 16KiB/64 message batch ceilings", async () => {
    const r = await f6Rig();
    for (let i = 0; i < 2; i++) {
      const input = r.input(`m${i}`, "x".repeat(9_000));
      input.payload.uploadIds = Array.from({ length: 10 }, (_, j) => `u-${i}-${j}`);
      const rec = r.requests.receive(input);
      if (!rec.ok) throw new Error("receive");
      await r.state.commit();
      r.requests.release(rec.value.id);
    }
    await r.requests.flushChat("chat");
    await untilF6(() => r.request.mock.calls.length === 2);
    expect(
      r.state.requests.list().every((x) => x.payload === undefined || Buffer.byteLength(x.payload.body) <= 16_384),
    ).toBe(true);
  });
  it("binding revisions and live denial after the commit barrier prevent all effects", async () => {
    const r = await f6Rig();
    const id = await receive(r, "m1");
    const commit = r.state.commit.bind(r.state);
    vi.spyOn(r.state, "commit").mockImplementation(async () => {
      const ok = await commit();
      if (r.state.requests.get(id)?.state === "dispatching") r.state.allowList.remove(OWNER);
      return ok;
    });
    await r.requests.flushChat("chat");
    expect(r.state.requests.get(id)).toMatchObject({ state: "rejected", code: "sender-denied" });
    expect(r.request).not.toHaveBeenCalled();
  });
  it.each(["unknown", "deadline", "throw", "none"])("maps %s effects correctly, never auto-retries", async (effect) => {
    const r = await f6Rig();
    if (effect === "throw") r.request.mockRejectedValueOnce(new Error("network"));
    else
      r.request.mockImplementationOnce(async (f): Promise<CmdResultFrame> => ({
        t: "cmd_result",
        id: f.id,
        rid: "",
        ok: false,
        code: effect === "deadline" ? "E_DEADLINE" : "E_BUSY",
        effect: effect === "unknown" ? "unknown" : "none",
        retryable: true,
      }));
    const id = await receive(r, "m1");
    await r.requests.flushChat("chat");
    expect(r.state.requests.get(id)?.state).toBe(effect === "none" ? "rejected" : "uncertain");
    r.requests.release(id);
    await r.requests.flushChat("chat");
    expect(r.request).toHaveBeenCalledTimes(1);
  });
  it("does not call the router if dispatching commit fails", async () => {
    const r = await f6Rig();
    const id = await receive(r, "m1");
    vi.spyOn(r.state, "commit").mockResolvedValue(false);
    await r.requests.flushChat("chat");
    expect(r.request).not.toHaveBeenCalled();
    expect(r.state.requests.get(id)?.state).toBe("dispatching");
  });
  it("expires missing/stale source times and rejects old install/tenant records", async () => {
    const r = await f6Rig();
    for (const variant of ["legacy", "stale", "gen", "tenant"] as const) {
      const input = r.input(variant);
      if (variant === "legacy") delete input.sourceCreatedAt;
      if (variant === "stale") input.sourceCreatedAt = NOW - 300_001;
      if (variant === "gen") input.installGen = 0;
      if (variant === "tenant") input.tenantKey = "old";
      r.state.requests.receive({
        ...input,
        ...feishuBatchIdentity(input.payload.messageIds),
        textDigest: "a".repeat(64),
      });
    }
    await r.state.commit();
    await r.requests.recover();
    expect(r.request).not.toHaveBeenCalled();
    expect(r.state.requests.list().map((x) => x.state)).toEqual(["expired", "expired", "rejected", "rejected"]);
  });
  it("recovery resumes received exactly; dispatching/uncertain get one queryOnly each", async () => {
    const r = await f6Rig();
    const fresh = r.requests.receive(r.input("fresh"));
    const pending = r.requests.receive(r.input("pending"));
    const unknown = r.requests.receive(r.input("unknown"));
    if (!fresh.ok || !pending.ok || !unknown.ok) throw new Error("receive");
    r.state.requests.transition(pending.value.id, "dispatching", { agentKey: "agent-1" });
    r.state.requests.transition(unknown.value.id, "dispatching", { agentKey: "agent-1" });
    r.state.requests.transition(unknown.value.id, "uncertain");
    await r.state.commit();
    r.request.mockImplementation(async (f) =>
      f.queryOnly
        ? { t: "cmd_result", id: f.id, rid: "", ok: false, code: "E_UNKNOWN_ID", retryable: false, effect: "none" }
        : { t: "cmd_result", id: f.id, rid: "", ok: true, data: {} as never },
    );
    await r.requests.recover();
    await r.requests.recover();
    expect(r.request.mock.calls.map(([f]) => [f.id, f.queryOnly === true])).toEqual([
      [fresh.value.id, false],
      [pending.value.id, true],
      [unknown.value.id, true],
    ]);
    expect(r.state.requests.get(pending.value.id)?.state).toBe("uncertain");
    expect(r.state.requests.get(unknown.value.id)?.state).toBe("uncertain");
  });
  it("crash reload keeps full payload and source context; already merged members are not dispatched", async () => {
    const r = await f6Rig();
    const a = r.requests.receive(r.input("a")),
      b = r.requests.receive(r.input("b"));
    if (!a.ok || !b.ok) throw new Error("receive");
    const input = { ...r.input("batch"), payload: { body: "a\nb", messageIds: ["a", "b"], uploadIds: [] } };
    const batch = r.requests.receive(input);
    if (!batch.ok) throw new Error("batch");
    r.state.requests.transition(a.value.id, "merged", { mergedBatchId: batch.value.batchId });
    r.state.requests.transition(b.value.id, "merged", { mergedBatchId: batch.value.batchId });
    await r.state.commit();
    const boot = createFeishuState({
      dir: r.dir,
      groupCommitMs: 0,
      clock: {
        now: r.clock.now,
        setTimeout: (f, ms) => {
          const t = setTimeout(f, ms);
          t.unref();
          return t;
        },
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      },
    });
    await boot.load();
    const recovered = createFeishuRequests({
      state: boot,
      installation: r.install,
      admission: r.admission,
      clock: r.clock,
      debounceMs: 1500,
      staleMessageS: 300,
      emit: () => {},
    });
    try {
      await recovered.recover();
      expect(r.request).toHaveBeenCalledTimes(1);
      expect(r.request.mock.calls[0]![0].id).toBe(batch.value.id);
      expect(boot.requests.get(a.value.id)?.state).toBe("merged");
    } finally {
      recovered.dispose();
      boot.dispose();
    }
  });
  it("revocation purges pending work/nonces and disposal kills debounce timers", async () => {
    const r = await f6Rig();
    const id = await receive(r, "m1");
    r.state.nonces.issue({
      installGen: 1,
      tenantKey: "tenant",
      operatorOpenId: OWNER,
      chatId: "chat",
      messageId: "card",
      action: "resend",
      target: id,
    });
    expect(await r.requests.revokeSender(OWNER)).toEqual([id]);
    expect(r.requests.bufferedChats).toBe(0);
    expect(r.state.nonces.size).toBe(0);
    expect(r.state.requests.get(id)?.state).toBe("revoked");
    expect(r.requests.receive(r.input("denied")).ok).toBe(false);
    r.state.allowList.add(OWNER);
    await receive(r, "m2");
    r.requests.dispose();
    r.clock.advance(10_000);
    expect(r.request).not.toHaveBeenCalled();
  });
  it.each(["ok", "failed", "running", "malformed"] as const)(
    "recovery interprets the real query envelope: %s",
    async (state) => {
      const r = await f6Rig();
      const received = r.requests.receive(r.input("query"));
      if (!received.ok) throw new Error("receive");
      r.state.requests.transition(received.value.id, "dispatching", { agentKey: "agent-1" });
      await r.state.commit();
      r.request.mockImplementationOnce(async (frame): Promise<CmdResultFrame> => ({
        t: "cmd_result",
        id: frame.id,
        rid: "",
        ok: true,
        data:
          state === "malformed"
            ? { op: "query", state: "ok" }
            : {
                op: "query",
                state,
                ...(state === "running"
                  ? {}
                  : {
                      result:
                        state === "ok"
                          ? { ok: true as const, data: { op: "prompt" as const, delivery: "queued" as never } }
                          : {
                              ok: false as const,
                              code: "E_BUSY_COMPACTING" as const,
                              retryable: true,
                              effect: "none" as const,
                            },
                    }),
              },
      }));
      await r.requests.recover();
      expect(r.request.mock.calls[0]![0].queryOnly).toBe(true);
      expect(r.state.requests.get(received.value.id)?.state).toBe(
        state === "ok" ? "accepted" : state === "failed" ? "rejected" : "uncertain",
      );
      await r.requests.recover();
      expect(r.request).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds debounce buffers at 64 chats without evicting acknowledged work", async () => {
    const r = await f6Rig();
    const ids: string[] = [];
    for (let i = 0; i < 65; i++) {
      const chatId = `chat${i}`;
      const b = r.state.bindings.set(`p2p:${chatId}`, { chatId, chatType: "p2p", sessionId: "session-1" });
      if (!b.ok) throw new Error("binding");
      const result = r.requests.receive({
        ...r.input(`m${i}`),
        chatId,
        bindingKey: b.value.key,
        bindingRev: b.value.rev,
      });
      if (!result.ok) throw new Error("receive");
      ids.push(result.value.id);
    }
    await r.state.commit();
    for (const id of ids) r.requests.release(id);
    expect(r.requests.bufferedChats).toBe(64);
    await untilF6(() => r.state.requests.get(ids[64]!)?.state === "accepted");
    expect(r.state.requests.get(ids[0]!)?.state).toBe("received");
    expect(r.request).toHaveBeenCalledTimes(1);
  });

  it("20 attachments closes immediately instead of waiting for debounce", async () => {
    const r = await f6Rig();
    const input = r.input("twenty");
    input.payload.uploadIds = Array.from({ length: 20 }, (_, i) => `upload-${i}`);
    const result = r.requests.receive(input);
    if (!result.ok) throw new Error("receive");
    await r.state.commit();
    r.requests.release(result.value.id);
    expect(r.requests.bufferedChats).toBe(0);
    await untilF6(() => r.state.requests.get(result.value.id)?.state === "accepted");
    expect(r.clock.now()).toBe(NOW);
  });
  it("explicit resend is sender-bound, fresh and idempotent per callback with a different token", async () => {
    const r = await f6Rig();
    const source = r.requests.receive(r.input("original", "same body"));
    if (!source.ok) throw new Error("receive");
    r.state.requests.transition(source.value.id, "dispatching", { agentKey: "agent-1" });
    r.state.requests.transition(source.value.id, "uncertain");
    await r.state.commit();
    expect(r.requests.resend(source.value.id, "clicked", { ...r.identity, senderOpenId: "ou_other" }).ok).toBe(false);
    const retry = r.requests.resend(source.value.id, "clicked", r.identity);
    if (!retry.ok) throw new Error("resend");
    expect(retry.value.id).not.toBe(source.value.id);
    expect(retry.value.payload?.body).toBe("same body");
    expect(feishuRequestText(retry.value, "secret")).not.toBe(feishuRequestText(source.value, "secret"));
    expect(r.requests.resend(source.value.id, "clicked", r.identity)).toEqual(retry);
    expect(r.request).not.toHaveBeenCalled();
    await r.state.commit();
    r.requests.release(retry.value.id);
    await r.requests.flushChat("chat");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.state.requests.get(source.value.id)?.state).toBe("uncertain");
  });
  it.each(["E_HUB_RESTARTING", "E_UNSUPPORTED", "E_BAD_REQUEST"] as const)(
    "outer query refusal %s is never proof of failed delivery",
    async (code) => {
      const r = await f6Rig();
      const record = r.requests.receive(r.input("already-maybe-delivered"));
      if (!record.ok) throw new Error("receive");
      r.state.requests.transition(record.value.id, "dispatching", { agentKey: "agent-1" });
      await r.state.commit();
      r.request.mockImplementationOnce(async (frame) => ({
        t: "cmd_result",
        rid: "",
        id: frame.id,
        ok: false,
        code,
        effect: "none",
        retryable: false,
      }));
      await r.requests.recover();
      expect(r.state.requests.get(record.value.id)).toMatchObject({ state: "uncertain", code });
      expect(r.events.map((e) => e.type)).toEqual(["uncertain"]);
      expect(r.request.mock.calls[0]![0].queryOnly).toBe(true);
      await r.requests.recover();
      expect(r.request).toHaveBeenCalledTimes(1);
    },
  );

  it("a failed pre-forward commit reports degraded and retries only its proven unsent effect after commit heals", async () => {
    const r = await f6Rig();
    const id = await receive(r, "pre-forward");
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    await r.requests.flushChat("chat");
    expect(r.request).not.toHaveBeenCalled();
    expect(r.state.requests.get(id)?.state).toBe("dispatching");
    expect(r.requests.pendingRetries).toBe(1);
    expect(r.health).toContainEqual({ degraded: true, reason: "persist-failed", operation: "dispatch" });
    r.clock.advance(1_000);
    await untilF6(() => r.state.requests.get(id)?.state === "accepted");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.request.mock.calls[0]![0].queryOnly).toBeUndefined();
    expect(r.requests.pendingRetries).toBe(0);
    r.clock.advance(5_000);
    expect(r.request).toHaveBeenCalledTimes(1);
  });

  it("a failed batch commit is surfaced and can resume at runtime without a restart", async () => {
    const r = await f6Rig();
    const a = await receive(r, "batch-a"),
      b = await receive(r, "batch-b");
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    await r.requests.flushChat("chat");
    const id = feishuBatchIdentity(["batch-a", "batch-b"]).id;
    expect(r.state.requests.get(a)?.state).toBe("merged");
    expect(r.state.requests.get(b)?.state).toBe("merged");
    expect(r.state.requests.get(id)?.state).toBe("received");
    expect(r.health).toContainEqual({ degraded: true, reason: "persist-failed", operation: "batch" });
    expect(r.request).not.toHaveBeenCalled();
    await r.requests.retryPending();
    expect(r.state.requests.get(id)?.state).toBe("accepted");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.request.mock.calls[0]![0].id).toBe(id);
  });

  it("runtime commit retries recheck authorization and do not retry an uncertain router effect", async () => {
    const r = await f6Rig();
    const id = await receive(r, "revoked-while-parked");
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    await r.requests.flushChat("chat");
    r.state.allowList.remove(OWNER);
    await r.requests.retryPending();
    expect(r.state.requests.get(id)).toMatchObject({ state: "rejected", code: "sender-denied" });
    expect(r.request).not.toHaveBeenCalled();
    r.state.allowList.add(OWNER);
    const second = await receive(r, "uncertain-effect");
    r.request.mockImplementationOnce(async (f) => {
      vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
      return { t: "cmd_result", id: f.id, rid: "", ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" };
    });
    await r.requests.flushChat("chat");
    expect(r.state.requests.get(second)?.state).toBe("uncertain");
    await r.requests.retryPending();
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.events.at(-1)).toMatchObject({ type: "uncertain", code: "E_DEADLINE" });
  });

  it("detached debounce exceptions report a static degraded signal rather than an unhandled rejection", async () => {
    const r = await f6Rig();
    await receive(r, "bad-detached-close");
    vi.spyOn(r.admission, "resolve").mockImplementationOnce(() => {
      throw new Error("DO-NOT-LOG secret body");
    });
    r.clock.advance(1_500);
    await untilF6(() => r.health.some((e: any) => e.reason === "background-failed"));
    expect(r.health).toContainEqual({ degraded: true, reason: "background-failed", operation: "close" });
    expect(JSON.stringify(r.health)).not.toContain("DO-NOT-LOG");
    expect(r.request).not.toHaveBeenCalled();
  });

  it("dispose clears the runtime commit-retry timer and cannot later forward parked work", async () => {
    const r = await f6Rig();
    await receive(r, "dispose-parked");
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    await r.requests.flushChat("chat");
    expect(r.requests.pendingRetries).toBe(1);
    r.requests.dispose();
    expect(r.requests.pendingRetries).toBe(0);
    r.clock.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.request).not.toHaveBeenCalled();
  });
});
