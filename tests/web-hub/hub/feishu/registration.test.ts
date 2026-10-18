import { describe, expect, it } from "vitest";

import { FEISHU_SETUP } from "../../../../src/web-hub/protocol/feishu.js";
import type { FsbSetupView } from "../../../../src/web-hub/protocol/feishu.js";
import {
  REGISTRATION_MAX_BODY_BYTES,
  classifyPollResponse,
  clampExpiresIn,
  clampPollInterval,
  createRegistration,
  decorateQrUrl,
  refusalToFsbCode,
} from "../../../../src/web-hub/hub/feishu/registration.js";
import type {
  CredentialsPresence,
  Registration,
  RegistrationLogEvent,
} from "../../../../src/web-hub/hub/feishu/registration.js";
import type { CredentialInput } from "../../../../src/web-hub/hub/feishu/credentials.js";
import { createFakeClock, settle } from "../../../fixtures/feishu/fake-http.js";
import type { FakeClock } from "../../../fixtures/feishu/fake-http.js";

const DEVICE_CODE = "DEVICECODE-SECRET-0123456789abcdef";
const CLIENT_SECRET = "CLIENTSECRET0123456789abcdefABCDEF12";
const QR = "https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH";
const FEISHU_REG = "https://accounts.feishu.cn/oauth/v1/app/registration";
const LARK_REG = "https://accounts.larksuite.com/oauth/v1/app/registration";
const OPEN_ID = "ou_owner0123456789";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: Record<string, string>;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
  at: number;
}
type Reply =
  { status?: number; json?: unknown; text?: string; bytes?: Uint8Array } | { throw: unknown } | { hang: true };

function beginOk(over: Record<string, unknown> = {}): Reply {
  return {
    json: { device_code: DEVICE_CODE, verification_uri_complete: QR, interval: 5, expires_in: 600, ...over },
  };
}
const pending: Reply = { status: 400, json: { error: "authorization_pending" } };
const success = (over: Record<string, unknown> = {}): Reply => ({
  json: { client_id: "cli_a1b2c3d4e5f6", client_secret: CLIENT_SECRET, user_info: { open_id: OPEN_ID }, ...over },
});

