import { describe, expect, it } from "vitest";
import {
  createXsSender,
  detectXsToolCollisions,
  type XsHubPort,
  type XsPortBroadcastArgs,
  type XsPortListArgs,
  type XsPortReply,
} from "../../src/fabric/xs/sender.js";
import { effectiveChannels, linkChannels, linkJoined } from "../../src/fabric/xs/channel.js";
import type { XsChannelView } from "../../src/fabric/xs/types-channel.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

/** Channel-plan §9.1 CH4: broadcast local pre-checks, level/wake downgrade, M8 epoch rechecks. */

const res = (p: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "r", ...p } as XsResFrame,
});

function view(pref: string[], enabled = true): XsChannelView {
  return {
    pref: () => pref,
    effective: () => effectiveChannels(pref, enabled),
    link: (cap) => linkChannels(pref, enabled, cap),
    linkJoined: (cap) => linkJoined(pref, enabled, cap),
  };
}

function make(opts: {
  pref?: string[];
  hubCap?: boolean;
  wakeOn?: boolean;
  rootLevel?: number;
  hop?: boolean;
  noView?: boolean;
  broadcast?: (a: XsPortBroadcastArgs) => Promise<XsPortReply>;
  list?: (a: XsPortListArgs) => Promise<XsPortReply>;
}) {
  let identity: { sessionId: string; epoch: number } | undefined = { sessionId: "sess-S1", epoch: 3 };
  const sent: XsPortBroadcastArgs[] = [];
  const listed: XsPortListArgs[] = [];
  const port: XsHubPort = {
    list: async (a) => {
      listed.push(a);
      return opts.list ? opts.list(a) : res({ ok: true, rows: [] });
    },
    resolve: async () => res({ ok: true, target: { ref: "abcdefgh1234" } }),
    send: async () => res({ ok: true, effect: "applied" }),
    hubChannelCap: () => opts.hubCap !== false,
    broadcast: async (a) => {
      sent.push(a);
      return opts.broadcast
        ? opts.broadcast(a)
        : res({ ok: true, effect: "applied", fanout: { total: 2, applied: 2, none: 0, unknown: 0, woke: 0 } });
    },
    channels: async () => res({ ok: true, channels: [{ name: "team", members: 2, joined: true }] }),
  };
  const sender = createXsSender({
    port,
    origin: { current: () => identity },
    wakeOn: opts.wakeOn ?? true,
    level: { levelOfRoot: () => opts.rootLevel ?? 0, hopAllowed: () => opts.hop ?? true },
    ...(opts.noView ? {} : { channels: view(opts.pref ?? ["default", "team"]) }),
  });
  return { sender, sent, listed, setIdentity: (i: typeof identity) => (identity = i) };
}

