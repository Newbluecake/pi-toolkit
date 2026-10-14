import { describe, expect, it, vi } from "vitest";
import { classifiedInfo } from "../../src/core/errors.js";
import type { DriverEvent, SessionSpec } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { RoutingSessionDriver } from "../../src/external-agent/router.js";
import type { ExternalRunSpec } from "../../src/core/types.js";
import type { ExternalAgentProvider, ExternalSessionHandle } from "../../src/external-agent/types.js";

const ext = (provider = "droid"): ExternalRunSpec => ({
  provider,
  modelId: "m",
  roleName: "r",
  contextBlocks: [],
  persistTranscript: true,
  runId: "run1",
  pricing: { status: "unpriced", reason: "no_match" },
  degraded: [],
});

function handle(tag: string): SessionHandle {
  return { sessionId: tag, sessionFile: undefined } as unknown as SessionHandle;
}

function setup() {
  const piHandle = handle("pi");
  const pi: SessionDriver = {
    create: vi.fn(async () => piHandle),
    resume: vi.fn(async () => piHandle),
    bind: vi.fn(async () => undefined),
    onLateArrival: vi.fn(),
    resolveModelRef: vi.fn(() => ({ opaque: true })),
  };
  const attach = vi.fn();
  const extHandle = {
    sessionId: "e",
    sessionFile: undefined,
    provider: "droid",
    attach,
  } as unknown as ExternalSessionHandle;
  const provider: ExternalAgentProvider = {
    id: "droid",
    ownsSessionFile: (p) => p.includes("/external-agent/droid/"),
    create: vi.fn(async () => extHandle),
    resume: vi.fn(async () => extHandle),
    catalog: {} as never,
    dispose: vi.fn(),
  };
  const router = new RoutingSessionDriver(pi, new Map([["droid", provider]]));
  return { pi, provider, router, piHandle, extHandle, attach };
}

describe("RoutingSessionDriver", () => {
  it("create: external spec → provider, otherwise → pi", async () => {
    const s = setup();
    expect(await s.router.create({ external: ext() } as SessionSpec)).toBe(s.extHandle);
    expect(s.provider.create).toHaveBeenCalledTimes(1);
    expect(s.pi.create).not.toHaveBeenCalled();
    expect(await s.router.create({} as SessionSpec)).toBe(s.piHandle);
    expect(s.pi.create).toHaveBeenCalledTimes(1);
  });

  it("create with unknown provider ⇒ ClassifiedError{config}", async () => {
    const s = setup();
    const err = await s.router.create({ external: ext("codex") } as SessionSpec).catch((e: unknown) => e);
    expect(classifiedInfo(err)?.kind).toBe("config");
  });

  it("resume dispatch: owner+external → provider; none+pi → pi", async () => {
    const s = setup();
    const f = "/a/external-agent/droid/sessions/x.jsonl";
    expect(await s.router.resume(f, { external: ext() } as SessionSpec)).toBe(s.extHandle);
    expect(s.provider.resume).toHaveBeenCalledWith(f, expect.anything());
    expect(await s.router.resume("/a/pi/s.jsonl", {} as SessionSpec)).toBe(s.piHandle);
    expect(s.pi.resume).toHaveBeenCalledTimes(1);
  });

  it("resume mismatch (both directions) ⇒ config, nothing opened", async () => {
    const s = setup();
    const e1 = await s.router.resume("/a/external-agent/droid/s.jsonl", {} as SessionSpec).catch((e: unknown) => e);
    const e2 = await s.router.resume("/a/pi/s.jsonl", { external: ext() } as SessionSpec).catch((e: unknown) => e);
    expect(classifiedInfo(e1)?.kind).toBe("config");
    expect(classifiedInfo(e1)?.message).toContain("droid session with a pi model");
    expect(classifiedInfo(e2)?.kind).toBe("config");
    expect(classifiedInfo(e2)?.message).toContain("pi session with a droid model");
    expect(s.pi.resume).not.toHaveBeenCalled();
    expect(s.provider.resume).not.toHaveBeenCalled();
  });

  it("a throwing ownsSessionFile counts as not-owned", async () => {
    const s = setup();
    (s.provider as { ownsSessionFile: (p: string) => boolean }).ownsSessionFile = () => {
      throw new Error("x");
    };
    expect(await s.router.resume("/a/pi/s.jsonl", {} as SessionSpec)).toBe(s.piHandle);
  });

  it("bind: WeakSet identity — only handles minted by the router go to attach()", async () => {
    const s = setup();
    const onEvent = (_: DriverEvent) => undefined;
    const h = await s.router.create({ external: ext() } as SessionSpec);
    await s.router.bind(h, onEvent);
    expect(s.attach).toHaveBeenCalledWith(onEvent);
    expect(s.pi.bind).not.toHaveBeenCalled();
    // duck-typed lookalike (has attach) that the router never minted → pi driver
    const impostor = { sessionId: "i", sessionFile: undefined, attach: vi.fn() } as unknown as SessionHandle;
    await s.router.bind(impostor, onEvent);
    expect(s.pi.bind).toHaveBeenCalledWith(impostor, onEvent);
    expect((impostor as unknown as { attach: ReturnType<typeof vi.fn> }).attach).not.toHaveBeenCalled();
  });

  it("bind rejects when attach throws (second attach)", async () => {
    const s = setup();
    s.attach.mockImplementation(() => {
      throw new Error("attach twice");
    });
    const h = await s.router.create({ external: ext() } as SessionSpec);
    await expect(s.router.bind(h, () => undefined)).rejects.toThrow("attach twice");
  });

  it("resolveModelRef: undefined for external providers, delegated otherwise", () => {
    const s = setup();
    expect(s.router.resolveModelRef("droid", "x")).toBeUndefined();
    expect(s.pi.resolveModelRef).not.toHaveBeenCalled();
    expect(s.router.resolveModelRef("anthropic", "x")).toEqual({ opaque: true });
  });

  it("onLateArrival delivers resolved handles and swallows rejections", async () => {
    const s = setup();
    const cb = vi.fn();
    s.router.onLateArrival(Promise.resolve(s.piHandle), cb);
    s.router.onLateArrival(Promise.reject(new Error("nope")), cb);
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(s.piHandle);
  });
});
