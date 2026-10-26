// data-encryption P2 §6: the secure-off golden. No `secure` section / `secure.enabled=false` / an empty
// section ⇒ a real activate() behaves exactly as before P2 (same ExtensionAPI call trace across the
// scenarios, no /secure command, no guard handlers, no env change, settings and hub env untouched).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { getSecureDomain, resetSecureDomainForTests } from "../../src/secure/domain.js";
import { hubSafeEnv } from "../../src/secure/env.js";
import { secureGuardsNeeded } from "../../src/secure/guards.js";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";
import { traceActivation, type ActivationTrace } from "../helpers/activation-trace.js";

interface Golden {
  scenarios: Record<string, unknown>;
  expect: {
    domainKind: string;
    guardsNeeded: boolean;
    secureCommandRegistered: boolean;
    envDelta: Record<string, string | null>;
    tracesIdenticalAcrossScenarios: boolean;
    loadSettingsIdentity: boolean;
    defaultSettingsUnchanged: boolean;
    hubSafeEnvIdentity: boolean;
  };
}
const golden = JSON.parse(
  readFileSync(new URL("../fixtures/secure-off-golden.json", import.meta.url), "utf8"),
) as Golden;

function releaseGlobals(): void {
  for (const k of ["pi-subagent:host", "pi-subagent:feishu-notify:host"])
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(k)];
  resetSecureDomainForTests();
}
afterEach(releaseGlobals);

describe("secure-off golden", () => {
  it("every off scenario: plain verdict, identical activation trace, no /secure, no env delta", () => {
    const defaultsBefore = JSON.stringify(DEFAULT_SETTINGS);
    const traces: ActivationTrace[] = [];
    for (const [name, settings] of Object.entries(golden.scenarios)) {
      const home = sandboxHome();
      releaseGlobals();
      try {
        mkdirSync(join(home.home, ".pi", "agent"), { recursive: true });
        if (settings !== null)
          writeFileSync(join(home.home, ".pi", "agent", "pi-subagent.json"), JSON.stringify(settings));
        const trace = traceActivation(activate);
        traces.push(trace);
        const domain = getSecureDomain();
        expect(domain?.kind, name).toBe(golden.expect.domainKind);
        expect(secureGuardsNeeded(domain), name).toBe(golden.expect.guardsNeeded);
        expect(trace.calls.includes("registerCommand(secure)"), name).toBe(golden.expect.secureCommandRegistered);
        expect(trace.envDelta, name).toEqual(golden.expect.envDelta);
        const user = { bashJobs: { dir: "/u/b" }, feishuNotify: { enabled: true } };
        const s = loadSettings(user);
        expect(s.bashJobs.dir === "/u/b" && s.feishuNotify.enabled, name).toBe(golden.expect.loadSettingsIdentity);
      } finally {
        releaseGlobals();
        home.restore();
      }
    }
    expect(traces.length).toBe(3);
    expect(traces.every((t) => JSON.stringify(t.calls) === JSON.stringify(traces[0]!.calls))).toBe(
      golden.expect.tracesIdenticalAcrossScenarios,
    );
    expect(JSON.stringify(DEFAULT_SETTINGS) === defaultsBefore).toBe(golden.expect.defaultSettingsUnchanged);
  });

  it("hubSafeEnv is the identity on a plain env", () => {
    const env = { PATH: "/usr/bin", TMPDIR: "/tmp", ARMORY_MEMORY_ROOT: "/m" };
    expect(hubSafeEnv(env) === env).toBe(golden.expect.hubSafeEnvIdentity);
  });
});

describe("secure activation wiring (real activate)", () => {
  it("guards are the FIRST handlers registered; /secure is registered; child-only events absent in a child", async () => {
    const { makeFakeVault, freezeDomain } = await import("./helpers.js");
    const v = makeFakeVault();
    const home = sandboxHome();
    releaseGlobals();
    try {
      freezeDomain(v); // frozen before activate ⇒ initSecureDomain() returns it
      const trace = traceActivation(activate);
      const firstOn = trace.calls.filter((c) => c.startsWith("on(")).slice(0, 5);
      expect(firstOn).toEqual([
        "on(tool_call)",
        "on(input)",
        "on(user_bash)",
        "on(session_before_switch)",
        "on(session_start)",
      ]);
      expect(trace.calls).toContain("registerCommand(secure)");
      // a second activation in the same process is a child session (HOST_KEY claimed): guards without session_start
      const child = traceActivation(activate);
      expect(child.calls.filter((c) => c.startsWith("on(")).slice(0, 4)).toEqual([
        "on(tool_call)",
        "on(input)",
        "on(user_bash)",
        "on(session_before_switch)",
      ]);
      expect(child.calls).not.toContain("registerCommand(secure)");
    } finally {
      releaseGlobals();
      home.restore();
      v.cleanup();
    }
  });

  it("security review #2: a corrupt settings file registers /secure + guards and warns once (real activate)", async () => {
    const { vi } = await import("vitest");
    const home = sandboxHome();
    releaseGlobals();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mkdirSync(join(home.home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home.home, ".pi", "agent", "pi-subagent.json"), "{corrupt");
      const trace = traceActivation(activate);
      expect(trace.calls).toContain("registerCommand(secure)");
      expect(trace.calls.filter((c) => c.startsWith("on(")).slice(0, 2)).toEqual(["on(tool_call)", "on(input)"]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("secure 配置无效")).length).toBe(1);
      expect(trace.envDelta).toEqual({});
    } finally {
      warn.mockRestore();
      releaseGlobals();
      home.restore();
    }
  });
});
