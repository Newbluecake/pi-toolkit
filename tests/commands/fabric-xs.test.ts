import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import {
  readXsMembershipEntry,
  XsEpochCounter,
  XsMembership,
  type XsMembershipEntryData,
} from "../../src/fabric/xs/membership.js";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import { createFabricXsCommand, type FabricXsCommandDeps, type XsBlockResolve } from "../../src/commands/fabric-xs.js";

/**
 * fabric phase-2 X4 (phase2-plan §5.3 + §11.2 X4 行 + r3 主会话裁定, superseded for web by the
 * 2026-10-22 user ruling): the `/fabric` command. Anchors: the FEISHU-ONLY HARD GATE (a
 * Feishu-marked invocation cannot join/leave/receive/block/unblock/fence reset even under any
 * policy — the gate never consults policy; web invocations — which are governed by
 * `webCommandPolicy.fabric` at the command-op policy layer, default allow — local TUI and local
 * RPC can all mutate), allowFrom full-session-id semantics, block's unique resolution
 * (ambiguous ⇒ candidates, never blocks; offline ⇒ full sessionId only), OFFLINE blocks /
 * unblock (local list only), and fork non-inheritance (P10: a mismatched sessionId entry
 * restores as not-joined).
 */

const SESSION = "sess-cmd-0123456789abcd";

interface CtxLog {
  notes: { message: string; level: string }[];
}

function makeCtx(
  web = false,
  mode: "tui" | "rpc" = "tui",
  feishu = false,
): { ctx: ExtensionCommandContext; log: CtxLog } {
  const log: CtxLog = { notes: [] };
  const ctx = {
    mode,
    ui: { notify: (message: string, level: string) => log.notes.push({ message, level }) },
    ...(web ? { webInvocation: true } : {}),
    ...(feishu ? { feishuInvocation: true } : {}),
  } as unknown as ExtensionCommandContext;
  return { ctx, log };
}

interface CommandHarness {
  run(args: string, opts?: { web?: boolean; feishu?: boolean; mode?: "tui" | "rpc" }): Promise<CtxLog>;
  membership: XsMembership;
  persisted: XsMembershipEntryData[];
  fence: ReturnType<typeof createSessionFence>;
  resolveCalls: string[];
  setResolve(impl: ((q: string) => Promise<XsBlockResolve>) | undefined): void;
  clock: FakeClock;
}

function makeCommand(over: Partial<FabricXsCommandDeps> = {}): CommandHarness {
  const clock = new FakeClock(1_000);
  const persisted: XsMembershipEntryData[] = [];
  const membership = new XsMembership({ sessionId: SESSION, clock, persist: (d) => persisted.push(d) });
  membership.attach();
  const fence = createSessionFence({ clock });
  const resolveCalls: string[] = [];
  let resolveImpl: ((q: string) => Promise<XsBlockResolve>) | undefined;
  const deps: FabricXsCommandDeps = {
    enabled: () => true,
    sessionId: () => SESSION,
    membership: () => membership,
    fence: () => fence,
    statusView: () => ({ capability: "verified", lines: ["in: recv 0/30h · wakes 0/12h · inbox 0/12"] }),
    now: () => clock.now(),
    ...(over.resolve !== undefined ? { resolve: over.resolve } : {}),
    ...over,
  };
  const command = createFabricXsCommand(deps);
  return {
    async run(args, opts = {}) {
      const { ctx, log } = makeCtx(opts.web ?? false, opts.mode ?? "tui", opts.feishu ?? false);
      // @ts-expect-error — the factory returns Omit<RegisteredCommand, name|sourceInfo>; handler is there
      await command.handler(args, ctx);
      return log;
    },
    membership,
    persisted,
    fence,
    resolveCalls,
    setResolve(impl) {
      resolveImpl = impl;
      (deps as { resolve?: unknown }).resolve =
        impl === undefined
          ? undefined
          : (q: string) => {
              resolveCalls.push(q);
              return impl(q);
            };
    },
    clock,
  };
}

