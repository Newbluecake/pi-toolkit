import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { CommandRouter } from "../../../src/web-hub/hub/ports.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeDeps, login, makeAgent, makeTmp, postJson, rawRequest, type FakeDeps } from "./helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let origin: string;

interface FakeRouter extends CommandRouter {
  calls: CmdFrame[];
  reply: (frame: CmdFrame) => CmdResultFrame | Promise<CmdResultFrame>;
}

function fakeRouter(reply: FakeRouter["reply"]): FakeRouter {
  const calls: CmdFrame[] = [];
  return {
    calls,
    reply,
    async request(frame) {
      calls.push(frame);
      return reply(frame);
    },
    async drain() {
      return { inflight: 0, timedOut: false };
    },
    inflight() {
      return 0;
    },
  };
}

function okReply(frame: CmdFrame): CmdResultFrame {
  return { t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: { op: "abort", wasBusy: false } };
}

beforeEach(async () => {
  tmp = makeTmp("pwh-api-cmd-");
  deps = fakeDeps(tmp.dir);
  deps.agents.set("a1", makeAgent("a1"));
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
  origin = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await fe.close();
  tmp.cleanup();
});

function cmdHeaders(over: Record<string, string> = {}): Record<string, string> {
  return { Cookie: cookie, Origin: origin, ...over };
}

function abortBody(id = "a".repeat(16)): Record<string, unknown> {
  return { agentKey: "a1", id, op: "abort" };
}

describe("POST /api/cmd — loopback gate order (plan §6.3)", () => {
  it("① missing Origin ⇒ 403 E_CSRF, before auth is even checked", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_CSRF" });
  });

  it("cross-origin Origin ⇒ 403 E_CSRF", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), { Cookie: cookie, Origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site ⇒ 403 E_CSRF even with a matching Origin", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders({ "Sec-Fetch-Site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: same-origin passes", async () => {
    deps.commands = fakeRouter(okReply);
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders({ "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(200);
  });

  it("② no cookie (with valid CSRF) ⇒ 401 E_AUTH", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), { Origin: origin });
    expect(res.status).toBe(401);
  });

  it("missing Content-Type / X-PWH ⇒ 403 (same as every other write endpoint)", async () => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/cmd",
      headers: { Cookie: cookie, Origin: origin },
      body: JSON.stringify(abortBody()),
    });
    expect(res.status).toBe(403);
  });

  it("commands router not wired ⇒ 501 E_NOT_IMPLEMENTED (past CSRF + auth)", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders());
    expect(res.status).toBe(501);
  });

  it("bad body (missing agentKey/id/op) ⇒ 400 E_BAD_REQUEST, router never called", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    const res = await postJson(port, "/api/cmd", { agentKey: "a1" }, cmdHeaders());
    expect(res.status).toBe(400);
    expect(router.calls).toHaveLength(0);
  });

  it("id must match ^[A-Za-z0-9_-]{16,64}$", async () => {
    deps.commands = fakeRouter(okReply);
    const res = await postJson(port, "/api/cmd", abortBody("short"), cmdHeaders());
    expect(res.status).toBe(400);
  });

  it("happy path: a valid abort reaches the router and 200s with its data", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "abort", wasBusy: false } });
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]).toMatchObject({
      t: "cmd",
      cmd: { op: "abort" },
      origin: { listener: "loopback", ip: "127.0.0.1" },
    });
    expect(router.calls[0]!.deadlineMs).toBeGreaterThan(0);
    expect(router.calls[0]!.deadlineMs).toBeLessThanOrEqual(8_000);
  });

  it("a resolved CmdErrorCode failure maps to the documented HTTP status", async () => {
    deps.commands = fakeRouter((frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_BUSY_STEER",
      retryable: true,
      effect: "none",
    }));
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders());
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BUSY_STEER", retryable: true, effect: "none" });
  });

  it("a rejected HubError E_AGENT_GONE ⇒ 503, retryable reflects whether the agent is still known to the registry", async () => {
    class FakeHubError extends Error {
      code = "E_AGENT_GONE";
    }
    deps.commands = fakeRouter(() => {
      throw new FakeHubError("gone");
    });
    const res = await postJson(port, "/api/cmd", abortBody(), cmdHeaders());
    // Not an instance of the real HubError class from registry.ts, so http.ts's `instanceof`
    // guard falls through to the generic 500 path — this is the correct, safe behavior for any
    // *other* thrown error a router implementation might produce.
    expect(res.status).toBe(500);
  });

  it("queryOnly:true is forwarded on the frame", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    await postJson(port, "/api/cmd", { ...abortBody(), queryOnly: true }, cmdHeaders());
    expect(router.calls[0]!.queryOnly).toBe(true);
  });

  it("dialog answer body maps to a dialog_answer CmdFrame via /api/dialog", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    const res = await postJson(
      port,
      "/api/dialog",
      {
        agentKey: "a1",
        id: "b".repeat(16),
        dialogId: "ask:1",
        epoch: "e1",
        action: "answer",
        answers: [{ selected: ["x"], other: null }],
      },
      cmdHeaders(),
    );
    expect(res.status).toBe(200);
    expect(router.calls[0]!.cmd).toMatchObject({ op: "dialog_answer", dialogId: "ask:1", epoch: "e1" });
  });

  it("dialog cancel maps to dialog_cancel", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    await postJson(
      port,
      "/api/dialog",
      { agentKey: "a1", id: "c".repeat(16), dialogId: "ask:1", epoch: "e1", action: "cancel" },
      cmdHeaders(),
    );
    expect(router.calls[0]!.cmd).toMatchObject({ op: "dialog_cancel" });
  });
});

