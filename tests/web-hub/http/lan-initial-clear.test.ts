/**
 * #66 D4 / P5 (http face): the first login with the generated password wipes the plaintext, but the
 * account is still "using the initial password" until a change — `GET /api/session` and the login
 * response keep saying so; store-raised warnings (`initial-password-residue`) reach `LanStatus`.
 */
import { describe, expect, it, vi } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers["set-cookie"] as string[] | undefined;
  return (sc?.[0] ?? "").split(";")[0]!;
}

describe("LAN initial-password wipe (#66 D4)", () => {
  it("login wipes the plaintext once; login response and /api/session keep reporting in-use", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "initial-pass-abc", initial: true });
      const mark = vi.spyOn(h.store, "markInitialLogin");

      const first = await lanPostJson(h.port, "/api/login", { username: "alice", password: "initial-pass-abc" });
      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ ok: true, initialPassword: true });
      expect(mark).toHaveBeenCalledTimes(1);
      expect((await h.store.getUser("alice"))?.initialPassword).toBeUndefined();

      const session = await lanRequest(h.port, { path: "/api/session", headers: { Cookie: cookieOf(first) } });
      expect(JSON.parse(session.body)).toEqual({ username: "alice", initialPasswordInUse: true });

      const second = await lanPostJson(h.port, "/api/login", { username: "alice", password: "initial-pass-abc" });
      expect(JSON.parse(second.body)).toEqual({ ok: true, initialPassword: true });
      expect(mark).toHaveBeenCalledTimes(1); // plaintext already gone ⇒ no second wipe
    } finally {
      await h.cleanup();
    }
  });

  it("a store whose markInitialLogin rejects still logs the user in (best effort)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "initial-pass-abc", initial: true });
      vi.spyOn(h.store, "markInitialLogin").mockRejectedValue(new Error("E_DB"));
      const res = await lanPostJson(h.port, "/api/login", { username: "alice", password: "initial-pass-abc" });
      expect(res.status).toBe(200);
      expect(cookieOf(res)).toMatch(/^pwh_lan=/);
    } finally {
      await h.cleanup();
    }
  });

  it("store.warnings() joins LanStatus.warnings and a notification republishes the status", async () => {
    const warnings = new Set<string>();
    const listeners = new Set<() => void>();
    const { fakeLanStore } = await import("../contract/fakes.js");
    const store = fakeLanStore();
    Object.assign(store, {
      warnings: () => [...warnings],
      onWarningsChanged: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    });
    const h = await startLan({ store });
    try {
      const before = h.fe.lan!.status();
      expect(before.state === "on" && before.warnings).not.toContain("initial-password-residue");

      warnings.add("initial-password-residue");
      for (const cb of listeners) cb();
      const during = h.fe.lan!.status();
      expect(during.state === "on" && during.warnings).toContain("initial-password-residue");

      warnings.clear();
      for (const cb of listeners) cb();
      const after = h.fe.lan!.status();
      expect(after.state === "on" && after.warnings).not.toContain("initial-password-residue");
      expect(after.state === "on" && after.warnings).toContain("plaintext");
    } finally {
      await h.cleanup();
    }
    expect(listeners.size).toBe(0); // unsubscribed on close
  });
});
