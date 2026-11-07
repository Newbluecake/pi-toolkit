import { describe, expect, it, vi } from "vitest";
import { createEffectiveHubSlotPort } from "../../../src/web-hub/agent/effective-paths.js";
import { resolveHubSlot } from "../../../src/memory/scopes/hub-slot.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";

describe("P3b same-source effective slot adapter", () => {
  it.each([
    { enabled: false, domain: "plain" as const },
    { enabled: true, domain: "secure" as const },
    { enabled: true, domain: "locked" as const },
  ])("%j is explicitly absent and does not access or parse paths", (gates) => {
    const paths = vi.fn(() => {
      throw new Error("must never resolve");
    });
    expect(createEffectiveHubSlotPort({ ...gates, paths })).toBeUndefined();
    expect(paths).not.toHaveBeenCalled();
  });
  it("uses the exact WebHub resolved paths object, not HOME/memoryRoot/agentDir", () => {
    const paths = resolveHubPaths({ home: "/tmp/own-launch", uid: 42, xdgRuntimeDir: undefined });
    const port = createEffectiveHubSlotPort({
      enabled: true,
      domain: "plain",
      paths: () => ({
        paths,
        launchHome: "/tmp/other-launch",
        env: { HOME: "/tmp/other-env" },
        getuid: () => 42,
      }),
    })!;
    expect(port.resolve()).toEqual({ effectiveStateDir: paths.stateDir, uid: 42, source: "web-hub" });
  });
  it.each([
    { launchHome: "/tmp/explicit", env: { HOME: "/tmp/env" } },
    { env: { HOME: "/tmp/env" } },
    { env: { HOME: "" }, homedir: (): string => "/tmp/fallback" },
    { env: {}, homedir: (): string => "/tmp/fallback" },
  ])("TUI-only default-slot uses the same P3a resolver with %j", (deps) => {
    // No webHub.enabled dependency: P4 may consume this port with daemon entirely off.
    const getuid = () => 71;
    const port = createEffectiveHubSlotPort({ enabled: true, domain: "plain", paths: () => ({ ...deps, getuid }) })!;
    expect(port.resolve()).toEqual(resolveHubSlot({ ...deps, getuid }));
    expect(port.resolve().source).toBe("default-slot");
  });
  it("different effective override slots stay distinct, despite the same home", () => {
    const slot = (stateDir: string) =>
      createEffectiveHubSlotPort({
        enabled: true,
        domain: "plain",
        paths: () => ({
          paths: { stateDir },
          launchHome: "/tmp/same-home",
          getuid: () => 1,
        }),
      })!.resolve();
    expect(slot("/tmp/a").effectiveStateDir).not.toBe(slot("/tmp/b").effectiveStateDir);
  });
});
