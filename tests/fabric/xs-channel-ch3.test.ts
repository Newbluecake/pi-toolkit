import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import {
  readXsMembershipEntry,
  XsEpochCounter,
  XsMembership,
  XS_MEMBERSHIP_CUSTOM_TYPE,
  type XsMembershipDeps,
  type XsMembershipEntryData,
} from "../../src/fabric/xs/membership.js";
import { XsReplyLedger, createXsReplyInboxPort } from "../../src/fabric/xs/reply-ledger.js";
import { XsReceiver, type XsDeliverHost, type XsDeliverInput } from "../../src/fabric/xs/receiver.js";
import type { RootWakeRequest } from "../../src/fabric/root-wake.js";
import { formatXsMessage, XS_BROADCAST_NOTE } from "../../src/fabric/xs/format.js";
import { buildXsView, xsHeaderLine } from "../../src/fabric/xs/render.js";
import { createFabricXsCommand, type FabricXsCommandDeps } from "../../src/commands/fabric-xs.js";
import type { XsChannelView } from "../../src/fabric/xs/types-channel.js";

/**
 * Channel-plan CH3 (§2.2 command semantics, §2.3 suspension, §2.4 persistence, §4.4/§4.5 stage-3
 * scope re-check, §5.3 broadcast display + Controller threading, §6.3 `/fabric` channels). Real
 * membership / fence / dedup / inbox / reply ledger; the host is a pure fake.
 */

const SESSION = "sess-ch3-0123456789abcdef";
const SENDER = "sess-peer-9876543210fedcba";

function membershipOf(over: Partial<XsMembershipDeps> = {}) {
  const persisted: XsMembershipEntryData[] = [];
  const clock = new FakeClock(5_000);
  const membership = new XsMembership({
    sessionId: SESSION,
    clock,
    epoch: new XsEpochCounter(0),
    persist: (d) => persisted.push(d),
    ...over,
  });
  membership.attach();
  return { membership, persisted, clock };
}

const branchOf = (data: unknown) => [{ type: "custom", customType: XS_MEMBERSHIP_CUSTOM_TYPE, data }];

describe("CH3 membership: §2.4 entry write rule (three shapes)", () => {
  it("∅ ⇒ joined:false, no channels key; [default] ⇒ byte-identical legacy entry; named ⇒ channels + joined=pref∋default", () => {
    const { membership, persisted } = membershipOf();
    expect(membership.toEntryData()).toEqual({ v: 1, sessionId: SESSION, joined: false, receive: "wake", blocked: [] });
    expect("channels" in membership.toEntryData()).toBe(false);

    membership.join();
    // Same bytes as the reply-off golden's `membershipEntry` shape (key order included).
    expect(JSON.stringify(persisted.at(-1))).toBe(
      JSON.stringify({ v: 1, sessionId: SESSION, joined: true, receive: "wake", blocked: [], joinedAt: 5_000 }),
    );

    membership.join(["#team"]);
    expect(persisted.at(-1)).toMatchObject({ joined: true, channels: ["default", "team"] });

    membership.leave(["#default"]);
    expect(persisted.at(-1)).toMatchObject({ joined: false, channels: ["team"] });
    expect(membership.joined).toBe(true); // effective [team] ≠ ∅
  });

  it("read-back: a legal channels array wins (normalized, capped at 4); a junk array falls back to joined ⇒ [default]", () => {
    const entry = readXsMembershipEntry(
      branchOf({
        v: 1,
        sessionId: SESSION,
        joined: false,
        channels: ["#Team", "b", "c", "d", "e", "bad name", 7],
        receive: "wake",
        blocked: [],
      }),
    );
    expect(entry?.channels).toEqual(["b", "c", "d", "e"]); // sorted, capped at 4 (default-first order)
    const { membership } = membershipOf();
    membership.restore(entry);
    expect(membership.pref()).toEqual(["b", "c", "d", "e"]);

    const junk = readXsMembershipEntry(
      branchOf({ v: 1, sessionId: SESSION, joined: true, channels: ["NOT OK", null], receive: "wake", blocked: [] }),
    );
    expect(junk && "channels" in junk).toBe(false);
    const m2 = membershipOf().membership;
    m2.restore(junk);
    expect(m2.pref()).toEqual(["default"]);

    // Legacy entry without `channels`: joined:false ⇒ ∅.
    const m3 = membershipOf().membership;
    m3.restore(
      readXsMembershipEntry(branchOf({ v: 1, sessionId: SESSION, joined: false, receive: "wake", blocked: [] })),
    );
    expect(m3.pref()).toEqual([]);
  });

  it("fork (sessionId mismatch) never inherits named channels (P10)", () => {
    const { membership } = membershipOf();
    membership.restore({
      v: 1,
      sessionId: "sess-other",
      joined: false,
      channels: ["team"],
      receive: "wake",
      blocked: [],
    });
    expect(membership.pref()).toEqual([]);
    expect(membership.joined).toBe(false);
  });
});