describe("sender.broadcast local pre-checks", () => {
  it("sends to a joined channel, normalizing #Team", async () => {
    const h = make({});
    const out = await h.sender.broadcast({ channel: "#Team", text: "hi" });
    expect(out).toMatchObject({ status: "sent", effect: "applied", channel: "team" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ channel: "team", text: "hi" });
    expect(h.sent[0]!.wake).toBeUndefined();
  });

  it("#default cannot broadcast (Q2) — nothing sent", async () => {
    const h = make({ pref: ["default"] });
    expect(await h.sender.broadcast({ channel: "#default", text: "x" })).toMatchObject({
      status: "default_channel",
      effect: "none",
    });
    expect(h.sent).toHaveLength(0);
  });

  it("invalid name / channel not in link ⇒ bad_channel, nothing sent", async () => {
    const h = make({});
    expect((await h.sender.broadcast({ channel: "Bad Name!", text: "x" })).status).toBe("bad_channel");
    expect((await h.sender.broadcast({ channel: "other", text: "x" })).status).toBe("bad_channel");
    expect(h.sent).toHaveLength(0);
  });

  it("old hub (no cap) ⇒ channel_unsupported; no view (channels off) ⇒ channel_unsupported", async () => {
    const old = make({ hubCap: false, pref: ["a"] });
    expect(await old.sender.broadcast({ channel: "a", text: "x" })).toMatchObject({
      status: "channel_unsupported",
      effect: "none",
    });
    const off = make({ noView: true });
    expect((await off.sender.broadcast({ channel: "team", text: "x" })).status).toBe("channel_unsupported");
    expect(old.sent.length + off.sent.length).toBe(0);
  });

  it("channels disabled (suspended named channel) ⇒ not_joined when nothing else on the link", async () => {
    let identity = { sessionId: "s", epoch: 1 };
    const port: XsHubPort = {
      list: async () => res({ ok: true }),
      resolve: async () => res({ ok: true }),
      send: async () => res({ ok: true }),
      hubChannelCap: () => true,
      broadcast: async () => res({ ok: true, effect: "applied" }),
    };
    const sender = createXsSender({ port, origin: { current: () => identity }, channels: view(["a"], false) });
    expect((await sender.broadcast({ channel: "a", text: "x" })).status).toBe("not_joined");
    identity = { sessionId: "s", epoch: 2 };
  });

  it("oversize worst-shape frame ⇒ too_large, nothing sent", async () => {
    const h = make({});
    const sender = createXsSender({
      port: {
        list: async () => res({ ok: true }),
        resolve: async () => res({ ok: true }),
        send: async () => res({ ok: true }),
        hubChannelCap: () => true,
        broadcast: async (a) => {
          h.sent.push(a);
          return res({ ok: true, effect: "applied" });
        },
      },
      origin: { current: () => ({ sessionId: "s", epoch: 1 }) },
      channels: view(["team"]),
      maxChars: 100_000,
    });
    const out = await sender.broadcast({ channel: "team", text: "x".repeat(17_000) });
    expect(out.status).toBe("too_large");
    expect(h.sent).toHaveLength(0);
  });
});

describe("sender.broadcast wake", () => {
  it("root level 0 and hop allowed ⇒ wake rides the frame with level 0", async () => {
    const h = make({});
    await h.sender.broadcast({ channel: "team", text: "x", wake: true });
    expect(h.sent[0]).toMatchObject({ wake: true, level: 0 });
  });

  it("maxLevel=0 (hopAllowed false) ⇒ local downgrade level_limit, wake not sent", async () => {
    const h = make({ hop: false });
    const out = await h.sender.broadcast({ channel: "team", text: "x", wake: true });
    expect(h.sent[0]!.wake).toBeUndefined();
    expect(out.wakeDowngraded).toBe("level_limit");
  });

  it("root level ≥ 1 ⇒ level_limit even though the hop is allowed", async () => {
    const h = make({ rootLevel: 1 });
    const out = await h.sender.broadcast({ channel: "team", text: "x", wake: true });
    expect(h.sent[0]!.wake).toBeUndefined();
    expect(out.wakeDowngraded).toBe("level_limit");
  });

  it("wake disabled locally ⇒ sender_wake_disabled and no level on the frame", async () => {
    const h = make({ wakeOn: false });
    const out = await h.sender.broadcast({ channel: "team", text: "x", wake: true });
    expect(h.sent[0]!.wake).toBeUndefined();
    expect(h.sent[0]!.level).toBeUndefined();
    expect(out.wakeDowngraded).toBe("sender_wake_disabled");
  });

  it("hub's own wakeDowngraded wins over the local one", async () => {
    const h = make({
      broadcast: async () => res({ ok: true, effect: "applied", wakeDowngraded: "broadcast_wake_rate" }),
    });
    const out = await h.sender.broadcast({ channel: "team", text: "x", wake: true });
    expect(out.wakeDowngraded).toBe("broadcast_wake_rate");
  });
});

