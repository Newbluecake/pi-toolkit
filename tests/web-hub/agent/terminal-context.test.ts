import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalContextProducer,
  type TerminalAgentContextV2,
  type TerminalContextFactsV2,
} from "../../../src/web-hub/agent/terminal/context.js";
import { terminalContextFrameV2Ok, type TerminalContextRequest } from "../../../src/web-hub/protocol/terminal-v2.js";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";

const limits = { maxPerSession: 2, inputIdleMs: 3_600_000, maxLifetimeMs: 28_800_000 };
function fixture() {
  let sessionId: string | undefined = "sessionA";
  let cwd = "/first";
  const readCwd = vi.fn(() => cwd);
  const ctx = {
    get cwd() {
      return readCwd();
    },
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
  };
  let facts: TerminalContextFactsV2<TerminalAgentContextV2> | undefined = {
    ctx,
    epoch: "epochA",
    linkInstance: {},
    domain: "plain",
    privateNamespace: "not-ns",
    isChild: false,
    enabled: true,
    control: true,
    webCommands: true,
    limits: { ...limits },
  };
  const guard = vi.fn((_ctx: TerminalAgentContextV2) => true);
  const current = vi.fn(() => facts);
  const producer = createTerminalContextProducer({ current, guard });
  const patch = (p: Partial<NonNullable<typeof facts>>) => {
    facts = { ...facts!, ...p };
  };
  const request = (): TerminalContextRequest => ({
    t: "terminal_context_req",
    v: 2,
    rid: "r".repeat(22),
    sessionId: sessionId!,
    epoch: facts!.epoch,
    contextGeneration: producer.declaration()!.contextGeneration,
  });
  return {
    ctx,
    guard,
    current,
    producer,
    patch,
    request,
    readCwd,
    link: () => facts!.linkInstance,
    setCwd: (next: string) => {
      cwd = next;
    },
    setSession: (next: string | undefined) => {
      sessionId = next;
    },
    disconnect: () => {
      facts = undefined;
    },
  };
}
const failure = (code: string) => ({
  t: "terminal_context_res",
  v: 2,
  rid: "r".repeat(22),
  ok: false,
  code,
});

