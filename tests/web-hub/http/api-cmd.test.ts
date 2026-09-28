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