describe("sender.broadcast result mapping", () => {
  it("passes fanout/results through; partial unknown stays unknown", async () => {
    const results = [{ ref: "a", effect: "unknown" as const, woke: false }];
    const h = make({
      broadcast: async () =>
        res({
          ok: true,
          effect: "unknown",
          reason: "partial",
          fanout: { total: 2, applied: 1, none: 0, unknown: 1, woke: 0 },
          results,
        }),
    });
    const out = await h.sender.broadcast({ channel: "team", text: "x" });
    expect(out).toMatchObject({ status: "sent", effect: "unknown", reason: "partial", results });
    expect(out.fanout?.total).toBe(2);
  });

  it("provable codes ⇒ none; unmapped code ⇒ unknown", async () => {
    const mk = (code: string, reason?: string) =>
      make({
        broadcast: async () => res({ ok: false, code: code as never, ...(reason ? { reason: reason as never } : {}) }),
      });
    expect(await mk("E_XS_FANOUT_TOO_LARGE").sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "fanout_too_large",
      effect: "none",
    });
    expect(await mk("E_XS_BAD_TARGET", "default").sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "default_channel",
      effect: "none",
    });
    expect(await mk("E_XS_INTERNAL").sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "error",
      effect: "unknown",
    });
  });

  it("deadline ⇒ unanswered unknown; origin change after send with no verdict ⇒ origin_changed_after_send", async () => {
    const h = make({ broadcast: async () => ({ kind: "deadline" }) });
    expect(await h.sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "unanswered",
      effect: "unknown",
      reason: "client_deadline",
    });
    const g = make({
      broadcast: async () => {
        g.setIdentity({ sessionId: "sess-S1", epoch: 4 });
        return { kind: "link_lost" };
      },
    });
    expect(await g.sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "unanswered",
      effect: "unknown",
      reason: "origin_changed_after_send",
    });
  });

  it("a received verdict survives an origin change after send", async () => {
    const g = make({
      broadcast: async () => {
        g.setIdentity({ sessionId: "sess-S1", epoch: 4 });
        return res({ ok: true, effect: "applied" });
      },
    });
    expect(await g.sender.broadcast({ channel: "team", text: "x" })).toMatchObject({
      status: "sent",
      effect: "applied",
    });
  });

  it("aborted signal before send ⇒ origin_changed, nothing sent", async () => {
    const h = make({});
    const ac = new AbortController();
    ac.abort();
    expect((await h.sender.broadcast({ channel: "team", text: "x", signal: ac.signal })).status).toBe("origin_changed");
    expect(h.sent).toHaveLength(0);
  });
});

describe("M8: list/channels recheck origin after await", () => {
  it("list: epoch changed during the round trip ⇒ origin_changed, rows NOT returned (default-only too)", async () => {
    const h = make({
      noView: true,
      list: async () => {
        h.setIdentity({ sessionId: "sess-S1", epoch: 99 });
        return res({ ok: true, rows: [{ ref: "x" } as never] });
      },
    });
    const out = await h.sender.list({});
    expect(out.status).toBe("origin_changed");
    expect(out.rows).toBeUndefined();
  });

  it("channels(): epoch changed ⇒ origin_changed, no listing; ok path returns rows", async () => {
    const ok = make({});
    expect(await ok.sender.channels()).toMatchObject({
      status: "ok",
      channels: [{ name: "team", members: 2, joined: true }],
    });
    const h = make({});
    const orig = h.sender.channels;
    h.setIdentity({ sessionId: "sess-S1", epoch: 3 });
    const p = orig();
    h.setIdentity({ sessionId: "sess-S1", epoch: 4 });
    expect((await p).status).toBe("origin_changed");
  });

  it("list gates: not joined on the link ⇒ not_joined without a frame; channel filter validated", async () => {
    const h = make({ pref: ["a"], hubCap: false });
    expect((await h.sender.list({})).status).toBe("not_joined");
    expect(h.listed).toHaveLength(0);
    const g = make({});
    expect((await g.sender.list({ channel: "other" })).status).toBe("bad_channel");
    await g.sender.list({ channel: "#Team" });
    expect(g.listed[0]!.channel).toBe("team");
    const n = make({ noView: true });
    expect((await n.sender.list({ channel: "team" })).status).toBe("channel_unsupported");
  });
});

describe("collision helper", () => {
  it("includes message_channel only with channels on", () => {
    expect(detectXsToolCollisions(["message_channel"])).toEqual([]);
    expect(detectXsToolCollisions(["message_channel", "list_sessions"], { channels: true })).toEqual([
      "list_sessions",
      "message_channel",
    ]);
  });
});