describe("v2 current context producer (not production-wired)", () => {
  it("requires an explicit lifecycle start; successful declarations have no cwd/readiness/authority", () => {
    const f = fixture();
    expect(f.producer.declaration()).toBeUndefined();
    expect(f.producer.start()).toBe(true);
    expect(f.producer.declaration()).toEqual({
      v: 2,
      enabled: true,
      sessionId: "sessionA",
      epoch: "epochA",
      contextGeneration: 1,
      limits,
    });
    expect(f.readCwd).not.toHaveBeenCalled();
    expect(f.guard.mock.calls[0]?.[0]).toBe(f.ctx);
    const d = f.producer.declaration()!;
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.limits)).toBe(true);
    const reply = f.producer.reply(f.request(), f.link());
    expect(reply).toEqual({ ...f.request(), t: "terminal_context_res", ok: true, cwd: "/first" });
    expect(terminalContextFrameV2Ok(reply)).toBe(true);
    expect(f.readCwd).toHaveBeenCalledTimes(1);
  });

  it("missing guard and a throwing current provider fail closed", () => {
    const f = fixture();
    const missing = createTerminalContextProducer({ current: f.current });
    expect(missing.start()).toBe(false);
    expect(missing.projectStatus({ terminalSessionV2: { ...limits } })).toEqual({});
    const throwing = createTerminalContextProducer({
      current: () => {
        throw new Error("private detail");
      },
      guard: f.guard,
    });
    expect(throwing.start()).toBe(false);
    expect(throwing.reply({ t: "invalid" }, {})).toBeUndefined();
  });

  it.each([
    { domain: "secure" },
    { domain: "locked" },
    { domain: "unknown" },
    { privateNamespace: "in-ns" },
    { privateNamespace: "unknown" },
    { isChild: true },
    { enabled: false },
    { control: false },
    { webCommands: false },
  ] as const)("refuses untrusted runtime facts %j without reading cwd", (patch) => {
    const f = fixture();
    f.patch(patch);
    expect(f.producer.start()).toBe(false);
    expect(f.producer.declaration()).toBeUndefined();
    expect(f.readCwd).not.toHaveBeenCalled();
  });

  it.each(["print", "unknown", ""])("refuses mode %s", (mode) => {
    const f = fixture();
    f.ctx.mode = mode;
    expect(f.producer.start()).toBe(false);
    expect(f.readCwd).not.toHaveBeenCalled();
  });
  it("allows rpc, not just tui", () => {
    const f = fixture();
    f.ctx.mode = "rpc";
    expect(f.producer.start()).toBe(true);
    expect(f.producer.reply(f.request(), f.link())?.ok).toBe(true);
  });

  it.each(["false", "throw"])("guard %s withdraws permanently until explicit new generation", (kind) => {
    const f = fixture();
    f.producer.start();
    const old = f.request();
    f.guard.mockImplementation(() => {
      if (kind === "throw") throw new Error("secret");
      return false;
    });
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SECURE"));
    f.guard.mockReturnValue(true);
    expect(f.producer.declaration()).toBeUndefined();
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.start()).toBe(true);
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.reply(f.request(), f.link())?.ok).toBe(true);
  });

  it("projects status at write time, removes stored positives, and never mutates raw status", () => {
    const f = fixture();
    f.producer.start();
    const stale = {
      t: "status",
      terminalSessionV2: { injected: true, cwd: "/secret" },
      terminalSession: { v: 1 },
      other: 3,
    };
    const first = f.producer.projectStatus(stale);
    expect(first.terminalSessionV2).toEqual(f.producer.declaration());
    expect(first.terminalSession).toEqual({ v: 1 }); // P6 removes v1 separately; this helper owns only v2.
    expect(stale.terminalSessionV2).toEqual({ injected: true, cwd: "/secret" });
    f.guard.mockReturnValue(false);
    expect(f.producer.projectStatus(first)).toEqual({ t: "status", terminalSession: { v: 1 }, other: 3 });
    f.guard.mockReturnValue(true);
    expect(f.producer.projectStatus(first)).not.toHaveProperty("terminalSessionV2");
  });

  it("ABA session/generation and epoch changes cannot upgrade a late request", () => {
    const f = fixture();
    f.producer.start();
    const old = f.request();
    f.setSession("sessionB");
    f.producer.start();
    f.setSession("sessionA");
    f.producer.start();
    expect(f.producer.declaration()!.contextGeneration).toBe(3);
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    const request = f.request();
    f.patch({ epoch: "epochB" });
    expect(f.producer.reply(request, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    f.patch({ epoch: "epochA" });
    expect(f.producer.declaration()).toBeUndefined();
    expect(f.readCwd).not.toHaveBeenCalled();
  });

  it("exact original link identity is required; obsolete ingress does not retire a successor", () => {
    const f = fixture();
    f.producer.start();
    const oldLink = f.link(),
      old = f.request();
    f.producer.withdraw();
    f.patch({ linkInstance: {} });
    f.producer.start();
    const fresh = f.request();
    expect(f.producer.reply(fresh, oldLink)).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.reply(fresh, f.link())?.ok).toBe(true);
    f.patch({ linkInstance: {} });
    expect(f.producer.declaration()).toBeUndefined();
  });

  it("same rid is not a stored positive: replies use current cwd and still recheck withdrawal", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    const first = f.producer.reply(request, f.link());
    f.setCwd("/new-current");
    expect(f.producer.reply(request, f.link())).toMatchObject({ ok: true, cwd: "/new-current" });
    expect(first).toMatchObject({ ok: true, cwd: "/first" });
    f.guard.mockReturnValue(false);
    expect(f.producer.reply(request, f.link())).toEqual(failure("E_SECURE"));
    expect(f.readCwd).toHaveBeenCalledTimes(2);
    // Hub P1/P6 retain the first snapshot on the original create requestId. This producer
    // intentionally does not own HTTP intents/rid history or grant replay authority.
  });

  it("request session/epoch/future generation mismatches are refused without affecting current scope", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    for (const patch of [{ sessionId: "other" }, { epoch: "other" }, { contextGeneration: 2 }]) {
      expect(f.producer.reply({ ...request, ...patch }, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    }
    expect(f.readCwd).not.toHaveBeenCalled();
    expect(f.producer.reply(request, f.link())?.ok).toBe(true);
  });

  it("target limits are a live defensive projection, invalid limits withdraw rather than clamp", () => {
    const f = fixture();
    f.producer.start();
    const saved = f.producer.declaration()!;
    f.patch({ limits: { ...limits, maxPerSession: 1 } });
    expect(f.producer.declaration()!.limits.maxPerSession).toBe(1);
    expect(saved.limits.maxPerSession).toBe(2);
    f.patch({ limits: { ...limits, maxPerSession: 5 } });
    expect(f.producer.declaration()).toBeUndefined();
    f.patch({ limits });
    expect(f.producer.declaration()).toBeUndefined();
  });

  it("cwd getter failure is body-free E_CWD and never falls back", () => {
    const f = fixture();
    f.producer.start();
    f.readCwd.mockImplementationOnce(() => {
      throw new Error("secret path");
    });
    expect(f.producer.reply(f.request(), f.link())).toEqual(failure("E_CWD"));
  });

  it("normal event context/cwd changes do not change generation; each RPC captures cwd once", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    const a = f.producer.reply(request, f.link());
    f.setCwd("/second");
    const b = f.producer.reply({ ...request, rid: "s".repeat(22) }, f.link());
    expect(a).toMatchObject({ ok: true, cwd: "/first", contextGeneration: 1 });
    expect(b).toMatchObject({ ok: true, cwd: "/second", contextGeneration: 1 });
    expect(f.readCwd).toHaveBeenCalledTimes(2);
    expect(a).toMatchObject({ cwd: "/first" }); // Existing captured create context is not migrated.
    const next = { ...f.ctx, cwd: "/third" };
    f.patch({ ctx: next });
    expect(f.producer.reply({ ...request, rid: "t".repeat(22) }, f.link())).toMatchObject({
      ok: true,
      cwd: "/third",
      contextGeneration: 1,
    });
  });

  it.each(["", "relative", "/nul\0x", "/" + "a".repeat(8192), "/" + "中".repeat(2731)])(
    "rejects invalid cwd without fallback (%#)",
    (cwd) => {
      const f = fixture();
      f.setCwd(cwd);
      f.producer.start();
      expect(f.producer.reply(f.request(), f.link())).toEqual(failure("E_CWD"));
      expect(f.readCwd).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts exactly 8KiB UTF-8 cwd, leaves directory traversal/existence to backend", () => {
    const f = fixture();
    f.producer.start();
    f.setCwd("/" + "a".repeat(8191));
    expect(f.producer.reply(f.request(), f.link())).toMatchObject({ ok: true, cwd: "/" + "a".repeat(8191) });
    f.setCwd("/nonexistent-context-only");
    expect(f.producer.reply(f.request(), f.link())).toMatchObject({ ok: true, cwd: "/nonexistent-context-only" });
  });

  it("guard withdrawal while reading cwd blocks the in-progress old request", () => {
    const f = fixture();
    f.producer.start();
    const old = f.request();
    f.readCwd.mockImplementationOnce(() => {
      f.producer.withdraw();
      return "/late";
    });
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.declaration()).toBeUndefined();
  });
  it("reentrant start during cwd capture cannot adopt the old request into new generation", () => {
    const f = fixture();
    f.producer.start();
    const old = f.request();
    f.readCwd.mockImplementationOnce(() => {
      f.producer.start();
      return "/late";
    });
    expect(f.producer.reply(old, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.declaration()!.contextGeneration).toBe(2);
    expect(f.producer.reply(f.request(), f.link())?.ok).toBe(true);
  });
  it("guard reentrancy cannot publish a positive declaration or complete an interrupted start", () => {
    const f = fixture();
    f.guard.mockImplementationOnce(() => {
      f.producer.withdraw();
      return true;
    });
    expect(f.producer.start()).toBe(false);
    expect(f.producer.declaration()).toBeUndefined();
    expect(f.producer.start()).toBe(true);
    f.guard.mockImplementationOnce(() => {
      f.producer.withdraw();
      return true;
    });
    expect(f.producer.declaration()).toBeUndefined();
  });
  it("guard cannot swap current context/security facts under a positive result", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    f.guard.mockImplementationOnce(() => {
      f.patch({ domain: "secure" });
      return true;
    });
    expect(f.producer.reply(request, f.link())).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.readCwd).not.toHaveBeenCalled();
  });

  it("disconnect/session loss/exit seals old context; dispose cannot be restarted", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    const link = f.link();
    f.disconnect();
    expect(f.producer.reply(request, link)).toEqual(failure("E_SESSION_CHANGED"));
    expect(f.producer.projectStatus({ other: true })).toEqual({ other: true });
    f.producer.dispose();
    expect(f.producer.start()).toBe(false);
    expect(f.producer.reply(request, link)).toEqual(failure("E_UNSUPPORTED"));
    const g = fixture();
    g.producer.start();
    const r = g.request();
    g.setSession(undefined);
    expect(g.producer.reply(r, g.link())).toEqual(failure("E_UNSUPPORTED"));
  });

  it("only standalone closed context requests are handled; ordinary decoders remain closed", () => {
    const f = fixture();
    f.producer.start();
    const request = f.request();
    for (const raw of [
      null,
      {},
      { ...request, cwd: "/injected" },
      { ...request, rid: "short" },
      { ...request, contextGeneration: -1 },
      { ...request, v: 1 },
      { cmd: request },
    ])
      expect(f.producer.reply(raw, f.link())).toBeUndefined();
    const reply = f.producer.reply(request, f.link())!;
    expect(f.producer.reply(reply, f.link())).toBeUndefined();
    expect(decodeHubFrame(request)).toBeUndefined();
    expect(decodeAgentFrame(reply)).toBeUndefined();
  });

  it("has a closed IO-free value-import surface, no shell/authority/receipt dependency or callback", () => {
    const source = readFileSync(new URL("../../../src/web-hub/agent/terminal/context.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual([
      "../../protocol/messages.js",
      "../../protocol/terminal-v2.js",
      "../../protocol/terminal-v2-values.js",
    ]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(
      /\b(?:process|globalThis|require|eval|Function|setTimeout|setInterval|fetch)\b|import\s*\(/,
    );
    const f = fixture();
    expect(Object.keys(f.producer).sort()).toEqual([
      "declaration",
      "dispose",
      "projectStatus",
      "reply",
      "start",
      "withdraw",
    ]);
    f.producer.start();
    expect(f.producer.reply(f.request(), f.link())).toMatchObject({ ok: true });
    expect(f.current).toHaveBeenCalled();
    expect(f.guard).toHaveBeenCalled();
    // No injected execution/write/send/owner factory exists: the complete port only returns metadata.
    expect(Object.keys(f.producer.reply(f.request(), f.link())!).sort()).toEqual([
      "contextGeneration",
      "cwd",
      "epoch",
      "ok",
      "rid",
      "sessionId",
      "t",
      "v",
    ]);
  });
});
