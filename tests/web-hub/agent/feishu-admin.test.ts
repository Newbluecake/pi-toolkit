// feishu-bot plan v2 §9/§10/§R2-e (F9): the agent-side fsb admin client — call classification,
// status rendering, coexistence probe and the setup device-flow orchestration, all through
// injected fakes (the module is pi-free by construction).

import { describe, expect, it, vi } from "vitest";
import {
  callFsb,
  coexistenceWarningLines,
  defaultFeishuAdminPort,
  degradedReasonLines,
  detectFeishuNotifyCoexistence,
  feishuStatusLevel,
  feishuStatusProseLines,
  formatAllowResultLine,
  formatDurationCompact,
  formatFeishuStatusLines,
  formatFsbRefusal,
  formatFsbTransportFailure,
  isFsbAllowData,
  isFsbInfoData,
  isFsbSetupView,
  maskFeishuId,
  readFeishuNotifyCoexistence,
  runFeishuSetupFlow,
  type FeishuAdminPort,
  type FeishuSetupUi,
} from "../../../src/web-hub/agent/feishu-admin.js";
import type { FsbInfoData, FsbResFrame, FsbSetupView } from "../../../src/web-hub/protocol/feishu.js";

function port(over: Partial<FeishuAdminPort> = {}): FeishuAdminPort {
  return {
    live: true,
    state: "live",
    caps: ["cmd.v1", "fsb.v1"],
    request: async () => {
      throw new Error("E_TIMEOUT: not scripted");
    },
    ...over,
  };
}

const INFO: FsbInfoData = {
  status: "open",
  brand: "feishu",
  gen: 3,
  uptimeMs: 3_723_000,
  reconnects: 2,
  lastClose: { at: 1_000, reason: "E_SILENCE", code: 1006 },
  counters: { in: 128, dup: 3, dropped: { malformed: 2 } },
  outbox: { ok: 40, failed: 1, lastCode: 230_020 },
  bindings: { total: 2, offline: 1, ambiguous: 0 },
  caps: { cards: "ok", reactions: "ok", files: "unknown", cardCallback: "denied" },
  keepalive: true,
  owner: "ou_abc1234567890def",
  allow: ["ou_abc1234567890def", "ou_zzz999yyy111xxx", "ou_short", "ou_…9f3c"],
};

