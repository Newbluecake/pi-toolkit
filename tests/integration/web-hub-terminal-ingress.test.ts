import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalCommandIngress } from "../../src/web-hub/hub/commands.js";
import * as sseModule from "../../src/web-hub/hub/sse.js";
import { formatSseFrame } from "../../src/web-hub/hub/sse.js";
import { terminalFrameOk, type TerminalOffer } from "../../src/web-hub/protocol/terminal.js";
import { terminalHarness, type TerminalHarness } from "./web-hub-terminal-harness.js";

const harnesses: TerminalHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  vi.restoreAllMocks();
});
const marker = "PRIVATE_TERMINAL_GRANT_OUTPUT_NONCE";
const scope = { sessionId: "session", epoch: "epoch-1", ownerInstance: "owner" };
const output = {
  t: "term_event",
  v: 1,
  ...scope,
  channelId: "channel",
  termId: "term",
  revision: 1,
  kind: "output",
  offset: 0,
  bytesB64: Buffer.from(marker).toString("base64"),
  streamEpoch: "stream",
};
const late = (id: string, data: unknown) => ({ t: "cmd_late", id, op: "command", at: 1, ok: true, data });
const legacyData = {
  op: "command",
  kind: "builtin",
  completion: "sync",
  history: "none",
  captured: true,
  output: {
    entries: [{ kind: "notify", level: "info", text: "ordinary terminal word" }],
    truncated: { entries: 0, bytes: 0 },
  },
};
const wire = (e: { id?: number; event: string; data: unknown }) => formatSseFrame(e.event, e.data, e.id);

