import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bounded, until, XsHarness, sanitizeDiagnostic } from "./helpers/fabric-xs-harness.js";

afterEach(() => vi.useRealTimers());

const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

describe("XS harness liveness barriers", () => {
  it("waits for an observed live state, not just a fixed sleep", async () => {
    fakeTime();
    const states = [{ conn: { state: "backoff" } }, { conn: { state: "live" } }];
    const read = vi.fn(async () => states.shift()!);
    const ready = until(read, (s) => s.conn.state === "live", "socket live");
    await vi.advanceTimersByTimeAsync(30);
    expect(await ready).toEqual({ conn: { state: "live" } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timed-out barrier includes elapsed time, last state and peer diagnostics", async () => {
    fakeTime();
    const ready = until(
      async () => ({ conn: { state: "backoff" } }),
      () => false,
      "socket live",
      {
        timeoutMs: 60,
        diagnostic: () => "agent:alpha pid=42 exit=null stderr=waiting for hello_ack",
      },
    );
    const failure = expect(ready).rejects.toThrow(
      /socket live; waited=60ms budget=60ms last=.*backoff.*pid=42.*hello_ack/,
    );
    await vi.advanceTimersByTimeAsync(60);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung read cannot outlive the enclosing barrier", async () => {
    fakeTime();
    const ready = until(
      () => new Promise<never>(() => {}),
      () => false,
      "hung inspect",
      { timeoutMs: 90 },
    );
    const failure = expect(ready).rejects.toThrow(/hung inspect; waited=90ms/);
    await vi.advanceTimersByTimeAsync(90);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout on success and propagates a failed peer without polling", async () => {
    fakeTime();
    expect(await bounded(Promise.resolve(42), "rpc")).toBe(42);
    const read = vi.fn(async () => {
      throw new Error("agent exit 1: diagnostic");
    });
    await expect(until(read, () => false, "live")).rejects.toThrow("agent exit 1: diagnostic");
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("XS real child startup diagnostics", () => {
  const secrets = [
    "fake-bearer-value",
    "fake-cookie-value",
    "fake-token-value",
    "fake-api-key-value",
    "fake-password-value",
    "a".repeat(64),
    "Qz7+".repeat(20),
  ];
  const stderr = `startup stage=before-ready\nAuthorization: Bearer ${secrets[0]}\nCookie: session=${secrets[1]}\nSet-Cookie: session=${secrets[1]}; HttpOnly\ntoken=${secrets[2]} api_key=${secrets[3]} secret=${secrets[2]} password=${secrets[4]}\nopaque ${secrets[5]} ${secrets[6]}\n`;
  function check(message: string): void {
    for (const secret of secrets) expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("startup stage=before-ready");
    expect(message).toMatch(/agent:early pid=\d+ exit=.*signal=.*connected=/);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(12_000);
  }
  it.each(["close", "timeout"])("real boot %s rejects with safe, useful diagnostics", async (mode) => {
    const h = new XsHarness({ bootMs: 1500 });
    const file = join(h.home, "early.mjs");
    writeFileSync(
      file,
      `process.stderr.write(process.env.XW_DIAGNOSTIC, () => { ${mode === "close" ? "process.exit(23)" : "setInterval(() => {}, 1000)"}; });`,
    );
    const childHarness = new XsHarness({ processFile: file, bootMs: 1500 });
    try {
      const failure = await childHarness.boot("agent", "early", undefined, true, false, { XW_DIAGNOSTIC: stderr }).then(
        () => {
          throw new Error("unexpected boot success");
        },
        (e: Error) => e,
      );
      check(failure.message);
      expect(failure.message).toContain(mode === "close" ? "child close code=23" : "timeout: agent ready");
      // A close must win the startup race, not be misreported as the timeout.
      if (mode === "close") expect(failure.message).not.toContain("timeout:");
    } finally {
      await childHarness.close();
      await h.close();
    }
  });
  it("redacts secret-named identifiers but preserves ordinary prose", () => {
    expect(sanitizeDiagnostic("token bucket refill; cookie expires; bearer arrived")).toBe(
      "token bucket refill; cookie expires; bearer arrived",
    );
    expect(sanitizeDiagnostic("FAKE_TOKEN_DO_NOT_LEAK_47c x-secret longcredential shortTOKEN1")).toBe(
      "[REDACTED] [REDACTED] [REDACTED] shortTOKEN1",
    );
  });
  it("redacts an invalid channels value echoed by the real child parser", async () => {
    const h = new XsHarness();
    try {
      const failure = await h
        .boot("agent", "parse", undefined, true, false, {
          XW_CHANNELS_JSON: "FAKE_TOKEN_DO_NOT_LEAK_47c",
        })
        .then(
          () => {
            throw new Error("unexpected boot success");
          },
          (e: Error) => e,
        );
      expect(failure.message).not.toContain("FAKE_TOKEN_DO_NOT_LEAK_47c");
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).toMatch(/agent:parse pid=\d+ exit=\d+ signal=.*connected=/);
      expect(failure.message).toContain("child close code=");
    } finally {
      await h.close();
    }
  });
  it("real spawn error rejects before ready with lifecycle fields", async () => {
    const h = new XsHarness({ execPath: "/nonexistent/pi-xs-test-node" });
    try {
      await expect(h.boot("agent", "missing")).rejects.toThrow(
        /child error:.*ENOENT.*agent:missing pid=undefined exit=.*signal=.*connected=/,
      );
    } finally {
      await h.close();
    }
  });
  it("caps sanitized UTF-8 diagnostics to 12,000 bytes", () => {
    const message = sanitizeDiagnostic(
      "agent:early pid=42 exit=23 signal=null connected=false\n" + "ordinary diagnostic界\n".repeat(2000) + stderr,
    );
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(12_000);
    expect(message).toContain("agent:early pid=42 exit=23 signal=null connected=false");
    expect(message).toContain("[truncated]");
    for (const secret of secrets) expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
  });
});