function rig(
  opts: {
    presence?: CredentialsPresence;
    commit?: (input: CredentialInput, guard: () => boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
    requestTimeoutMs?: number;
  } = {},
) {
  const clock = createFakeClock(1_000_000);
  const calls: Call[] = [];
  const queue: Reply[] = [];
  const logs: RegistrationLogEvent[] = [];
  const commits: Array<{ input: CredentialInput; guard: () => boolean }> = [];
  let presence: CredentialsPresence = opts.presence ?? "none";
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    calls.push({
      url,
      method: String(init.method),
      headers,
      form,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
      at: clock.now(),
    });
    let reply = queue.shift() ?? pending;
    if ("gate" in reply) {
      await reply.gate;
      reply = reply.then;
    }
    if ("throw" in reply) throw reply.throw;
    if ("hang" in reply) {
      await new Promise<never>((_, reject) => {
        const sig = init.signal;
        if (sig?.aborted) return reject(new Error("aborted"));
        sig?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const r = reply as Exclude<Reply, { throw: unknown } | { hang: true } | { gate: Promise<void> }>;
    const body = r.bytes ?? (r.text !== undefined ? r.text : JSON.stringify(r.json ?? {}));
    return new Response(body as BodyInit, { status: r.status ?? 200 });
  };
  const reg = createRegistration({
    fetch: fetchFn,
    clock,
    hostname: () => "my host!",
    credentialsState: () => presence,
    commit:
      opts.commit ??
      (async (input, guard) => {
        commits.push({ input, guard });
        return { ok: true };
      }),
    log: (e) => logs.push(e),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
  return {
    clock,
    calls,
    queue,
    logs,
    commits,
    reg,
    setPresence: (p: CredentialsPresence) => (presence = p),
  };
}

async function drive(clock: FakeClock, ms: number, step = 250): Promise<void> {
  await settle(3);
  for (let t = 0; t < ms; t += step) {
    clock.advance(Math.min(step, ms - t));
    await settle(3);
  }
}
async function runUntil(clock: FakeClock, reg: Registration, done: () => boolean, maxMs = 700_000): Promise<void> {
  for (let t = 0; t < maxMs && !done(); t += 500) await drive(clock, 500, 500);
  void reg;
}
const phase = (reg: Registration): string | undefined => reg.status()?.phase;

describe("begin: probe-verified request shape", () => {
  it("POSTs the form to the feishu accounts origin with the PersonalAgent fields and decorates the QR link", async () => {
    const { reg, calls, queue, clock } = rig();
    queue.push(beginOk());
    const r = await reg.begin();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(FEISHU_REG);
    expect(c.method).toBe("POST");
    expect(c.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(c.redirect).toBe("error");
    expect(c.form).toEqual({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    if (!r.ok) throw new Error("begin failed");
    expect(r.adopted).toBe(false);
    expect(r.view.phase).toBe("pending");
    expect(r.view.expiresAt).toBe(clock.now() + 600_000);
    const url = new URL(r.view.qrUrl!);
    expect(url.origin + url.pathname).toBe("https://open.feishu.cn/page/launcher");
    expect(url.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(url.searchParams.get("from")).toBe("sdk");
    expect(url.searchParams.get("tp")).toBe("sdk");
    expect(url.searchParams.get("source")).toBe("pi-toolkit");
    expect(url.searchParams.get("name")).toBe("pi@my-host-");
    expect(Object.keys(r.view).sort()).toEqual(["expiresAt", "phase", "qrUrl"]);
    await reg.dispose();
  });

  it("clamps interval (1..60, default 5) and expires_in (1..600, default 600; `expire_in` accepted)", async () => {
    expect([0, 0.5, 5, 61, 1e9, NaN, "x", undefined].map(clampPollInterval)).toEqual([1, 1, 5, 60, 60, 5, 5, 5]);
    expect([0, -1, 3, 601, undefined, "9", Infinity].map(clampExpiresIn)).toEqual([600, 600, 3, 600, 600, 600, 600]);
    const { reg, queue, clock } = rig();
    queue.push({ json: { device_code: DEVICE_CODE, verification_uri_complete: QR, expire_in: 30 } });
    const r = await reg.begin();
    if (!r.ok) throw new Error("begin failed");
    expect(r.view.expiresAt).toBe(clock.now() + 30_000);
    await reg.dispose();
  });
});

describe("polling semantics", () => {
  it("honours the interval, keeps polling through HTTP 400 pending / empty {} bodies, slow_down adds 5 s, then commits once", async () => {
    const { reg, calls, queue, clock, commits } = rig();
    queue.push(beginOk({ interval: 2 }));
    await reg.begin();
    queue.push(
      pending,
      { status: 400, json: { error: "slow_down" } },
      { json: {} },
      { status: 400, json: { error: "authorization_pending" } },
      success(),
    );
    await runUntil(clock, reg, () => phase(reg) === "done");
    expect(phase(reg)).toBe("done");
    const polls = calls.filter((c) => c.form["action"] === "poll");
    expect(polls).toHaveLength(5);
    for (const p of polls) {
      expect(p.url).toBe(FEISHU_REG);
      expect(p.form).toEqual({ action: "poll", device_code: DEVICE_CODE });
    }
    const gaps = polls.map((p, i) => p.at - (i === 0 ? calls[0]!.at : polls[i - 1]!.at));
    // interval 2 s → first poll after 2 s; slow_down answer ⇒ +5 s from then on (7 s)
    expect(gaps).toEqual([2_000, 2_000, 7_000, 7_000, 7_000]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.input).toEqual({
      brand: "feishu",
      appId: "cli_a1b2c3d4e5f6",
      appSecret: CLIENT_SECRET,
      ownerOpenId: OPEN_ID,
    });
    expect(reg.status()).toEqual({ phase: "done" });
    expect(clock.pending()).toBe(0);
  });

  it("slow_down growth is capped at 600 s", async () => {
    const { reg, calls, queue, clock } = rig();
    queue.push(beginOk({ interval: 60, expires_in: 600 }));
    await reg.begin();
    for (let i = 0; i < 8; i++) queue.push({ status: 400, json: { error: "slow_down" } });
    await drive(clock, 600_000, 1_000);
    const gaps = calls
      .filter((c) => c.form["action"] === "poll")
      .map((p, i, a) => p.at - (i === 0 ? calls[0]!.at : a[i - 1]!.at));
    expect(gaps[0]).toBe(60_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(600_000);
    expect(gaps[1]).toBe(65_000);
    await reg.dispose();
  });

  it("brand switch re-polls IMMEDIATELY on the other accounts origin with the same device code and stores that brand", async () => {
    const { reg, calls, queue, clock, commits } = rig();
    queue.push(beginOk());
    await reg.begin();
    queue.push(
      { json: { user_info: { tenant_brand: "lark" } } },
      success({ user_info: { open_id: OPEN_ID, tenant_brand: "lark" } }),
    );
    await runUntil(clock, reg, () => phase(reg) === "done");
    const polls = calls.filter((c) => c.form["action"] === "poll");
    expect(polls.map((p) => p.url)).toEqual([FEISHU_REG, LARK_REG]);
    expect(polls[1]!.at).toBe(polls[0]!.at); // delay 0
    expect(polls[1]!.form["device_code"]).toBe(DEVICE_CODE);
    expect(commits[0]!.input.brand).toBe("lark");
  });

  it("partial / empty / contradictory / malformed credentials are rejected and never committed", async () => {
    const bad: Array<[string, Reply, string]> = [
      ["id only", { json: { client_id: "cli_x1", user_info: { open_id: OPEN_ID } } }, "poll-fields"],
      ["secret only", { json: { client_secret: CLIENT_SECRET, user_info: { open_id: OPEN_ID } } }, "poll-fields"],
      ["empty strings", { json: { client_id: "", client_secret: "" } }, "poll-fields"],
      ["with error", success({ error: "access_denied" }), "contradictory"],
      ["with pending error", success({ error: "authorization_pending" }), "contradictory"],
      ["bad appId", success({ client_id: "app_nope" }), "credential-fields"],
      ["no open_id", success({ user_info: {} }), "credential-fields"],
      ["bad open_id", success({ user_info: { open_id: "xx" } }), "credential-fields"],
      ["secret with space", success({ client_secret: "has space" }), "credential-fields"],
      ["array body", { json: [] }, "poll-body"],
    ];
    for (const [name, reply, reason] of bad) {
      const { reg, queue, clock, commits } = rig();
      queue.push(beginOk());
      await reg.begin();
      queue.push(reply);
      await runUntil(clock, reg, () => phase(reg) !== "pending", 20_000);
      expect([name, phase(reg), reg.diagnostic()?.reason]).toEqual([name, "failed", reason]);
      expect(commits).toHaveLength(0);
      expect(clock.pending()).toBe(0);
    }
  });

  it("expired_token ⇒ expired, access_denied ⇒ denied, other 400 ⇒ failed(poll-http-400)", async () => {
    const table: Array<[unknown, string, string | undefined]> = [
      [{ error: "expired_token" }, "expired", "expired-token"],
      [{ error: "access_denied" }, "denied", "access-denied"],
      [{ error: "invalid_grant" }, "failed", "poll-http-400"],
    ];
    for (const [body, ph, reason] of table) {
      const { reg, queue, clock } = rig();
      queue.push(beginOk());
      await reg.begin();
      queue.push({ status: 400, json: body });
      await runUntil(clock, reg, () => phase(reg) !== "pending", 20_000);
      expect(phase(reg)).toBe(ph);
      expect(reg.diagnostic()?.reason).toBe(reason);
      expect(reg.status()).toEqual({ phase: ph }); // qr + expiresAt dropped
    }
  });

  it("hard-stops at expires_in: no request is issued past the deadline and the phase is expired", async () => {
    const r = rig();
    r.queue.push(beginOk({ interval: 5, expires_in: 12 })); // default reply afterwards is `pending`
    await r.reg.begin();
    const start = r.calls[0]!.at;
    await runUntil(r.clock, r.reg, () => phase(r.reg) !== "pending", 60_000);
    expect(phase(r.reg)).toBe("expired");
    for (const c of r.calls) expect(c.at).toBeLessThanOrEqual(start + 12_000);
    expect(r.calls.filter((c) => c.form["action"] === "poll")).toHaveLength(2); // t+5, t+10
    expect(r.clock.pending()).toBe(0);
  });

  it("a success answer that lands AFTER the deadline is never committed (expired-at-commit)", async () => {
    let open!: () => void;
    const r = rig();
    r.queue.push(beginOk({ interval: 1, expires_in: 20 }));
    await r.reg.begin();
    r.queue.push({ gate: new Promise<void>((res) => (open = res)), then: success() });
    await drive(r.clock, 1_000, 250); // poll in flight, gated
    r.clock.advance(30_000); // deadline passes while the answer is on the wire
    open();
    await drive(r.clock, 2_000, 500);
    expect(r.commits).toHaveLength(0);
    expect([phase(r.reg), r.reg.diagnostic()?.reason]).toEqual(["expired", "expired-at-commit"]);
  });

  it("each request is bounded by min(8 s, time left): a hung poll fails over as a transient timeout", async () => {
    const { reg, calls, queue, clock } = rig();
    queue.push(beginOk({ interval: 1 }));
    await reg.begin();
    queue.push({ hang: true }, success());
    await runUntil(clock, reg, () => phase(reg) === "done", 60_000);
    expect(phase(reg)).toBe("done");
    const polls = calls.filter((c) => c.form["action"] === "poll");
    expect(polls).toHaveLength(2);
    // the hung request was aborted by the 8 s deadline, the retry waited >= interval
    expect(polls[1]!.at - polls[0]!.at).toBeGreaterThanOrEqual(8_000);
    expect(polls[0]!.signal?.aborted).toBe(true);
  });

  it("transient failures (network, 5xx, 429, timeout): up to 4 in a row retry; the 5th fails; a success resets the counter", async () => {
    const net: Reply = { throw: new Error("ECONNRESET") };
    const s500: Reply = { status: 503, json: {} };
    const s429: Reply = { status: 429, text: "slow" };
    const a = rig();
    a.queue.push(beginOk({ interval: 1 }));
    await a.reg.begin();
    a.queue.push(net, s500, s429, net, success());
    await runUntil(a.clock, a.reg, () => phase(a.reg) !== "pending", 60_000);
    expect(phase(a.reg)).toBe("done");

    const b = rig();
    b.queue.push(beginOk({ interval: 1 }));
    await b.reg.begin();
    b.queue.push(net, net, net, net, net);
    await runUntil(b.clock, b.reg, () => phase(b.reg) !== "pending", 60_000);
    expect([phase(b.reg), b.reg.diagnostic()?.reason]).toEqual(["failed", "transient-limit"]);
    expect(b.calls.filter((c) => c.form["action"] === "poll")).toHaveLength(5);

    const c = rig();
    c.queue.push(beginOk({ interval: 1 }));
    await c.reg.begin();
    // 4 failures, a pending answer (counter reset), 4 more failures, then success: must NOT fail
    c.queue.push(net, net, net, net, pending, net, net, net, net, success());
    await runUntil(c.clock, c.reg, () => phase(c.reg) !== "pending", 120_000);
    expect(phase(c.reg)).toBe("done");
  });

  it("non-JSON 2xx/4xx and oversized bodies are non-transient failures", async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 200, text: "<html>" }, "protocol"],
      [{ status: 400, text: "nope" }, "protocol"],
      [{ bytes: new Uint8Array(REGISTRATION_MAX_BODY_BYTES + 1).fill(32) }, "too-large"],
    ];
    for (const [reply, reason] of cases) {
      const { reg, queue, clock } = rig();
      queue.push(beginOk({ interval: 1 }));
      await reg.begin();
      queue.push(reply);
      await runUntil(clock, reg, () => phase(reg) !== "pending", 20_000);
      expect([phase(reg), reg.diagnostic()?.reason]).toEqual(["failed", reason]);
    }
  });
});

describe("begin failures never create a run", () => {
  const bads: Array<[string, Reply, string]> = [
    ["http 500", { status: 500, json: {} }, "http-500"],
    ["http 400", { status: 400, json: { error: "invalid_request" } }, "begin-http-400"],
    ["non-json", { text: "x" }, "protocol"],
    ["network", { throw: new Error("down") }, "network"],
    ["no device_code", { json: { verification_uri_complete: QR } }, "begin-fields"],
    ["empty device_code", { json: { device_code: "", verification_uri_complete: QR } }, "begin-fields"],
    ["no uri", { json: { device_code: DEVICE_CODE } }, "begin-fields"],
    ["foreign host", beginOk({ verification_uri_complete: "https://evil.example.com/x" }), "begin-qr-url"],
    ["apex host", beginOk({ verification_uri_complete: "https://feishu.cn/x" }), "begin-qr-url"],
    ["http scheme", beginOk({ verification_uri_complete: "http://open.feishu.cn/x" }), "begin-qr-url"],
    ["userinfo", beginOk({ verification_uri_complete: "https://u:p@open.feishu.cn/x" }), "begin-qr-url"],
    ["port", beginOk({ verification_uri_complete: "https://open.feishu.cn:8443/x" }), "begin-qr-url"],
    ["fragment", beginOk({ verification_uri_complete: "https://open.feishu.cn/x#frag" }), "begin-qr-url"],
    [
      "device_code in url",
      beginOk({ verification_uri_complete: `https://open.feishu.cn/x?c=${DEVICE_CODE}` }),
      "begin-qr-url",
    ],
    [
      "secret-ish query key",
      beginOk({ verification_uri_complete: "https://open.feishu.cn/x?device_code=abc" }),
      "begin-qr-url",
    ],
    [
      "too long",
      beginOk({ verification_uri_complete: `https://open.feishu.cn/x?a=${"b".repeat(FEISHU_SETUP.qrUrlMaxLength)}` }),
      "begin-qr-url",
    ],
  ];
  for (const [name, reply, reason] of bads) {
    it(name, async () => {
      const { reg, calls, queue, clock } = rig();
      queue.push(reply);
      const r = await reg.begin();
      expect(r).toEqual({ ok: false, refused: "begin-failed", failure: reason });
      expect(reg.status()).toBeUndefined();
      expect(reg.active).toBe(false);
      await drive(clock, 30_000, 1_000);
      expect(calls).toHaveLength(1); // no polling ever started
      expect(clock.pending()).toBe(0);
    });
  }

  it("a failed begin can simply be retried", async () => {
    const { reg, queue } = rig();
    queue.push({ status: 500, json: {} });
    expect((await reg.begin()).ok).toBe(false);
    queue.push(beginOk());
    expect((await reg.begin()).ok).toBe(true);
    await reg.dispose();
  });
});

describe("single bounded generation, replace, refusals", () => {
  it("a second begin adopts the running generation (no second POST) and returns its view", async () => {
    const { reg, calls, queue } = rig();
    queue.push(beginOk());
    const a = await reg.begin();
    const gen = reg.setupGen;
    const b = await reg.begin();
    if (!a.ok || !b.ok) throw new Error("begin failed");
    expect(b.adopted).toBe(true);
    expect(b.view).toEqual(a.view);
    expect(calls).toHaveLength(1);
    expect(reg.setupGen).toBe(gen);
    await reg.dispose();
  });

  it("concurrent begins during the begin POST share ONE request", async () => {
    const { reg, calls, queue } = rig();
    queue.push(beginOk());
    const [a, b, c] = await Promise.all([reg.begin(), reg.begin(), reg.begin()]);
    expect(calls).toHaveLength(1);
    expect([a, b, c].every((r) => r.ok)).toBe(true);
    expect([a, b, c].filter((r) => r.ok && r.adopted)).toHaveLength(2);
    await reg.dispose();
  });

  it("existing credentials require replace+confirm; unsafe credentials refuse; confirm-less replace refuses", async () => {
    const r = rig({ presence: "present" });
    expect(await r.reg.begin()).toEqual({ ok: false, refused: "exists" });
    expect(await r.reg.begin({ replace: true })).toEqual({ ok: false, refused: "confirm-required" });
    expect(r.calls).toHaveLength(0);
    r.queue.push(beginOk());
    const ok = await r.reg.begin({ replace: true, confirm: true });
    expect(ok.ok).toBe(true);
    await r.reg.dispose();

    const u = rig({ presence: "unsafe" });
    expect(await u.reg.begin({ replace: true, confirm: true })).toEqual({ ok: false, refused: "credentials-unsafe" });
    expect(u.calls).toHaveLength(0);

    // `replace` without existing credentials is simply a normal setup
    const n = rig({ presence: "none" });
    n.queue.push(beginOk());
    expect((await n.reg.begin({ replace: true, confirm: true })).ok).toBe(true);
    await n.reg.dispose();
  });

  it("replace cannot be adopted into a running non-replace setup (active-conflict); the converse adopts", async () => {
    const a = rig({ presence: "none" });
    a.queue.push(beginOk());
    await a.reg.begin();
    a.setPresence("present");
    expect(await a.reg.begin({ replace: true, confirm: true })).toEqual({ ok: false, refused: "active-conflict" });
    await a.reg.dispose();

    const b = rig({ presence: "present" });
    b.queue.push(beginOk());
    await b.reg.begin({ replace: true, confirm: true });
    const again = await b.reg.begin();
    expect(again.ok && again.adopted).toBe(true);
    await b.reg.dispose();
  });

  it("refusal → wire code mapping", () => {
    expect(refusalToFsbCode("exists")).toBe("E_FSB_CONFIRM_REQUIRED");
    expect(refusalToFsbCode("confirm-required")).toBe("E_FSB_CONFIRM_REQUIRED");
    expect(refusalToFsbCode("active-conflict")).toBe("E_FSB_SETUP_ACTIVE");
    expect(refusalToFsbCode("credentials-unsafe")).toBe("E_FSB_STATE");
    expect(refusalToFsbCode("begin-failed")).toBe("E_FSB_STATE");
  });

  it("a new begin after a terminal run bumps the gen and forgets the old view", async () => {
    const { reg, queue, clock } = rig();
    queue.push(beginOk());
    await reg.begin();
    const g1 = reg.setupGen;
    queue.push({ status: 400, json: { error: "access_denied" } });
    await runUntil(clock, reg, () => phase(reg) === "denied", 20_000);
    expect(reg.active).toBe(false);
    queue.push(beginOk());
    const r = await reg.begin();
    expect(r.ok && !r.adopted).toBe(true);
    expect(reg.setupGen).toBeGreaterThan(g1);
    expect(phase(reg)).toBe("pending");
    await reg.dispose();
  });
});

describe("cancel fencing (§R2-e)", () => {
  it("cancel while pending: view cancelled, in-flight request aborted, nothing more is polled", async () => {
    const { reg, calls, queue, clock, commits } = rig();
    queue.push(beginOk({ interval: 1 }));
    await reg.begin();
    queue.push({ hang: true });
    await drive(clock, 1_000, 250);
    expect(calls.filter((c) => c.form["action"] === "poll")).toHaveLength(1);
    expect(await reg.cancel()).toEqual({ phase: "cancelled" });
    expect(calls.at(-1)!.signal?.aborted).toBe(true);
    await drive(clock, 20_000, 1_000);
    expect(commits).toHaveLength(0);
    expect(phase(reg)).toBe("cancelled");
    expect(calls.filter((c) => c.form["action"] === "poll")).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("a credential answer already on the wire when cancel lands is DISCARDED (late result, nothing written)", async () => {
    let open!: () => void;
    const r = rig();
    r.queue.push(beginOk({ interval: 1 }));
    await r.reg.begin();
    r.queue.push({ gate: new Promise<void>((res) => (open = res)), then: success() });
    await drive(r.clock, 1_000, 250);
    await r.reg.cancel();
    open();
    await drive(r.clock, 2_000, 500);
    expect(r.commits).toHaveLength(0);
    expect(phase(r.reg)).toBe("cancelled");
    expect(r.clock.pending()).toBe(0);
  });

  it("a credential answer already on the wire when reset fences is DISCARDED (setupGen recheck)", async () => {
    let open!: () => void;
    const r = rig();
    r.queue.push(beginOk({ interval: 1 }));
    await r.reg.begin();
    r.queue.push({ gate: new Promise<void>((res) => (open = res)), then: success() });
    await drive(r.clock, 1_000, 250);
    const gen = r.reg.setupGen;
    await r.reg.fence();
    expect(r.reg.setupGen).toBeGreaterThan(gen);
    open();
    await drive(r.clock, 2_000, 500);
    expect(r.commits).toHaveLength(0);
    expect(r.reg.status()).toBeUndefined();
  });

  it("the commit guard flips false after cancel / expiry (credential store honours it at the rename)", async () => {
    const r = rig();
    r.queue.push(beginOk({ interval: 1, expires_in: 100 }));
    await r.reg.begin();
    r.queue.push(success());
    await runUntil(r.clock, r.reg, () => r.commits.length === 1);
    const { guard } = r.commits[0]!;
    // commit callback resolved ok ⇒ run is done; guard is false afterwards (phase no longer pending)
    expect(phase(r.reg)).toBe("done");
    expect(guard()).toBe(false);
  });

  it("cancel during an in-flight commit waits for it; guard is false meanwhile; result decides the phase truthfully", async () => {
    for (const outcome of ["ok", "guard"] as const) {
      let finish!: (v: { ok: true } | { ok: false; reason: string }) => void;
      let seenGuard: (() => boolean) | undefined;
      const r = rig({
        commit: (_input, guard) => {
          seenGuard = guard;
          return new Promise((resolve) => (finish = resolve));
        },
      });
      r.queue.push(beginOk({ interval: 1 }));
      await r.reg.begin();
      r.queue.push(success());
      await runUntil(r.clock, r.reg, () => seenGuard !== undefined, 10_000);
      expect(seenGuard!()).toBe(true);
      let settled = false;
      const cancelling = r.reg.cancel().then((v) => {
        settled = true;
        return v;
      });
      await settle(5);
      expect(settled).toBe(false); // waits for the commit
      expect(seenGuard!()).toBe(false); // the credential store's pre-rename guard now refuses
      finish(outcome === "ok" ? { ok: true } : { ok: false, reason: "guard" });
      const view = await cancelling;
      expect(view).toEqual({ phase: outcome === "ok" ? "done" : "cancelled" });
    }
  });

  it("cancel during the begin POST: begin resolves cancelled and nothing starts", async () => {
    const r = rig();
    r.queue.push({ hang: true });
    const begin = r.reg.begin();
    await settle(3);
    expect(r.reg.active).toBe(true);
    await r.reg.cancel();
    expect(await begin).toEqual({ ok: false, refused: "cancelled" });
    expect(r.reg.active).toBe(false);
    expect(r.reg.status()).toBeUndefined();
    await drive(r.clock, 20_000, 1_000);
    expect(r.calls).toHaveLength(1);
  });

  it("fence() (reset) forgets the terminal view and bumps the generation; dispose aborts everything and refuses begin", async () => {
    const r = rig();
    r.queue.push(beginOk());
    await r.reg.begin();
    const g = r.reg.setupGen;
    await r.reg.fence();
    expect(r.reg.status()).toBeUndefined();
    expect(r.reg.setupGen).toBeGreaterThan(g);
    r.queue.push(beginOk());
    await r.reg.begin();
    await r.reg.dispose();
    expect(await r.reg.begin()).toEqual({ ok: false, refused: "disposed" });
    expect(r.clock.pending()).toBe(0);
  });

  it("commit failure / throw ⇒ failed(commit-…), never done", async () => {
    for (const commit of [
      async () => ({ ok: false as const, reason: "write-failed" }),
      async (): Promise<never> => {
        throw new Error("boom");
      },
    ]) {
      const r = rig({ commit });
      r.queue.push(beginOk({ interval: 1 }));
      await r.reg.begin();
      r.queue.push(success());
      await runUntil(r.clock, r.reg, () => phase(r.reg) !== "pending", 20_000);
      expect(phase(r.reg)).toBe("failed");
      expect(r.reg.diagnostic()?.reason).toMatch(/^commit-/);
    }
  });
});

describe("secrets never surface", () => {
  it("device_code and client_secret appear in no view, diagnostic, begin result or log line (success + failure runs)", async () => {
    const sink: unknown[] = [];
    const r = rig();
    r.queue.push(beginOk({ interval: 1 }));
    const b = await r.reg.begin();
    sink.push(b, r.reg.status(), r.reg.diagnostic());
    r.queue.push(pending, success());
    await runUntil(r.clock, r.reg, () => phase(r.reg) === "done", 30_000);
    sink.push(r.reg.status(), r.reg.diagnostic(), r.logs, await r.reg.cancel());

    const r2 = rig();
    r2.queue.push(beginOk({ interval: 1 }));
    sink.push(await r2.reg.begin());
    r2.queue.push({
      status: 400,
      json: { error: "access_denied", device_code: DEVICE_CODE, client_secret: CLIENT_SECRET },
    });
    await runUntil(r2.clock, r2.reg, () => phase(r2.reg) === "denied", 30_000);
    sink.push(r2.reg.status(), r2.reg.diagnostic(), r2.logs);

    const r3 = rig();
    r3.queue.push({ status: 400, json: { error: DEVICE_CODE, device_code: DEVICE_CODE } });
    sink.push(await r3.reg.begin(), r3.logs);

    const text = JSON.stringify(sink);
    expect(text).not.toContain(DEVICE_CODE);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("device_code");
    // the QR link only exists while pending
    expect(JSON.stringify(r.reg.status())).not.toContain("https://");
  });

  it("only registration origins are ever contacted", async () => {
    const r = rig();
    r.queue.push(beginOk({ interval: 1 }));
    await r.reg.begin();
    r.queue.push({ json: { user_info: { tenant_brand: "lark" } } }, success());
    await runUntil(r.clock, r.reg, () => phase(r.reg) === "done", 30_000);
    for (const c of r.calls) expect([FEISHU_REG, LARK_REG]).toContain(c.url);
  });
});

describe("pure helpers", () => {
  it("classifyPollResponse table", () => {
    const ok = {
      client_id: "cli_abc123",
      client_secret: "sekret",
      user_info: { open_id: OPEN_ID },
    };
    expect(classifyPollResponse(400, { error: "authorization_pending" }, "feishu")).toEqual({ kind: "pending" });
    expect(classifyPollResponse(400, { error: "slow_down" }, "feishu")).toEqual({ kind: "slow_down" });
    expect(classifyPollResponse(200, {}, "feishu")).toEqual({ kind: "pending" });
    expect(classifyPollResponse(200, { error: "" }, "feishu")).toEqual({ kind: "pending" });
    expect(classifyPollResponse(200, { error: null }, "feishu")).toEqual({ kind: "pending" });
    expect(classifyPollResponse(400, { user_info: { tenant_brand: "lark" } }, "feishu")).toEqual({
      kind: "brand-switch",
      brand: "lark",
    });
    // same brand ⇒ not a switch; neutral ⇒ pending
    expect(classifyPollResponse(200, { user_info: { tenant_brand: "feishu" } }, "feishu")).toEqual({ kind: "pending" });
    expect(classifyPollResponse(200, ok, "feishu")).toMatchObject({ kind: "credentials", brand: "feishu" });
    expect(
      classifyPollResponse(200, { ...ok, user_info: { ...ok.user_info, tenant_brand: "lark" } }, "feishu"),
    ).toMatchObject({
      kind: "credentials",
      brand: "lark",
    });
    expect(classifyPollResponse(400, { error: 7 }, "feishu")).toEqual({ kind: "failed", reason: "poll-http-400" });
    expect(classifyPollResponse(200, { error: "weird" }, "feishu")).toEqual({ kind: "failed", reason: "poll-fields" });
    expect(classifyPollResponse(200, "x", "feishu")).toEqual({ kind: "failed", reason: "poll-body" });
  });

  it("decorateQrUrl overwrites caller-supplied decoration and keeps existing params", () => {
    const out = decorateQrUrl(`${QR}&from=evil&name=x`, "dc", "h1")!;
    const u = new URL(out);
    expect(u.searchParams.get("from")).toBe("sdk");
    expect(u.searchParams.get("name")).toBe("pi@h1");
    expect(u.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(decorateQrUrl(QR, "", "")).toContain("name=pi%40host");
    expect(decorateQrUrl("https://x.larksuite.com/p", "dc", "h")).toBeDefined();
    expect(decorateQrUrl(undefined, "dc", "h")).toBeUndefined();
  });

  it("view shape stays exactly FsbSetupView", async () => {
    const r = rig();
    r.queue.push(beginOk());
    const b = await r.reg.begin();
    if (!b.ok) throw new Error("begin failed");
    const v: FsbSetupView = b.view;
    expect(Object.keys(v).every((k) => ["phase", "qrUrl", "expiresAt"].includes(k))).toBe(true);
    await r.reg.dispose();
  });
});