describe("callFsb", () => {
  it("pre-checks liveness and the fsb.v1 cap without ever sending", async () => {
    const request = vi.fn();
    const notLive = callFsb(port({ live: false, state: "backoff", request }), { t: "fsb_req", rid: "r", op: "info" });
    const noCap = callFsb(port({ caps: ["cmd.v1"], request }), { t: "fsb_req", rid: "r", op: "info" });
    expect(await notLive).toMatchObject({ ok: false, reason: "not-live" });
    expect(await noCap).toMatchObject({ ok: false, reason: "no-cap" });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns ok:true with data / ok:true without data", async () => {
    const p = port({
      request: async (frame) =>
        frame.op === "info"
          ? ({ t: "fsb_res", rid: frame.rid, ok: true, data: { phase: "pending" } } as FsbResFrame)
          : ({ t: "fsb_res", rid: frame.rid, ok: true } as FsbResFrame),
    });
    expect(await callFsb(p, { t: "fsb_req", rid: "a", op: "info" })).toEqual({
      ok: true,
      data: { phase: "pending" },
    });
    expect(await callFsb(p, { t: "fsb_req", rid: "b", op: "setup_cancel" })).toEqual({ ok: true });
  });

  it("classifies refusals by code and transports by error prefix", async () => {
    const refused = await callFsb(
      port({
        request: async (f) => ({ t: "fsb_res", rid: f.rid, ok: false, code: "E_FSB_CAP", message: "allow-list full" }),
      }),
      { t: "fsb_req", rid: "r", op: "allow", openId: "ou_x" },
    );
    expect(refused).toEqual({ ok: false, reason: "refused", code: "E_FSB_CAP", message: "allow-list full" });

    const cases: Array<[Error, string]> = [
      [new Error("E_NO_CAP: fsb.v1"), "no-cap"],
      [new Error("E_TIMEOUT: admin request timed out"), "timeout"],
      [new Error("E_CLOSED: quit"), "conn-lost"],
      [new Error("E_CONN_LOST: link torn down"), "conn-lost"],
      [new Error("E_NOT_CONNECTED"), "not-live"],
      [new Error("weird"), "unexpected"],
    ];
    for (const [err, reason] of cases) {
      const r = await callFsb(port({ request: async () => Promise.reject(err) }), {
        t: "fsb_req",
        rid: "r",
        op: "info",
      });
      expect(r, err.message).toMatchObject({ ok: false, reason });
    }
  });

  it("bounds a never-answering hub with its own unref'd deadline", async () => {
    const r = await callFsb(
      port({ request: () => new Promise<FsbResFrame>(() => {}) }),
      { t: "fsb_req", rid: "r", op: "info" },
      15,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("forwards the frame verbatim to the port", async () => {
    const seen: unknown[] = [];
    const p = port({
      request: async (f) => {
        seen.push(f);
        return { t: "fsb_res", rid: f.rid, ok: true };
      },
    });
    await callFsb(p, { t: "fsb_req", rid: "rid-1", op: "deny", openId: "ou_abc" });
    expect(seen).toEqual([{ t: "fsb_req", rid: "rid-1", op: "deny", openId: "ou_abc" }]);
  });
});

describe("rendering helpers", () => {
  it("maskFeishuId: hub-masked pass through, full ids get masked, short ids pass", () => {
    expect(maskFeishuId("ou_…9f3c")).toBe("ou_…9f3c");
    expect(maskFeishuId("ou_abc1234567890def")).toBe("ou_ab…0def");
    expect(maskFeishuId("ou_short")).toBe("ou_…"); // too short to mask meaningfully ⇒ fixed token
    expect(maskFeishuId("ou_x…y")).toBe("ou_…"); // malformed "masked" value
    expect(maskFeishuId("ou_SECRET…TOKENVALUE")).toBe("ou_SE…ALUE"); // not a well-formed mask ⇒ re-masked
  });

  it("formatDurationCompact renders compact English tokens", () => {
    expect(formatDurationCompact(45_000)).toBe("45s");
    expect(formatDurationCompact(243_000)).toBe("4m03s");
    expect(formatDurationCompact(3_723_000)).toBe("1h02m");
    expect(formatDurationCompact(53 * 3_600_000)).toBe("2d05h");
    expect(formatDurationCompact(-1)).toBe("?");
  });

  it("formatFeishuStatusLines renders every §10 element, ids masked", () => {
    const lines = formatFeishuStatusLines(INFO, 10_000_000);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(
      "feishu: status=open brand=feishu gen=3 uptime=1h02m reconnects=2 lastClose=E_SILENCE/1006 2h46m ago",
    );
    expect(lines[1]).toBe("counters: in=128 dup=3 dropped{malformed=2}");
    expect(lines[2]).toBe("outbox: ok=40 failed=1 last=230020");
    expect(lines[3]).toBe("bindings: total=2 offline=1 amb=0");
    expect(lines[4]).toBe("caps: cards=✓ reactions=✓ files=? cb=✗");
    expect(lines[5]).toBe("keepalive=on");
    expect(lines[6]).toBe("owner=ou_ab…0def allow=4: ou_ab…0def, ou_zz…1xxx, ou_…, ou_…9f3c");
    // never a raw long id
    expect(lines.join("\n")).not.toContain("ou_abc1234567890def");
  });

  it("omits absent fields and folds long allow-lists", () => {
    const info: FsbInfoData = {
      ...INFO,
      brand: undefined,
      uptimeMs: undefined,
      lastClose: undefined,
      counters: { in: 0, dup: 0, dropped: {} },
      outbox: { ok: 0, failed: 0 },
      owner: undefined,
      allow: Array.from({ length: 9 }, (_, i) => `ou_member${i}padding`),
    };
    const lines = formatFeishuStatusLines(info, 0);
    expect(lines[0]).toBe("feishu: status=open gen=3 reconnects=2");
    expect(lines[1]).toBe("counters: in=0 dup=0");
    expect(lines[2]).toBe("outbox: ok=0 failed=0");
    expect(lines[6]).toMatch(/^owner=- allow=9: (ou_me…ding, ){5}ou_me…ding \+3 more$/);
  });

  it("renders degraded reasons inline and maps statuses to levels", () => {
    const deg: FsbInfoData = { ...INFO, status: "degraded", degraded: ["state-corrupt"] };
    expect(formatFeishuStatusLines(deg, 0)[0]).toBe(
      "feishu: status=degraded(state-corrupt) brand=feishu gen=3 uptime=1h02m reconnects=2 lastClose=E_SILENCE/1006 0s ago",
    );
    expect(feishuStatusLevel(deg)).toBe("warning");
    expect(feishuStatusLevel({ ...INFO, status: "auth_failed" })).toBe("warning");
    expect(feishuStatusLevel({ ...INFO, status: "conn_limit" })).toBe("warning");
    expect(feishuStatusLevel(INFO)).toBe("info");
    expect(feishuStatusLevel({ ...INFO, status: "unconfigured" })).toBe("info");
  });

  it("degradedReasonLines covers the frozen set, capability-denied and unknowns", () => {
    const lines = degradedReasonLines([
      "state-corrupt",
      "credentials-unsafe",
      "persist-failed",
      "ws-unavailable",
      "undecodable-events",
      "capability-denied:cards",
      "who-knows",
    ]);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("/webhub feishu repair");
    expect(lines[5]).toContain("cards");
    expect(lines[6]).toBe("降级原因：who-knows");
  });

  it("feishuStatusProseLines gives per-status hints and the keepalive line", () => {
    expect(feishuStatusProseLines({ ...INFO, status: "unconfigured" })[0]).toContain("/webhub feishu setup");
    expect(feishuStatusProseLines({ ...INFO, status: "setup" })[0]).toContain("/webhub feishu cancel");
    expect(feishuStatusProseLines({ ...INFO, status: "auth_failed" })[0]).toContain("10 分钟");
    expect(feishuStatusProseLines({ ...INFO, status: "conn_limit" })[0]).toContain("另一");
    expect(feishuStatusProseLines(INFO).at(-1)).toContain("空闲");
    expect(feishuStatusProseLines({ ...INFO, keepalive: false }).some((l) => l.includes("空闲"))).toBe(false);
    // degraded prose rides along
    const deg = feishuStatusProseLines({ ...INFO, status: "degraded", degraded: ["persist-failed"] });
    expect(deg[0]).toContain("ACK");
  });

  it("formatFsbRefusal maps every frozen code family", () => {
    expect(formatFsbRefusal("E_FSB_CONFIRM_REQUIRED", "").message).toContain("--replace");
    expect(formatFsbRefusal("E_FSB_SETUP_ACTIVE", "").level).toBe("warning");
    expect(formatFsbRefusal("E_FSB_UNCONFIGURED", "").message).toContain("setup");
    expect(formatFsbRefusal("E_FSB_CAP", "allow-list full").message).toContain("allow-list full");
    expect(formatFsbRefusal("E_FSB_BAD_REQUEST", "bad open_id").message).toContain("bad open_id");
    expect(formatFsbRefusal("E_FSB_STATE", "corrupt").message).toContain("corrupt");
    const unknown = formatFsbRefusal("E_FSB_FUTURE", "");
    expect(unknown.level).toBe("error");
    expect(unknown.message).toContain("E_FSB_FUTURE");
  });

  it("formatFsbTransportFailure distinguishes no-hub / not-live / no-cap / timeout / conn-lost", () => {
    expect(formatFsbTransportFailure({ reason: "no-hub", message: "" }).message).toContain("web-hub 未启用");
    expect(
      formatFsbTransportFailure({ reason: "not-live", message: "web-hub 未连接（state=backoff）" }).message,
    ).toContain("restart");
    expect(
      formatFsbTransportFailure({ reason: "no-cap", message: "当前 hub 尚不支持飞书机器人（缺少 fsb.v1 能力）。" })
        .message,
    ).toContain("fsb.v1");
    expect(formatFsbTransportFailure({ reason: "timeout", message: "x" }).level).toBe("warning");
    expect(formatFsbTransportFailure({ reason: "conn-lost", message: "x" }).message).toContain("中断");
  });

  it("formatAllowResultLine + the data-shape guards", () => {
    expect(formatAllowResultLine({ changed: true, count: 2 }, "allow")).toBe("allow: changed allow-list=2");
    expect(formatAllowResultLine({ changed: false, count: 1 }, "deny")).toBe("deny: unchanged allow-list=1");
    expect(isFsbAllowData({ changed: true, count: 2 })).toBe(true);
    expect(isFsbAllowData({ phase: "pending" })).toBe(false);
    expect(isFsbInfoData({ status: "open" })).toBe(true);
    expect(isFsbInfoData(undefined)).toBe(false);
    expect(isFsbSetupView({ phase: "done" })).toBe(true);
    expect(isFsbSetupView({ status: "open" })).toBe(false);
  });
});

describe("feishu-notify coexistence (§8)", () => {
  it("reads env, file, both, bad json and watchDefault", () => {
    const read = (path: string) =>
      path === "/cfg.json" ? `{"webhookUrl":"https://example/hook","watchDefault":true}` : undefined;
    expect(readFeishuNotifyCoexistence({}, () => undefined, "/none.json")).toEqual({
      configured: false,
      watchDefault: false,
    });
    expect(readFeishuNotifyCoexistence({ FEISHU_WEBHOOK_URL: "https://x" }, () => undefined, "/none.json")).toEqual({
      configured: true,
      watchDefault: false,
    });
    expect(readFeishuNotifyCoexistence({}, read, "/cfg.json")).toEqual({ configured: true, watchDefault: true });
    expect(readFeishuNotifyCoexistence({}, () => "{oops", "/cfg.json")).toEqual({
      configured: false,
      watchDefault: false,
    });
    // file without webhookUrl but with watchDefault set
    expect(readFeishuNotifyCoexistence({}, () => `{"watchDefault":true}`, "/cfg.json")).toEqual({
      configured: false,
      watchDefault: true,
    });
  });

  it("detectFeishuNotifyCoexistence uses the env-overridable path", () => {
    const env = { FEISHU_NOTIFY_CONFIG_PATH: "/definitely/not/here.json" };
    expect(detectFeishuNotifyCoexistence(env)).toEqual({ configured: false, watchDefault: false });
  });

  it("coexistenceWarningLines: empty when unconfigured, watchDefault line only when true", () => {
    expect(coexistenceWarningLines({ configured: false, watchDefault: false })).toEqual([]);
    const w = coexistenceWarningLines({ configured: true, watchDefault: false });
    expect(w).toHaveLength(2);
    expect(w[1]).toContain("watchDefault");
    expect(coexistenceWarningLines({ configured: true, watchDefault: true })).toHaveLength(3);
  });
});

describe("defaultFeishuAdminPort", () => {
  it("adapts the process connection: liveness from status, request widened with the cap", async () => {
    const frames: unknown[] = [];
    const conn = {
      implVersion: "v",
      status: () => ({ state: "live", attached: true }),
      caps: ["fsb.v1"],
      close: () => {},
      request: async (frame: unknown, cap: string) => {
        frames.push([frame, cap]);
        return { t: "fsb_res", rid: (frame as { rid: string }).rid, ok: true };
      },
    };
    const p = defaultFeishuAdminPort(() => conn as never);
    expect(p).toBeDefined();
    expect(p!.live).toBe(true);
    expect(p!.caps).toContain("fsb.v1");
    await p!.request({ t: "fsb_req", rid: "r1", op: "info" });
    expect(frames).toEqual([[{ t: "fsb_req", rid: "r1", op: "info" }, "fsb.v1"]]);
  });

  it("returns undefined without a connection; non-live state surfaces in state", () => {
    expect(defaultFeishuAdminPort(() => undefined)).toBeUndefined();
    const backoff = defaultFeishuAdminPort(
      () =>
        ({
          implVersion: "v",
          status: () => ({ state: "backoff", attached: false }),
          caps: [],
          close: () => {},
          request: async () => {
            throw new Error("unreached");
          },
        }) as never,
    );
    expect(backoff!.live).toBe(false);
    expect(backoff!.state).toBe("backoff");
  });
});

// ---------------------------------------------------------------------------
// setup device-flow orchestration
// ---------------------------------------------------------------------------

interface ScriptedPort {
  port: FeishuAdminPort;
  sent: unknown[];
}

function scriptedPort(responses: Array<FsbResFrame | Error>, onSend?: (f: unknown) => void): ScriptedPort {
  const sent: unknown[] = [];
  let i = 0;
  return {
    port: port({
      request: async (frame) => {
        sent.push(frame);
        onSend?.(frame);
        const r = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        if (r instanceof Error) throw r;
        return { ...r, rid: frame.rid } as FsbResFrame;
      },
    }),
    sent,
  };
}

function uiCollector() {
  const notes: Array<{ message: string; level: string }> = [];
  const qr: string[][] = [];
  let cleared = 0;
  const ui: FeishuSetupUi = {
    notify: (message, level) => notes.push({ message, level }),
    showQr: (lines) => qr.push([...lines]),
    clearQr: () => {
      cleared += 1;
    },
  };
  return { ui, notes, qr, cleared: () => cleared };
}

function flowDeps(p: FeishuAdminPort, ui: FeishuSetupUi) {
  let t = 0;
  return {
    port: p,
    ui,
    renderQr: (text: string) => `QR<${text}>`,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const PENDING_VIEW: FsbSetupView = {
  phase: "pending",
  qrUrl: "https://open.feishu.cn/page/launcher?user_code=XYZ",
  expiresAt: 60_000,
};

describe("runFeishuSetupFlow", () => {
  it("happy path: begin(pending) → QR+URL → poll → done, QR cleared", async () => {
    const { port, sent } = scriptedPort([
      { t: "fsb_res", rid: "", ok: true, data: PENDING_VIEW },
      { t: "fsb_res", rid: "", ok: true, data: { phase: "pending" } },
      { t: "fsb_res", rid: "", ok: true, data: { phase: "done" } },
    ]);
    const { ui, notes, qr, cleared } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(sent[0]).toEqual({ t: "fsb_req", rid: expect.any(String), op: "setup_begin" });
    expect(sent[1]).toMatchObject({ op: "setup_status" });
    expect(qr).toEqual([`QR<${PENDING_VIEW.qrUrl}>`.split("\n")]);
    expect(notes.map((n) => n.message)).toContain(PENDING_VIEW.qrUrl!);
    expect(notes.at(-1)!.message).toContain("配置完成");
    expect(notes.at(-1)!.level).toBe("info");
    expect(cleared()).toBe(1);
  });

  it("--replace carries replace+confirm on the wire (after the command-side TUI confirm)", async () => {
    const { port, sent } = scriptedPort([{ t: "fsb_res", rid: "", ok: true, data: { phase: "done" } }]);
    const { ui } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: true });
    expect(sent[0]).toEqual({ t: "fsb_req", rid: expect.any(String), op: "setup_begin", replace: true, confirm: true });
  });

  it("adopts a terminal begin view immediately (no QR, no polling)", async () => {
    const { port, sent } = scriptedPort([{ t: "fsb_res", rid: "", ok: true, data: { phase: "done" } }]);
    const { ui, notes, qr } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(sent).toHaveLength(1);
    expect(qr).toEqual([]);
    expect(notes[0]!.message).toContain("配置完成");
  });

  it("a refused begin maps the code (E_FSB_SETUP_ACTIVE → hint)", async () => {
    const { port, sent } = scriptedPort([
      { t: "fsb_res", rid: "", ok: false, code: "E_FSB_SETUP_ACTIVE", message: "busy" },
    ]);
    const { ui, notes } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(sent).toHaveLength(1);
    expect(notes[0]!.message).toContain("/webhub feishu status");
    expect(notes[0]!.level).toBe("warning");
  });

  it("an unexpected data shape is an error, nothing else sent", async () => {
    const { port, sent } = scriptedPort([{ t: "fsb_res", rid: "", ok: true, data: { changed: true, count: 1 } }]);
    const { ui, notes } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(notes[0]!.level).toBe("error");
    expect(sent).toHaveLength(1);
  });

  it("pending without qrUrl adopts the running registration (URL not notified)", async () => {
    const { port } = scriptedPort([
      { t: "fsb_res", rid: "", ok: true, data: { phase: "pending", expiresAt: 60_000 } },
      { t: "fsb_res", rid: "", ok: true, data: { phase: "cancelled" } },
    ]);
    const { ui, notes, qr } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(qr).toEqual([]);
    expect(notes[0]!.message).toContain("进行中");
    expect(notes.at(-1)!.message).toContain("cancel");
  });

  it("expired / denied / failed phases carry their own message and level", async () => {
    for (const [phase, level] of [
      ["expired", "warning"],
      ["denied", "warning"],
      ["failed", "error"],
    ] as const) {
      const { port } = scriptedPort([
        { t: "fsb_res", rid: "", ok: true, data: PENDING_VIEW },
        { t: "fsb_res", rid: "", ok: true, data: { phase } },
      ]);
      const { ui, notes } = uiCollector();
      await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
      expect(notes.at(-1)!.level, phase).toBe(level);
    }
  });

  it("warns once on a transient poll failure, then keeps polling to success", async () => {
    const { port } = scriptedPort([
      { t: "fsb_res", rid: "", ok: true, data: PENDING_VIEW },
      new Error("E_TIMEOUT: x"),
      new Error("E_TIMEOUT: x"),
      { t: "fsb_res", rid: "", ok: true, data: { phase: "done" } },
    ]);
    const { ui, notes } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(notes.filter((n) => n.message.startsWith("轮询暂时失败"))).toHaveLength(1);
    expect(notes.at(-1)!.message).toContain("配置完成");
  });

  it("aborts at once when the hub loses fsb.v1 mid-flow (superseded by an older hub)", async () => {
    const { port } = scriptedPort([
      { t: "fsb_res", rid: "", ok: true, data: PENDING_VIEW },
      new Error("E_NO_CAP: fsb.v1"),
    ]);
    const { ui, notes, cleared } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(notes.at(-1)!.message).toContain("中止");
    expect(cleared()).toBe(1);
  });

  it("hard-stops at expiresAt+slack with a timeout warning (bounded loop)", async () => {
    // every poll answers pending forever; the clock advances 2 s per sleep
    const { port, sent } = scriptedPort([{ t: "fsb_res", rid: "", ok: true, data: PENDING_VIEW }]);
    const { ui, notes, cleared } = uiCollector();
    await runFeishuSetupFlow(flowDeps(port, ui), { replace: false });
    expect(notes.at(-1)!.message).toContain("等待超时");
    expect(notes.at(-1)!.level).toBe("warning");
    expect(cleared()).toBe(1);
    // (60 s expires + 15 s slack) / 2 s poll ⇒ ≤ 38 setup_status frames, then the deadline bite
    expect(sent.filter((f) => (f as { op: string }).op === "setup_status").length).toBeLessThanOrEqual(38);
  });
});
