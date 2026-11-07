import { MEMORY_BIND_EVENT, type MemoryBindRequest } from "../../src/memory/scopes/child-bind.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastBindRequest, FastOwner } from "../../src/fast/ports.js";
import type { SessionSpec } from "../../src/core/types.js";
const fixture = vi.hoisted(() => ({
  memoryRequests: [] as MemoryBindRequest[],
  memoryDispose: vi.fn(),
  memoryReceiver: true,
  memoryLate: false,
  records: [] as Array<{ type: string; data: unknown }>,
  prompt: vi.fn(async () => {}),
  disposed: vi.fn(),
  aborted: vi.fn(),
  receiverDispose: vi.fn(),
  appendFail: false,
  initFail: false,
  sdkFail: false,
  secureFail: false,
  mode: "on" as "on" | "off" | "inherit",
  receiver: true,
  late: false,
  requests: [] as FastBindRequest[],
  loaders: [] as Record<string, unknown>[],
  options: [] as Record<string, unknown>[],
  readBeforeReady: undefined as (() => void) | undefined,
}));
vi.mock("../../src/secure/domain.js", () => ({
  secureChildSessionDir: () => {
    if (fixture.secureFail) throw new Error("locked");
    return undefined;
  },
  assertSessionFileInDomain: () => {
    if (fixture.secureFail) throw new Error("cross-domain");
  },
}));
const manager = vi.hoisted(() => ({
  appendCustomEntry: vi.fn((type: string, data: unknown) => {
    if (fixture.appendFail && type === "subagent:fast") throw new Error("real public append throw");
    fixture.records.push({ type, data });
    return String(fixture.records.length);
  }),
  getBranch: () => fixture.records,
  getCwd: () => "/isolated",
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    SettingsManager: { create: vi.fn(() => ({})) },
    getAgentDir: () => "/isolated/agent",
    SessionManager: {
      create: vi.fn(() => {
        if (fixture.initFail) throw new Error("manager init failed");
        return manager;
      }),
      inMemory: vi.fn(() => manager),
      open: vi.fn(() => manager),
    },
    DefaultResourceLoader: class {
      constructor(readonly options: Record<string, unknown>) {
        fixture.loaders.push(options);
      }
      async reload() {
        fixture.readBeforeReady?.();
        const bus = this.options.eventBus as ReturnType<typeof sdk.createEventBus> | undefined;
        if (fixture.memoryReceiver)
          bus?.on("subagent:memory-bind", (value) => {
            const req = value as MemoryBindRequest;
            fixture.memoryRequests.push(req);
            if (!fixture.memoryLate) req.reply({ v: 1, wired: true, dispose: fixture.memoryDispose });
          });
        if (!fixture.receiver) return;
        bus?.on("subagent:fast-bind", (value) => {
          const req = value as FastBindRequest;
          fixture.requests.push(req);
          if (!fixture.late)
            req.reply({ v: 1, wired: true, readMode: () => fixture.mode, dispose: fixture.receiverDispose });
        });
      }
    },
    createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
      fixture.options.push(options);
      if (fixture.sdkFail) throw new Error("sdk create failed");
      return {
        session: {
          sessionId: "s",
          sessionFile: undefined,
          prompt: fixture.prompt,
          dispose: fixture.disposed,
          abort: fixture.aborted,
          subscribe: vi.fn(),
        },
      };
    }),
  };
});
import { PiSessionDriver, toCreateOptions } from "../../src/runtime/session-driver.js";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.memoryRequests = [];
  fixture.memoryReceiver = true;
  fixture.memoryLate = false;
  fixture.memoryDispose.mockReset();
  fixture.receiverDispose.mockReset();
  fixture.records = [];
  fixture.requests = [];
  fixture.loaders = [];
  fixture.options = [];
  fixture.appendFail = false;
  fixture.initFail = false;
  fixture.sdkFail = false;
  fixture.secureFail = false;
  fixture.receiver = true;
  fixture.late = false;
  fixture.mode = "on";
  fixture.readBeforeReady = undefined;
});
const spec = (mode: "on" | "off" | "inherit" = "on", extras = {}): SessionSpec => ({
  fastSeed: { v: 1, mode },
  ...extras,
});
describe("Fast driver first-prompt barrier", () => {
  it.each([undefined, "replacement prompt"])(
    "marker first, exact seed, shared loader bus, no SDK seed leakage (%s)",
    async (systemPrompt) => {
      const driver = new PiSessionDriver();
      const handle = await driver.create(spec("off", systemPrompt ? { systemPrompt } : {}));
      expect(fixture.records).toEqual([
        { type: "subagent:child", data: { v: 1 } },
        { type: "subagent:fast", data: { v: 1, mode: "off" } },
      ]);
      expect(fixture.loaders).toHaveLength(1);
      expect(Object.hasOwn(fixture.options[0]!, "fastSeed")).toBe(false);
      expect(Object.hasOwn(fixture.options[0]!, "eventBus")).toBe(false);
      expect(fixture.requests[0]!.manager.getBranch()).toBe(fixture.records);
      await handle.prompt("only after ready");
      expect(fixture.prompt).toHaveBeenCalledTimes(1);
      await handle.requestAbort();
      handle.dispose();
      handle.dispose();
      expect(fixture.receiverDispose).toHaveBeenCalledTimes(1);
    },
  );
  it("absent seed keeps default loader and writes no Fast entry or bus", async () => {
    await new PiSessionDriver().create({});
    expect(fixture.loaders).toEqual([]);
    expect(fixture.records).toEqual([{ type: "subagent:child", data: { v: 1 } }]);
    expect(fixture.requests).toEqual([]);
    expect(await toCreateOptions({}, "/isolated")).toEqual({});
  });
  it("no-seed custom prompt keeps its original single loader without a Fast bus", async () => {
    const handle = await new PiSessionDriver().create({ systemPrompt: "original" });
    expect(fixture.loaders).toHaveLength(1);
    expect(Object.hasOwn(fixture.loaders[0]!, "eventBus")).toBe(false);
    expect((fixture.loaders[0]!.systemPromptOverride as () => string)()).toBe("original");
    expect(fixture.requests).toEqual([]);
    expect(fixture.records.map((r) => r.type)).toEqual(["subagent:child"]);
    handle.dispose();
  });
  it.each(["on", "off"] as const)("missing receiver fails %s with zero prompts and SDK cleanup", async (mode) => {
    fixture.receiver = false;
    await expect(new PiSessionDriver().create(spec(mode))).rejects.toHaveProperty("reason", "fast_receiver_missing");
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.disposed).toHaveBeenCalledTimes(1);
  });
  it("inherit resume appends tombstone over old on instead of restoring child value", async () => {
    fixture.records.push({ type: "subagent:fast", data: { v: 1, mode: "on" } });
    const handle = await new PiSessionDriver().resume("owned-file", spec("inherit"));
    expect(fixture.records).toEqual([
      { type: "subagent:fast", data: { v: 1, mode: "on" } },
      { type: "subagent:fast", data: { v: 1, mode: "inherit" } },
    ]);
    handle.dispose();
  });
  it.each(["append", "init"])("public %s failure: no SDK create and zero prompts", async (failure) => {
    fixture.appendFail = failure === "append";
    fixture.initFail = failure === "init";
    await expect(Promise.resolve().then(() => new PiSessionDriver().create(spec()))).rejects.toThrow();
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });
  it.each([false, true])("secure rejection precedes all manager opens, resume=%s", async (resume) => {
    fixture.secureFail = true;
    const driver = new PiSessionDriver();
    await expect(resume ? driver.resume("foreign", spec()) : driver.create(spec())).rejects.toThrow();
    expect(SessionManager.create).not.toHaveBeenCalled();
    expect(SessionManager.open).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(manager.appendCustomEntry).not.toHaveBeenCalled();
  });
  it("binding uses admitted seed before readiness and child's branch callback afterwards; cleanup exact once", async () => {
    let read: (() => string) | undefined;
    let owner: FastOwner | undefined;
    const unbind = vi.fn();
    const driver = new PiSessionDriver(true, undefined, undefined, {
      bind(o, callback) {
        owner = o;
        read = callback;
        return unbind;
      },
    });
    fixture.readBeforeReady = () => {
      expect(read?.()).toBe("off");
    };
    const handle = await driver.create(spec("off", { runId: "trusted-child" }));
    expect(owner!.parentRunId).toBe("trusted-child");
    expect(read?.()).toBe("on");
    fixture.mode = "inherit";
    expect(read?.()).toBe("inherit");
    await handle.requestAbort();
    handle.dispose();
    expect(unbind).toHaveBeenCalledTimes(1);
  });
  it("create failure and abort revoke owner without SDK shutdown", async () => {
    const unbind = vi.fn();
    const controller = new AbortController();
    const driver = new PiSessionDriver(true, undefined, undefined, {
      bind() {
        return unbind;
      },
    });
    fixture.sdkFail = true;
    await expect(driver.create(spec("on", { runId: "trusted", signal: controller.signal }))).rejects.toThrow(
      "sdk create failed",
    );
    expect(unbind).toHaveBeenCalledTimes(1);
    expect(fixture.prompt).not.toHaveBeenCalled();
    fixture.sdkFail = false;
    fixture.readBeforeReady = () => controller.abort();
    await expect(driver.create(spec("on", { runId: "trusted", signal: controller.signal }))).rejects.toThrow("aborted");
    expect(unbind).toHaveBeenCalledTimes(2);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });
  it("late reply from old same-id creation cannot update new binding (ABA)", async () => {
    let read: (() => string) | undefined;
    const owners: FastOwner[] = [];
    const driver = new PiSessionDriver(true, undefined, undefined, {
      bind(owner, callback) {
        owners.push(owner);
        read = callback;
        return vi.fn();
      },
    });
    fixture.late = true;
    await expect(driver.create(spec("on", { runId: "same" }))).rejects.toHaveProperty(
      "reason",
      "fast_receiver_missing",
    );
    const old = fixture.requests[0]!;
    fixture.late = false;
    fixture.mode = "off";
    const handle = await driver.create(spec("inherit", { runId: "same" }));
    const staleDispose = vi.fn();
    old.reply({ v: 1, wired: true, readMode: () => "on", dispose: staleDispose });
    expect(read?.()).toBe("off");
    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(owners[0]!.incarnation).not.toBe(owners[1]!.incarnation);
    handle.dispose();
  });
});

