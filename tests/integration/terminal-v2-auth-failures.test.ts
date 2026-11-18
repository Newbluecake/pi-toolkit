/** A5 failure/partial/business-no-change with original real SQLite/auth. No success stub.
 * Partial bulk is an explicit oversized original DB fixture (> normal32 cap), not
 * a claim that ordinary admitted logins can naturally reach that defensive state.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture, terminalV2Admin } from "./helpers/terminal-v2-auth-fixture.js";
import { authCookie, authPassword, rotateAuth } from "./helpers/terminal-v2-auth-ops.js";
import { passwordFactStore } from "../../src/web-hub/hub/auth-store-facts.js";
import { DbClientError } from "../../src/web-hub/hub/db-client.js";
import { hashSid } from "../../src/web-hub/hub/sid-hash.js";
import { lanPostJson, lanRequest } from "../web-hub/http/lan-helpers.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each(["passwd", "delete"].flatMap((op) => [false, true].map((committed) => ({ op, committed }))))(
  "A5 original $op failure committed=$committed preserves unknown deny and resource health",
  async ({ op, committed }) => {
    const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
      name = `failure-${randomBytes(5).toString("hex")}`,
      password = authPassword();
    if (op === "delete")
      expect((await terminalV2Admin(h.agent, { op: "passwd", username: name, password: authPassword() })).ok).toBe(
        true,
      );
    const before = readFileSync(`${h.state}/terminal-v2/ledger.json`),
      user = (await h.authStore.getUser(h.username))!;
    let restore: () => void;
    if (op === "passwd") {
      const bridge = passwordFactStore(h.authStore)!,
        actual = bridge.setPasswordWithFact.bind(bridge);
      const fault = vi.spyOn(bridge, "setPasswordWithFact").mockImplementationOnce(async (...args) => {
        if (committed) await actual(...args);
        throw new DbClientError("E_DB", "original password result unavailable");
      });
      restore = () => fault.mockRestore();
    } else {
      const actual = h.authStore.deleteUser.bind(h.authStore),
        fault = vi.spyOn(h.authStore, "deleteUser").mockImplementationOnce(async (...args) => {
          if (committed) await actual(...args);
          throw new DbClientError("E_DB", "original delete result unavailable");
        });
      restore = () => fault.mockRestore();
    }
    const result = await terminalV2Admin(
      h.agent,
      op === "passwd" ? { op: "passwd", username: h.username, password } : { op: "user_delete", username: name },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("E_INTERNAL");
    restore();
    if (op === "passwd") expect((await h.authStore.getUser(h.username))!.epoch).toBe(user.epoch + (committed ? 1 : 0));
    else expect((await h.authStore.getUser(name)) !== undefined).toBe(!committed);
    const current = await h.loginLan(op === "passwd" && committed ? password : undefined);
    expect(current.status).toBe(200);
    expect((await h.lan("list", { scope: h.scope }, authCookie(current))).body.code).toBe("E_REVOKING");
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
    await rotateAuth(h);
    const after = await h.loginLan(op === "passwd" && committed ? password : undefined);
    expect(after.status).toBe(200);
    expect((await h.lan("list", { scope: h.scope }, authCookie(after))).status).toBe(200);
  },
  30000,
);
it("A5 real failed kick keeps exact target deny but not another current SID or resource poison", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    second = authCookie(await h.loginLan());
  const rows = await lanRequest(h.lanPort, {
    method: "GET",
    path: "/api/lan/sessions",
    headers: { ...h.lanHeaders, Cookie: h.lanCookie, "X-PWH": "1" },
  });
  const target = JSON.parse(rows.body).sessions.find((row: any) => !row.current);
  expect(target).toBeDefined();
  const before = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  const failure = vi
    .spyOn(h.authStore, "revokeSession")
    .mockRejectedValueOnce(new DbClientError("E_DB", "owned original revoke failure"));
  const result = await lanPostJson(
    h.lanPort,
    "/api/lan/sessions/revoke",
    { id: target.id },
    { ...h.lanHeaders, Cookie: h.lanCookie },
  );
  expect(result.status).toBe(503);
  expect(JSON.parse(result.body).error).toBe("E_DB");
  expect(failure).toHaveBeenCalledOnce();
  failure.mockRestore();
  expect((await h.lan("list", { scope: h.scope }, second)).body.code).toBe("E_REVOKING");
  expect((await h.lan("list", { scope: h.scope })).status).toBe(200);
  const originalAuth = await lanRequest(h.lanPort, {
    method: "GET",
    path: "/api/lan/sessions",
    headers: { ...h.lanHeaders, Cookie: second, "X-PWH": "1" },
  });
  expect(originalAuth.status).toBe(200);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
}, 30000);
it("A5 original primary-account business refusal settles ONLY its own no-change token", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    before = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  expect(
    (await terminalV2Admin(h.agent, { op: "passwd", username: "business-secondary", password: authPassword() })).ok,
  ).toBe(true);
  const refusal = await terminalV2Admin(h.agent, { op: "user_delete", username: h.username });
  expect(refusal.code).toBe("E_PRIMARY_USER");
  expect((await h.lan("list", { scope: h.scope })).status).toBe(200);
  const fault = vi
    .spyOn(h.authStore, "deleteUser")
    .mockRejectedValueOnce(new DbClientError("E_DB", "unknown older mutation"));
  expect((await terminalV2Admin(h.agent, { op: "user_delete", username: "absent-account" })).code).toBe("E_INTERNAL");
  fault.mockRestore();
  expect((await terminalV2Admin(h.agent, { op: "user_delete", username: h.username })).code).toBe("E_PRIMARY_USER");
  expect((await h.lan("list", { scope: h.scope })).body.code).toBe("E_REVOKING");
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
}, 30000);
it("A5 original actual oversized SQLite bulk returns complete:false with real64 deletes, not manufactured success", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    before = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  const keep = hashSid(h.lanCookie.slice(h.lanCookie.indexOf("=") + 1));
  const hashes = Array.from({ length: 65 }, () => hashSid(randomBytes(32).toString("base64url")));
  const script = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const keep=Buffer.from(process.argv[2],'base64url');const add=db.prepare('INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) SELECT ?,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip FROM sessions WHERE sid_hash=?');for(const hash of JSON.parse(process.argv[3])){if(add.run(Buffer.from(hash,'base64url'),keep).changes!==1)throw new Error('owned oversized original fixture failed');}db.close();`;
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "-e", script, h.hub.paths.dbFile, keep, JSON.stringify(hashes)],
    { stdio: "pipe" },
  );
  const actual = h.authStore.deleteSessionsExcept.bind(h.authStore),
    observed: any[] = [];
  vi.spyOn(h.authStore, "deleteSessionsExcept").mockImplementation(async (...args) => {
    const result = await actual(...args);
    observed.push(result);
    return result;
  });
  const result = await lanPostJson(
    h.lanPort,
    "/api/lan/sessions/revoke",
    { others: true },
    { ...h.lanHeaders, Cookie: h.lanCookie },
  );
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ok: true, revoked: 64, complete: false });
  expect(observed).toHaveLength(1);
  expect(observed[0].deleted).toHaveLength(64);
  expect(observed[0].more).toBe(true);
  expect(await h.authStore.touchSession(hashes[0]!, Date.now())).toBeUndefined();
  expect(await h.authStore.touchSession(hashes[64]!, Date.now())).toBeDefined();
  expect((await h.lan("list", { scope: h.scope })).status).toBe(200);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
}, 30000);

it("A6 original DELETE commits then its actual HTTP transport is lost; restart trusts DB, not terminal memory", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    old = h.lanCookie,
    ledger = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  let signal!: () => void;
  const committed = new Promise<void>((r) => {
      signal = r;
    }),
    actual = h.authStore.deleteSession.bind(h.authStore);
  let client!: ReturnType<typeof request>;
  let receivedResponse = false;
  vi.spyOn(h.authStore, "deleteSession").mockImplementationOnce(async (...args) => {
    await actual(...args);
    client.destroy();
    signal();
  });
  const lost = new Promise<void>((resolve, reject) => {
    client = request(
      {
        host: "127.0.0.1",
        port: h.lanPort,
        path: "/api/logout",
        method: "POST",
        headers: { ...h.lanHeaders, Cookie: old, "X-PWH": "1", "Content-Type": "application/json" },
      },
      (res) => {
        receivedResponse = true;
        res.resume();
        reject(new Error("expected actual post-commit HTTP response loss"));
      },
    );
    client.once("error", () => resolve());
    client.end("{}");
  });
  await committed;
  await lost;
  expect(receivedResponse).toBe(false);
  const restarted = await h.restart();
  const original = await lanRequest(restarted.lanPort, {
    method: "GET",
    path: "/api/lan/sessions",
    headers: { ...restarted.lanHeaders, Cookie: old, "X-PWH": "1" },
  });
  expect(original.status).toBe(401);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(ledger);
}, 30000);
it("A6 original password epoch commits then its actual admin transport is lost; real restart rejects old SID", async () => {
  const h = await terminalV2AuthFixture(closers, true, true, { retain: true }),
    old = h.lanCookie,
    password = authPassword(),
    rid = randomBytes(16).toString("hex");
  const ledger = readFileSync(`${h.state}/terminal-v2/ledger.json`),
    before = (await h.authStore.getUser(h.username))!,
    bridge = passwordFactStore(h.authStore)!,
    actual = bridge.setPasswordWithFact.bind(bridge);
  let signal!: () => void;
  const committed = new Promise<void>((r) => {
    signal = r;
  });
  vi.spyOn(bridge, "setPasswordWithFact").mockImplementationOnce(async (...args) => {
    const receipt = await actual(...args);
    h.agent.sock.destroy();
    signal();
    return receipt;
  });
  h.agent.send({ t: "lan_req", rid, op: "passwd", username: h.username, password });
  await committed;
  await h.agent.closed;
  expect(h.agent.frames.some((raw: any) => raw.t === "lan_res" && raw.rid === rid)).toBe(false);
  const restarted = await h.restart(password);
  expect((await restarted.authStore.getUser(h.username))!.epoch).toBe(before.epoch + 1);
  const original = await lanRequest(restarted.lanPort, {
    method: "GET",
    path: "/api/lan/sessions",
    headers: { ...restarted.lanHeaders, Cookie: old, "X-PWH": "1" },
  });
  expect(original.status).toBe(401);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(ledger);
}, 30000);
