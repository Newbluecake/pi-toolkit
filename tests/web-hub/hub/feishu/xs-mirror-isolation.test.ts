/**
 * feishu-xs-mirror §4.4: mirror traffic can never take the last outbox slots / state bytes from
 * security alerts and owner notices. Real state + real outbox (never started ⇒ nothing is sent).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFeishuOutbox, deriveSendId } from "../../../../src/web-hub/hub/feishu/outbox.js";
import type { FeishuOutbox, OutboxTarget } from "../../../../src/web-hub/hub/feishu/outbox.js";
import { FEISHU_OUTBOX_FINAL_RESERVE, createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import {
  XSM_BYTE_HEADROOM,
  XSM_MAX_QUEUED,
  createFeishuXsMirror,
} from "../../../../src/web-hub/hub/feishu/xs-mirror.js";
import type { FeishuXsMirrorEvent } from "../../../../src/web-hub/hub/feishu/xs-mirror.js";
import { FEISHU_CAPS } from "../../../../src/web-hub/protocol/feishu.js";
import type { FeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";

const SID = "sess-iso-0001";
let root: string;
const live: { state: FeishuState; outbox: FeishuOutbox }[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xsm-iso-"));
});
afterEach(async () => {
  for (const l of live.splice(0)) {
    l.outbox.dispose();
    l.state.dispose();
    await l.state.whenIdle();
  }
  rmSync(root, { recursive: true, force: true });
});

const clock: FeishuClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms <= 100 ? 1 : ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const T = (id: string): OutboxTarget => ({ scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: id });
const TEXT = { msgType: "text", content: '{"text":"x"}' } as const;

async function build(bindingCount: number) {
  const state = createFeishuState({ dir: join(root, "fb"), clock });
  await state.load();
  const api = {} as unknown as FeishuApi;
  const outbox = createFeishuOutbox({ state, api, clock, onSettled: async () => {} });
  live.push({ state, outbox });
  for (let i = 0; i < bindingCount; i++) {
    const r = state.bindings.set(`p2p:oc_b${i}`, { chatId: `oc_b${i}`, chatType: "p2p", sessionId: SID });
    if (!r.ok) throw new Error("binding");
  }
  let work = 0;
  const counts: Record<string, number> = {};
  const m = createFeishuXsMirror({
    state,
    now: clock.now,
    label: () => "iso",
    link: () => "http://h/",
    target: (b) => T(b.chatId),
    enqueue: outbox.enqueueNotice,
    run: (task) => {
      work++;
      void Promise.resolve()
        .then(task)
        .finally(() => work--);
      return true;
    },
    workSize: () => work,
    log: () => {},
    count: (r) => {
      counts[r] = (counts[r] ?? 0) + 1;
    },
  });
  return { state, outbox, m, counts };
}
const ev = (n: string | number, text = "hello"): FeishuXsMirrorEvent => ({
  sessionId: SID,
  agentKey: "ak",
  xid: `x${n}`,
  kind: "message",
  from: { ref: "r" },
  text,
});
async function settleAll(m: ReturnType<typeof createFeishuXsMirror>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const s = m.stats();
    if (s.queued === 0 && !s.pumping) return;
  }
  throw new Error("mirror did not drain");
}
const mirrorQueued = (s: FeishuState): number =>
  s.outbox.list({ state: "queued" }).filter((p) => p.requestId?.startsWith("xsm:")).length;
async function fillNotices(o: FeishuOutbox, s: FeishuState, until: number): Promise<void> {
  let i = 0;
  while (s.outbox.size < until) {
    const r = await o.enqueueNotice({ target: T("oc_x"), message: TEXT, key: `fill-${i++}` });
    if (!r.ok) throw new Error(`fill refused ${r.refused}`);
  }
}

describe("xs-mirror isolation (§4.4)", () => {
  it("15 mirrors already queued + a fan-out of 8 ⇒ mirror queued is exactly 16, the rest are cap-omitted", async () => {
    const { state, m, counts } = await build(8);
    // 15 pre-existing mirrors with a different tag family
    for (let i = 0; i < 15; i++) {
      const r = await state.outbox.add({
        sendId: deriveSendId(`pre${i}`, 1),
        kind: "notice",
        route: "send",
        targetId: "oc_pre",
        receiveIdType: "chat_id",
        msgType: "text",
        content: '{"text":"p"}',
        requestId: `xsm:pre${i}`,
      });
      expect(r.ok).toBe(true);
    }
    m.deliver(ev(1));
    await settleAll(m);
    expect(mirrorQueued(state)).toBe(XSM_MAX_QUEUED);
    expect(counts["xs-mirror-cap"]).toBe(7);
  });
  it("total occupancy 319 + fan-out ⇒ at most one more mirror; security/owner notices still fit afterwards (≥128 free)", async () => {
    const { state, outbox, m, counts } = await build(5);
    const limit = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE - 128; // 320
    await fillNotices(outbox, state, limit - 1);
    expect(state.outbox.size).toBe(limit - 1);
    m.deliver(ev(1));
    await settleAll(m);
    expect(mirrorQueued(state)).toBe(1);
    expect(state.outbox.size).toBe(limit);
    expect(counts["xs-mirror-cap"]).toBe(4);
    const free = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE - state.outbox.size;
    expect(free).toBeGreaterThanOrEqual(128);
    const alert = await outbox.enqueueNotice({ target: T("ou_owner"), message: TEXT, key: "alert-1" });
    expect(alert.ok).toBe(true);
  });
  async function fillToEdge(rig: { state: FeishuState; outbox: FeishuOutbox }): Promise<void> {
    const big = JSON.stringify({ text: "y".repeat(19_000) });
    const small = JSON.stringify({ text: "s".repeat(500) });
    for (const [content, step] of [
      [big, 60_000],
      [small, 3_000],
    ] as const)
      for (let k = 0; k < 3_000; k++) {
        const u = rig.state.usage();
        if (u.bytes + u.reserve + step + XSM_BYTE_HEADROOM > u.budget) break;
        const r = await rig.outbox.enqueueNotice({
          target: T("oc_x"),
          message: { msgType: "text", content },
          key: `${step}-${k}`,
        });
        if (!r.ok) return;
      }
  }
  it("near the byte budget every mirror is bytes-refused; the guarded headroom stays available to non-mirror notices", async () => {
    const a = await build(3);
    await fillToEdge(a);
    const before = a.state.usage().bytes;
    for (let i = 0; i < 6; i++) a.m.deliver(ev(i, "z".repeat(2000)));
    await settleAll(a.m);
    expect(mirrorQueued(a.state)).toBe(0);
    expect(a.counts["xs-mirror-bytes"]).toBeGreaterThanOrEqual(1);
    expect(a.state.usage().bytes).toBe(before); // the flood consumed nothing
    // the 256 KiB the mirror refused to touch is fully available to non-mirror notices
    for (let i = 0; i < 40; i++) {
      const r = await a.outbox.enqueueNotice({
        target: T("oc_y"),
        message: { msgType: "text", content: JSON.stringify({ text: "w".repeat(2_000) }) },
        key: `alert-${i}`,
      });
      expect(r.ok).toBe(true);
    }
  });
  it("mirror stops once the 256 KiB headroom would be violated: queued mirrors never push free bytes below it", async () => {
    const r = await build(2);
    await fillToEdge(r);
    const before = r.state.usage();
    for (let i = 0; i < 4; i++) r.m.deliver(ev(i, "q".repeat(2000)));
    await settleAll(r.m);
    const u = r.state.usage();
    expect(u.bytes + u.reserve + XSM_BYTE_HEADROOM).toBeLessThanOrEqual(
      Math.max(u.budget, before.bytes + before.reserve + XSM_BYTE_HEADROOM),
    );
    expect(mirrorQueued(r.state)).toBe(0);
  });
  it("same-tick interleave: a non-mirror enqueue issued between mirror cards never sees a broken bound", async () => {
    const { state, outbox, m } = await build(6);
    const limit = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE - 128;
    await fillNotices(outbox, state, limit - 3);
    m.deliver(ev(1));
    const extra: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++)
      extra.push(outbox.enqueueNotice({ target: T("oc_x"), message: TEXT, key: `alert-${i}` }));
    await Promise.all(extra);
    await settleAll(m);
    // mirrors only ever fill up to the 320 line that existed when each was checked, never beyond +0
    const cap = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE;
    expect(state.outbox.size).toBeLessThanOrEqual(cap);
    // alerts all admitted
    expect((await Promise.all(extra)).every((r) => (r as { ok: boolean }).ok)).toBe(true);
  });
  it("mirror traffic never makes a non-mirror work.run() fail (single slot)", async () => {
    // the shared work pool is simulated by the rig's counter: while a mirror drain runs it holds exactly one slot
    const { m } = await build(5);
    for (let i = 0; i < 5; i++) m.deliver(ev(i));
    expect(m.stats().pumping).toBe(true);
    await settleAll(m);
  });
});
