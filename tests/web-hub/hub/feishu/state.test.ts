import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realFeishuFs } from "../../../../src/web-hub/hub/feishu/credentials.js";
import type { FeishuFs } from "../../../../src/web-hub/hub/feishu/credentials.js";
import {
  FEISHU_OUTBOX_FINAL_RESERVE,
  FEISHU_OUTBOX_SETTLED_TTL_MS,
  FEISHU_STATE_FILE,
  REQUEST_STATES,
  REQUEST_TRANSITIONS,
  createFeishuState,
} from "../../../../src/web-hub/hub/feishu/state.js";
import type {
  FeishuState,
  NewOutboxPartInput,
  NewRequestInput,
  PersistHealth,
} from "../../../../src/web-hub/hub/feishu/state.js";
import {
  FEISHU_ACK,
  FEISHU_CAPS,
  FEISHU_NONCE_RE,
  FEISHU_RECEIVED_BODY_MAX_BYTES,
  FEISHU_REPLY_LIMITS,
} from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock, settle } from "../../../fixtures/feishu/fake-http.js";
import type { FakeClock } from "../../../fixtures/feishu/fake-http.js";

const HOUR = 3_600_000;
const OWNER = "ou_owner0123456789";
const APP = "cli_a1b2c3d4e5f6";

let root: string;
let dir: string;
const open: FeishuState[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feishu-state-"));
  dir = join(root, "feishu-bot");
});
afterEach(async () => {
  const states = open.splice(0);
  for (const s of states) s.dispose();
  // a disposed state may still have ONE atomic write in flight; rmSync blocks the event loop so rm
  // retries cannot out-wait it — wait for the writer to go idle (nothing new can start after dispose)
  await Promise.all(states.map((s) => s.whenIdle()));
  rmSync(root, { recursive: true, force: true });
});

function wrapFs(overrides: Partial<FeishuFs>): FeishuFs {
  return { ...realFeishuFs, ...overrides };
}
interface Rig {
  s: FeishuState;
  clock: FakeClock;
  health: PersistHealth[];
}
async function mk(opts: { clock?: FakeClock; fs?: FeishuFs; load?: boolean; retryMs?: number } = {}): Promise<Rig> {
  const clock = opts.clock ?? createFakeClock(1_760_000_000_000);
  const health: PersistHealth[] = [];
  let n = 0;
  const s = createFeishuState({
    dir,
    clock,
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    random: (len) => {
      n += 1;
      return new Uint8Array(createHash("sha256").update(`nonce-${n}`).digest().subarray(0, len));
    },
    onHealth: (h) => health.push(h),
  });
  open.push(s);
  if (opts.load !== false) await s.load();
  return { s, clock, health };
}
/** make everything applied so far durable: arm + fire the group-commit timer, then await the barrier */
async function durable(r: { s: FeishuState; clock: FakeClock }): Promise<boolean> {
  const p = r.s.commit();
  r.clock.advance(FEISHU_ACK.groupCommitMs);
  return p;
}
/** real-I/O wait: fs operations complete on the thread pool, `settle()` rounds alone do not cover them */
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("until: timed out");
}
const statePath = (): string => join(dir, FEISHU_STATE_FILE);
const mode = (p: string): number => lstatSync(p).mode & 0o777;

const hex = (n: string): string => createHash("sha256").update(n).digest("hex");
function cmdId(n: number | string): string {
  return `fs${createHash("sha256").update(String(n)).digest("base64url").slice(0, 30)}`;
}
function reqInput(n: number | string, over: Partial<NewRequestInput> = {}, body = `hello ${n}`): NewRequestInput {
  return {
    id: cmdId(n),
    batchId: hex(`batch-${n}`),
    sessionId: "sess-0123456789",
    bindingKey: "p2p:oc_chat1",
    bindingRev: 3,
    senderOpenId: OWNER,
    senderDisplay: "Alice",
    chatLabel: "alice-dm",
    chatId: "oc_chat1",
    chatType: "p2p",
    triggerMessageId: `om_${n}`,
    textDigest: hex(body),
    payload: { body, messageIds: [`om_${n}`], uploadIds: [] },
    ...over,
  };
}
function partInput(n: number | string, over: Partial<NewOutboxPartInput> = {}): NewOutboxPartInput {
  return {
    sendId: `send_${n}`,
    kind: "final",
    route: "reply",
    targetId: `om_${n}`,
    msgType: "interactive",
    content: JSON.stringify({ n }),
    ...over,
  };
}
function bindInput(chat: string, over: Record<string, unknown> = {}) {
  return { chatId: chat, chatType: "p2p" as const, ...over };
}
const openId = (n: number): string => `ou_user${String(n).padStart(6, "0")}`;

function raw(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
}

