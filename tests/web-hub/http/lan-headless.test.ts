/**
 * web-hub-spawn plan §SP9 验收（#8 硬门槛的后半）: the LAN face of the §6.4 visibility matrix
 * through the real LAN listener (`lan-helpers.ts`'s harness + the spawn-kit fakes):
 *
 *   - LAN user B's GET never sees A's `cwd`/`stderrTail`/`hintDetail`/`origin.user`/owner
 *     `firstPrompt` lens; A (the owner) sees them; the first-prompt BODY appears in NO SSE
 *     frame, GET response, or audit line;
 *   - LAN user B may STOP user A's session (arch §6.0's user ruling — 202, no owner check);
 *   - `lan:"off"` ⇒ LAN face identical to not-enabled (covered in headless-matrix.test.ts);
 *   - `lan:"roots"` on a PLAIN-HTTP direct connection is capped to `known` scope (roots内未知
 *     目录被拒); via a trusted proxy over https the roots scope applies;
 *   - a KNOWN dir on LAN still requires confirmation (confirm:"always").
 */
import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { lanPostJson, lanRequest, seedLanUser, startLan, fakeClock, type LanHarness } from "./lan-helpers.js";
import { openSse } from "./helpers.js";
import type { SseConn } from "./helpers.js";
import { spawnKit } from "./spawn-kit.js";
import { fakeHistory, fakeSessionPin } from "./spawn-kit.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest } from "./helpers.js";
import type { SpawnPolicyWire } from "../../../src/web-hub/protocol/spawn.js";
import { ALLOWED_POLICY } from "./spawn-kit.js";