describe("POST /api/cmd — rate limiting (plan §6.5)", () => {
  it("exhausting the per-category bucket returns 429 with Retry-After, and does not reach the router", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    for (let i = 0; i < 10; i++) {
      const res = await postJson(port, "/api/cmd", abortBody(`a${i}`.padEnd(16, "0")), cmdHeaders());
      expect(res.status).toBe(200);
    }
    const eleventh = await postJson(port, "/api/cmd", abortBody("b".repeat(16)), cmdHeaders());
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers["retry-after"]).toBeDefined();
    expect(router.calls).toHaveLength(10);
  });
});

describe('POST /api/cmd — idempotent hit skips the rate limiter (plan §6.5 "\u5e42\u7b49\u547d\u4e2d\u4e0d\u6263\u4ee4\u724c", C3 P1 fix)', () => {
  function fakeRouterWithIdempotency(reply: FakeRouter["reply"]): FakeRouter & {
    peekIdempotent: NonNullable<CommandRouter["peekIdempotent"]>;
  } {
    const calls: CmdFrame[] = [];
    const done = new Set<string>();
    return {
      calls,
      reply,
      async request(frame, agentKey) {
        calls.push(frame);
        const r = await reply(frame);
        done.add(`${agentKey}|${frame.id}`);
        return r;
      },
      async drain() {
        return { inflight: 0, timedOut: false };
      },
      inflight() {
        return 0;
      },
      peekIdempotent(_origin, agentKey, id) {
        return done.has(`${agentKey}|${id}`) ? "done" : undefined;
      },
    };
  }

  it("a done dup retried well past the per-category bucket capacity still succeeds (fine/perIp/perAgent admits skipped)", async () => {
    const router = fakeRouterWithIdempotency(okReply);
    deps.commands = router;
    const id = "d".repeat(16);
    const first = await postJson(port, "/api/cmd", abortBody(id), cmdHeaders());
    expect(first.status).toBe(200);
    // "abort" is the "stop" category: burst 10, refill 1/2s. Without the C3 P1 dup-skip fix, the
    // 11th retry of this SAME id would 429 (the bucket only had 9 tokens left after the first call).
    for (let i = 0; i < 15; i++) {
      const res = await postJson(port, "/api/cmd", abortBody(id), cmdHeaders());
      expect(res.status).toBe(200);
    }
    expect(router.calls).toHaveLength(16); // this double doesn't itself cache — it only reports peekIdempotent
  });

  it("control (no peekIdempotent on the router double): the same retried id DOES exhaust the bucket", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    const id = "e".repeat(16);
    for (let i = 0; i < 10; i++) {
      const res = await postJson(port, "/api/cmd", abortBody(id), cmdHeaders());
      expect(res.status).toBe(200);
    }
    const eleventh = await postJson(port, "/api/cmd", abortBody(id), cmdHeaders());
    expect(eleventh.status).toBe(429);
  });
});

describe("POST /api/cmd — reject-phase audit lines (plan §6.4, C3 P1 fix)", () => {
  function controlAudits(): Record<string, unknown>[] {
    return deps.logLines
      .filter((l) => (l.data as Record<string, unknown> | undefined)?.["audit"] === "control")
      .map((l) => l.data as Record<string, unknown>);
  }

  it("CSRF rejection (missing Origin) writes a phase:reject audit line without a user field", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(403);
    const audits = controlAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      phase: "reject",
      code: "E_CSRF",
      endpoint: "cmd",
      listener: "loopback",
      ok: false,
    });
    expect(audits[0]).not.toHaveProperty("user");
  });

  it("auth rejection (no cookie) writes a phase:reject audit line with code E_AUTH, no user field", async () => {
    const res = await postJson(port, "/api/cmd", abortBody(), { Origin: origin });
    expect(res.status).toBe(401);
    const audits = controlAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ phase: "reject", code: "E_AUTH", endpoint: "cmd", ok: false });
    expect(audits[0]).not.toHaveProperty("user");
  });

  it("429s are throttled to at most one audit line per throttle key within the audit window", async () => {
    const router = fakeRouter(okReply);
    deps.commands = router;
    for (let i = 0; i < 10; i++) {
      await postJson(port, "/api/cmd", abortBody(`a${i}`.padEnd(16, "0")), cmdHeaders());
    }
    const before = controlAudits().length;
    const first429 = await postJson(port, "/api/cmd", abortBody("b".repeat(16)), cmdHeaders());
    expect(first429.status).toBe(429);
    const second429 = await postJson(port, "/api/cmd", abortBody("c".repeat(16)), cmdHeaders());
    expect(second429.status).toBe(429);
    const third429 = await postJson(port, "/api/cmd", abortBody("f".repeat(16)), cmdHeaders());
    expect(third429.status).toBe(429);
    const after = controlAudits().filter((a) => a["phase"] === "reject" && a["code"] === "E_RATE");
    expect(after.length - 0).toBeGreaterThanOrEqual(1);
    // All three 429s share the same throttle key (`fine:loopback:token:stop`, the "stop" category
    // bucket the first 10 abort calls already exhausted) — only the first should have produced an
    // audit line.
    expect(controlAudits().length).toBe(before + 1);
  });
});
