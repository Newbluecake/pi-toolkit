import { afterEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";
import { traceActivation } from "../helpers/activation-trace.js";
import { sandbox, resetGlobals, HOST_KEY, BASELINE } from "../integration/helpers/schedule-activate.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
afterEach(() => {
  resetGlobals();
  resetSecureDomainForTests();
});
function record(child: boolean, on: boolean) {
  resetGlobals();
  resetSecureDomainForTests();
  const box = sandbox("memory39-trace-");
  try {
    box.writeSettings({
      ...BASELINE,
      fast: { enabled: false },
      memory: { enabled: true, jev: { enabled: false }, scopes: { session: on, hub: on } },
    });
    if (child) Reflect.set(globalThis, HOST_KEY, { activatedAt: 1 });
    return traceActivation(activate).calls;
  } finally {
    box.cleanup();
    resetGlobals();
    resetSecureDomainForTests();
  }
}
describe("independent scopes-on registration contract (no old fixture refresh)", () => {
  it("root early context/proof precede handled interceptors and prompt hub; scoped tool exactly once", () => {
    const calls = record(false, true);
    expect(calls.slice(0, 4)).toEqual(["on(session_start)", "on(input)", "on(before_agent_start)", "on(agent_start)"]);
    expect(calls.filter((c) => c === "registerTool(scoped_memory)")).toHaveLength(1);
    expect(calls.indexOf("on(input)")).toBeLessThan(calls.indexOf("registerTool(memory)"));
  });
  it("child receives binding, but gains no human input/BAS hooks or main commands", () => {
    const before = record(true, false),
      after = record(true, true);
    for (const hook of ["on(input)", "on(before_agent_start)", "on(agent_start)"])
      expect(after.filter((c) => c === hook)).toHaveLength(before.filter((c) => c === hook).length);
    expect(after.filter((c) => c === "registerTool(scoped_memory)")).toHaveLength(1);
    expect(after).not.toContain("registerCommand(agent)");
    expect(before).not.toContain("registerTool(scoped_memory)");
  });
});