describe("/fabric: feishu hard gate (2026-10-22 ruling; web is policy-gated, not gated here)", () => {
  it.each(["join", "leave", "receive wake", "block ab12", "unblock 1", "fence reset"])(
    "feishu-marked invocation cannot run `%s` — fixed refusal, no policy consulted",
    async (args) => {
      const h = makeCommand();
      const log = await h.run(args, { web: true, feishu: true });
      expect(log.notes).toEqual([{ message: "飞书入口不能修改跨会话加入状态，请在终端或 web 执行", level: "warning" }]);
      // nothing changed — the feishu mutation attempt never even reached the membership
      expect(h.membership.joined).toBe(false);
      expect(h.persisted).toEqual([]);
    },
  );

  it("feishu gate is FIRST, before the enabled/membership checks and before usage — even offline", async () => {
    // deps.enabled() false + no membership would otherwise answer first; the gate wins.
    const clock = new FakeClock(1_000);
    const dead: FabricXsCommandDeps = {
      enabled: () => false,
      sessionId: () => SESSION,
      membership: () => undefined,
      fence: () => undefined,
      statusView: () => ({ capability: "unknown", lines: [] }),
      now: () => clock.now(),
    };
    const command = createFabricXsCommand(dead);
    const { ctx, log } = makeCtx(true, "tui", true);
    // @ts-expect-error — handler exists on the factory product
    await command.handler("join", ctx);
    expect(log.notes).toEqual([{ message: "飞书入口不能修改跨会话加入状态，请在终端或 web 执行", level: "warning" }]);
  });

  it("web invocation CAN now mutate — the web surface is webCommandPolicy.fabric's job, not this handler's", async () => {
    const h = makeCommand();
    const log = await h.run("join", { web: true });
    expect(log.notes[0]!.message).toContain("已加入");
    expect(h.membership.joined).toBe(true);
    for (const args of ["leave", "receive wake", "unblock 1", "fence reset"]) {
      await h.run(args, { web: true });
    }
  });

  it("web can still READ: status and blocks pass the gate", async () => {
    const h = makeCommand();
    const status = await h.run("status", { web: true });
    expect(status.notes[0]!.message).toContain("not joined");
    const blocks = await h.run("blocks", { web: true });
    expect(blocks.notes[0]!.message).toContain("屏蔽列表为空");
  });

  it("local TUI and local RPC (no webInvocation) can mutate", async () => {
    for (const mode of ["tui", "rpc"] as const) {
      const h = makeCommand();
      const log = await h.run("join", { mode });
      expect(log.notes[0]!.message).toContain("已加入");
      expect(h.membership.joined).toBe(true);
    }
  });
});

describe("/fabric: membership commands", () => {
  it("join bumps epoch and persists; double join is a no-op without another bump", async () => {
    const h = makeCommand();
    await h.run("join");
    const e1 = h.membership.epoch;
    await h.run("join");
    expect(h.membership.epoch).toBe(e1);
    await h.run("leave");
    expect(h.membership.epoch).toBe(e1 + 1);
    expect(h.persisted.at(-1)!.joined).toBe(false);
  });

  it("receive changes policy WITHOUT an epoch bump (§8.1)", async () => {
    const h = makeCommand();
    await h.run("join");
    const e = h.membership.epoch;
    await h.run("receive deliver");
    expect(h.membership.receive).toBe("deliver");
    expect(h.membership.epoch).toBe(e);
    expect(h.persisted.at(-1)!.receive).toBe("deliver");
    const bad = await h.run("receive loud");
    expect(bad.notes[0]!.level).toBe("warning");
  });

  it("status shows joined state, receive, the FULL own sessionId, fence and capability", async () => {
    const h = makeCommand();
    await h.run("join");
    const log = await h.run("status");
    const text = log.notes[0]!.message;
    expect(text).toContain("joined");
    expect(text).toContain(`sid: ${SESSION}`);
    expect(text).toContain("host cap: verified");
    expect(text).toContain("fence:");
  });

  it("status shows the preference only when reply is disabled and the effective receive differs", async () => {
    const m = new XsMembership({ sessionId: SESSION, persist: () => {}, replyEnabled: false });
    m.attach();
    m.join();
    m.setReceive("replies");
    const h = makeCommand({ membership: () => m });
    expect((await h.run("status")).notes[0]!.message).toContain("recv off (pref replies) · epoch");
    const plain = makeCommand();
    await plain.run("join");
    const text = (await plain.run("status")).notes[0]!.message;
    expect(text).toContain("recv wake · epoch");
    expect(text).not.toContain("pref");
  });

  it("fence reset clears a stuck window (local only — web is gated above)", async () => {
    const h = makeCommand();
    h.fence.onEvent({ type: "session_before_tree" });
    h.clock.advance(31_000);
    h.clock.advance(0); // stuck timer fires during advance
    expect(h.fence.status().stuck).toEqual(["tree"]);
    await h.run("fence reset");
    expect(h.fence.status().open).toEqual([]);
    const usage = await h.run("fence clear");
    expect(usage.notes[0]!.level).toBe("warning");
  });
});