describe("CH3 membership: §2.3 suspension (channels.enabled=false)", () => {
  it("saved [a] → disabled → reload ⇒ not joined, entry untouched → enabled → reload ⇒ [a]", () => {
    const first = membershipOf();
    first.membership.join(["a"]);
    const saved = first.persisted.at(-1)!;
    expect(saved).toMatchObject({ joined: false, channels: ["a"] });

    const off = membershipOf({ channelsEnabled: false });
    off.membership.restore(readXsMembershipEntry(branchOf(saved)));
    expect(off.membership.joined).toBe(false);
    expect(off.membership.effective()).toEqual([]);
    expect(off.membership.suspended()).toEqual(["a"]);
    expect(off.membership.linkJoined(true)).toBe(false);
    expect(off.persisted).toEqual([]); // restore never rewrites the entry
    expect(off.membership.toEntryData()).toEqual(saved); // a later unrelated write keeps the suspended pref verbatim

    const on = membershipOf({ channelsEnabled: true });
    on.membership.restore(readXsMembershipEntry(branchOf(saved)));
    expect(on.membership.joined).toBe(true);
    expect(on.membership.effective()).toEqual(["a"]);
  });

  it("[default, a] under disabled ⇒ effective [default] only (never folded wider), named join/leave refused, bare join/leave still work", () => {
    const { membership, persisted } = membershipOf({ channelsEnabled: false });
    membership.restore({
      v: 1,
      sessionId: SESSION,
      joined: true,
      channels: ["default", "a"],
      receive: "wake",
      blocked: [],
    });
    expect(membership.effective()).toEqual(["default"]);
    const epoch = membership.epoch;
    expect(membership.join(["#b"])).toEqual({ ok: false, reason: "channels_disabled" });
    expect(membership.leave(["#a"])).toEqual({ ok: false, reason: "channels_disabled" });
    expect(membership.epoch).toBe(epoch);
    expect(persisted).toEqual([]);
    expect(membership.join()).toEqual({ ok: false, reason: "already_joined" });
    // bare leave clears suspended channels too (§2.2)
    expect(membership.leave()).toMatchObject({ ok: true });
    expect(membership.pref()).toEqual([]);

    // A suspended-only pref + bare join adds default while keeping the suspended channel.
    const s = membershipOf({ channelsEnabled: false });
    s.membership.restore({ v: 1, sessionId: SESSION, joined: false, channels: ["a"], receive: "wake", blocked: [] });
    expect(s.membership.join()).toMatchObject({ ok: true });
    expect(s.persisted.at(-1)).toMatchObject({ joined: true, channels: ["default", "a"] });
  });
});