const harnesses: LanHarness[] = [];
const conns: SseConn[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function loginAs(h: LanHarness, username: string, id: number): Promise<string> {
  seedLanUser(h.store, { id, username, password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username, password: "correct-horse-battery" });
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

const BODY_A = { id: "lan00000-aaaaaaaa", cwd: "/home/alice/secret-project" };

function policyFn(scopeWanted: (via: { scheme: string; viaTrustedProxy: boolean }) => "known" | "roots") {
  return (args: { scheme: "http" | "https"; viaTrustedProxy: boolean }): SpawnPolicyWire => ({
    ...ALLOWED_POLICY,
    confirm: "always", // the supervisor's LAN answer (arch §6.2: LAN confirm is always)
    scope: scopeWanted(args),
  });
}

describe("LAN visibility matrix (arch §6.4, #8)", () => {
  it("B's GET hides A's owner fields; A sees them; the prompt body leaks nowhere", async () => {
    const kit = spawnKit({ lan: "known" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/alice/secret-project", dev: 1, ino: 2, known: true });
    kit.supervisor.setPolicy(policyFn(() => "known"));

    const alice = await loginAs(h, "alice", 1);
    const bob = await loginAs(h, "bob", 2);

    // Alice spawns with a first prompt whose BODY must never resurface
    const PROMPT = "LAN-SECRET-PROMPT-𝄞-do-not-leak";
    const created = await lanPostJson(
      h.port,
      "/api/headless",
      { ...BODY_A, firstPrompt: { text: PROMPT } },
      { Cookie: alice },
    );
    expect(created.status).toBe(409); // LAN: known dir STILL requires confirmation (confirm:"always")
    const confirmed = await lanPostJson(
      h.port,
      "/api/headless",
      { ...BODY_A, confirm: true, expectCwd: "/home/alice/secret-project", firstPrompt: { text: PROMPT } },
      { Cookie: alice },
    );
    expect(confirmed.status).toBe(202);
    const spawnId = JSON.parse(confirmed.body).spawnId;
    expect(JSON.parse(confirmed.body)).not.toContain("LAN-SECRET-PROMPT");

    // Mutate the auto-owned record into a rich FAILED record (the owner-field carrier) instead
    // of seeding a second one, then add the forwarder's authoritative view
    const rec = kit.supervisor.recordsOut.find((r) => r.spawnId === spawnId)!;
    rec.state = "failed";
    rec.cwd = "/home/alice/secret-project";
    rec.endReason = "spawn_error";
    rec.hint = "protocol-error";
    rec.hintDetail = "private stderr detail";
    rec.stderrTail = () => "private: /home/alice/secret-path";
    rec.owner = { listener: "lan", reqId: BODY_A.id, user: "u1" };
    rec.uiCancelled = [{ method: "select", title: "Sensitive Dialog Title", at: 3 }];
    rec.firstPrompt = { state: "failed", textLen: PROMPT.length };
    kit.firstPrompt.setView(spawnId, {
      state: "failed",
      code: "E_SESSION_CHANGED",
      textLen: PROMPT.length,
      attempts: 2,
    });

    // B's GET: Public only — every §6.4 owner row hidden
    const bGet = await lanRequest(h.port, {
      path: "/api/headless",
      headers: { Cookie: bob, "X-PWH": "1", Host: `127.0.0.1:${h.port}` },
    });
    expect(bGet.status).toBe(200);
    const bItems = JSON.parse(bGet.body).items;
    expect(bItems).toHaveLength(1);
    expect(bItems[0]).toMatchObject({ spawnId, state: "failed", cwdLabel: "secret-project", uiCancelledCount: 1 });
    expect("cwd" in bItems[0]).toBe(false);
    expect("stderrTail" in bItems[0]).toBe(false);
    expect("hintDetail" in bItems[0]).toBe(false);
    expect("user" in bItems[0].origin).toBe(false);
    expect("uiCancelled" in bItems[0]).toBe(false);
    expect(bItems[0].firstPrompt).toEqual({ state: "failed", code: "E_SESSION_CHANGED" }); // no textLen/attempts
    expect(bGet.body).not.toContain("LAN-SECRET-PROMPT");

    // A's GET (the owner): full SpawnRecordOwner
    const aGet = await lanRequest(h.port, {
      path: "/api/headless",
      headers: { Cookie: alice, "X-PWH": "1", Host: `127.0.0.1:${h.port}` },
    });
    expect(aGet.status).toBe(200);
    const aItems = JSON.parse(aGet.body).items;
    expect(aItems[0]).toMatchObject({
      cwd: "/home/alice/secret-project",
      stderrTail: "private: /home/alice/secret-path",
      hintDetail: "private stderr detail",
      uiCancelled: [{ method: "select", title: "Sensitive Dialog Title", at: 3 }],
      firstPrompt: { state: "failed", code: "E_SESSION_CHANGED", textLen: PROMPT.length, attempts: 2 },
    });
    expect(aItems[0].origin.user).toBe("u1");
    expect(aGet.body).not.toContain("LAN-SECRET-PROMPT");

    // The broadcasts (SSE) carry the Public projection only — and never the prompt body
    const sseB = await openSse(h.port, { cookie: bob, host: `127.0.0.1:${h.port}` });
    conns.push(sseB);
    const spawns = await sseB.waitFor((e) => e.event === "spawns");
    expect(JSON.stringify(spawns.data)).not.toContain("/home/alice/secret-project");
    expect(JSON.stringify(spawns.data)).not.toContain("secret-path");
    expect(JSON.stringify(spawns.data)).not.toContain("Sensitive Dialog Title");
    expect(JSON.stringify(spawns.data)).not.toContain("textLen");
    expect(JSON.stringify(spawns.data)).not.toContain("LAN-SECRET-PROMPT");

    // Audits never carry the body either (U7)
    expect(JSON.stringify(kit.log.lines)).not.toContain("LAN-SECRET-PROMPT");
  });

  it("B may STOP A's session (arch §6.0 user ruling) — 202, no owner check", async () => {
    const kit = spawnKit({ lan: "known" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    const bob = await loginAs(h, "bob", 2);
    const spawnId = "stopme00-0000-0001";
    kit.supervisor.setStopResult({ ok: true, state: "stopping" });
    const res = await lanPostJson(h.port, `/api/headless/${spawnId}/stop`, {}, { Cookie: bob });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ state: "stopping" });
    expect(kit.supervisor.stopCalls).toEqual([{ spawnId, force: false }]);
  });
});

describe("LAN scope threading (arch §6.4: roots capped to known on plaintext direct)", () => {
  it("lan:roots + plain-HTTP DIRECT ⇒ policy gets (http,false), scope known ⇒ unknown dir rejected", async () => {
    const kit = spawnKit({ lan: "roots" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    kit.supervisor.setPolicy(
      policyFn(({ scheme, viaTrustedProxy }) => (scheme === "https" || viaTrustedProxy ? "roots" : "known")),
    );
    kit.dirs.setAdmitResult((raw, scope) =>
      scope === "known"
        ? { ok: false, reason: "not-allowed" }
        : { ok: true, realpath: raw, dev: 1, ino: 2, known: false },
    );
    const cookie = await loginAs(h, "alice", 1);
    const res = await lanPostJson(
      h.port,
      "/api/headless",
      { id: "roots0000-aaaaaaaa", cwd: "/srv/deep/unknown", confirm: true, expectCwd: "/srv/deep/unknown" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason: "not-allowed" });
    // the policy call saw the DIRECT plaintext transport
    expect(kit.supervisor.policyCalls.at(-1)).toMatchObject({
      listener: "lan",
      scheme: "http",
      viaTrustedProxy: false,
    });
    // and admit ran under the capped scope
    expect(kit.dirs.admitCalls.at(-1)?.scope).toBe("known");
  });

  it("lan:roots via a TRUSTED PROXY over https ⇒ scope roots ⇒ same dir is admitted", async () => {
    const kit = spawnKit({ lan: "roots" }, fakeClock());
    const h = await startLan({
      spawn: kit.spawn,
      cfg: {
        trustProxyFrom: ["127.0.0.1"],
        externalOrigins: ["https://hub.example.test"],
      },
    });
    harnesses.push(h);
    kit.supervisor.setPolicy(
      policyFn(({ scheme, viaTrustedProxy }) => (scheme === "https" && viaTrustedProxy ? "roots" : "known")),
    );
    kit.dirs.setAdmitResult((raw, scope) =>
      scope === "roots"
        ? { ok: true, realpath: raw, dev: 1, ino: 2, known: false }
        : { ok: false, reason: "not-allowed" },
    );
    // with trustProxyFrom ∋ 127.0.0.1, EVERY loopback peer is "via proxy" — the LOGIN itself
    // must ride the proxied shape too, or the session never exists
    seedLanUser(h.store, { id: 1, username: "alice", password: "correct-horse-battery" });
    const login = await lanRequest(h.port, {
      method: "POST",
      path: "/api/login",
      headers: {
        Host: `127.0.0.1:${h.port}`,
        "Content-Type": "application/json",
        "X-PWH": "1",
        Origin: "https://hub.example.test",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "hub.example.test",
      },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const res = await lanRequest(h.port, {
      method: "POST",
      path: "/api/headless",
      headers: {
        Host: `127.0.0.1:${h.port}`,
        "Content-Type": "application/json",
        "X-PWH": "1",
        Cookie: cookie,
        Origin: "https://hub.example.test",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "hub.example.test",
      },
      body: JSON.stringify({
        id: "roots0000-bbbbbbbb",
        cwd: "/srv/deep/unknown",
        confirm: true,
        expectCwd: "/srv/deep/unknown",
      }),
    });
    expect(res.status).toBe(202);
    expect(kit.supervisor.policyCalls.at(-1)).toMatchObject({
      listener: "lan",
      scheme: "https",
      viaTrustedProxy: true,
    });
    expect(kit.dirs.admitCalls.at(-1)?.scope).toBe("roots");
  });
});

// ---------------------------------------------------------------------------
// default-model plan §3 ④ / D1 (U1): the global shared preference + its LAN semantics
// ---------------------------------------------------------------------------

describe("default-model prefs — global share (U1) and the second-authorize race", () => {
  it("U1: Alice (LAN) writes ⇒ Bob (LAN) and the loopback face see the SAME value; a loopback spawn forks with it; the audit carries the principal", async () => {
    const kit = spawnKit({ lan: "known" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    kit.supervisor.setPolicy(policyFn(() => "known"));

    const alice = await loginAs(h, "alice", 1);
    const bob = await loginAs(h, "bob", 2);

    // Alice writes the preference over LAN
    const write = await lanPostJson(h.port, "/api/headless/prefs", { defaultModel: "p1/shared" }, { Cookie: alice });
    expect(write.status).toBe(200);
    expect(JSON.parse(write.body)).toEqual({ prefs: { defaultModel: "p1/shared" } });

    // the audit line carries the WRITING principal (U1/A9: 全局单值 + principal 审计)
    const line = kit.log.lines
      .map((l) => l.data as Record<string, unknown>)
      .find((d) => d["endpoint"] === "prefs" && d["phase"] === "request");
    expect(line).toMatchObject({ listener: "lan", user: "u1", from: null, to: "p1/shared" });

    // Bob (a DIFFERENT LAN principal) reads the same value off his own GET
    const bobGet = await lanRequest(h.port, {
      path: "/api/headless",
      headers: { Cookie: bob, "X-PWH": "1", Host: `127.0.0.1:${h.port}` },
    });
    expect(JSON.parse(bobGet.body).prefs).toEqual({ defaultModel: "p1/shared" });

    // the loopback face of the SAME hub sees it too, and forks with it
    const tmpLoop = makeTmp("pwh-prefs-loop-");
    try {
      const depsLoop = fakeDeps(tmpLoop.dir);
      depsLoop.spawn = kit.spawn;
      const feLoop = createHttpFrontend(depsLoop);
      const portLoop = (await feLoop.listen()).port;
      try {
        const cookieLoop = await login(portLoop, depsLoop.paths.tokenFile);
        const get = await rawRequest(portLoop, {
          path: "/api/headless",
          headers: { Cookie: cookieLoop, "X-PWH": "1" },
        });
        expect(JSON.parse(get.body).prefs).toEqual({ defaultModel: "p1/shared" });
        const origin = `http://127.0.0.1:${portLoop}`;
        kit.supervisor.setPolicy(() => ({ ...ALLOWED_POLICY })); // loopback: known dir needs no confirm
        const spawn = await postJson(portLoop, "/api/headless", BODY_A, { Cookie: cookieLoop, Origin: origin });
        expect(spawn.status).toBe(202);
        expect(JSON.parse(spawn.body).model).toBe("p1/shared");
        expect(kit.supervisor.startCalls[0]!.model).toBe("p1/shared");
      } finally {
        await feLoop.close();
      }
    } finally {
      tmpLoop.cleanup();
    }
  });

  it("LAN revokeAllSessions racing the prefs body read ⇒ 401, prefs.set never called, value unchanged", async () => {
    const kit = spawnKit({ lan: "known" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    kit.prefs.setValue("p1/old");
    const cookie = await loginAs(h, "alice", 1);
    const host = `127.0.0.1:${h.port}`;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: "/api/headless/prefs",
          headers: {
            Host: host,
            "Content-Type": "application/json",
            "X-PWH": "1",
            Cookie: cookie,
            Origin: `http://${host}`,
          },
          agent: false,
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          r.on("error", reject);
        },
      );
      req.on("error", reject);
      const body = JSON.stringify({ defaultModel: "p1/new" });
      req.write(body.slice(0, 5));
      void (async () => {
        await new Promise((r2) => setTimeout(r2, 50));
        await h.store.deleteAllSessions(1); // a landed rotation revokes every LAN session row (alice=u1)
        req.end(body.slice(5));
      })();
    });
    expect(res.status).toBe(401);
    expect(kit.prefs.setCalls).toHaveLength(0);
    expect(kit.prefs.get()).toBe("p1/old");
  });
});

describe("LAN session-backed POST (session-history plan §4.6.6)", () => {
  const SESSION_REF = { key: "dir/sess-old.jsonl", id: "sess-old", mode: "resume" as const };

  it("lan:'known': GET /api/headless/history returns 200", async () => {
    const history = fakeHistory();
    const kit = spawnKit({ lan: "known", history: true }, fakeClock(), undefined, history);
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    history.setPageResult({
      ok: true,
      page: { items: [], stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 0, dirsTotal: 0 } } },
    });
    const alice = await loginAs(h, "alice", 1);
    const r = await lanRequest(h.port, { path: "/api/headless/history", headers: { Cookie: alice, "X-PWH": "1" } });
    expect(r.status).toBe(200);
  });

  it("resume ⇒ 409 always (LAN confirm), confirm resent ⇒ 202", async () => {
    const history = fakeHistory();
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const kit = spawnKit({ lan: "known", history: true }, fakeClock(), undefined, history);
    kit.supervisor.setPolicy(policyFn(() => "known"));
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    const alice = await loginAs(h, "alice", 1);
    const body = { id: "lanhist00aaaaaaaaaa", cwd: pin.cwd, session: SESSION_REF };
    const first = await lanPostJson(h.port, "/api/headless", body, { Cookie: alice });
    expect(first.status).toBe(409);
    const confirmed = await lanPostJson(
      h.port,
      "/api/headless",
      { ...body, confirm: true, expectCwd: pin.cwd },
      { Cookie: alice },
    );
    expect(confirmed.status).toBe(202);
  });

  it("fork + confirm ⇒ one 202 round-trip", async () => {
    const history = fakeHistory();
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const kit = spawnKit({ lan: "known", history: true }, fakeClock(), undefined, history);
    kit.supervisor.setPolicy(policyFn(() => "known"));
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    const alice = await loginAs(h, "alice", 1);
    const body = {
      id: "lanhist01aaaaaaaaaa",
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { ...SESSION_REF, mode: "fork" as const },
    };
    const r = await lanPostJson(h.port, "/api/headless", body, { Cookie: alice });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body).session.mode).toBe("fork");
  });

  it("scope 'roots' on plain HTTP is capped to 'known' for the legacy path, but a session-backed admit never reaches the roots branch at all (sessionBacked skips the scan)", async () => {
    const history = fakeHistory();
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const kit = spawnKit({ lan: "roots", history: true }, fakeClock(), undefined, history);
    kit.supervisor.setPolicy(policyFn((via) => (via.viaTrustedProxy ? "roots" : "known")));
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    const alice = await loginAs(h, "alice", 1);
    const body = {
      id: "lanhist02aaaaaaaaaa",
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: SESSION_REF,
    };
    const r = await lanPostJson(h.port, "/api/headless", body, { Cookie: alice });
    expect(r.status).toBe(202);
    expect(kit.dirs.admitCalls[0]?.sessionBacked).toBe(true);
  });
});
