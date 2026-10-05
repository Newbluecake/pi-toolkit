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
import { lanPostJson, lanRequest, seedLanUser, startLan, fakeClock, type LanHarness } from "./lan-helpers.js";
import { openSse } from "./helpers.js";
import type { SseConn } from "./helpers.js";
import { spawnKit } from "./spawn-kit.js";
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
