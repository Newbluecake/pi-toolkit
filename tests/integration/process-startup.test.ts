import { readFileSync } from "node:fs";
import ts from "typescript";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessStartup, startupBudget, STARTUP_MARGIN_MS, PROCESS_STARTUP_MS } from "./helpers/process-startup.js";

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

  it(
    "a singleton loser exiting does not fail a surviving winner's readiness",
    async () => {
      vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const boot = new ProcessStartup();
      const loser = child(boot, "process.exit(0)", "loser");
      const winner = child(boot, "process.on('message', () => { process.send({ ready: true }); });", "winner");
      let ready = false;
      winner.on("message", () => {
        ready = true;
      });
      await once(loser, "close");
      const pending = boot
        .wait(
          () => ready,
          (value) => value,
          "winner ready",
        )
        .then(
          (value) => ({ value }),
          (error: Error) => ({ error: error.message }),
        );
      // Force an exit check while winner readiness is withheld. This deterministically
      // kills every→some, without relying on which real process gets the next timeslice.
      await vi.advanceTimersByTimeAsync(25);
      const acknowledged = once(winner, "message");
      winner.send("go");
      await acknowledged;
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toEqual({ value: true });
      expect(loser.exitCode).toBe(0);
      expect(winner.exitCode).toBeNull();
    },
    startupBudget(1) + STARTUP_MARGIN_MS,
  );

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

// Independent cold-start inventory: serial boots add; hub + concurrent agents count as
// two paths, not three. A launcher parent contains its grandchild within the same boot.
// Legacy headless hub startup is 15s * SLOW(3); it is not silently reduced to 30s.
// T51 removed the four v1 terminal suites and their 26 nonexistent registrations.
// Keep all 31 surviving paths/budgets unchanged; v2 in-process SDK/CLI fixtures
// do not use this ProcessStartup inventory and are not invented v1 boot aliases.
const startupCases: Array<
  [file: string, titlePrefix: string, boots: number, margin: number, legacy45s: number, otherColdMs: number]
> = [
  ["process-startup.test.ts", "a singleton loser", 1, 30000, 0, 0],
  ["web-hub-headless.test.ts", "web-hub-delete-session", 1, 65000, 2, 0],
  ["web-hub-headless.test.ts", "closure:", 1, 60000, 0, 0],
  ["web-hub-headless.test.ts", "browser-off delivery:", 1, 30000, 0, 0],
  ["web-hub-headless.test.ts", "§7.3-1 (A4)", 1, 30000, 0, 0],
  ["web-hub-headless.test.ts", "H5: 1 MiB", 4, 150000, 0, 0],
  ["web-hub-headless.test.ts", "H9a:", 3, 30000, 0, 0],
  ["web-hub-headless.test.ts", "HR3: legacy", 1, 52000, 0, 0],
  ["web-hub-history.test.ts", "HH2:", 1, 30000, 0, 0],
  ["web-hub-history.test.ts", "HH3:", 1, 60000, 0, 0],
  ["web-hub-history.test.ts", "HH4:", 1, 30000, 0, 0],
  ["web-hub-history.test.ts", "HH9:", 2, 30000, 0, 0],
  ["web-hub-spawn.test.ts", "3 concurrent", 1, 15000, 0, 0],
  ["web-hub-spawn.test.ts", "kill -9", 2, 30000, 0, 0],
  ["bash-orphan-on-timeout.test.ts", "leader +", 1, 15000, 0, 0],
  ["fabric-thread-rebind-e2e.test.ts", "A18 main", 2, 60000, 0, 0],
  ["fabric-thread-rebind-e2e.test.ts", "A18 degrade", 2, 60000, 0, 0],
  ["fabric-thread-rebind-e2e.test.ts", "A13 full", 2, 60000, 0, 0],
  ["fabric-thread-rebind-e2e.test.ts", "A10 full", 2, 60000, 0, 0],
  ["web-hub-headless.test.ts", "HH7:", 0, 65000, 2, 0],
  ["web-hub-headless.test.ts", "H1:", 0, 49000, 1, 0],
  ["web-hub-headless.test.ts", "H2:", 0, 78000, 1, 0],
  ["web-hub-headless.test.ts", "H10:", 0, 38000, 1, 0],
  ["web-hub-headless.test.ts", "H6 (flood/RSS", 0, 115000, 1, 0],
  ["web-hub-headless.test.ts", "H3:", 0, 129000, 3, 0],
  ["web-hub-headless.test.ts", "H9c:", 0, 43000, 3, 0],
  ["web-hub-headless.test.ts", "H9d:", 0, 35000, 2, 0],
  ["web-hub-headless.test.ts", "HR2:", 0, 30000, 3, 75000],
  ["web-hub-headless.test.ts", "HR5b:", 0, 65000, 3, 0],
  ["web-hub-headless.test.ts", "HR6:", 0, 31000, 7, 225000],
  ["web-hub-headless.test.ts", "HR7:", 0, 125000, 5, 180000],
];

function registeredTimeout(file: string, prefix: string): ts.Expression {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const matches: ts.Expression[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const title = node.arguments[0];
      if ((callee === "it" || callee.startsWith("it.each")) && title?.getText(source).slice(1, -1).startsWith(prefix)) {
        const options = node.arguments.find(ts.isObjectLiteralExpression);
        const property = options?.properties.find((p) => p.name?.getText(source) === "timeout");
        const timeout = property && ts.isPropertyAssignment(property) ? property.initializer : node.arguments[2];
        if (!timeout) throw new Error(file + ": " + prefix + " uses Vitest default timeout");
        matches.push(timeout);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  expect(matches, file + ": " + prefix + " registration").toHaveLength(1);
  return matches[0]!;
}

// Evaluate only the permitted arithmetic, never eval test source. perBootMs is an
// injected scaled startup budget: 35_000 models a 35s startup without a real sleep.
function timeoutValue(node: ts.Expression, perBootMs = PROCESS_STARTUP_MS): number {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) {
    if (node.text === "STARTUP_MARGIN_MS") return STARTUP_MARGIN_MS;
    if (node.text === "SLOW") return 3;
  }
  if (ts.isCallExpression(node) && node.expression.getText() === "startupBudget") {
    return startupBudget(
      timeoutValue(node.arguments[0]!, perBootMs),
      node.arguments[1] ? timeoutValue(node.arguments[1], perBootMs) : perBootMs,
    );
  }
  if (ts.isBinaryExpression(node)) {
    const a = timeoutValue(node.left, perBootMs),
      b = timeoutValue(node.right, perBootMs);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
  }
  throw new Error("unsupported startup timeout expression: " + node.getText());
}

describe("startup wrapper budget regression gate (no wallclock sleeps)", () => {
  it.each(startupCases)(
    "%s / %s leaves the whole startup critical path plus finite protocol/setup margin",
    (file, prefix, boots, margin, legacyHubs, otherColdMs) => {
      const expression = registeredTimeout(file, prefix);
      const required = startupBudget(boots) + startupBudget(legacyHubs, 45_000) + otherColdMs + margin;
      expect(timeoutValue(expression), file + ": " + prefix).toBeGreaterThanOrEqual(required);
      expect(expression.getText()).toContain("startupBudget(");
      expect(timeoutValue(expression)).toBeLessThanOrEqual(900_000);
    },
  );

  it("H9a retains three serial 35s simulated boots plus setup/protocol margin", () => {
    const expression = registeredTimeout("web-hub-headless.test.ts", "H9a:");
    expect(timeoutValue(expression, 35_000)).toBeGreaterThanOrEqual(startupBudget(3, 35_000) + STARTUP_MARGIN_MS);
  });
});
