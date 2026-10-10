/**
 * D-B-guard tests. This is test-infra hardening unrelated to Bug B's root cause: it catches
 * accidental real-hub access, while singleton diagnostics are the Bug B change.
 */
import { afterEach, describe, expect, it } from "vitest";
import childProcess, { spawnSync } from "node:child_process";
import net, { connect } from "node:net";
import { REAL_HOME, clearSandboxHomeViolations, sandboxHomeViolations, withRealHomeAllowed } from "./sandbox-home.js";

const realSocket = `${REAL_HOME}/.pi/agent/web-hub/hub.sock`;

// This suite intentionally consumes the recorded violation after asserting it. The global
// afterEach hook fails ordinary tests that forget to do so; consuming here lets us test the
// call-site throw and stack without making this test itself fail in its cleanup hook.
afterEach(() => clearSandboxHomeViolations());

describe("sandbox-home guard", () => {
  it("rejects ESM named net.connect bindings at the call site and records a stack", () => {
    expect(() => connect(realSocket)).toThrow(/sandbox-home guard/);
    const [record] = sandboxHomeViolations();
    expect(record?.operation).toBe("net.connect");
    expect(record?.stack).toContain("sandbox-home guard");
  });

  it("also wraps namespace imports for net and child_process", () => {
    expect(() => net.connect(realSocket)).toThrow(/sandbox-home guard/);
    expect(() =>
      childProcess.spawnSync(process.execPath, ["-e", ""], {
        env: { ...process.env, PI_WEBHUB_CONFIG: JSON.stringify({ home: REAL_HOME }) },
      }),
    ).toThrow(/sandbox-home guard/);
    expect(sandboxHomeViolations().map((entry) => entry.operation)).toEqual(["net.connect", "child_process.spawnSync"]);
  });

  it("rejects a hub spawn whose explicit config home is the real HOME", () => {
    expect(() =>
      spawnSync(process.execPath, ["-e", ""], {
        env: { ...process.env, PI_WEBHUB_CONFIG: JSON.stringify({ home: REAL_HOME }) },
      }),
    ).toThrow(/sandbox-home guard/);
    expect(sandboxHomeViolations()[0]?.operation).toBe("child_process.spawnSync");
  });

  it("allows an intentional real-home operation only inside the escape hatch", async () => {
    await withRealHomeAllowed(() => {
      const child = spawnSync(process.execPath, ["-e", ""], {
        env: { ...process.env, PI_WEBHUB_CONFIG: JSON.stringify({ home: REAL_HOME }) },
      });
      expect(child.status).toBe(0);
    });
    expect(sandboxHomeViolations()).toHaveLength(0);
  });
});