describe("load / fresh / durability basics", () => {
  it("a missing file is a fresh ok state; nothing touches the disk until the first write", async () => {
    const { s } = await mk();
    expect(s.phase()).toBe("ok");
    expect(s.connectorMayStart()).toBe(true);
    expect(s.degradedReasons()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(await s.commit()).toBe(true); // nothing dirty ⇒ nothing to wait for
    expect(existsSync(dir)).toBe(false);
  });

  it("file is 0600 in a 0700 dir and round-trips every store", async () => {
    const r = await mk();
    const { s } = r;
    s.tenant.pin("tk_tenant1");
    s.allowList.add(OWNER);
    s.dedup.add(s.dedup.keyFor("event", "ev-1")!);
    s.requests.receive(reqInput(1));
    s.bindings.set("p2p:oc_chat1", bindInput("oc_chat1", { sessionId: "sess-0123456789", label: "L" }));
    s.dialogCards.add({
      id: "agent1:dlg1:1",
      agentKey: "agent1",
      dialogId: "dlg1",
      epoch: 1,
      bindingKey: "p2p:oc_chat1",
      chatId: "oc_chat1",
      messageId: "om_card",
      shortCode: "#k3",
    });
    const nonce = s.nonces.issue({
      installGen: 7,
      tenantKey: "tk_tenant1",
      operatorOpenId: OWNER,
      chatId: "oc_chat1",
      messageId: "om_card",
      action: "allow",
      target: "ou_stranger",
    });
    s.approvals.ask("ou_stranger000001", "Bob");
    s.outbox.add(partInput(1));
    s.undecodable.record({ reason: "bad-encoding", sha8: "deadbeef" });
    expect(await durable(r)).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(mode(statePath())).toBe(0o600);
    expect(readdirSync(dir)).toEqual([FEISHU_STATE_FILE]);
    expect(statSync(statePath()).size).toBeLessThanOrEqual(FEISHU_CAPS.stateMaxBytes);

    const again = await mk({ clock: r.clock });
    const s2 = again.s;
    expect(s2.phase()).toBe("ok");
    expect(s2.tenant.get()).toBe("tk_tenant1");
    expect(s2.allowList.list()).toEqual([OWNER]);
    expect(s2.dedup.has("e:ev-1")).toBe(true);
    expect(s2.requests.get(cmdId(1))).toEqual(s.requests.get(cmdId(1)));
    expect(s2.requests.get(cmdId(1))?.payload?.body).toBe("hello 1"); // §R2-c: payload survives
    expect(s2.bindings.get("p2p:oc_chat1")).toEqual(s.bindings.get("p2p:oc_chat1"));
    expect(s2.dialogCards.list()).toEqual(s.dialogCards.list());
    expect(s2.nonces.get(nonce.ok ? nonce.value.nonce : "")).toBeDefined();
    expect(s2.approvals.list()).toEqual(s.approvals.list());
    expect(s2.outbox.list()).toEqual(s.outbox.list());
    expect(s2.undecodable.snapshot()).toEqual(s.undecodable.snapshot());
    expect(s2.usage().bytes).toBe(s.usage().bytes); // the ledger is reproducible from disk
  });
});

describe("group commit (§2.4)", () => {
  it("nothing is on disk before the group-commit timer; many mutations ride ONE write", async () => {
    let renames = 0;
    const r = await mk({
      fs: wrapFs({
        rename: (a, b) => {
          renames++;
          return realFeishuFs.rename(a, b);
        },
      }),
    });
    for (let i = 0; i < 20; i++) r.s.dedup.add(`e:ev-${i}`);
    r.s.requests.receive(reqInput(1));
    const p = r.s.commit();
    await settle(5);
    expect(existsSync(statePath())).toBe(false);
    r.clock.advance(FEISHU_ACK.groupCommitMs - 1);
    await settle(5);
    expect(existsSync(statePath())).toBe(false);
    r.clock.advance(1);
    expect(await p).toBe(true);
    expect(renames).toBe(1);
    expect(Object.keys(raw()["dedup"] as object)).toHaveLength(20);
    expect(r.clock.pending()).toBe(0);
  });

  it("mutations during an in-flight write trigger exactly one follow-up write; commit() covers only what was applied before the call", async () => {
    let renames = 0;
    let release!: () => void;
    let blocked = true;
    const gate = new Promise<void>((res) => (release = res));
    const r = await mk({
      fs: wrapFs({
        rename: async (a, b) => {
          if (blocked) await gate; // hold the first write at the commit point
          renames++;
          return realFeishuFs.rename(a, b);
        },
      }),
    });
    r.s.dedup.add("e:first");
    const first = r.s.commit();
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    await settle(5);
    r.s.dedup.add("e:second"); // applied while write #1 is in flight
    const second = r.s.commit();
    blocked = false;
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(renames).toBe(2);
    expect(Object.keys(raw()["dedup"] as object).sort()).toEqual(["e:first", "e:second"]);
  });

  it("uncommitted mutations are lost on a crash; committed ones survive (ACK-after-durable rule)", async () => {
    const r = await mk();
    r.s.dedup.add("e:durable");
    expect(await durable(r)).toBe(true);
    r.s.dedup.add("e:volatile"); // applied, never committed, process "crashes"
    r.s.dispose();
    const after = await mk({ clock: r.clock });
    expect(after.s.dedup.has("e:durable")).toBe(true);
    expect(after.s.dedup.has("e:volatile")).toBe(false);
  });

  it("a failed write ⇒ commit() false, persist-failed health, previous file intact; a later write clears it", async () => {
    let failing = false;
    const r = await mk({
      retryMs: 1_000,
      fs: wrapFs({
        rename: async (a, b) => {
          if (failing) throw new Error("disk full");
          return realFeishuFs.rename(a, b);
        },
      }),
    });
    r.s.dedup.add("e:old");
    expect(await durable(r)).toBe(true);
    const before = readFileSync(statePath(), "utf8");
    failing = true;
    r.s.dedup.add("e:new");
    expect(await durable(r)).toBe(false);
    expect(r.s.persistFailed()).toBe(true);
    expect(r.s.degradedReasons()).toEqual(["persist-failed"]);
    expect(r.health).toEqual([{ persistFailed: true }]);
    expect(readFileSync(statePath(), "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual([FEISHU_STATE_FILE]); // no tmp left
    // the disk recovers: the armed retry writes EVERYTHING and resumes the connector
    failing = false;
    r.clock.advance(1_000);
    await until(() => !r.s.persistFailed());
    expect(r.s.persistFailed()).toBe(false);
    expect(r.health).toEqual([{ persistFailed: true }, { persistFailed: false }]);
    expect(Object.keys(raw()["dedup"] as object).sort()).toEqual(["e:new", "e:old"]);
    expect(await r.s.commit()).toBe(true);
  });

  it("not durable within 1.5 s ⇒ commit() false + degraded(persist-failed), then recovers when the write finally lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = await mk({
      fs: wrapFs({
        openWriteExcl: async (p, m) => {
          await gate;
          return realFeishuFs.openWriteExcl(p, m);
        },
      }),
    });
    r.s.dedup.add("e:slow");
    const p = r.s.commit();
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    await settle(5);
    r.clock.advance(FEISHU_ACK.commitDeadlineMs);
    expect(await p).toBe(false);
    expect(r.s.persistFailed()).toBe(true);
    release();
    await until(() => !r.s.persistFailed());
    expect(r.s.persistFailed()).toBe(false);
    expect(await r.s.commit()).toBe(true);
    expect(Object.keys(raw()["dedup"] as object)).toEqual(["e:slow"]);
  });

  it("flush() drains dirty state within the budget; false when the write cannot finish", async () => {
    const r = await mk();
    r.s.dedup.add("e:a");
    expect(await r.s.flush()).toBe(true);
    expect(Object.keys(raw()["dedup"] as object)).toEqual(["e:a"]);
    expect(r.clock.pending()).toBe(0);

    const hang = await mk({
      fs: wrapFs({ openWriteExcl: () => new Promise(() => {}) }),
    });
    hang.s.dedup.add("e:b");
    const p = hang.s.flush(1_000);
    await settle(5);
    hang.clock.advance(1_000);
    expect(await p).toBe(false);
    // its writer never settles by design, so whenIdle() would never resolve: opt this rig out of afterEach's wait
    hang.s.dispose();
    const i = open.indexOf(hang.s);
    if (i >= 0) open.splice(i, 1);
  });

  it("dispose() leaves no timers and fails pending waiters", async () => {
    const r = await mk();
    r.s.dedup.add("e:a");
    const p = r.s.commit();
    r.s.dispose();
    expect(await p).toBe(false);
    expect(r.clock.pending()).toBe(0);
  });

  describe("dispose() stops all future writes (an in-flight atomic write may finish, none may START)", () => {
    function gate(): { wait: Promise<void>; open: () => void } {
      let open!: () => void;
      const wait = new Promise<void>((r) => {
        open = r;
      });
      return { wait, open };
    }

    it("dispose while the dir step is in flight ⇒ the write never starts; whenIdle() resolves", async () => {
      const g = gate();
      let opens = 0;
      let inMkdir = false;
      const r = await mk({
        fs: wrapFs({
          mkdir: async (p, m) => {
            inMkdir = true;
            await g.wait;
            return realFeishuFs.mkdir(p, m);
          },
          openWriteExcl: (p, m) => {
            opens += 1;
            return realFeishuFs.openWriteExcl(p, m);
          },
        }),
      });
      r.s.dedup.add("e:a");
      const committed = r.s.commit();
      r.clock.advance(FEISHU_ACK.groupCommitMs); // the writer starts and parks inside the (gated) mkdir
      await until(() => inMkdir); // the writer is parked inside the dir step
      r.s.dispose();
      g.open();
      await r.s.whenIdle();
      expect(await committed).toBe(false);
      expect(opens).toBe(0);
      expect(existsSync(statePath())).toBe(false);
      expect(existsSync(`${statePath()}.tmp`)).toBe(false);
    });

    it("dispose while a write is in flight and more data is dirty ⇒ that write finishes, no second one starts, no retry timer", async () => {
      const g = gate();
      let opens = 0;
      const r = await mk({
        fs: wrapFs({
          openWriteExcl: async (p, m) => {
            opens += 1;
            await g.wait;
            return realFeishuFs.openWriteExcl(p, m);
          },
        }),
      });
      r.s.dedup.add("e:first");
      void r.s.commit();
      r.clock.advance(FEISHU_ACK.groupCommitMs);
      await until(() => opens === 1); // real I/O (mkdir/unlink) precedes it: the first write parks in flight
      r.s.dedup.add("e:second"); // dirty again ⇒ the writer loop WOULD iterate once more
      r.s.dispose();
      g.open();
      await r.s.whenIdle();
      expect(opens).toBe(1);
      expect(r.clock.pending()).toBe(0);
      expect(readdirSync(dir)).toEqual([FEISHU_STATE_FILE]); // the in-flight write landed atomically, tmp gone
      expect(Object.keys(raw()["dedup"] as object)).toEqual(["e:first"]); // the post-dispose mutation never hit disk
    });

    it("mutate + commit + flush after dispose never touch the disk", async () => {
      let opens = 0;
      const r = await mk({
        fs: wrapFs({
          openWriteExcl: (p, m) => {
            opens += 1;
            return realFeishuFs.openWriteExcl(p, m);
          },
        }),
      });
      r.s.dispose();
      r.s.dedup.add("e:late");
      const c = r.s.commit();
      const f = r.s.flush(1_000);
      r.clock.advance(FEISHU_ACK.groupCommitMs);
      r.clock.advance(1_000);
      await Promise.all([c, f]);
      await r.s.whenIdle();
      expect(opens).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("a duplicate must be re-committed before its ACK: has() is memory, commit() is the evidence", async () => {
    const r = await mk();
    r.s.dedup.add("e:x");
    expect(r.s.dedup.has("e:x")).toBe(true); // visible in memory…
    expect(existsSync(statePath())).toBe(false); // …but not durable yet
    expect(await durable(r)).toBe(true);
    expect(existsSync(statePath())).toBe(true);
  });
});

describe("caps refuse the NEW item, never evict (§5.8 + §R2-f)", () => {
  it("allow-list 32", async () => {
    const { s } = await mk();
    for (let i = 0; i < 32; i++) expect(s.allowList.add(openId(i)).ok).toBe(true);
    expect(s.allowList.add(openId(99))).toEqual({ ok: false, refused: "cap" });
    expect(s.allowList.size).toBe(32);
    expect(s.allowList.has(openId(0))).toBe(true);
    expect(s.allowList.add(openId(0))).toEqual({ ok: true, value: { added: false } }); // idempotent at cap
    expect(s.allowList.remove(openId(0))).toBe(true);
    expect(s.allowList.add(openId(99)).ok).toBe(true);
    expect(s.allowList.add("not-an-open-id")).toEqual({ ok: false, refused: "invalid" });
  });

  it("dedup 16 384: stops accepting new ids, keeps every old one; expired entries are reclaimed first", async () => {
    const r = await mk();
    const { s, clock } = r;
    for (let i = 0; i < FEISHU_CAPS.dedup; i++) expect(s.dedup.add(`e:id${i}`).ok).toBe(true);
    expect(s.dedup.size).toBe(FEISHU_CAPS.dedup);
    expect(s.dedup.add("e:one-too-many")).toEqual({ ok: false, refused: "cap" });
    expect(s.dedup.size).toBe(FEISHU_CAPS.dedup);
    expect(s.dedup.has("e:id0")).toBe(true);
    expect(s.dedup.has("e:one-too-many")).toBe(false);
    expect(s.dedup.add("e:id5")).toEqual({ ok: true, value: { added: false } });
    // after the TTL the entries are expired (not security state): reclaimed, new ones fit again
    clock.advance(FEISHU_CAPS.dedupTtlMs + 1);
    expect(s.dedup.has("e:id0")).toBe(false);
    expect(s.dedup.add("e:fresh").ok).toBe(true);
    expect(s.dedup.size).toBe(1);
    expect(s.dedup.add("bad key").ok).toBe(false);
    expect(s.dedup.keyFor("message", "om_abc")).toBe("m:om_abc");
    expect(s.dedup.keyFor("event", "has space")).toBeUndefined();
  });

  it("dedup TTL is 72 h", async () => {
    const { s, clock } = await mk();
    s.dedup.add("e:a");
    clock.advance(72 * HOUR);
    expect(s.dedup.has("e:a")).toBe(true);
    clock.advance(1);
    expect(s.dedup.has("e:a")).toBe(false);
  });

  it("non-terminal requests 256", async () => {
    const { s } = await mk();
    for (let i = 0; i < 256; i++) expect(s.requests.receive(reqInput(i)).ok).toBe(true);
    expect(s.requests.receive(reqInput("over"))).toEqual({ ok: false, refused: "cap" });
    expect(s.requests.nonTerminal).toBe(256);
    expect(s.requests.get(cmdId(0))).toBeDefined();
    // finishing one frees exactly one slot
    expect(s.requests.transition(cmdId(0), "rejected", { code: "x" }).ok).toBe(true);
    expect(s.requests.receive(reqInput("over")).ok).toBe(true);
  });

  it("bindings 256 (updating an existing key still works at cap)", async () => {
    const { s } = await mk();
    for (let i = 0; i < 256; i++) expect(s.bindings.set(`p2p:oc_${i}`, bindInput(`oc_${i}`)).ok).toBe(true);
    expect(s.bindings.set("p2p:oc_new", bindInput("oc_new"))).toEqual({ ok: false, refused: "cap" });
    expect(s.bindings.size).toBe(256);
    expect(s.bindings.set("p2p:oc_0", bindInput("oc_0", { sessionId: "sess-1" })).ok).toBe(true);
  });

  it("dialog cards 64 / 24 h", async () => {
    const { s, clock } = await mk();
    const card = (i: number) => ({
      id: `a:d${i}:1`,
      agentKey: "a",
      dialogId: `d${i}`,
      epoch: 1,
      bindingKey: "p2p:oc_1",
      chatId: "oc_1",
      messageId: `om_${i}`,
      shortCode: `#k${i}`,
    });
    for (let i = 0; i < 64; i++) expect(s.dialogCards.add(card(i)).ok).toBe(true);
    expect(s.dialogCards.add(card(64))).toEqual({ ok: false, refused: "cap" });
    expect(s.dialogCards.add(card(0))).toEqual({ ok: false, refused: "exists" });
    clock.advance(24 * HOUR + 1);
    expect(s.dialogCards.add(card(64)).ok).toBe(true); // expired ones reclaimed
    expect(s.dialogCards.size).toBe(1);
  });

  it("nonces 512 / ≤24 h", async () => {
    const { s, clock } = await mk();
    const base = {
      installGen: 1,
      tenantKey: "tk1",
      operatorOpenId: OWNER,
      chatId: "oc_1",
      messageId: "om_1",
      action: "send",
      target: "t",
    };
    for (let i = 0; i < 512; i++) expect(s.nonces.issue({ ...base, target: `t${i}` }).ok).toBe(true);
    expect(s.nonces.issue(base)).toEqual({ ok: false, refused: "cap" });
    expect(s.nonces.size).toBe(512);
    clock.advance(24 * HOUR + 1);
    const again = s.nonces.issue(base);
    expect(again.ok).toBe(true);
    expect(s.nonces.size).toBe(1);
  });

  it("approvals 16 / 24 h (+ at most one per sender per 24 h)", async () => {
    const { s, clock } = await mk();
    for (let i = 0; i < 16; i++) expect(s.approvals.ask(openId(i), `n${i}`).ok).toBe(true);
    expect(s.approvals.ask(openId(99), "x")).toEqual({ ok: false, refused: "cap" });
    expect(s.approvals.ask(openId(0), "again")).toEqual({ ok: false, refused: "recent" });
    clock.advance(24 * HOUR + 1);
    expect(s.approvals.ask(openId(0), "again").ok).toBe(true);
    expect(s.sweep()).toBe(15); // the other 15 expired
    expect(s.approvals.size).toBe(1);
  });

  it("outbox 512: notices stop at 512−reserve, finals fill to 512, nothing is evicted", async () => {
    const { s } = await mk();
    const notices = 512 - FEISHU_OUTBOX_FINAL_RESERVE;
    for (let i = 0; i < notices; i++) expect(s.outbox.add(partInput(`n${i}`, { kind: "notice" })).ok).toBe(true);
    expect(s.outbox.add(partInput("n-over", { kind: "notice" }))).toEqual({ ok: false, refused: "cap" });
    for (let i = 0; i < FEISHU_OUTBOX_FINAL_RESERVE; i++) expect(s.outbox.add(partInput(`f${i}`)).ok).toBe(true);
    expect(s.outbox.add(partInput("f-over"))).toEqual({ ok: false, refused: "cap" });
    expect(s.outbox.size).toBe(512);
    expect(s.outbox.get("send_n0")).toBeDefined();
    expect(s.outbox.get("send_f0")).toBeDefined();
  });

  it("terminal request metadata is bounded at 2 000 (oldest evicted — the one documented exception)", async () => {
    const { s, clock } = await mk();
    for (let i = 0; i < 2_100; i++) {
      expect(s.requests.receive(reqInput(i)).ok).toBe(true);
      clock.advance(1);
      expect(s.requests.transition(cmdId(i), "rejected").ok).toBe(true);
    }
    expect(s.requests.terminal).toBe(FEISHU_CAPS.terminalMetadata);
    expect(s.requests.nonTerminal).toBe(0);
    expect(s.requests.get(cmdId(0))).toBeUndefined();
    expect(s.requests.get(cmdId(99))).toBeUndefined();
    expect(s.requests.get(cmdId(100))).toBeDefined();
    expect(s.requests.get(cmdId(2_099))).toBeDefined();
  });
});

describe("requests (§5.4 + §R2-c)", () => {
  it("receive validates, rejects duplicates, bounds the payload", async () => {
    const { s } = await mk();
    const ok = s.requests.receive(reqInput(1));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.state).toBe("received");
      expect(ok.value.createdAt).toBe(ok.value.stateAt);
    }
    expect(s.requests.receive(reqInput(1))).toEqual({ ok: false, refused: "exists" });
    // exactly 16 KiB is fine, one more byte is not
    const full = "x".repeat(FEISHU_RECEIVED_BODY_MAX_BYTES);
    expect(s.requests.receive(reqInput(2, {}, full)).ok).toBe(true);
    expect(s.requests.receive(reqInput(3, {}, `${full}x`))).toEqual({ ok: false, refused: "payload-too-large" });
    // multi-byte counts in UTF-8 bytes, not characters
    const cjk = "飞".repeat(Math.floor(FEISHU_RECEIVED_BODY_MAX_BYTES / 3) + 1);
    expect(s.requests.receive(reqInput(4, {}, cjk))).toEqual({ ok: false, refused: "payload-too-large" });
    for (const bad of [
      reqInput(5, { id: "nope" }),
      reqInput(6, { batchId: "zz" }),
      reqInput(7, { senderOpenId: "u_x" }),
      reqInput(8, { chatType: "dm" as never }),
      reqInput(9, { sessionId: "" }),
      reqInput(10, { chatLabel: "a\nb" }),
      reqInput(11, { payload: { body: "x", messageIds: [], uploadIds: new Array<string>(21).fill("u") } }),
    ]) {
      expect(s.requests.receive(bad)).toEqual({ ok: false, refused: "invalid" });
    }
  });

  it("returns defensive copies", async () => {
    const { s } = await mk();
    s.requests.receive(reqInput(1));
    const copy = s.requests.get(cmdId(1))!;
    copy.payload!.body = "tampered";
    copy.state = "replied";
    expect(s.requests.get(cmdId(1))!.payload!.body).toBe("hello 1");
    expect(s.requests.get(cmdId(1))!.state).toBe("received");
  });

  it("the §5.4 transition table is enforced (every pair)", async () => {
    const { s } = await mk();
    let n = 0;
    for (const from of REQUEST_STATES) {
      for (const to of REQUEST_STATES) {
        // walk a fresh request into `from` via legal steps
        const id = cmdId(`t${n++}`);
        s.requests.receive(reqInput(`t${n}`, { id }));
        const path: Record<string, string[]> = {
          received: [],
          dispatching: ["dispatching"],
          accepted: ["dispatching", "accepted"],
          uncertain: ["dispatching", "uncertain"],
          rejected: ["rejected"],
          replied: ["dispatching", "accepted", "replied"],
          "reply-failed": ["dispatching", "accepted", "reply-failed"],
          unattributed: ["dispatching", "accepted", "unattributed"],
          revoked: ["revoked"],
          expired: ["expired"],
          merged: ["merged"],
        };
        for (const step of path[from]!)
          expect(
            s.requests.transition(id, step as never, step === "merged" ? { mergedBatchId: hex("batch") } : undefined)
              .ok,
          ).toBe(true);
        const legal = REQUEST_TRANSITIONS[from].includes(to);
        const res = s.requests.transition(id, to, to === "merged" ? { mergedBatchId: hex("batch") } : undefined);
        expect([from, to, res.ok]).toEqual([from, to, legal]);
        if (!res.ok) expect(res.reason).toBe("illegal");
      }
    }
    expect(s.requests.transition("fsnotarequestnotarequestnotare00", "accepted")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("terminal transitions delete the payload; patches apply; bad patches are refused atomically", async () => {
    const { s } = await mk();
    s.requests.receive(reqInput(1));
    expect(s.requests.transition(cmdId(1), "dispatching", { agentKey: "agent-1", dispatchedAt: 123 }).ok).toBe(true);
    expect(s.requests.get(cmdId(1))).toMatchObject({ agentKey: "agent-1", dispatchedAt: 123 });
    expect(s.requests.get(cmdId(1))!.payload).toBeDefined();
    expect(s.requests.transition(cmdId(1), "accepted", { code: "x".repeat(65) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(s.requests.get(cmdId(1))!.state).toBe("dispatching");
    expect(s.requests.patch(cmdId(1), { reactionId: "rx_1" })).toBe(true);
    expect(s.requests.transition(cmdId(1), "accepted").ok).toBe(true);
    const done = s.requests.transition(cmdId(1), "replied", { code: "ok" });
    expect(done.ok && done.record.payload).toBeUndefined();
    expect(s.requests.get(cmdId(1))!.payload).toBeUndefined();
    expect(s.requests.get(cmdId(1))!.reactionId).toBe("rx_1");
    expect(s.requests.nonTerminal).toBe(0);
    expect(s.requests.terminal).toBe(1);
  });

  it("terminal metadata is kept 24 h then swept", async () => {
    const r = await mk();
    r.s.requests.receive(reqInput(1));
    r.s.requests.transition(cmdId(1), "expired");
    r.clock.advance(24 * HOUR);
    expect(r.s.sweep()).toBe(0);
    r.clock.advance(1);
    expect(r.s.sweep()).toBe(1);
    expect(r.s.requests.get(cmdId(1))).toBeUndefined();
    expect(r.s.requests.terminal).toBe(0);
  });

  it("revokeSender revokes only `received` requests of that sender and drops their payload", async () => {
    const { s } = await mk();
    const other = "ou_other0123456789";
    s.requests.receive(reqInput(1));
    s.requests.receive(reqInput(2));
    s.requests.receive(reqInput(3, { senderOpenId: other }));
    s.requests.receive(reqInput(4));
    s.requests.transition(cmdId(4), "dispatching");
    const ids = s.requests.revokeSender(OWNER).sort();
    expect(ids).toEqual([cmdId(1), cmdId(2)].sort());
    expect(s.requests.get(cmdId(1))).toMatchObject({ state: "revoked" });
    expect(s.requests.get(cmdId(1))!.payload).toBeUndefined();
    expect(s.requests.get(cmdId(3))!.state).toBe("received");
    expect(s.requests.get(cmdId(4))!.state).toBe("dispatching");
    expect(s.requests.nonTerminal).toBe(2);
  });

  it("recovery: every non-terminal request reloads with its exact payload; terminal ones without", async () => {
    const r = await mk();
    const body = 'line1\n中文 \u0000 "q" \\ end';
    r.s.requests.receive(reqInput(1, {}, body));
    r.s.requests.receive(reqInput(2));
    r.s.requests.transition(cmdId(2), "dispatching", { agentKey: "ag" });
    r.s.requests.receive(reqInput(3));
    r.s.requests.transition(cmdId(3), "rejected", { code: "binding-changed" });
    expect(await durable(r)).toBe(true);
    const again = await mk({ clock: r.clock });
    expect(again.s.requests.get(cmdId(1))!.payload!.body).toBe(body);
    expect(again.s.requests.get(cmdId(2))).toMatchObject({ state: "dispatching", agentKey: "ag" });
    expect(again.s.requests.get(cmdId(3))).toMatchObject({ state: "rejected", code: "binding-changed" });
    expect(again.s.requests.get(cmdId(3))!.payload).toBeUndefined();
    expect(again.s.requests.nonTerminal).toBe(2);
  });
});

describe("byte budget (§R2-c / §R2-f)", () => {
  it("admission refuses `budget` BEFORE persisting; the file never exceeds 4 MiB even with max growth afterwards", async () => {
    const r = await mk();
    const { s } = r;
    const big = "y".repeat(FEISHU_RECEIVED_BODY_MAX_BYTES);
    let accepted = 0;
    let refused: string | undefined;
    for (let i = 0; i < 256; i++) {
      const res = s.requests.receive(reqInput(i, { chatLabel: "l".repeat(100) }, big));
      if (!res.ok) {
        refused = res.refused;
        break;
      }
      accepted++;
    }
    expect(refused).toBe("budget");
    expect(accepted).toBeGreaterThan(150);
    expect(accepted).toBeLessThan(256);
    expect(s.usage().bytes + s.usage().reserve).toBeLessThanOrEqual(FEISHU_CAPS.stateMaxBytes + 100_000);
    // every accepted request may still grow through its transitions up to the per-record reserve
    for (let i = 0; i < accepted; i++) {
      const t = s.requests.transition(cmdId(i), "dispatching", {
        agentKey: "a".repeat(256),
        dispatchedAt: 1_760_000_000_000,
        code: "c".repeat(64),
        reactionId: "r".repeat(256),
      });
      expect(t.ok).toBe(true);
    }
    expect(await durable(r)).toBe(true);
    const size = statSync(statePath()).size;
    expect(size).toBeLessThanOrEqual(FEISHU_CAPS.stateMaxBytes);
    expect(size).toBeLessThanOrEqual(s.usage().bytes); // the ledger is an upper bound of the real file
    // terminal transitions are never blocked by the budget and shrink the document
    for (let i = 0; i < accepted; i++) expect(s.requests.transition(cmdId(i), "accepted").ok).toBe(true);
    for (let i = 0; i < accepted; i++) expect(s.requests.transition(cmdId(i), "replied").ok).toBe(true);
    expect(s.usage().bytes).toBeLessThan(size / 4);
    expect(s.requests.receive(reqInput("after", {}, big)).ok).toBe(true); // room again
  });

  it("budget counts SERIALIZED bytes: JSON-escape-heavy bodies hit the budget far earlier", async () => {
    const r = await mk();
    const nasty = "\u0001".repeat(FEISHU_RECEIVED_BODY_MAX_BYTES); // 6 bytes each once escaped
    let accepted = 0;
    for (let i = 0; i < 256; i++) {
      const res = r.s.requests.receive(reqInput(i, {}, nasty));
      if (!res.ok) {
        expect(res.refused).toBe("budget");
        break;
      }
      accepted++;
    }
    expect(accepted).toBeLessThan(45);
    expect(await durable(r)).toBe(true);
    expect(statSync(statePath()).size).toBeLessThanOrEqual(FEISHU_CAPS.stateMaxBytes);
  });

  it("every store at its cap with max-size entries still fits the budget (worst-case packing)", async () => {
    const r = await mk();
    const { s } = r;
    for (let i = 0; i < 32; i++) s.allowList.add(openId(i));
    for (let i = 0; i < FEISHU_CAPS.dedup; i++) s.dedup.add(`e:${"d".repeat(90)}${String(i).padStart(10, "0")}`);
    expect(s.dedup.size).toBe(FEISHU_CAPS.dedup);
    for (let i = 0; i < 256; i++) {
      s.bindings.set(`grp:${"c".repeat(100)}${i}:${"t".repeat(100)}`, {
        chatId: "c".repeat(120),
        chatType: "group",
        threadId: "t".repeat(120),
        sessionId: "s".repeat(120),
        label: "l".repeat(120),
        offline: "o".repeat(60),
      });
    }
    for (let i = 0; i < 64; i++) {
      s.dialogCards.add({
        id: `a${i}:${"d".repeat(100)}:1`,
        agentKey: "a".repeat(120),
        dialogId: "d".repeat(120),
        epoch: 99,
        bindingKey: "b".repeat(200),
        chatId: "c".repeat(120),
        messageId: "m".repeat(120),
        shortCode: "#k3",
      });
    }
    for (let i = 0; i < 512; i++) {
      s.nonces.issue({
        installGen: 1_760_000_000_000,
        tenantKey: "t".repeat(64),
        operatorOpenId: OWNER,
        chatId: "c".repeat(120),
        messageId: "m".repeat(120),
        action: "a".repeat(32),
        target: "g".repeat(400),
      });
    }
    for (let i = 0; i < 16; i++) s.approvals.ask(openId(i), "n".repeat(100));
    for (let i = 0; i < 100; i++) s.undecodable.record({ reason: "r".repeat(60), sha8: "deadbeef" });
    // requests + outbox compete for the remainder under the same admission control
    let outboxAdded = 0;
    for (let i = 0; i < 512; i++) {
      const res = s.outbox.add(
        partInput(`w${i}`, { content: "z".repeat(FEISHU_REPLY_LIMITS.maxCardBytes - 40), targetId: "t".repeat(120) }),
      );
      if (res.ok) outboxAdded++;
    }
    let reqAdded = 0;
    for (let i = 0; i < 256; i++) {
      if (s.requests.receive(reqInput(i, {}, "r".repeat(8_000))).ok) reqAdded++;
    }
    expect(outboxAdded).toBeGreaterThan(0);
    expect(reqAdded + outboxAdded).toBeGreaterThan(0);
    expect(await durable(r)).toBe(true);
    const size = statSync(statePath()).size;
    expect(size).toBeLessThanOrEqual(FEISHU_CAPS.stateMaxBytes);
    expect(size).toBeLessThanOrEqual(s.usage().bytes);
    // …and the packed document reloads cleanly
    const again = await mk({ clock: r.clock });
    expect(again.s.phase()).toBe("ok");
    expect(again.s.usage().bytes).toBe(s.usage().bytes);
  });
});

describe("corruption ⇒ .bak + state-corrupt + connector not started (§5.8)", () => {
  function write(content: string | object, m = 0o600): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(statePath(), typeof content === "string" ? content : JSON.stringify(content), { mode: m });
    chmodSync(statePath(), m);
  }
  const valid = () => ({
    v: 1,
    revSeq: 0,
    allowList: {},
    dedup: {},
    requests: {},
    bindings: {},
    dialogCards: {},
    nonces: {},
    approvals: {},
    outbox: {},
    undecodable: { count: 0, ring: [] },
  });

  it("garbage ⇒ corrupt: bytes copied to .bak, original left in place, mutators refuse, commit false, fail closed on every boot", async () => {
    write("{{{ definitely not json");
    const r = await mk({ load: false });
    const out = await r.s.load();
    expect(out).toEqual({ kind: "corrupt", reason: "json", backedUp: true });
    expect(r.s.phase()).toBe("corrupt");
    expect(r.s.connectorMayStart()).toBe(false);
    expect(r.s.degradedReasons()).toEqual(["state-corrupt"]);
    expect(r.s.corruptReason()).toBe("json");
    expect(readFileSync(`${statePath()}.bak`, "utf8")).toBe("{{{ definitely not json");
    expect(mode(`${statePath()}.bak`)).toBe(0o600);
    expect(readFileSync(statePath(), "utf8")).toBe("{{{ definitely not json"); // NOT replaced by a fresh state
    expect(r.s.dedup.add("e:x")).toEqual({ ok: false, refused: "unavailable" });
    expect(r.s.allowList.add(OWNER)).toEqual({ ok: false, refused: "unavailable" });
    expect(r.s.requests.receive(reqInput(1))).toEqual({ ok: false, refused: "unavailable" });
    expect(r.s.tenant.pin("tk1")).toBe("unavailable");
    expect(await r.s.commit()).toBe(false);
    expect(await r.s.flush()).toBe(false);
    expect(r.clock.pending()).toBe(0);
    // next boot is corrupt again (never "fresh")
    const again = await mk({ load: false, clock: r.clock });
    expect((await again.s.load()).kind).toBe("corrupt");
  });

  const invalid: Array<[string, () => object, string]> = [
    ["unknown top-level key", () => ({ ...valid(), extra: 1 }), "schema"],
    ["wrong version", () => ({ ...valid(), v: 2 }), "version"],
    ["bad revSeq", () => ({ ...valid(), revSeq: -1 }), "rev-seq"],
    ["missing store", () => ({ ...valid(), outbox: undefined }), "outbox"],
    [
      "allow-list over cap",
      () => ({ ...valid(), allowList: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [openId(i), 1])) }),
      "allow-list",
    ],
    ["allow-list bad key", () => ({ ...valid(), allowList: { nope: 1 } }), "allow-list"],
    ["dedup bad key", () => ({ ...valid(), dedup: { "x:1": 1 } }), "dedup"],
    ["bad nonce key", () => ({ ...valid(), nonces: { short: {} } }), "nonces"],
    [
      "non-terminal request without payload",
      () => {
        const rec = { ...reqInput(1), state: "received", createdAt: 1, stateAt: 1 } as Record<string, unknown>;
        delete rec["payload"];
        return { ...valid(), requests: { [cmdId(1)]: rec } };
      },
      "requests",
    ],
    [
      "terminal request still carrying a payload",
      () => ({ ...valid(), requests: { [cmdId(1)]: { ...reqInput(1), state: "replied", createdAt: 1, stateAt: 1 } } }),
      "requests",
    ],
    [
      "request id ≠ key",
      () => ({ ...valid(), requests: { [cmdId(2)]: { ...reqInput(1), state: "received", createdAt: 1, stateAt: 1 } } }),
      "requests",
    ],
    [
      "binding rev beyond revSeq",
      () => ({
        ...valid(),
        bindings: { "p2p:oc_1": { key: "p2p:oc_1", rev: 5, chatId: "oc_1", chatType: "p2p", updatedAt: 1 } },
      }),
      "rev-seq",
    ],
    [
      "queued outbox part without content",
      () => ({
        ...valid(),
        outbox: {
          s1: {
            sendId: "s1",
            kind: "final",
            state: "queued",
            route: "reply",
            targetId: "om",
            msgType: "text",
            attempts: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "outbox",
    ],
    [
      "undecodable ring too long",
      () => ({
        ...valid(),
        undecodable: { count: 99, ring: Array.from({ length: 17 }, () => ({ at: 1, reason: "r" })) },
      }),
      "undecodable",
    ],
  ];
  for (const [name, doc, reason] of invalid) {
    it(`invalid: ${name}`, async () => {
      write(doc());
      const { s } = await mk({ load: false });
      const out = await s.load();
      expect(out).toMatchObject({ kind: "corrupt", reason, backedUp: true });
      expect(s.connectorMayStart()).toBe(false);
      expect(s.requests.nonTerminal).toBe(0); // nothing leaked into memory
      expect(s.allowList.size).toBe(0);
    });
  }

  it("an oversize file / loose mode / symlink are corrupt without a .bak (never followed)", async () => {
    write(" ".repeat(FEISHU_CAPS.stateMaxBytes + 1));
    expect((await (await mk({ load: false })).s.load()).kind).toBe("corrupt");
    expect(existsSync(`${statePath()}.bak`)).toBe(false);
    rmSync(statePath());

    write(valid(), 0o644);
    const loose = await mk({ load: false });
    expect(await loose.s.load()).toEqual({ kind: "corrupt", reason: "file-mode", backedUp: false });
    rmSync(statePath());

    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(valid()), { mode: 0o600 });
    symlinkSync(target, statePath());
    const link = await mk({ load: false });
    expect(await link.s.load()).toEqual({ kind: "corrupt", reason: "file-symlink", backedUp: false });
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify(valid()));
    expect(existsSync(`${statePath()}.bak`)).toBe(false);
  });

  it("repair: keeps nothing but the owner; dedup/requests/tenant cleared; .bak preserved; durable; healthy afterwards", async () => {
    write("garbage");
    const r = await mk({ load: false });
    await r.s.load();
    expect(await r.s.repair({ appId: APP, ownerOpenId: "bad" })).toEqual({ ok: false, reason: "not-corrupt" });
    expect(await r.s.repair({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: true });
    expect(r.s.phase()).toBe("ok");
    expect(r.s.connectorMayStart()).toBe(true);
    expect(r.s.degradedReasons()).toEqual([]);
    expect(r.s.allowList.list()).toEqual([OWNER]);
    expect(r.s.tenant.get()).toBeUndefined();
    expect(r.s.dedup.size).toBe(0);
    expect(r.s.appId).toBe(APP);
    expect(readFileSync(`${statePath()}.bak`, "utf8")).toBe("garbage");
    expect(mode(statePath())).toBe(0o600);
    expect(r.s.tenant.pin("tk_new")).toBe("pinned"); // re-pins on the next owner event
    expect(await durable(r)).toBe(true);
    const again = await mk({ clock: r.clock });
    expect(again.s.phase()).toBe("ok");
    expect(again.s.allowList.list()).toEqual([OWNER]);
    expect(again.s.tenant.get()).toBe("tk_new");
  });

  it("repair only runs from corrupt; a failing repair write leaves it corrupt", async () => {
    const healthy = await mk();
    expect(await healthy.s.repair({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: false, reason: "not-corrupt" });

    write("garbage");
    let failing = true;
    const r = await mk({
      load: false,
      fs: wrapFs({
        rename: async (a, b) => {
          if (failing && b === statePath()) throw new Error("ro fs");
          return realFeishuFs.rename(a, b);
        },
      }),
    });
    await r.s.load();
    expect(await r.s.repair({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: false, reason: "write-failed" });
    expect(r.s.phase()).toBe("corrupt");
    expect(readFileSync(statePath(), "utf8")).toBe("garbage");
    failing = false;
    expect(await r.s.repair({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: true });
  });

  it("repair replaces a symlinked state.json by a regular file (the link target is untouched)", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(root, "target.json");
    writeFileSync(target, "precious", { mode: 0o600 });
    symlinkSync(target, statePath());
    const r = await mk({ load: false });
    expect((await r.s.load()).kind).toBe("corrupt");
    expect(await r.s.repair({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: true });
    expect(lstatSync(statePath()).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("precious");
  });
});

describe("install binding, reset", () => {
  it("adoptInstall: first bind seeds the owner; same app = no-op; another app wipes everything (open_ids are per app)", async () => {
    const r = await mk();
    const { s } = r;
    expect(await durableAdopt(r, { appId: APP, ownerOpenId: OWNER })).toEqual({ ok: true, reset: true });
    expect(s.appId).toBe(APP);
    expect(s.allowList.list()).toEqual([OWNER]);
    s.tenant.pin("tk1");
    s.dedup.add("e:1");
    s.requests.receive(reqInput(1));
    s.bindings.set("p2p:oc_1", bindInput("oc_1"));
    expect(await s.adoptInstall({ appId: APP, ownerOpenId: OWNER })).toEqual({ ok: true, reset: false });
    expect(s.dedup.size).toBe(1);
    const newOwner = "ou_newowner0123456";
    expect(await durableAdopt(r, { appId: "cli_other0000000", ownerOpenId: newOwner })).toEqual({
      ok: true,
      reset: true,
    });
    expect(s.allowList.list()).toEqual([newOwner]);
    expect(s.tenant.get()).toBeUndefined();
    expect(s.dedup.size).toBe(0);
    expect(s.requests.nonTerminal).toBe(0);
    expect(s.bindings.size).toBe(0);
    const again = await mk({ clock: r.clock });
    expect(again.s.appId).toBe("cli_other0000000");
    expect(again.s.allowList.list()).toEqual([newOwner]);
  });

  async function durableAdopt(r: Rig, install: { appId: string; ownerOpenId: string }) {
    const p = r.s.adoptInstall(install);
    await settle(3);
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    return p;
  }

  it("adoptInstall waits for durability (persist failure ⇒ reason persist)", async () => {
    const r = await mk({
      fs: wrapFs({
        rename: async () => {
          throw new Error("nope");
        },
      }),
    });
    expect(await durableAdopt(r, { appId: APP, ownerOpenId: OWNER })).toEqual({ ok: false, reason: "persist" });
  });

  it("destroy() removes state.json, .bak and tmp by exact path and returns to unloaded; a later load is fresh", async () => {
    const r = await mk();
    r.s.dedup.add("e:1");
    expect(await durable(r)).toBe(true);
    writeFileSync(`${statePath()}.bak`, "old", { mode: 0o600 });
    writeFileSync(`${statePath()}.tmp`, "partial", { mode: 0o600 });
    expect(await r.s.destroy()).toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual([]);
    expect(r.s.phase()).toBe("unloaded");
    expect(r.s.connectorMayStart()).toBe(false);
    expect(r.s.dedup.size).toBe(0);
    expect(r.s.dedup.add("e:2")).toEqual({ ok: false, refused: "unavailable" });
    expect(r.clock.pending()).toBe(0);
    expect((await r.s.load()).kind).toBe("fresh");
    expect(r.s.dedup.size).toBe(0);
  });

  it("destroy() racing an in-flight write leaves nothing behind", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = await mk({
      fs: wrapFs({
        rename: async (a, b) => {
          await gate;
          return realFeishuFs.rename(a, b);
        },
      }),
    });
    r.s.dedup.add("e:1");
    r.clock.advance(0);
    const p = r.s.commit();
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    await settle(5);
    const destroying = r.s.destroy();
    release();
    expect(await destroying).toEqual({ ok: true });
    expect(await p).toBe(false);
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(`${statePath()}.tmp`)).toBe(false);
  });
});

describe("tenant pin", () => {
  it("TOFU: first valid key pins, same ⇒ same, other ⇒ mismatch, junk ⇒ invalid", async () => {
    const { s } = await mk();
    expect(s.tenant.pin("bad key!")).toBe("invalid");
    expect(s.tenant.get()).toBeUndefined();
    expect(s.tenant.pin("tk_1")).toBe("pinned");
    expect(s.tenant.pin("tk_1")).toBe("same");
    expect(s.tenant.pin("tk_2")).toBe("mismatch");
    expect(s.tenant.get()).toBe("tk_1");
  });
});

describe("nonces (§4.3)", () => {
  const base = {
    installGen: 7,
    tenantKey: "tk1",
    operatorOpenId: OWNER,
    chatId: "oc_1",
    messageId: "om_card",
    action: "allow",
    target: "ou_stranger",
  };
  const ctx = (nonce: string, over: Record<string, unknown> = {}) => ({
    nonce,
    operatorOpenId: OWNER,
    chatId: "oc_1",
    messageId: "om_card",
    tenantKey: "tk1",
    installGen: 7,
    ...over,
  });

  it("issues 16-random-byte b64url nonces that redeem exactly once", async () => {
    const { s } = await mk();
    const a = s.nonces.issue(base);
    const b = s.nonces.issue(base);
    if (!a.ok || !b.ok) throw new Error("issue failed");
    expect(a.value.nonce).toMatch(FEISHU_NONCE_RE);
    expect(a.value.nonce).not.toBe(b.value.nonce);
    const first = s.nonces.redeem(ctx(a.value.nonce));
    expect(first.ok && first.record.target).toBe("ou_stranger");
    expect(s.nonces.redeem(ctx(a.value.nonce))).toEqual({ ok: false, reason: "unknown" }); // one-shot
    expect(s.nonces.get(b.value.nonce)).toBeDefined();
  });

  it("every bound field must match; a mismatch does NOT consume the nonce", async () => {
    const { s } = await mk();
    const n = s.nonces.issue(base);
    if (!n.ok) throw new Error("issue failed");
    const nonce = n.value.nonce;
    for (const over of [
      { operatorOpenId: "ou_attacker0123456" },
      { chatId: "oc_other" },
      { messageId: "om_other" },
      { tenantKey: "tk2" },
      { installGen: 8 },
    ]) {
      expect(s.nonces.redeem(ctx(nonce, over))).toEqual({ ok: false, reason: "mismatch" });
    }
    expect(s.nonces.get(nonce)).toBeDefined();
    expect(s.nonces.redeem(ctx(nonce)).ok).toBe(true);
    expect(s.nonces.redeem(ctx("short"))).toEqual({ ok: false, reason: "unknown" });
    expect(s.nonces.redeem(ctx("A".repeat(22)))).toEqual({ ok: false, reason: "unknown" });
  });

  it("expiry (≤24 h, shorter ttl honoured) consumes the record", async () => {
    const { s, clock } = await mk();
    const short = s.nonces.issue(base, 1_000);
    const long = s.nonces.issue(base, 99 * HOUR); // clamped to 24 h
    if (!short.ok || !long.ok) throw new Error("issue failed");
    expect(long.value.expiresAt - long.value.createdAt).toBe(24 * HOUR);
    clock.advance(1_000);
    expect(s.nonces.redeem(ctx(short.value.nonce))).toEqual({ ok: false, reason: "expired" });
    expect(s.nonces.get(short.value.nonce)).toBeUndefined();
    expect(s.nonces.redeem(ctx(long.value.nonce)).ok).toBe(true);
  });

  it("purgeOperator revokes everything issued to one operator", async () => {
    const { s } = await mk();
    const other = "ou_other0123456789";
    s.nonces.issue(base);
    s.nonces.issue(base);
    s.nonces.issue({ ...base, operatorOpenId: other });
    expect(s.nonces.purgeOperator(OWNER)).toBe(2);
    expect(s.nonces.size).toBe(1);
  });

  it("rejects malformed bound fields", async () => {
    const { s } = await mk();
    for (const bad of [
      { ...base, installGen: 0 },
      { ...base, tenantKey: "a b" },
      { ...base, operatorOpenId: "x" },
      { ...base, action: "Bad Action" },
      { ...base, target: "x".repeat(513) },
    ]) {
      expect(s.nonces.issue(bad)).toEqual({ ok: false, refused: "invalid" });
    }
  });
});

describe("approvals / bindings / dialogs / outbox / undecodable", () => {
  it("approvals: allowed removes, ignored keeps the 24 h gate, attach binds the card", async () => {
    const { s } = await mk();
    const a = openId(1);
    const b = openId(2);
    expect(s.approvals.ask(a, "Alice").ok).toBe(true);
    expect(s.approvals.attach(a, { nonce: "N".repeat(22), cardMessageId: "om_card" })).toBe(true);
    expect(s.approvals.get(a)).toMatchObject({ state: "pending", nonce: "N".repeat(22), cardMessageId: "om_card" });
    expect(s.approvals.attach(a, { nonce: "bad" })).toBe(false);
    expect(s.approvals.resolve(a, "allowed")).toBe(true);
    expect(s.approvals.get(a)).toBeUndefined();
    s.approvals.ask(b, "Bob");
    expect(s.approvals.resolve(b, "ignored")).toBe(true);
    expect(s.approvals.get(b)).toMatchObject({ state: "ignored" });
    expect(s.approvals.get(b)!.nonce).toBeUndefined();
    expect(s.approvals.ask(b, "Bob")).toEqual({ ok: false, refused: "recent" });
    expect(s.approvals.resolve(openId(9), "allowed")).toBe(false);
  });

  it("bindings: rev strictly increases on every change and across remove/recreate; null clears; merge keeps the rest", async () => {
    const { s } = await mk();
    const key = "grp:oc_1:omt_1";
    const a = s.bindings.set(key, {
      chatId: "oc_1",
      chatType: "group",
      threadId: "omt_1",
      sessionId: "s1",
      label: "L",
    });
    const b = s.bindings.set(key, { chatId: "oc_1", chatType: "group", offline: "session-changed" });
    const c = s.bindings.set(key, { chatId: "oc_1", chatType: "group", sessionId: null, offline: null });
    if (!a.ok || !b.ok || !c.ok) throw new Error("set failed");
    expect(b.value).toMatchObject({ sessionId: "s1", label: "L", threadId: "omt_1", offline: "session-changed" });
    expect(c.value.sessionId).toBeUndefined();
    expect(c.value.offline).toBeUndefined();
    expect([a.value.rev, b.value.rev, c.value.rev]).toEqual([1, 2, 3]);
    expect(s.bindings.remove(key)).toBe(true);
    const d = s.bindings.set(key, { chatId: "oc_1", chatType: "group" });
    expect(d.ok && d.value.rev).toBe(4); // a frozen rev can never be matched by a recreated binding
    expect(s.bindings.set("p2p:x", { chatId: "", chatType: "p2p" })).toEqual({ ok: false, refused: "invalid" });
  });

  it("dialog cards: add/update/remove, duplicate refused", async () => {
    const { s } = await mk();
    const card = {
      id: "a:d1:1",
      agentKey: "a",
      dialogId: "d1",
      epoch: 1,
      bindingKey: "p2p:oc_1",
      chatId: "oc_1",
      messageId: "om_1",
      shortCode: "#k3",
    };
    const r = s.dialogCards.add(card);
    expect(r.ok && r.value.status).toBe("open");
    expect(s.dialogCards.add(card)).toEqual({ ok: false, refused: "exists" });
    expect(s.dialogCards.update("a:d1:1", { status: "answered", messageId: "om_2" })).toBe(true);
    expect(s.dialogCards.get("a:d1:1")).toMatchObject({ status: "answered", messageId: "om_2" });
    expect(s.dialogCards.update("missing", { status: "closed" })).toBe(false);
    expect(s.dialogCards.remove("a:d1:1")).toBe(true);
    expect(s.dialogCards.size).toBe(0);
  });

  it("outbox: sent/failed drop the content, same sendId refused, oversize content refused, settled parts expire", async () => {
    const { s, clock } = await mk();
    expect(s.outbox.add(partInput(1)).ok).toBe(true);
    expect(s.outbox.add(partInput(1))).toEqual({ ok: false, refused: "exists" });
    expect(s.outbox.add(partInput(2, { content: "x".repeat(FEISHU_REPLY_LIMITS.maxCardBytes + 1) }))).toEqual({
      ok: false,
      refused: "invalid",
    });
    expect(s.outbox.add(partInput(3, { sendId: "bad id!" }))).toEqual({ ok: false, refused: "invalid" });
    expect(s.outbox.update("send_1", { attempts: 1 })).toBe(true);
    expect(s.outbox.get("send_1")).toMatchObject({ state: "queued", attempts: 1 });
    expect(s.outbox.get("send_1")!.content).toBeDefined();
    expect(s.outbox.update("send_1", { state: "failed", code: "api-code-230020" })).toBe(true);
    expect(s.outbox.get("send_1")!.content).toBeUndefined();
    expect(s.outbox.list({ state: "queued" })).toHaveLength(0);
    expect(s.outbox.list({ state: "failed" })).toHaveLength(1);
    clock.advance(FEISHU_OUTBOX_SETTLED_TTL_MS + 1);
    expect(s.sweep()).toBe(1);
    expect(s.outbox.size).toBe(0);
    // queued parts never expire by TTL (they must survive until sent)
    s.outbox.add(partInput(4));
    clock.advance(100 * HOUR);
    s.sweep();
    expect(s.outbox.get("send_4")).toBeDefined();
  });

  it("undecodable: bounded ring (16), counter keeps counting, owner notice ≤1/h", async () => {
    const r = await mk();
    const { s, clock } = r;
    for (let i = 0; i < 40; i++) {
      clock.advance(1);
      s.undecodable.record({ reason: `r${i}` });
    }
    const snap = s.undecodable.snapshot();
    expect(snap.count).toBe(40);
    expect(snap.ring).toHaveLength(16);
    expect(snap.ring[0]!.reason).toBe("r24");
    expect(snap.ring.at(-1)!.reason).toBe("r39");
    s.undecodable.record({ reason: "x".repeat(100), sha8: "NOT-HEX!" });
    expect(s.undecodable.snapshot().ring.at(-1)).toEqual({ at: clock.now(), reason: "undecodable" });
    expect(s.undecodable.noticeDue()).toBe(true);
    s.undecodable.markNotice();
    expect(s.undecodable.noticeDue()).toBe(false);
    clock.advance(HOUR - 1);
    expect(s.undecodable.noticeDue()).toBe(false);
    clock.advance(1);
    expect(s.undecodable.noticeDue()).toBe(true);
    expect(await durable(r)).toBe(true);
    const again = await mk({ clock });
    expect(again.s.undecodable.snapshot().count).toBe(41);
  });
});

describe("crash matrix (kill points)", () => {
  it("crash between the `received` mutation and its commit ⇒ not durable ⇒ never ACKed ⇒ redelivery re-creates it", async () => {
    const r = await mk();
    expect(r.s.requests.receive(reqInput(1)).ok).toBe(true);
    r.s.dispose(); // kill -9 before the group commit fired
    const boot = await mk({ clock: r.clock });
    expect(boot.s.requests.get(cmdId(1))).toBeUndefined();
    expect(boot.s.requests.receive(reqInput(1)).ok).toBe(true);
  });

  it("crash after `received` is durable ⇒ dedup AND request recovered (redelivery is a duplicate)", async () => {
    const r = await mk();
    r.s.dedup.add("e:ev-1");
    r.s.requests.receive(reqInput(1));
    expect(await durable(r)).toBe(true);
    r.s.dispose();
    const boot = await mk({ clock: r.clock });
    expect(boot.s.dedup.has("e:ev-1")).toBe(true);
    expect(boot.s.requests.get(cmdId(1))!.state).toBe("received");
    expect(boot.s.requests.get(cmdId(1))!.payload!.body).toBe("hello 1");
  });

  it("crash after `dispatching` is durable but before `accepted` ⇒ recovers as dispatching (⇒ queryOnly path, never auto-redispatch)", async () => {
    const r = await mk();
    r.s.requests.receive(reqInput(1));
    expect(await durable(r)).toBe(true);
    r.s.requests.transition(cmdId(1), "dispatching", { agentKey: "ag", dispatchedAt: 1 });
    expect(await durable(r)).toBe(true);
    r.s.requests.transition(cmdId(1), "accepted"); // never committed: crash
    r.s.dispose();
    const boot = await mk({ clock: r.clock });
    expect(boot.s.requests.get(cmdId(1))).toMatchObject({ state: "dispatching", agentKey: "ag" });
    expect(boot.s.requests.get(cmdId(1))!.payload).toBeDefined();
  });

  it("crash mid-write (partial tmp left behind) ⇒ the live file is untouched and the next write replaces the stale tmp", async () => {
    const r = await mk();
    r.s.dedup.add("e:old");
    expect(await durable(r)).toBe(true);
    const good = readFileSync(statePath(), "utf8");
    writeFileSync(`${statePath()}.tmp`, '{"v":1,"half', { mode: 0o600 });
    r.s.dispose();
    const boot = await mk({ clock: r.clock });
    expect(boot.s.phase()).toBe("ok");
    expect(boot.s.dedup.has("e:old")).toBe(true);
    expect(readFileSync(statePath(), "utf8")).toBe(good);
    boot.s.dedup.add("e:new");
    expect(await durable(boot)).toBe(true);
    expect(readdirSync(dir)).toEqual([FEISHU_STATE_FILE]);
    expect(Object.keys(raw()["dedup"] as object).sort()).toEqual(["e:new", "e:old"]);
  });

  for (const stage of ["open", "write", "sync", "rename"] as const) {
    it(`I/O error at ${stage} never damages the previous file`, async () => {
      let failing = false;
      const r = await mk({
        fs: wrapFs({
          openWriteExcl: async (p, m) => {
            if (failing && stage === "open") throw new Error("x");
            const h = await realFeishuFs.openWriteExcl(p, m);
            return {
              writeFile: async (d) => {
                if (failing && stage === "write") throw new Error("x");
                return h.writeFile(d);
              },
              sync: async () => {
                if (failing && stage === "sync") throw new Error("x");
                return h.sync();
              },
              close: () => h.close(),
            };
          },
          rename: async (a, b) => {
            if (failing && stage === "rename") throw new Error("x");
            return realFeishuFs.rename(a, b);
          },
        }),
      });
      r.s.dedup.add("e:old");
      expect(await durable(r)).toBe(true);
      const good = readFileSync(statePath(), "utf8");
      failing = true;
      r.s.dedup.add("e:new");
      expect(await durable(r)).toBe(false);
      expect(readFileSync(statePath(), "utf8")).toBe(good);
      expect(readdirSync(dir)).toEqual([FEISHU_STATE_FILE]);
    });
  }

  it("restart sweeps expired entries it finds and rewrites on the next flush", async () => {
    const r = await mk();
    r.s.dedup.add("e:old");
    r.s.nonces.issue({
      installGen: 1,
      tenantKey: "tk",
      operatorOpenId: OWNER,
      chatId: "oc",
      messageId: "om",
      action: "a",
      target: "t",
    });
    expect(await durable(r)).toBe(true);
    r.clock.advance(73 * HOUR);
    const boot = await mk({ clock: r.clock });
    expect(boot.s.dedup.size).toBe(0);
    expect(boot.s.nonces.size).toBe(0);
    expect(await durable(boot)).toBe(true);
    expect(raw()["dedup"]).toEqual({});
  });
});

describe("F6 additive frozen context and merged terminal metadata (user ruling)", () => {
  it("round-trips source time/install/tenant and merged destination; merged drops payload and frees a slot", async () => {
    const r = await mk();
    const input = reqInput("member", { sourceCreatedAt: r.clock.now() - 500, installGen: 42, tenantKey: "tenant_1" });
    expect(r.s.requests.receive(input).ok).toBe(true);
    expect(r.s.requests.transition(input.id, "merged")).toEqual({ ok: false, reason: "invalid" });
    expect(r.s.requests.transition(input.id, "merged", { mergedBatchId: "bad" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(r.s.requests.get(input.id)?.state).toBe("received");
    expect(r.s.requests.transition(input.id, "merged", { mergedBatchId: hex("batch") }).ok).toBe(true);
    expect(r.s.requests.nonTerminal).toBe(0);
    expect(r.s.requests.terminal).toBe(1);
    expect(r.s.requests.get(input.id)).toMatchObject({
      state: "merged",
      mergedBatchId: hex("batch"),
      sourceCreatedAt: input.sourceCreatedAt,
      installGen: 42,
      tenantKey: "tenant_1",
    });
    expect(r.s.requests.get(input.id)?.payload).toBeUndefined();
    expect(await durable(r)).toBe(true);
    const boot = await mk({ clock: r.clock });
    expect(boot.s.requests.get(input.id)).toEqual(r.s.requests.get(input.id));
    expect(boot.s.requests.transition(input.id, "accepted")).toEqual({ ok: false, reason: "illegal" });
    r.clock.advance(FEISHU_CAPS.terminalTtlMs + 1);
    expect(boot.s.sweep()).toBe(1);
  });

  it("optional context keeps legacy files parseable; malformed context is refused", async () => {
    const r = await mk();
    expect(r.s.requests.receive(reqInput("legacy")).ok).toBe(true);
    for (const patch of [
      { sourceCreatedAt: -1 },
      { sourceCreatedAt: Infinity },
      { installGen: 1.5 },
      { tenantKey: "bad tenant" },
    ]) {
      expect(r.s.requests.receive({ ...reqInput(JSON.stringify(patch)), ...patch })).toEqual({
        ok: false,
        refused: "invalid",
      });
    }
    expect(r.s.requests.patch(cmdId("legacy"), { mergedBatchId: hex("batch") })).toBe(false);
    expect(r.s.requests.transition(cmdId("legacy"), "dispatching", { mergedBatchId: hex("batch") })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await durable(r)).toBe(true);
    const boot = await mk({ clock: r.clock });
    expect(boot.s.requests.get(cmdId("legacy"))?.sourceCreatedAt).toBeUndefined();
  });

  it.each(["missing-destination", "bad-destination", "nonmerged-destination", "bad-time", "bad-gen", "bad-tenant"])(
    "corrupt %s fails closed on reload",
    async (variant) => {
      const r = await mk();
      const input = reqInput("member");
      r.s.requests.receive(input);
      r.s.requests.transition(input.id, "merged", { mergedBatchId: hex("batch") });
      await durable(r);
      const doc = JSON.parse(readFileSync(statePath(), "utf8"));
      const record = doc.requests[input.id];
      if (variant === "missing-destination") delete record.mergedBatchId;
      if (variant === "bad-destination") record.mergedBatchId = "bad";
      if (variant === "nonmerged-destination") record.state = "expired";
      if (variant === "bad-time") record.sourceCreatedAt = -1;
      if (variant === "bad-gen") record.installGen = "1";
      if (variant === "bad-tenant") record.tenantKey = "bad tenant";
      writeFileSync(statePath(), JSON.stringify(doc), { mode: 0o600 });
      const boot = await mk({ clock: r.clock });
      expect(boot.s.phase()).toBe("corrupt");
      expect(boot.s.connectorMayStart()).toBe(false);
    },
  );
});

describe("F6 rework: persistent approval nonce pair", () => {
  it("round-trips the ignore nonce, rejects a malformed one, and clears both on decision", async () => {
    const r = await mk();
    r.s.approvals.ask("ou_stranger", "Stranger");
    expect(
      r.s.approvals.attach("ou_stranger", { nonce: "a".repeat(22), ignoreNonce: "bad", cardMessageId: "card" }),
    ).toBe(false);
    expect(
      r.s.approvals.attach("ou_stranger", {
        nonce: "a".repeat(22),
        ignoreNonce: "b".repeat(22),
        cardMessageId: "card",
      }),
    ).toBe(true);
    await durable(r);
    const boot = await mk({ clock: r.clock });
    expect(boot.s.approvals.get("ou_stranger")).toMatchObject({ nonce: "a".repeat(22), ignoreNonce: "b".repeat(22) });
    boot.s.approvals.resolve("ou_stranger", "ignored");
    expect(boot.s.approvals.get("ou_stranger")?.nonce).toBeUndefined();
    expect(boot.s.approvals.get("ou_stranger")?.ignoreNonce).toBeUndefined();
  });
});
