// settings-rename P1 (T-ID2): the secure-off golden scenarios, re-run with PI_CODING_AGENT_DIR set to ""
// and to the default dir spelled out. The frozen fixture is only READ; every scenario must still produce the
// same verdict, activation trace and env delta as with the variable unset ("same as default" ⇒ unset).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";
import { getSecureDomain, resetSecureDomainForTests } from "../../src/secure/domain.js";
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

const SPELLINGS: Array<[string, (home: string) => string]> = [
  ['""', () => ""],
  ["default dir", (home) => join(home, ".pi", "agent")],
  ["default dir, trailing slash", (home) => `${join(home, ".pi", "agent")}/`],
  ["tilde spelling", () => "~/.pi/agent"],
];

describe("T-ID2 secure-off golden under a default-equivalent PI_CODING_AGENT_DIR", () => {
  for (const [label, valueOf] of SPELLINGS) {
    for (const legacyName of [true, false]) {
      it(`PI_CODING_AGENT_DIR=${label}, settings file ${legacyName ? "pi-subagent.json" : "pi-toolkit.json"}`, () => {
        const traces: ActivationTrace[] = [];
        for (const [name, settings] of Object.entries(golden.scenarios)) {
          const sb = sandboxHome();
          releaseGlobals();
          try {
            process.env.PI_CODING_AGENT_DIR = valueOf(sb.home);
            mkdirSync(join(sb.home, ".pi", "agent"), { recursive: true });
            if (settings !== null)
              writeFileSync(
                join(sb.home, ".pi", "agent", legacyName ? "pi-subagent.json" : "pi-toolkit.json"),
                JSON.stringify(settings),
              );
            const trace = traceActivation(activate);
            traces.push(trace);
            const domain = getSecureDomain();
            expect(domain?.kind, name).toBe(golden.expect.domainKind);
            expect(secureGuardsNeeded(domain), name).toBe(golden.expect.guardsNeeded);
            expect(trace.calls.includes("registerCommand(secure)"), name).toBe(golden.expect.secureCommandRegistered);
            expect(trace.envDelta, name).toEqual(golden.expect.envDelta);
          } finally {
            releaseGlobals();
            sb.restore();
          }
        }
        expect(traces.length).toBe(3);
        expect(traces.every((t) => JSON.stringify(t.calls) === JSON.stringify(traces[0]!.calls))).toBe(
          golden.expect.tracesIdenticalAcrossScenarios,
        );
      });
    }
  }
});