describe("CH3 membership: §2.2 incremental join/leave + epoch", () => {
  it("never joined ⇒ join #a is ONLY #a (Q3); in #default ⇒ [default,a]; leave #default isolates", () => {
    const fresh = membershipOf().membership;
    expect(fresh.join(["#a"])).toMatchObject({ ok: true });
    expect(fresh.pref()).toEqual(["a"]);

    const { membership } = membershipOf();
    membership.join();
    const e = membership.epoch;
    expect(membership.join(["#A", "a"])).toEqual({ ok: true, epoch: e + 1 });
    expect(membership.pref()).toEqual(["default", "a"]);
    expect(membership.join(["a"])).toEqual({ ok: false, reason: "already_joined" });
    expect(membership.epoch).toBe(e + 1); // no change ⇒ no bump
    expect(membership.leave(["#default"])).toEqual({ ok: true, epoch: e + 2 });
    expect(membership.pref()).toEqual(["a"]);
    expect(membership.leave(["#zzz"])).toEqual({ ok: false, reason: "not_joined" });
    expect(membership.epoch).toBe(e + 2);
  });

  it("whole-call rejection: invalid / reserved / >4 change nothing", () => {
    const { membership, persisted } = membershipOf();
    membership.join(["a", "b", "c"]);
    const before = membership.pref();
    const e = membership.epoch;
    const n = persisted.length;
    expect(membership.join(["d", "Ünicode"])).toEqual({ ok: false, reason: "invalid", names: ["Ünicode"] });
    expect(membership.join(["d", "#all"])).toEqual({ ok: false, reason: "reserved", names: ["#all"] });
    expect(membership.join(["pi-x"])).toMatchObject({ ok: false, reason: "reserved" });
    expect(membership.join(["d", "e"])).toEqual({ ok: false, reason: "too_many", max: 4 });
    expect(membership.leave(["bad name!"])).toMatchObject({ ok: false, reason: "invalid" });
    expect(membership.pref()).toEqual(before);
    expect(membership.epoch).toBe(e);
    expect(persisted.length).toBe(n);
    expect(membership.join(["d"])).toMatchObject({ ok: true }); // exactly 4 is fine
  });

  it("XsChannelView: link(hubCap) drops named channels on a hub without xs.channel.v1", () => {
    const { membership } = membershipOf();
    const view: XsChannelView = membership;
    membership.join(["a"]);
    expect(view.link(true)).toEqual(["a"]);
    expect(view.link(false)).toEqual([]);
    expect(view.linkJoined(false)).toBe(false);
    membership.join();
    expect(view.link(false)).toEqual(["default"]);
    expect(view.linkJoined(false)).toBe(true);
  });
});

// ----------------------------------------------------------------- receiver stage 3 (§4.4 / Q4)

function receiverHarness(opts: { hubCap?: boolean; replies?: boolean; join?: string[] | "default" } = {}) {
  const clock = new FakeClock(1_000);
  const membership = new XsMembership({ sessionId: SESSION, clock, epoch: new XsEpochCounter(0), persist: () => {} });
  membership.attach();
  if (opts.join === "default" || opts.join === undefined) membership.join();
  else membership.join(opts.join);
  const sent: { message: { content: string; details?: unknown }; options: { triggerTurn: boolean } }[] = [];
  const leaves: { type: string; customType?: string; details?: unknown }[] = [];
  const host: XsDeliverHost = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sendMessage(message, options) {
      sent.push({ message, options });
      leaves.push({ type: "custom_message", customType: message.customType, details: message.details });
    },
    getLeafEntry: () => leaves.at(-1),
  };
  const replyInbox = new XsInbox(2, clock);
  const replyLedger = new XsReplyLedger({ clock });
  replyLedger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(replyInbox) });
  const receiver = new XsReceiver({
    sessionId: SESSION,
    membership,
    fence: createSessionFence({ clock }),
    inbox: new XsInbox(12, clock),
    ...(opts.replies ? { replyLedger } : {}),
    recvPerHour: 30,
    wakesInPerHour: 12,
    host,
    ...(opts.hubCap === undefined ? {} : { hubChannelCap: () => opts.hubCap! }),
    dedup: new XsDedup(256, clock),
    clock,
    warn: () => {},
  });
  let n = 0;
  const input = (over: Partial<XsDeliverInput> = {}): XsDeliverInput => ({
    xid: `xid-${++n}`,
    to: { sessionId: SESSION, epoch: membership.epoch },
    from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/ai/peer", agentId: "agent-1" },
    text: "hi",
    wake: false,
    expiresAt: clock.now() + 5_000,
    ...over,
  });
  return { membership, receiver, sent, input, replyLedger, replyInbox, clock };
}

const REJECTED = { effect: "none", reason: "rejected", woke: false };

