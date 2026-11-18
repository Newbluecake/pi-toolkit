/** Real startHub/both listeners/SQLite/token/original rotate. Metadata context is the
 * explicitly simulated helper, not SDK evidence. Resource failure injection below
 * never mocks an auth success; original DB/token results are independently checked.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture, terminalV2Admin } from "./helpers/terminal-v2-auth-fixture.js";
import {
  authPassword as password,
  authCookie as cookie,
  rotateAuth as rotate,
  exerciseOriginalAuthMutations as originalMutations,
} from "./helpers/terminal-v2-auth-ops.js";
import { HubTerminalServiceV2 } from "../../src/web-hub/hub/terminal/v2/service.js";
import { lanPostJson, lanRequest } from "../web-hub/http/lan-helpers.js";
import { postJson, login } from "../web-hub/http/helpers.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each(["off", "bad-ledger", "initialize-throw", "initialize-pending"] as const)(
  "A1 real original auth mutations remain independent: %s",
  async (variant) => {
    let release!: () => void,
      entered = false;
    if (variant === "initialize-throw")
      vi.spyOn(HubTerminalServiceV2.prototype, "initialize").mockImplementationOnce(() => {
        throw new Error("resource initialize failure");
      });
    if (variant === "initialize-pending") {
      const pending = new Promise<boolean>((resolve) => {
        release = () => resolve(false);
      });
      vi.spyOn(HubTerminalServiceV2.prototype, "initialize").mockImplementationOnce(() => {
        entered = true;
        return pending;
      });
    }
    try {
      const h = await terminalV2AuthFixture(closers, variant === "bad-ledger", variant !== "off", {
        awaitTerminal: variant !== "initialize-pending",
        retain: true,
      });
      await originalMutations(h);
      if (variant === "initialize-pending") expect(entered).toBe(true); // auth already completed while original resource Promise is unreleased
      if (variant !== "off") expect(h.service.maintenanceSnapshot().allocationCount).toBe(0);
    } finally {
      release?.();
    }
  },
  30000,
);
it("A5/A10 real committed-delete reply loss retains terminal deny, new SID cannot clear it, actual full rotate fact can", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    name = `lost-${randomBytes(5).toString("hex")}`;
  expect((await terminalV2Admin(h.agent, { op: "passwd", username: name, password: password() })).ok).toBe(true);
  const before = readFileSync(`${h.state}/terminal-v2/ledger.json`),
    actualDelete = h.authStore.deleteUser.bind(h.authStore);
  const deletion = vi.spyOn(h.authStore, "deleteUser").mockImplementationOnce(async (username) => {
    await actualDelete(username);
    throw new Error("lost original committed reply");
  });
  const result = await terminalV2Admin(h.agent, { op: "user_delete", username: name });
  expect(result.ok).toBe(false);
  expect(result.code).toBe("E_INTERNAL");
  expect(deletion).toHaveBeenCalledOnce();
  expect(await h.authStore.getUser(name)).toBeUndefined();
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
  const response = await h.loginLan();
  expect(response.status).toBe(200);
  const current = cookie(response);
  expect((await h.lan("list", { scope: h.scope }, current)).body.code).toBe("E_REVOKING");
  await rotate(h);
  const loginAfter = await h.loginLan();
  expect(loginAfter.status).toBe(200);
  expect((await h.lan("list", { scope: h.scope }, cookie(loginAfter))).status).toBe(200);
  expect(readdirSync(h.state).filter((name) => /terminal.*auth|auth.*terminal/i.test(name))).toEqual([]);
}, 30000);
it("A9 throwing real terminal subscriber cannot replace original passwd/rotate commit or poison resource ledger", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    before = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  h.terminal.auth.subscribe(() => {
    throw new Error("terminal subscriber fault only");
  });
  const user = (await h.authStore.getUser(h.username))!;
  const result = await terminalV2Admin(h.agent, { op: "passwd", username: h.username, password: password() });
  expect(result.ok).toBe(true);
  expect((await h.authStore.getUser(h.username))!.epoch).toBeGreaterThan(user.epoch);
  await rotate(h);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
}, 30000);
it("A10 selector saturation remains terminal-only; valid original auth succeeds and only complete original rotate clears wide deny", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true });
  for (let n = 0; n < 2050; n++) h.terminal.auth.invalidate({ sidTag: `bounded-selector-${n}` });
  expect((await h.loop("list", { scope: h.scope })).body.code).toBe("E_REVOKING");
  const newCookie = await login(h.hub.httpPort, h.hub.paths.tokenFile);
  expect(newCookie.length).toBeGreaterThan(0);
  expect(
    (
      await postJson(
        h.hub.httpPort,
        "/api/terminal/v2/list",
        { scope: h.scope },
        { Cookie: newCookie, Origin: `http://127.0.0.1:${h.hub.httpPort}` },
      )
    ).status,
  ).toBe(401);
  await rotate(h);
  const fresh = await login(h.hub.httpPort, h.hub.paths.tokenFile);
  const terminal = await postJson(
    h.hub.httpPort,
    "/api/terminal/v2/list",
    { scope: h.scope },
    { Cookie: fresh, Origin: `http://127.0.0.1:${h.hub.httpPort}` },
  );
  expect(terminal.status).toBe(200);
  expect(JSON.parse(terminal.body).rows).toEqual([]);
}, 30000);

it("A9 real same-SID double logout and a newer pending revoke: older successful finally cannot clear the newer deny", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true });
  const { hashSid } = await import("../../src/web-hub/hub/sid-hash.js");
  const tag = hashSid(h.lanCookie.slice(h.lanCookie.indexOf("=") + 1)),
    user = (await h.authStore.getUser(h.username))!;
  let releaseFirst!: () => void, releaseThird!: () => void;
  const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }),
    third = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
  const actual = h.authStore.deleteSession.bind(h.authStore);
  let calls = 0;
  vi.spyOn(h.authStore, "deleteSession").mockImplementation(async (sid, options) => {
    calls++;
    const n = calls;
    expect(() =>
      h.terminal.auth.check(
        {
          listener: "lan",
          principal: `u${user.id}`,
          userId: user.id,
          sidTag: tag,
          parentExpiresAt: Date.now() + 30000,
        },
        h.terminal.auth.revision,
      ),
    ).toThrow();
    if (n === 1) await first;
    if (n === 3) await third;
    return actual(sid, options);
  });
  const request = () => lanPostJson(h.lanPort, "/api/logout", {}, { ...h.lanHeaders, Cookie: h.lanCookie });
  const a = request();
  try {
    const { observeUntil } = await import("../../scripts/web-hub/terminal-v2-maintenance/http-client.js");
    await observeUntil(
      async () => calls,
      (n) => n === 1,
    );
    const b = await request();
    expect(b.status).toBe(200);
    expect(b.body).toBe('{"ok":true}');
    const c = request();
    await observeUntil(
      async () => calls,
      (n) => n === 3,
    );
    releaseFirst();
    expect((await a).body).toBe('{"ok":true}');
    expect(() =>
      h.terminal.auth.check(
        {
          listener: "lan",
          principal: `u${user.id}`,
          userId: user.id,
          sidTag: tag,
          parentExpiresAt: Date.now() + 30000,
        },
        h.terminal.auth.revision,
      ),
    ).toThrow();
    releaseThird();
    expect((await c).body).toBe('{"ok":true}');
    expect(calls).toBe(3);
    const response = await lanRequest(h.lanPort, {
      method: "GET",
      path: "/api/lan/sessions",
      headers: { ...h.lanHeaders, Cookie: h.lanCookie, "X-PWH": "1" },
    });
    expect(response.status).toBe(401); // original DB truth, NOT memory-fence settlement, decides auth
  } finally {
    releaseFirst();
    releaseThird();
  }
}, 30000);