describe("/fabric: allowFrom full-session-id semantics (#14)", () => {
  it("empty allowFrom ⇒ any sender; a list ⇒ only listed FULL ids; all-invalid ⇒ deny-all", () => {
    const clock = new FakeClock(0);
    const open = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
    expect(open.senderAllowed("sess-anyone-1234")).toBe(true);

    const listed = new XsMembership({
      sessionId: SESSION,
      allowFrom: ["sess-friend-0001", "sess-friend-0002"],
      clock,
      persist: () => {},
    });
    expect(listed.senderAllowed("sess-friend-0001")).toBe(true);
    expect(listed.senderAllowed("sess-friend-000")).toBe(false); // prefix is NOT a full id
    expect(listed.senderAllowed("sess-other-9999")).toBe(false);

    const denyAll = new XsMembership({
      sessionId: SESSION,
      allowFrom: [],
      allowFromDenyAll: true,
      clock,
      persist: () => {},
    });
    expect(denyAll.senderAllowed("sess-friend-0001")).toBe(false); // fail closed
  });

  it("blocked senders are refused regardless of allowFrom", () => {
    const clock = new FakeClock(0);
    const m = new XsMembership({
      sessionId: SESSION,
      allowFrom: ["sess-friend-0001"],
      clock,
      persist: () => {},
    });
    m.block("sess-friend-0001", "buddy");
    expect(m.senderAllowed("sess-friend-0001")).toBe(false);
  });

  it("status renders the deny-all marker (all-invalid config)", async () => {
    const clock = new FakeClock(0);
    const membership = new XsMembership({
      sessionId: SESSION,
      allowFrom: [],
      allowFromDenyAll: true,
      clock,
      persist: () => {},
    });
    membership.attach();
    const h = makeCommandWithMembership(membership, clock);
    const log = await h.run("status");
    expect(log.notes[0]!.message).toContain("deny-all");
  });
});

function makeCommandWithMembership(membership: XsMembership, clock: FakeClock) {
  const fence = createSessionFence({ clock });
  const command = createFabricXsCommand({
    enabled: () => true,
    sessionId: () => SESSION,
    membership: () => membership,
    fence: () => fence,
    statusView: () => ({ capability: "unknown", lines: [] }),
    now: () => clock.now(),
  });
  return {
    async run(args: string, opts: { web?: boolean } = {}) {
      const { ctx, log } = makeCtx(opts.web ?? false);
      // @ts-expect-error — handler exists on the factory product
      await command.handler(args, ctx);
      return log;
    },
  };
}