describe("T-INGRESS / F1 (§4.1.2): real decoder → agent-server → registry → dual HTTP/SSE", () => {
  it("consumes normal/late/dup/forged/unknown frames before registry, online broadcast AND offline replay", async () => {
    let h: TerminalHarness;
    const publishSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    const realSseFactory = sseModule.createSseHub;
    vi.spyOn(sseModule, "createSseHub").mockImplementation((options) => {
      const real = realSseFactory(options);
      publishSpies.push(vi.spyOn(real, "publish"));
      return real;
    });
    const privateOutput: unknown[] = [];
    const offers: Array<TerminalOffer | undefined> = [];
    const port = createTerminalCommandIngress({
      current: (m) =>
        m.agentKey === h?.agentKey &&
        m.linkGen === h.registry.getLinkGen(h.agentKey) &&
        m.sessionId === "session" &&
        m.epoch === "epoch-1",
      onOffer: (_m, _id, o) => offers.push(o),
      onDedicated: (_m, raw) => {
        const f = raw as typeof output;
        if (terminalFrameOk(raw) && f.channelId === "channel" && f.ownerInstance === "owner") privateOutput.push(raw);
      },
    });
    h = await terminalHarness({ terminal: port });
    harnesses.push(h);
    const spy = vi.spyOn(h.registry, "onFrame");
    const online = await Promise.all([h.sse(0), h.sse(1)]);
    h.client.send(late("before", legacyData));
    await h.barrier();
    for (const c of online) await c.waitFor((e) => e.event === "cmd_late" && e.data.id === "before");
    const prior = online.map((c) => c.events.find((e) => e.event === "cmd_late")!.id!);
    const meta = {
      agentKey: h.agentKey,
      linkGen: h.registry.getLinkGen(h.agentKey)!,
      sessionId: "session",
      epoch: "epoch-1",
    };
    expect(port.register(meta, { rid: "private-rid", commandId: "private-id-00000" })).toBe(true);
    const publicOffer = {
      op: "command",
      kind: "builtin",
      completion: "sync",
      history: "none",
      terminal: { v: 1, outcome: "handshake-required", offerId: "offer" },
    };
    const frames: unknown[] = [
      { t: "cmd_result", rid: "private-rid", id: "private-id-00000", ok: true, data: publicOffer },
      { t: "cmd_result", rid: "private-rid", id: "private-id-00000", ok: true, data: publicOffer },
      late("private-id-00000", publicOffer),
      late("private-id-00000", { op: "query", result: { ok: true, data: publicOffer } }),
      late("forged", { terminal: { v: 1, grant: marker, inventory: marker } }),
      late("forged-resolved", {
        v: 1,
        op: "resolved_ack",
        resolved: { journalRevision: 1, identities: [{ termId: marker }] },
      }),
      late("forged-resolved-version", {
        v: 99,
        op: "resolved_ack",
        resolved: { journalRevision: 1, identities: [{ termId: marker }] },
      }),
      {
        t: "term_req",
        v: 1,
        rid: "forged-resolved",
        ...scope,
        channelId: "channel",
        op: "resolved_ack",
        resolved: {
          hubBootId: "boot",
          challengeId: "challenge",
          linkGen: 1,
          inventoryId: "inventory",
          revision: 1,
          journalRevision: 2,
          identities: [
            {
              agentSessionId: "old-session",
              termId: marker,
              epoch: "old-epoch",
              ownerInstance: "old-owner",
              reservationId: "reservation",
            },
          ],
        },
      },
      late("forged-query", { op: "query", result: { ok: true, data: { terminal: { v: 99, unknown: marker } } } }),
      { t: "cmd_result", rid: "no-pending", id: "forged", ok: true, data: { terminalOutcome: marker } },
      output,
      { ...output, channelId: "wrong" },
      { ...output, ownerInstance: "wrong" },
      {
        t: "term_res",
        v: 1,
        rid: "unknown",
        ...scope,
        op: "protocol_ready",
        ok: true,
        mode: "interactive",
        grant: marker,
      },
      {
        t: "term_req",
        v: 1,
        rid: "forged",
        sessionId: "session",
        epoch: "epoch-1",
        op: "prepare_protocol",
        offerId: "offer",
        hubNonce: marker,
      },
      { ...output, t: "term_future" },
      { ...output, kind: "future" },
      { ...output, v: 99 },
      { ...output, bytesB64: "YR==" },
    ];
    expect(publishSpies).toHaveLength(2);
    const publishCounts = publishSpies.map((s) => s.mock.calls.length);
    const startCalls = spy.mock.calls.length;
    const busStart = h.bus.length;
    const encoded = frames.map((f) => JSON.stringify(f) + "\n").join("");
    h.client.raw(encoded.slice(0, 27));
    h.client.raw(encoded.slice(27, 173));
    h.client.raw(encoded.slice(173));
    await h.barrier();
    expect(spy.mock.calls.slice(startCalls).map((c) => c[1].t)).toEqual(["ping"]);
    expect(h.bus.slice(busStart)).toEqual([]);
    expect(publishSpies.map((s) => s.mock.calls.length)).toEqual(publishCounts);
    expect(offers).toEqual([{ v: 1, outcome: "handshake-required", offerId: "offer" }]);
    expect(privateOutput).toEqual([output]);
    h.client.send(late("after", legacyData));
    await h.barrier();
    for (let i = 0; i < 2; i++) {
      const after = await online[i]!.waitFor((e) => e.event === "cmd_late" && e.data.id === "after");
      expect(after.id).toBe(prior[i]! + 1);
      expect(JSON.stringify(online[i]!.events)).not.toContain(marker);
      expect(JSON.stringify(online[i]!.events)).not.toContain(output.bytesB64);
      const replay = await h.sse(i, prior[i]);
      await replay.waitFor((e) => e.event === "cmd_late" && e.data.id === "after");
      const replayFrames = replay.events.filter((e) => e.id !== undefined);
      expect(replayFrames.map(wire)).toEqual([wire(after)]);
    }
  });
  it("no port / off / synchronous port exceptions stay fail-closed, ordinary cmd_late is a positive control", async () => {
    const h = await terminalHarness();
    harnesses.push(h);
    const spy = vi.spyOn(h.registry, "onFrame");
    const online = await Promise.all([h.sse(0), h.sse(1)]);
    for (const mode of ["off", "throws-consume", "throws-classify"]) {
      if (mode === "throws-consume")
        h.serverDeps.terminal = {
          ownsCommand: () => false,
          consumeAgentFrame: () => {
            throw new Error(marker);
          },
          retireLink: () => {},
        };
      let classified!: () => void;
      const observed = new Promise<void>((r) => (classified = r));
      if (mode === "throws-classify")
        h.serverDeps.terminal = {
          ownsCommand: () => {
            classified();
            throw new Error(marker);
          },
          consumeAgentFrame: () => {},
          retireLink: () => {},
        };
      const n = spy.mock.calls.length;
      h.client.send(output);
      h.client.send(late("forged", { terminal: { unknown: marker } }));
      if (mode !== "throws-classify") await h.barrier();
      else {
        await observed;
        delete h.serverDeps.terminal;
        await h.barrier();
      } // same ordered socket barrier; no sleep
      expect(spy.mock.calls.slice(n).map((c) => c[1].t)).toEqual(["ping"]);
    }
    h.client.send(late("ordinary", { op: "abort", wasBusy: false }));
    await h.barrier();
    for (const c of online) {
      const e = await c.waitFor((e) => e.event === "cmd_late");
      expect(e.data).toEqual({
        agentKey: h.agentKey,
        id: "ordinary",
        op: "command",
        ok: true,
        data: { op: "abort", wasBusy: false },
      });
      expect(JSON.stringify(c.events)).not.toContain(marker);
    }
    expect(JSON.stringify(h.log.lines)).not.toContain(marker);
  });
  it("I10 raw mixed old/new hello/ack and legacy registry/SSE bytes are unchanged", async () => {
    const old = await terminalHarness({ legacy: true });
    harnesses.push(old);
    const fresh = await terminalHarness();
    harnesses.push(fresh);
    expect(JSON.stringify(fresh.helloAck) + "\n").toBe(JSON.stringify(old.helloAck) + "\n");
    const streams = await Promise.all([old.sse(0), old.sse(1), fresh.sse(0), fresh.sse(1)]);
    const oldSpy = vi.spyOn(old.registry, "onFrame"),
      newSpy = vi.spyOn(fresh.registry, "onFrame");
    const frames = [
      { t: "status", leafId: null, busy: false, pending: false },
      late("legacy", legacyData),
      { t: "cmd_result", rid: "legacy-rid", id: "legacy-id", ok: true, data: { op: "abort", wasBusy: false } },
      { t: "ctl", epoch: "epoch-1", sessionId: "session", items: [] },
      { t: "ev", seq: 1, e: { type: "agent_start" } },
    ];
    for (const f of frames) {
      old.client.send(f);
      fresh.client.send(f);
    }
    await old.barrier();
    await fresh.barrier();
    expect(newSpy.mock.calls.filter((c) => c[1].t !== "ping").map((c) => c[1].t)).toEqual([
      "status",
      "cmd_late",
      "cmd_result",
      "ctl",
      "ev",
    ]);
    expect(newSpy.mock.calls.filter((c) => c[1].t !== "ping").map((c) => JSON.stringify(c[1]))).toEqual(
      oldSpy.mock.calls.filter((c) => c[1].t !== "ping").map((c) => JSON.stringify(c[1])),
    );
    for (const s of streams) await s.waitFor((e) => e.event === "ev");
    const normalize = (s: (typeof streams)[number]) => {
      const ids = s.events.filter((e) => e.id !== undefined);
      const base = ids[0]!.id!;
      return ids.map((e) => wire({ ...e, id: e.id! - base }));
    };
    expect(normalize(streams[2]!)).toEqual(normalize(streams[0]!));
    expect(normalize(streams[3]!)).toEqual(normalize(streams[1]!));
    // Full pre-feature stream, including directed connect/history/status. ONLY generated
    // browser client IDs and the host process PID are normalized; no caps/frames/data removed.
    const full = (s: (typeof streams)[number]) =>
      s.events
        .map((e) => {
          const data =
            e.event === "hello"
              ? { ...e.data, clientId: "<clientId>" }
              : e.event === "hub"
                ? { ...e.data, pid: "<hubPid>", port: "<httpPort>" }
                : e.data;
          return wire({ ...e, data });
        })
        .join("");
    const captured = {
      baseline: "2d802f1f",
      normalization: ["hello.clientId", "hub.pid", "hub.port", "broadcast id origin (relative, order/deltas retained)"],
      helloNdjson: JSON.stringify(old.helloAck) + "\n",
      legacyIncoming: oldSpy.mock.calls.filter((c) => c[1].t !== "ping").map((c) => JSON.stringify(c[1]) + "\n"),
      loopbackSse: full(streams[0]!),
      lanSse: full(streams[1]!),
    };
    const fixture = new URL("../web-hub/terminal-legacy/trace.json", import.meta.url);
    if (process.env.P1C_CAPTURE_LEGACY_TRACE === "1") {
      if (existsSync(fixture)) throw new Error("refuse to overwrite legacy trace");
      writeFileSync(fixture, JSON.stringify(captured, null, 2) + "\n");
    }
    expect(captured).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
    expect(full(streams[2]!)).toBe(captured.loopbackSse);
    expect(full(streams[3]!)).toBe(captured.lanSse);
    expect(fresh.client.frames.map((f) => (f as { t: string }).t)).toEqual(
      old.client.frames.map((f) => (f as { t: string }).t),
    );
  });
});
