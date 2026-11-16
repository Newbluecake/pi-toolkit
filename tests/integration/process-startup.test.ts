import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessStartup } from "./helpers/process-startup.js";

const children: ChildProcess[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }),
  );
});
function child(boot: ProcessStartup, script: string, name = "fixture"): ChildProcess {
  const c = boot.observe(spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] }), name);
  children.push(c);
  return c;
}
async function failure(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => {
      throw new Error("unexpected readiness");
    },
    (e: Error) => e.message,
  );
}

const secrets = ["fake-bearer-value", "fake-cookie-value", "fake-api-value", "fake-password-value", "a".repeat(64)];
const stderr = `stage=before-ready\nAuthorization: Bearer ${secrets[0]}\nCookie: session=${secrets[1]}\napi_key=${secrets[2]} password=${secrets[3]}\n${secrets[4]}\n`;
function safe(message: string) {
  for (const secret of secrets) expect(message).not.toContain(secret);
  expect(message).toContain("[REDACTED]");
  expect(message).toContain("stage=before-ready");
}

describe("shared real-process startup barrier", () => {
  it("all real contenders exiting fails early, with each lifecycle and safe stderr", async () => {
    const boot = new ProcessStartup(1500);
    const a = child(boot, `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(23))`, "alpha");
    const b = child(boot, `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(24))`, "beta");
    const message = await failure(
      boot.wait(
        () => false,
        (ready) => ready,
        "hub.json",
      ),
    );
    // Reason assertion, NOT a tight wallclock threshold: disabling early exit must fail.
    expect(message).toContain("all children exited before ready");
    expect(message).not.toContain("startup timeout");
    expect(message).toContain(`alpha pid=${a.pid} exit=23 signal=null`);
    expect(message).toContain(`beta pid=${b.pid} exit=24 signal=null`);
    safe(message);
  });

  it("a singleton loser exiting does not fail a surviving winner's readiness", async () => {
    const boot = new ProcessStartup();
    const loser = child(boot, "process.exit(0)", "loser");
    const winner = child(boot, "process.on('message', () => { process.send({ ready: true }); });", "winner");
    let ready = false;
    winner.on("message", () => {
      ready = true;
    });
    await once(loser, "close");
    winner.send("go");
    expect(
      await boot.wait(
        () => ready,
        (value) => value,
        "winner ready",
      ),
    ).toBe(true);
    expect(loser.exitCode).toBe(0);
    expect(winner.exitCode).toBeNull();
  });

  it("signal exit interrupts a hung readiness read", async () => {
    const boot = new ProcessStartup(1500);
    const c = child(boot, "process.send('running'); setInterval(() => {}, 1000)");
    await once(c, "message");
    const pending = failure(
      boot.wait(
        () => new Promise<never>(() => {}),
        () => false,
        "IPC ready",
      ),
    );
    c.kill("SIGTERM");
    const message = await pending;
    expect(message).toContain("all children exited before ready");
    expect(message).toContain(`pid=${c.pid} exit=null signal=SIGTERM`);
    expect(message).not.toContain("startup timeout");
  });

  it("timeout keeps capped, sanitized real-child diagnostics", async () => {
    const boot = new ProcessStartup(1500);
    const c = child(
      boot,
      `process.stderr.write(${JSON.stringify("ordinary 界\n".repeat(4000) + stderr)}, () => process.send('written')); setInterval(() => {}, 1000)`,
    );
    await once(c, "message");
    const message = await failure(
      boot.wait(
        () => false,
        (ready) => ready,
        "ready",
      ),
    );
    expect(message).toContain("startup timeout");
    expect(message).toContain(`pid=${c.pid} exit=null signal=null`);
    safe(message);
    expect(message).toContain("[truncated]");
    expect(Buffer.byteLength(boot.diagnostic())).toBeLessThanOrEqual(12_000);
  });

  it("ready and live consume the SAME budget; all timers are cleared", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const boot = new ProcessStartup(100);
    expect(
      await boot.wait(
        () => true,
        (ready) => ready,
        "ready",
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(75);
    const pending = failure(
      boot.wait(
        () => "connecting",
        (s) => s === "live",
        "live",
      ),
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toContain('waited=100ms budget=100ms last="connecting"');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      boot.wait(
        () => true,
        (ready) => ready,
        "too late",
      ),
    ).rejects.toThrow("startup timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("managed grandchildren fail on persisted terminal lifecycle with redacted stderr", async () => {
    const boot = new ProcessStartup(1500);
    const c = child(boot, `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(27))`);
    await once(c, "close");
    const managed = new ProcessStartup(1500);
    managed.observeManaged(
      () => ({ pid: c.pid!, state: "failed", exit: { code: c.exitCode, signal: c.signalCode } }),
      () => stderr,
      "managed",
    );
    const message = await failure(
      managed.wait(
        () => false,
        (ready) => ready,
        "session live",
      ),
    );
    expect(message).toContain("all children exited before ready");
    expect(message).toContain(`managed pid=${c.pid} exit=27`);
    safe(message);
  });
});