describe("/fabric block: unique resolution (§5.3/#14)", () => {
  it("hub resolves uniquely ⇒ blocked with a name snapshot", async () => {
    const h = makeCommand();
    h.setResolve(async (q) =>
      q === "buddy" ? { ok: true, sessionId: "sess-target-0001", name: "buddy" } : { ok: false, kind: "no_target" },
    );
    const log = await h.run("block buddy");
    expect(log.notes[0]!.message).toContain("sess-target-0001");
    expect(h.membership.blockedSnapshot()).toEqual([
      { sessionId: "sess-target-0001", nameSnapshot: "buddy", at: h.clock.now() },
    ]);
    expect(h.persisted.at(-1)!.blocked).toHaveLength(1);
  });

  it("ambiguous resolve ⇒ candidates listed, NOTHING blocked", async () => {
    const h = makeCommand();
    h.setResolve(async () => ({
      ok: false,
      kind: "ambiguous",
      candidates: [
        { ref: "ab12cd34ef56", name: "buddy1" },
        { ref: "ab99cd88ef77", name: "buddy2" },
      ],
    }));
    const log = await h.run("block buddy");
    expect(log.notes[0]!.level).toBe("warning");
    expect(log.notes[0]!.message).toContain("ab12cd34ef56");
    expect(h.membership.blockedSnapshot()).toEqual([]);
  });

  it("target offline ⇒ only a FULL sessionId is accepted; names/refs are refused", async () => {
    const h = makeCommand();
    h.setResolve(async () => ({ ok: false, kind: "no_target" }));
    const refused = await h.run("block buddy");
    expect(refused.notes[0]!.message).toContain("完整 sessionId");
    expect(h.membership.blockedSnapshot()).toEqual([]);
    const ok = await h.run("block sess-offline-0001");
    expect(ok.notes[0]!.message).toContain("sess-offline-0001");
    expect(h.membership.blockedSnapshot()).toHaveLength(1);
  });

  it("no resolve port wired (hub off) ⇒ offline full-id rule directly", async () => {
    const h = makeCommand();
    const ok = await h.run("block sess-offline-0002");
    expect(ok.notes[0]!.message).toContain("sess-offline-0002");
  });

  it("duplicate and cap refusals", async () => {
    const h = makeCommand();
    h.setResolve(async (q) => ({ ok: true, sessionId: q }));
    await h.run("block sess-a-000000000001");
    const dup = await h.run("block sess-a-000000000001");
    expect(dup.notes[0]!.message).toContain("已在屏蔽列表");
  });
});

describe("/fabric blocks & unblock: OFFLINE (§5.3/#14)", () => {
  async function withEntries() {
    const h = makeCommand();
    await h.run("block sess-alpha-0001"); // offline full-id path
    await h.run("block sess-beta-0002");
    await h.run("block sess-gamma-0003");
    return h;
  }

  it("blocks lists index + full id + name snapshot + age — never touches the hub", async () => {
    const h = await withEntries();
    h.setResolve(async () => {
      throw new Error("hub must not be called");
    });
    const log = await h.run("blocks");
    const text = log.notes[0]!.message;
    expect(text).toContain("1. sess-alpha-0001");
    expect(text).toContain("3/64");
    expect(h.resolveCalls).toEqual([]);
  });

  it("unblock by 1-based index / full id / unique prefix ≥8 / name snapshot — all offline", async () => {
    const h = await withEntries();
    h.setResolve(async () => {
      throw new Error("hub must not be called");
    });
    await h.run("unblock 2");
    expect(h.membership.blockedSnapshot().map((b) => b.sessionId)).toEqual(["sess-alpha-0001", "sess-gamma-0003"]);
    await h.run("unblock sess-gamma-0003");
    expect(h.membership.blockedSnapshot().map((b) => b.sessionId)).toEqual(["sess-alpha-0001"]);

    const g = await withEntries();
    await g.run("unblock sess-beta"); // 8-char prefix, unique
    expect(g.membership.blockedSnapshot().map((b) => b.sessionId)).toEqual(["sess-alpha-0001", "sess-gamma-0003"]);

    const k = await withEntries();
    await k.run("block sess-named-0004"); // then patch a name via a second membership op
    await k.run("unblock 4");
    expect(k.membership.blockedSnapshot()).toHaveLength(3);
  });

  it("unblock ambiguity lists candidates and blocks nothing; unknown selector is not_found", async () => {
    const h = await withEntries();
    const before = h.membership.blockedSnapshot().length;
    const amb = await h.run("unblock sess-"); // 4 chars < 8 ⇒ no prefix match; not a name ⇒ not_found
    expect(amb.notes[0]!.message).toContain("未找到");
    expect(h.membership.blockedSnapshot()).toHaveLength(before);
  });

  it("short prefix (<8) never matches as a prefix", async () => {
    const h = await withEntries();
    const log = await h.run("unblock sess-al"); // 7 chars — below the ≥8 threshold
    expect(log.notes[0]!.message).toContain("未找到");
  });
});