describe("CH3 receiver: stage-3 channel scope re-check (§4.4)", () => {
  it("default-only: no via ⇒ unchanged applied; frames are judged against [default]", () => {
    const h = receiverHarness();
    expect(h.receiver.deliver(h.input())).toMatchObject({ effect: "applied" });
    // A via that does not include default cannot reach a default-only session.
    expect(h.receiver.deliver(h.input({ via: ["team"] }))).toEqual(REJECTED);
    expect(h.receiver.deliver(h.input({ bc: { channel: "team" } }))).toEqual(REJECTED);
  });

  it("[team] only: via ∋ team accepted; missing via (≡ [default]) rejected; bc on another channel rejected", () => {
    const h = receiverHarness({ join: ["team"], hubCap: true });
    expect(h.receiver.deliver(h.input({ via: ["team"] }))).toMatchObject({ effect: "applied" });
    expect(h.receiver.deliver(h.input())).toEqual(REJECTED);
    expect(h.receiver.deliver(h.input({ bc: { channel: "ops" } }))).toEqual(REJECTED);
    expect(h.receiver.deliver(h.input({ bc: { channel: "team" } }))).toMatchObject({ effect: "applied" });
    // bc takes precedence over via
    expect(h.receiver.deliver(h.input({ via: ["team"], bc: { channel: "ops" } }))).toEqual(REJECTED);
  });

  it("linkChannels: hub without the cap and no via ⇒ a named-only member is not joined on the link (fail closed)", () => {
    const h = receiverHarness({ join: ["team"], hubCap: false });
    expect(h.receiver.deliver(h.input())).toEqual(REJECTED);
    // An unwired cap port is the same as no cap.
    const u = receiverHarness({ join: ["team"] });
    expect(u.receiver.deliver(u.input())).toEqual(REJECTED);
    // [default, team] on an old hub: still reachable through #default.
    const mixed = receiverHarness({ join: "default", hubCap: false });
    mixed.membership.join(["team"]);
    expect(
      mixed.receiver.deliver(mixed.input({ to: { sessionId: SESSION, epoch: mixed.membership.epoch } })),
    ).toMatchObject({
      effect: "applied",
    });
  });

  it("a throwing hub-cap port reads as no cap", () => {
    const h = receiverHarness({ join: ["team"] });
    (h.receiver as unknown as { deps: { hubChannelCap: () => boolean } }).deps.hubChannelCap = () => {
      throw new Error("boom");
    };
    expect(h.receiver.deliver(h.input())).toEqual(REJECTED);
  });

  it("§4.5: leave BEFORE stage 3 ⇒ rejected; leave AFTER dispatch keeps the effect (dedup replays applied, no rollback)", () => {
    const h = receiverHarness({ join: ["team"], hubCap: true });
    const first = h.input({ xid: "x-after", via: ["team"] });
    expect(h.receiver.deliver(first)).toMatchObject({ effect: "applied" });
    h.membership.leave(["team"]);
    expect(h.receiver.deliver(first)).toMatchObject({ effect: "applied" }); // replayed verdict, nothing rolled back
    expect(h.sent).toHaveLength(1);
    expect(h.receiver.deliver(h.input({ via: ["team"] }))).toEqual(REJECTED);
  });

  it("Q4: a reply with no shared channel is refused BEFORE reserve — the credential survives; re-sharing lets a resend through", () => {
    const h = receiverHarness({ join: ["team"], hubCap: true, replies: true });
    const issued = h.replyLedger.issue({
      requesterSessionId: SESSION,
      replierSessionId: SENDER,
      replierRef: "ab12cd34ef56",
      origin: "model",
      wakeOnReply: false,
      requesterLevel: 0,
      timeoutMs: 60_000,
      lateGraceMs: 600_000,
      maxPending: 2,
      maxPendingPerTarget: 2,
    });
    if (!issued.ok) throw new Error("issue failed");
    const requestId = issued.ticket.requestId;
    h.membership.leave(["team"]);
    h.membership.join(["ops"]);
    const reserve = vi.spyOn(h.replyLedger, "reserve");
    const epoch = () => ({ to: { sessionId: SESSION, epoch: h.membership.epoch } });
    expect(h.receiver.deliver(h.input({ ...epoch(), inReplyTo: requestId, via: ["team"] }))).toEqual(REJECTED);
    expect(reserve).not.toHaveBeenCalled();
    expect(h.replyLedger.get(requestId)?.state).toBe("pending");
    expect(h.replyInbox.occupied).toBe(0);
    h.membership.join(["team"]);
    expect(h.receiver.deliver(h.input({ ...epoch(), inReplyTo: requestId, via: ["team"] }))).toMatchObject({
      effect: "applied",
    });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("§5.3: bc rides the deliver-only details + header; no bc ⇒ details carry no bc key", () => {
    const h = receiverHarness({ join: ["team"], hubCap: true });
    h.receiver.deliver(h.input({ bc: { channel: "team" } }));
    const msg = h.sent[0]!.message;
    expect((msg.details as { bc?: unknown }).bc).toEqual({ channel: "team" });
    expect(msg.content.split("\n")[0]).toContain('channel="#team" kind="broadcast"]');
    expect(msg.content).toContain(XS_BROADCAST_NOTE);
    const d = receiverHarness();
    d.receiver.deliver(d.input());
    expect("bc" in (d.sent[0]!.message.details as object)).toBe(false);
    expect(d.sent[0]!.message.content).not.toContain("kind=");
  });

  it("§5.3: bc is threaded into the Controller request (RootWakeRequest.bc); replies-mode refuses a broadcast (unsolicited)", () => {
    const h = receiverHarness({ join: ["team"], hubCap: true });
    const seen: RootWakeRequest[] = [];
    h.receiver.setController({
      dispatch: (r) => {
        seen.push(r);
        return { dispatched: true, effect: "applied", woke: true, token: "t" };
      },
    });
    expect(h.receiver.deliver(h.input({ wake: true, level: 0, bc: { channel: "team" } }))).toMatchObject({
      effect: "applied",
      woke: true,
    });
    expect(seen[0]!.bc).toEqual({ channel: "team" });
    expect(seen[0]!.content).toContain('kind="broadcast"');
    h.receiver.deliver(h.input({ wake: true, level: 0, via: ["team"] }));
    expect("bc" in seen[1]!).toBe(false);

    const r = receiverHarness({ join: ["team"], hubCap: true, replies: true });
    r.membership.setReceive("replies");
    expect(r.receiver.deliver(r.input({ bc: { channel: "team" } }))).toEqual(REJECTED);
  });
});

// ----------------------------------------------------------------- format / render (§5.3)

describe("CH3 format/render: broadcast display", () => {
  const from = { ref: "ab12cd34", name: "beta", cwdLabel: "~/proj" };

  it("format: bc appends channel/kind on the first line + the host note; without bc the header has neither", () => {
    const bc = formatXsMessage({ xid: "x", from, wake: false, bc: { channel: "team" } }, "body");
    const [first, second] = bc.split("\n");
    expect(first).toMatch(/^\[fabric xs from=.* wake=false channel="#team" kind="broadcast"\] 不可信输入/);
    expect(second).toBe(XS_BROADCAST_NOTE);
    const plain = formatXsMessage({ xid: "x", from, wake: false }, "body");
    expect(plain).not.toContain("channel=");
    expect(plain).not.toContain(XS_BROADCAST_NOTE);
    // only the header differs: stripping the additions gives the plain shape (modulo the fence nonce)
    const norm = (s: string) => s.replace(/r_[0-9A-Z]{8}/g, "<n>");
    expect(norm(bc.replace(' channel="#team" kind="broadcast"', "").replace(`\n${XS_BROADCAST_NOTE}`, ""))).toBe(
      norm(plain),
    );
  });

  it("render: details.bc wins; the first-line header is the fallback; non-broadcast views are unchanged", () => {
    const content = formatXsMessage({ xid: "x", from, wake: true, bc: { channel: "team" } }, "hello");
    const viaDetails = buildXsView(content, { xsWake: true, from, bc: { channel: "team" } });
    expect(viaDetails).toMatchObject({ kind: "broadcast", channel: "team", body: "hello" });
    expect(xsHeaderLine(viaDetails)).toBe("xs ← beta · ~/proj · #team broadcast");
    expect(buildXsView(content, undefined)).toMatchObject({ kind: "broadcast", channel: "team" });
    // a body line mimicking the marker never turns a plain message into a broadcast
    const spoof = formatXsMessage({ xid: "x", from, wake: false }, 'x channel="#evil" kind="broadcast"]');
    expect(buildXsView(spoof, undefined).kind).toBe("deliver");
    // malformed details.bc is ignored
    expect(
      buildXsView(formatXsMessage({ xid: "x", from, wake: false }, "b"), { bc: { channel: "Bad Name" } }).kind,
    ).toBe("deliver");
    const plain = buildXsView(formatXsMessage({ xid: "x", from, wake: false }, "b"), { from });
    expect("channel" in plain).toBe(false);
    expect(xsHeaderLine(plain)).toBe("xs ← beta · ~/proj · deliver");
  });
});

// ----------------------------------------------------------------- /fabric command (§2.2 / §6.3)

function commandHarness(over: Partial<FabricXsCommandDeps> = {}, channelsEnabled = true) {
  const { membership, persisted } = membershipOf({ channelsEnabled });
  const fence = createSessionFence({ clock: new FakeClock(1_000) });
  const channelsCalls = { n: 0 };
  const deps: FabricXsCommandDeps = {
    enabled: () => true,
    sessionId: () => SESSION,
    membership: () => membership,
    fence: () => fence,
    statusView: () => ({ capability: "verified", lines: [] }),
    now: () => 10_000,
    ...over,
  };
  const command = createFabricXsCommand(deps);
  return {
    membership,
    persisted,
    channelsCalls,
    complete: (s: string) =>
      command.getArgumentCompletions?.(s) as { value: string; label: string; description?: string }[],
    async run(args: string, opts: { feishu?: boolean; web?: boolean } = {}) {
      const notes: { message: string; level: string }[] = [];
      const ctx = {
        mode: "tui",
        ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
        ...(opts.web ? { webInvocation: true } : {}),
        ...(opts.feishu ? { feishuInvocation: true } : {}),
      } as unknown as ExtensionCommandContext;
      // @ts-expect-error — handler exists on the returned command
      await command.handler(args, ctx);
      return notes;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CH3 /fabric join/leave/channels/status", () => {
  it("join echoes the resulting set and, with #default + named channels, the isolation hint", async () => {
    const h = commandHarness();
    const bare = await h.run("join");
    expect(bare[0]!.message).toMatch(/^已加入（epoch \d+）。当前频道：#default$/);
    const named = await h.run("join #team #ops");
    expect(named[0]!.message).toContain("当前频道：#default #ops #team");
    expect(named[0]!.message).toContain("仍在 #default（与所有默认频道会话互通）；如需隔离：/fabric leave #default");
    const iso = await h.run("leave #default");
    expect(iso[0]!.message).toContain("已离开");
    expect(iso[0]!.message).toContain("当前频道：#ops #team");
    expect(iso[0]!.message).not.toContain("仍在 #default");
    const fresh = commandHarness();
    const only = await fresh.run("join #a");
    expect(only[0]!.message).toContain("当前频道：#a");
    expect(only[0]!.message).not.toContain("仍在 #default");
    expect(fresh.membership.pref()).toEqual(["a"]);
  });

  it("refusals are whole-call warnings; channels.enabled=false refuses named channels with the fixed text", async () => {
    const h = commandHarness();
    expect((await h.run("join #all"))[0]).toMatchObject({ level: "warning" });
    expect((await h.run("join a b c d e"))[0]!.message).toContain("超过 4 个频道");
    expect(h.persisted).toEqual([]);
    const off = commandHarness({}, false);
    const refused = await off.run("join #team");
    expect(refused[0]).toEqual({
      message: "频道功能未启用（fabric.crossSession.channels.enabled=false）",
      level: "warning",
    });
    expect((await off.run("leave #team"))[0]!.message).toContain("频道功能未启用");
    expect((await off.run("join"))[0]!.message).toContain("已加入");
  });

  it("Feishu stays hard-refused for join/leave with channel args; channels is read-only and passes", async () => {
    const h = commandHarness({ channels: async () => ({ ok: true, channels: [] }) });
    for (const args of ["join #a", "leave #default"]) {
      expect(await h.run(args, { feishu: true })).toEqual([
        { message: "飞书入口不能修改跨会话加入状态，请在终端或 web 执行", level: "warning" },
      ]);
    }
    expect(h.membership.pref()).toEqual([]);
    expect((await h.run("channels", { feishu: true }))[0]!.message).toContain("local:");
  });

  it("/fabric channels lists local pref/effective/suspended + hub names and member counts (Q7)", async () => {
    let calls = 0;
    const h = commandHarness(
      {
        channels: async () => {
          calls++;
          return {
            ok: true,
            channels: [
              { name: "default", members: 3, joined: true },
              { name: "team", members: 1, joined: false },
            ],
          };
        },
        hubChannelCap: () => true,
      },
      false,
    );
    h.membership.restore({
      v: 1,
      sessionId: SESSION,
      joined: true,
      channels: ["default", "a"],
      receive: "wake",
      blocked: [],
    });
    const text = (await h.run("channels"))[0]!.message;
    expect(calls).toBe(1);
    expect(text).toContain("local: pref #default #a · effective #default · suspended #a (channels.enabled=false)");
    expect(text).toContain("#default · 3 members · joined");
    expect(text).toContain("#team · 1 member");
    const offline = commandHarness();
    expect((await offline.run("channels"))[0]!.message).toContain("hub: n/a");
    const failing = commandHarness({ channels: async () => ({ ok: false, reason: "not_joined" }) });
    expect((await failing.run("channels"))[0]!.message).toContain("hub: unavailable (not_joined)");
  });

  it("status shows the channels line (hub-cap on/off/n/a, suspended), the old-hub link note, autoJoin-invalid and broadcast config", async () => {
    const h = commandHarness({
      hubChannelCap: () => true,
      broadcast: () => ({ outPerHour: 6, wakeOutPerHour: 2, wakeMaxRecipients: 4 }),
    });
    h.membership.join();
    h.membership.join(["team"]);
    const text = (await h.run("status"))[0]!.message;
    expect(text).toContain("channels #default #team (2/4) · hub-cap on · suspended -");
    expect(text).toContain("broadcast ≤6/h · wake ≤2/h ≤4 rcpt · usage n/a");

    const old = commandHarness({ hubChannelCap: () => false, autoJoinInvalid: () => true });
    old.membership.join(["team"]);
    const oldText = (await old.run("status"))[0]!.message;
    expect(oldText).toContain(
      "channels #team (1/4) · hub-cap off · suspended - · link - (hub-cap off: not joined on this hub; /webhub restart)",
    );
    expect(oldText).toContain("autoJoin: every configured channel is invalid");

    const na = commandHarness();
    expect((await na.run("status"))[0]!.message).toContain("channels - (0/4) · hub-cap n/a · suspended -");

    const off = commandHarness(
      { broadcast: () => ({ outPerHour: 6, wakeOutPerHour: 2, wakeMaxRecipients: 4 }) },
      false,
    );
    off.membership.restore({ v: 1, sessionId: SESSION, joined: false, channels: ["a"], receive: "wake", blocked: [] });
    const offText = (await off.run("status"))[0]!.message;
    expect(offText).toContain("xs: not joined");
    expect(offText).toContain("suspended #a (channels.enabled=false)");
    expect(offText).not.toContain("broadcast ≤");
  });

  it("m5: completion reads only the cache (no I/O); status/channels/join refresh it", async () => {
    let calls = 0;
    const h = commandHarness({
      channels: async () => {
        calls++;
        return { ok: true, channels: [{ name: "hubonly", members: 2, joined: false }] };
      },
      directoryChannels: () => ["fromdir"],
    });
    expect(h.complete("join ").map((c) => c.value)).toEqual(["join #fromdir"]);
    expect(calls).toBe(0); // the completer never touches the network
    await h.run("status");
    await flush();
    expect(calls).toBe(1);
    expect(h.complete("join ").map((c) => c.value)).toEqual(["join #fromdir", "join #hubonly"]);
    expect(calls).toBe(1);
    await h.run("join #hubonly");
    await flush();
    expect(calls).toBe(2);
    // joined channels are not offered again; leave offers pref (#default carries the isolation note)
    expect(h.complete("join #h")).toEqual([]);
    expect(h.complete("join #fromdir ").map((c) => c.value)).toEqual([]);
    h.membership.join();
    const leave = h.complete("leave ");
    expect(leave.map((c) => c.value)).toEqual(["leave #default", "leave #hubonly"]);
    expect(leave[0]!.description).toBe("离开后不再与默认频道会话互通");
    expect(h.complete("leave #default #h").map((c) => c.value)).toEqual(["leave #default #hubonly"]);
    expect(h.complete("ch").map((c) => c.value)).toEqual(["channels"]);
  });

  it("a throwing channels port never breaks status / completion", async () => {
    const h = commandHarness({
      channels: () => Promise.reject(new Error("down")),
      directoryChannels: () => {
        throw new Error("boom");
      },
      hubChannelCap: () => {
        throw new Error("boom");
      },
    });
    expect((await h.run("status"))[0]!.message).toContain("hub-cap n/a");
    await flush();
    expect(h.complete("join ")).toEqual([]);
    expect((await h.run("channels"))[0]!.message).toContain("hub: unavailable (error)");
  });
});
