/** Real original auth mutation choreography, shared only by integration tests. */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import { terminalV2AuthFixture, terminalV2Admin } from "./terminal-v2-auth-fixture.js";
import { lanPostJson, lanRequest } from "../../web-hub/http/lan-helpers.js";
import { postJson, login } from "../../web-hub/http/helpers.js";
export const authPassword = () => `Private-${randomBytes(20).toString("base64url")}!9`;
export const authCookie = (response: { headers: Record<string, unknown> }) =>
  (response.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
export async function rotateAuth(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>) {
  const before = createHash("sha256").update(readFileSync(h.hub.paths.tokenFile)).digest("hex"),
    rid = randomBytes(16).toString("hex");
  h.agent.send({ t: "hub_ctl", rid, op: "rotate_token" });
  const ack = await h.agent.waitFrame((frame) => frame.t === "hub_ctl_ack" && frame.rid === rid, 15000);
  expect((ack.revoked as { loopback: number; lan: number })?.loopback).toBeGreaterThanOrEqual(0);
  expect((ack.revoked as { loopback: number; lan: number })?.lan).toBeGreaterThanOrEqual(0);
  const after = createHash("sha256").update(readFileSync(h.hub.paths.tokenFile)).digest("hex");
  expect(after).not.toBe(before);
  expect(await login(h.hub.httpPort, h.hub.paths.tokenFile)).toEqual(expect.any(String));
}
export async function exerciseOriginalAuthMutations(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>) {
  const second = await h.loginLan();
  expect(second.status).toBe(200);
  const sid2 = authCookie(second);
  const listed = await lanRequest(h.lanPort, {
    method: "GET",
    path: "/api/lan/sessions",
    headers: { ...h.lanHeaders, Cookie: sid2, "X-PWH": "1" },
  });
  expect(listed.status).toBe(200);
  const other = JSON.parse(listed.body).sessions.find((session: any) => !session.current);
  expect(other).toBeDefined();
  const kicked = await lanPostJson(
    h.lanPort,
    "/api/lan/sessions/revoke",
    { id: other.id },
    { ...h.lanHeaders, Cookie: sid2 },
  );
  expect(kicked.status).toBe(200);
  expect(JSON.parse(kicked.body)).toMatchObject({ ok: true, revoked: 1, complete: true });
  const name = `temporary-${randomBytes(5).toString("hex")}`;
  expect((await terminalV2Admin(h.agent, { op: "passwd", username: name, password: authPassword() })).ok).toBe(true);
  const secondary = await h.authStore.getUser(name);
  expect(secondary).toBeDefined();
  expect((await terminalV2Admin(h.agent, { op: "user_delete", username: name })).ok).toBe(true);
  expect(await h.authStore.getUser(name)).toBeUndefined();
  const before = (await h.authStore.getUser(h.username))!;
  expect((await terminalV2Admin(h.agent, { op: "passwd", username: h.username, password: authPassword() })).ok).toBe(
    true,
  );
  expect((await h.authStore.getUser(h.username))!.epoch).toBeGreaterThan(before.epoch);
  const deleted = vi.spyOn(h.authStore, "deleteSession");
  expect((await lanPostJson(h.lanPort, "/api/logout", {}, { ...h.lanHeaders, Cookie: sid2 })).body).toBe('{"ok":true}');
  expect(deleted).toHaveBeenCalledTimes(1);
  expect(
    (
      await postJson(
        h.hub.httpPort,
        "/api/logout",
        {},
        { Cookie: h.loopCookie, Origin: `http://127.0.0.1:${h.hub.httpPort}` },
      )
    ).body,
  ).toBe('{"ok":true}');
  await rotateAuth(h);
}