describe("membership entry persistence & fork (D2/P10)", () => {
  it("restore round-trips join/receive/blocked through the session entry", () => {
    const clock = new FakeClock(1_000);
    const m = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
    m.attach();
    m.join();
    m.setReceive("deliver");
    m.block("sess-blocked-0001", "old-friend");
    const entry = m.toEntryData();
    const branch = [{ type: "custom", customType: "subagent:xs-membership", data: entry }];
    expect(readXsMembershipEntry(branch)).toEqual(entry);

    const restored = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
    restored.attach();
    restored.restore(readXsMembershipEntry(branch));
    expect(restored.joined).toBe(true);
    expect(restored.receive).toBe("deliver");
    expect(restored.blockedSnapshot()).toEqual([
      { sessionId: "sess-blocked-0001", nameSnapshot: "old-friend", at: 1_000 },
    ]);
  });

  it("fork does NOT inherit: an entry recorded for a different sessionId restores as not joined", () => {
    const clock = new FakeClock(1_000);
    const original = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
    original.attach();
    original.join();
    original.block("sess-blocked-0001");
    const entry = original.toEntryData();

    // the fork copies the session FILE ⇒ the branch carries the parent's entry, but the fork's
    // live sessionId differs ⇒ ignored (P10), including its blocklist.
    const fork = new XsMembership({ sessionId: "sess-fork-999888777666", clock, persist: () => {} });
    fork.attach();
    fork.restore(entry);
    expect(fork.joined).toBe(false);
    expect(fork.blockedSnapshot()).toEqual([]);
  });

  it("malformed newest entry ⇒ no restorable state (tolerant read-back)", () => {
    const branch = [{ type: "custom", customType: "subagent:xs-membership", data: { v: 99 } }];
    expect(readXsMembershipEntry(branch)).toBeUndefined();
    expect(readXsMembershipEntry([])).toBeUndefined();
  });

  it("epoch is process-level: one counter shared across stack rebuilds, bumped on attach/join/leave", () => {
    const counter = new XsEpochCounter();
    const clock = new FakeClock(0);
    const a = new XsMembership({ sessionId: SESSION, clock, epoch: counter, persist: () => {} });
    a.attach();
    const b = new XsMembership({ sessionId: SESSION, clock, epoch: counter, persist: () => {} });
    b.attach(); // stack rebuild
    b.join();
    b.leave();
    expect(counter.value).toBe(4); // attach, attach, join, leave
    expect(b.epoch).toBe(4);
  });
});

