import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubAssembly } from "../../../src/web-hub/hub/assembly.js";
import { startRuntimeMonitors } from "../../../src/web-hub/hub/assembly-runtime.js";
import { startFence } from "../../../src/web-hub/hub/singleton.js";

vi.mock("../../../src/web-hub/hub/singleton.js", () => ({ startFence: vi.fn(() => vi.fn()) }));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("runtime fence logging", () => {
  it.each([
    ["socket-replaced", "socket fence lost: another hub owns the socket path"],
    ["io", "socket fence verification failed"],
    ["socket-missing", "socket fence verification failed"],
  ] as const)("logs %s accurately and closes the hub", (why, message) => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const close = vi.fn();
    const ctx = {
      config: { idleExitMinutes: 1 },
      paths: { socketPath: "/private/socket" },
      log: { warn },
      now: Date.now,
      registry: {},
      hubJson: {},
      close,
      registryTickMs: 5000,
      rotateScanMs: 5000,
    } as unknown as HubAssembly;
    startRuntimeMonitors(ctx, {} as never);
    const args = vi.mocked(startFence).mock.calls[0]!;
    args[2](why);
    expect(warn).toHaveBeenCalledWith(message, { why });
    expect(close).toHaveBeenCalledWith("fence");
  });

  it("logs bounded strike diagnostics without leaking an unsafe error class", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const ctx = {
      config: { idleExitMinutes: 1 },
      paths: { socketPath: "/private/socket" },
      log: { warn },
      now: Date.now,
      registry: {},
      hubJson: {},
      registryTickMs: 5000,
      rotateScanMs: 5000,
    } as unknown as HubAssembly;
    startRuntimeMonitors(ctx, {} as never);
    const diagnostic = vi.mocked(startFence).mock.calls[0]![5]!.onDiagnostic!;
    diagnostic({ errorClass: "EACCES", durationMs: 12, inFlight: 1, strike: 3, threshold: 3 });
    expect(warn).toHaveBeenCalledWith("socket fence check strike", {
      errorClass: "EACCES",
      durationMs: 12,
      inFlight: 1,
      strike: 3,
      threshold: 3,
    });
    diagnostic({ errorClass: "/private/secret", durationMs: 1, inFlight: 1, strike: 1, threshold: 3 });
    expect(warn).toHaveBeenLastCalledWith("socket fence check strike", {
      errorClass: "unknown",
      durationMs: 1,
      inFlight: 1,
      strike: 1,
      threshold: 3,
    });
  });
});
