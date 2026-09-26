/**
 * §5.1 "读取校验" / §9.2 LanStatus (LC review fix, lan-plan.md task LC #2): a corrupt KDF params
 * row (caught by `validateKdfParams`) must, beyond the existing `onCorruptKdfParams` log line,
 * also surface as `db-invalid:kdf` in `LanStatus.warnings` so `/webhub status` shows it without
 * grepping `hub.log`.
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN status db-invalid:kdf warning (plan §5.1/§9.2; LC review fix, lan-plan.md §15.9 #2)", () => {
  it("a login attempt against a user with corrupt KDF params (n not a power of 2) adds db-invalid:kdf to LanStatus.warnings", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, {
        username: "alice",
        password: "correct-horse-battery",
        kdfOverride: { n: 12_345 }, // not a power of 2 ⇒ validateKdfParams rejects
      });

      const before = h.fe.lan!.status();
      expect(before.state).toBe("on");
      if (before.state === "on") expect(before.warnings).not.toContain("db-invalid:kdf");

      const res = await lanPostJson(h.port, "/api/login", {
        username: "alice",
        password: "correct-horse-battery",
      });
      expect(res.status).toBe(401);

      const after = h.fe.lan!.status();
      expect(after.state).toBe("on");
      if (after.state === "on") expect(after.warnings).toContain("db-invalid:kdf");
    } finally {
      await h.cleanup();
    }
  });

  it("a healthy user's login never adds db-invalid:kdf", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "bob", password: "another-battery-1" });
      const res = await lanPostJson(h.port, "/api/login", { username: "bob", password: "another-battery-1" });
      expect(res.status).toBe(200);
      const status = h.fe.lan!.status();
      expect(status.state).toBe("on");
      if (status.state === "on") expect(status.warnings).not.toContain("db-invalid:kdf");
    } finally {
      await h.cleanup();
    }
  });

  it("the warning is sticky: it stays set across a later successful login by a different (healthy) user", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, {
        username: "alice",
        password: "correct-horse-battery",
        kdfOverride: { n: 12_345 },
      });
      seedLanUser(h.store, { username: "bob", password: "another-battery-1", id: 2 });

      await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      let status = h.fe.lan!.status();
      expect(status.state).toBe("on");
      if (status.state === "on") expect(status.warnings).toContain("db-invalid:kdf");

      const bobLogin = await lanPostJson(h.port, "/api/login", { username: "bob", password: "another-battery-1" });
      expect(bobLogin.status).toBe(200);
      status = h.fe.lan!.status();
      expect(status.state).toBe("on");
      if (status.state === "on") expect(status.warnings).toContain("db-invalid:kdf");
    } finally {
      await h.cleanup();
    }
  });
});