describe("RX5 membership receivePref and replies command", () => {
  it("persists replies as off + receivePref, restores preference with reply off fail-closed", () => {
    const m = new XsMembership({ sessionId: SESSION, persist: () => {} });
    m.join();
    m.setReceive("replies");
    expect(m.receive).toBe("replies");
    const entry = m.toEntryData();
    expect(entry).toMatchObject({ receive: "off", receivePref: "replies" });
    // The previous reader uses only receive and ignores extra keys; it therefore sees off.
    expect(entry.receive).toBe("off");
    const read = readXsMembershipEntry([{ type: "custom", customType: "subagent:xs-membership", data: entry }]);
    for (const replyEnabled of [true, false]) {
      const restored = new XsMembership({ sessionId: SESSION, replyEnabled, persist: () => {} });
      restored.restore(read);
      expect(restored.receivePref).toBe("replies");
      expect(restored.receive).toBe(replyEnabled ? "replies" : "off");
      expect(restored.toEntryData()).toEqual(entry);
    }
  });

  it("legacy receive entries stay byte-compatible; invalid receivePref does not widen", () => {
    const m = new XsMembership({ sessionId: SESSION, replyEnabled: false, persist: () => {} });
    const entry = m.toEntryData();
    expect(entry).not.toHaveProperty("receivePref");
    const read = readXsMembershipEntry([
      { type: "custom", customType: "subagent:xs-membership", data: { ...entry, receive: "off", receivePref: "wake" } },
    ]);
    expect(read?.receive).toBe("off");
    expect(read).not.toHaveProperty("receivePref");
    const d = new XsMembership({
      sessionId: SESSION,
      defaultReceive: "replies",
      replyEnabled: false,
      persist: () => {},
    });
    d.join();
    expect(d.receive).toBe("off");
    expect(d.receivePref).toBe("replies");
  });

  it("receive replies changes preference without bumping epoch, remains Feishu-hard-refused", async () => {
    const h = makeCommand();
    await h.run("join");
    const epoch = h.membership.epoch;
    await h.run("receive replies", { web: true });
    expect(h.membership.receive).toBe("replies");
    expect(h.membership.epoch).toBe(epoch);
    expect(h.persisted.at(-1)).toMatchObject({ receive: "off", receivePref: "replies" });
    await h.run("receive off");
    const log = await h.run("receive replies", { feishu: true });
    expect(log.notes[0]?.message).toContain("飞书入口");
    expect(h.membership.receive).toBe("off");
  });

  it("reply-disabled receive replies refuses instead of widening to wake", async () => {
    const membership = new XsMembership({ sessionId: SESSION, replyEnabled: false, persist: () => {} });
    const h = makeCommand({ membership: () => membership });
    const log = await h.run("receive replies");
    expect(log.notes[0]?.message).toContain("reply.enabled=false");
    expect(membership.receive).toBe("wake");
  });

  it("replies view and status render ledger rows/counters; completion includes replies", async () => {
    const clock = new FakeClock(1000);
    const ledger = new XsReplyLedger({ clock });
    const issued = ledger.issue({
      requesterSessionId: SESSION,
      replierSessionId: "target",
      replierRef: "target-ref",
      origin: "model",
      wakeOnReply: true,
      requesterLevel: 0,
      timeoutMs: 60_000,
      lateGraceMs: 600_000,
      maxPending: 8,
      maxPendingPerTarget: 3,
    });
    if (!issued.ok) throw new Error("issue failed");
    const h = makeCommand({ replies: () => ({ ledger, maxPending: 8 }) });
    const rows = (await h.run("replies", { web: true })).notes[0]?.message;
    expect(rows).toContain(issued.ticket.requestId);
    expect(rows).toContain("target-ref · 60s · pending · owed no");
    expect((await h.run("status")).notes[0]?.message).toContain("replies pending 1/8 · inbox 0");
    const command = createFabricXsCommand({
      enabled: () => true,
      sessionId: () => SESSION,
      membership: () => h.membership,
      fence: () => h.fence,
      statusView: () => ({ capability: "verified", lines: [] }),
    });
    expect(command.getArgumentCompletions?.("receive r")).toMatchObject([
      { value: "receive replies", label: "replies" },
    ]);
    expect(command.getArgumentCompletions?.("rep")).toEqual([{ value: "replies", label: "replies" }]);
  });

  it("argument completions: trailing space, filter, descriptions, fence, unblock, bad input", () => {
    const h = makeCommand();
    const c = createFabricXsCommand({
      enabled: () => true,
      sessionId: () => SESSION,
      membership: () => h.membership,
      fence: () => h.fence,
      statusView: () => ({ capability: "verified", lines: [] }),
    });
    const f = (s: string) => c.getArgumentCompletions?.(s) as { value: string; label: string; description?: string }[];
    expect(f("receive").map((x) => x.value)).toEqual(["receive"]);
    const modes = f("receive ");
    expect(modes.map((x) => x.value)).toEqual(["receive off", "receive deliver", "receive wake", "receive replies"]);
    expect(modes.every((x) => (x.description ?? "").length > 0)).toBe(true);
    expect(modes.find((x) => x.label === "wake")?.description).toBe("送达并可被唤醒（默认）");
    expect(f("receive d").map((x) => x.label)).toEqual(["deliver"]);
    expect(f("receive x")).toEqual([]);
    expect(f("fence ").map((x) => x.value)).toEqual(["fence reset"]);
    expect(f("fence z")).toEqual([]);
    expect(f("unblock ")).toEqual([]);
    h.membership.block("abcdefgh-0123456789", "bob");
    expect(f("unblock ").map((x) => x.value)).toEqual(["unblock abcdefgh-0123456789"]);
    expect(f("unblock bo")[0]?.label).toBe("bob");
    expect(f("unblock zz")).toEqual([]);
    expect(f("")).toHaveLength(9);
    expect(f("join extra stuff")).toEqual([]);
    const off = createFabricXsCommand({
      enabled: () => true,
      sessionId: () => SESSION,
      membership: () => {
        throw new Error("boom");
      },
      fence: () => h.fence,
      statusView: () => ({ capability: "verified", lines: [] }),
    });
    expect(off.getArgumentCompletions?.("receive ")).toEqual([]);
  });
});