describe("#39 memory-specific driver response fence and cleanup", () => {
  const driver = (strict = true) => new PiSessionDriver(true, undefined, undefined, undefined, undefined, { strict });
  it.each([false, true])("actual manager and literal reason; resume=%s, no Fastseed dependency", async (resume) => {
    const h = await (resume ? driver().resume("owned", {}) : driver().create({}));
    expect(fixture.memoryRequests).toHaveLength(1);
    expect(fixture.memoryRequests[0]!.manager).toBe(manager);
    expect(fixture.memoryRequests[0]!.reason).toBe(resume ? "resume" : "created");
    expect(fixture.requests).toHaveLength(0);
    expect(Object.hasOwn(fixture.options[0]!, "signal")).toBe(false);
    h.dispose();
    h.dispose();
    expect(fixture.memoryDispose).toHaveBeenCalledTimes(1);
  });
  it("late/duplicate replies dispose only their own binding; old same-run cleanup does not touch new incarnation", async () => {
    const one = await driver().create({ runId: "same" } as SessionSpec);
    const old = fixture.memoryRequests[0]!;
    const two = await driver().create({ runId: "same" } as SessionSpec);
    const fresh = fixture.memoryRequests[1]!;
    expect(old.owner.incarnation).not.toBe(fresh.owner.incarnation);
    const duplicate = vi.fn();
    old.reply({ v: 1, wired: true, dispose: duplicate });
    expect(duplicate).toHaveBeenCalledTimes(1);
    one.dispose();
    expect(fixture.memoryDispose).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    old.reply({ v: 1, wired: true, dispose: late });
    expect(late).toHaveBeenCalledTimes(1);
    expect(fixture.memoryDispose).toHaveBeenCalledTimes(1);
    two.dispose();
    expect(fixture.memoryDispose).toHaveBeenCalledTimes(2);
  });
  it("production missing receiver is diagnostic-only; strict missing refuses before prompt and disposes SDK once", async () => {
    fixture.memoryReceiver = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = await driver(false).create({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("continuing without scoped child binding"));
      expect(fixture.memoryDispose).not.toHaveBeenCalled();
      h.dispose();
      fixture.disposed.mockClear();
      await expect(driver().create({})).rejects.toThrow("memory_receiver_missing");
      expect(fixture.prompt).not.toHaveBeenCalled();
      expect(fixture.disposed).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("reply after synchronous emit boundary cannot resurrect failed strict creation", async () => {
    fixture.memoryLate = true;
    await expect(driver().create({})).rejects.toThrow("memory_receiver_missing");
    const release = vi.fn();
    fixture.memoryRequests[0]!.reply({ v: 1, wired: true, dispose: release });
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.disposed).toHaveBeenCalledTimes(1);
    expect(fixture.memoryDispose).not.toHaveBeenCalled();
  });
  it.each(["Fast", "memory"] as const)(
    "throwing %s cleanup cannot block the other binding, SDK disposal, or bus clearing",
    async (failure) => {
      const h = await driver().create(spec("off"));
      expect(fixture.memoryRequests).toHaveLength(1);
      expect(fixture.requests).toHaveLength(1);
      (failure === "Fast" ? fixture.receiverDispose : fixture.memoryDispose).mockImplementationOnce(() => {
        throw Error(`${failure} close fault`);
      });
      expect(h.dispose().returned).toBe(false);
      expect(fixture.memoryDispose).toHaveBeenCalledTimes(1);
      expect(fixture.receiverDispose).toHaveBeenCalledTimes(1);
      expect(fixture.disposed).toHaveBeenCalledTimes(1);
      const bus = fixture.loaders[0]!.eventBus as ReturnType<
        typeof import("@earendil-works/pi-coding-agent").createEventBus
      >;
      bus.emit(MEMORY_BIND_EVENT, fixture.memoryRequests[0]);
      expect(fixture.memoryRequests).toHaveLength(1);
    },
  );
});
