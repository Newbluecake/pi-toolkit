/**
 * rebind-plan r3 §4.8 (agent package): the main-session `thread` tool's dual frozen schema
 * instances, the rebind/acquire actions' result texts (three failure classes), the `/thread`
 * USAGE variants, and the message_session dispatch-convention suffix (never appended while
 * rebind is off — threads-on × rebind-off stays byte-identical, A16).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createThreadTool,
  ThreadToolParams,
  ThreadToolParamsLegacy,
  ThreadToolParamsRebind,
  threadParamsFor,
  type ThreadMainOps,
} from "../../src/tools/thread-tool.js";
import { createThreadCommand } from "../../src/commands/thread.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import type { XsSender, XsSendOutcome } from "../../src/fabric/xs/sender.js";

const here = dirname(fileURLToPath(import.meta.url));
const REBIND_OFF_GOLDEN = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "thread-rebind-off-golden.json"), "utf8"),
) as { threadTool: { description: string; parameters: unknown }; threadCommand: { usage: string } };

type OpsOver = Partial<ThreadMainOps>;
function fakeOps(over: OpsOver = {}): ThreadMainOps {
  return {
    list: () => "(list)",
    subscribe: () => ({ ok: false, reason: "stub" }),
    unsubscribe: () => ({ ok: true }),
    origins: () => [],
    ...over,
  };
}

describe("thread tool dual frozen schema (rebind-plan §4.8)", () => {
  it("ThreadToolParamsLegacy is byte-identical to the rebind-off golden parameters", () => {
    expect(JSON.stringify(ThreadToolParamsLegacy)).toBe(JSON.stringify(REBIND_OFF_GOLDEN.threadTool.parameters));
    // the back-compat alias IS the legacy instance
    expect(ThreadToolParams).toBe(ThreadToolParamsLegacy);
  });

  it("threadParamsFor picks the instance; rebind-off keeps the legacy description byte-identical", () => {
    expect(threadParamsFor(false)).toBe(ThreadToolParamsLegacy);
    expect(threadParamsFor(true)).toBe(ThreadToolParamsRebind);
    const legacy = createThreadTool({ current: () => fakeOps() });
    expect(legacy.description).toBe(REBIND_OFF_GOLDEN.threadTool.description);
    expect(legacy.parameters).toBe(ThreadToolParamsLegacy);
    const json = JSON.stringify({ description: legacy.description, parameters: legacy.parameters });
    expect(json).not.toContain("rebind");
    expect(json).not.toContain("acquire");
  });

  it("rebind-on instance: five actions + `to`; description carries the convention and the three failure classes", () => {
    const tool = createThreadTool({ current: () => fakeOps(), rebind: true });
    expect(tool.parameters).toBe(ThreadToolParamsRebind);
    const actions = (ThreadToolParamsRebind.properties.action as { anyOf: Array<{ const: string }> }).anyOf.map(
      (a) => a.const,
    );
    expect(actions).toEqual(["list", "subscribe", "unsubscribe", "rebind", "acquire"]);
    expect(ThreadToolParamsRebind.properties).toHaveProperty("to");
    // fromRev is NEVER a model parameter (§4.8)
    expect(ThreadToolParamsRebind.properties).not.toHaveProperty("fromRev");
    expect(tool.description).toContain("rebind");
    expect(tool.description).toContain("acquire");
    expect(tool.description).toContain("do NOT blind-retry");
    // legacy prose is a verbatim PREFIX of the rebind description
    expect(tool.description.startsWith(REBIND_OFF_GOLDEN.threadTool.description)).toBe(true);
  });
});

describe("thread tool rebind/acquire actions (rebind-plan §4.8 result texts)", () => {
  const H = "fs:aaaaaaaaaaaa";
  const SID = "worker-session-full-id";

  async function run(tool: ReturnType<typeof createThreadTool>, params: Record<string, unknown>) {
    const result = (await tool.execute("call-1", params as never, undefined)) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    return result.content[0]!.text;
  }

  it("rebind success: full sessionId + the acquire-before-subscribe dispatch instruction", async () => {
    const tool = createThreadTool({
      current: () =>
        fakeOps({
          rebind: async (input) => {
            expect(input).toEqual({ h: H, to: SID, origin: false });
            return { ok: true, h: H, sessionId: SID, rev: 42, changed: true, label: "topic" };
          },
        }),
      rebind: true,
    });
    const text = await run(tool, { action: "rebind", h: H, to: SID });
    expect(text).toContain("rebound");
    expect(text).toContain(SID);
    expect(text).toContain("rev 42");
    expect(text).toContain('message_session(to:"' + SID + '")');
    expect(text).toContain('thread(action:"acquire"');
    expect(text).toContain(H);
  });

  it("rebind changed:false is the same-target no-op (P1) — explicitly NOT a transfer", async () => {
    const tool = createThreadTool({
      current: () =>
        fakeOps({
          rebind: async () => ({ ok: true, h: H, sessionId: SID, rev: 42, changed: false, label: "topic" }),
        }),
      rebind: true,
    });
    const text = await run(tool, { action: "rebind", h: H, to: SID });
    expect(text).toContain("no-op");
    expect(text).toContain("ALREADY bound");
  });

  it("E_THR_UNSUPPORTED: do-NOT-retry wording (A9 class)", async () => {
    const tool = createThreadTool({
      current: () => fakeOps({ rebind: async () => ({ ok: false, code: "E_THR_UNSUPPORTED", effect: "none" }) }),
      rebind: true,
    });
    const text = await run(tool, { action: "rebind", h: H, to: SID });
    expect(text).toContain("E_THR_UNSUPPORTED");
    expect(text).toContain("do NOT retry");
  });

  it("effect none: provably not applied; effect unknown: probe-with-acquire guidance (§4.9 P2/P3)", async () => {
    const noneTool = createThreadTool({
      current: () => fakeOps({ rebind: async () => ({ ok: false, code: "E_THR_NO_OWNER", effect: "none" }) }),
      rebind: true,
    });
    const noneText = await run(noneTool, { action: "rebind", h: H, to: SID });
    expect(noneText).toContain("effect none");
    expect(noneText).toContain("not the current holder");
    expect(noneText).not.toContain("blind-retry");

    const unknownTool = createThreadTool({
      current: () => fakeOps({ rebind: async () => ({ ok: false, code: "E_THR_COMMIT", effect: "unknown" }) }),
      rebind: true,
    });
    const unknownText = await run(unknownTool, { action: "rebind", h: H, to: SID });
    expect(unknownText).toContain("effect unknown");
    expect(unknownText).toContain("do NOT blind-retry");
    expect(unknownText).toContain('thread(action:"acquire"');
  });

  it("acquire: fast path vs hub round trip texts; E_THR_NO_OWNER passes through", async () => {
    const fast = createThreadTool({
      current: () => fakeOps({ acquire: async () => ({ ok: true, already: true, label: "topic", rev: 41 }) }),
      rebind: true,
    });
    const fastText = await run(fast, { action: "acquire", h: H });
    expect(fastText).toContain("already open");
    expect(fastText).toContain("NOT refreshed");

    const fresh = createThreadTool({
      current: () => fakeOps({ acquire: async () => ({ ok: true, already: false, label: "topic", rev: 44 }) }),
      rebind: true,
    });
    const freshText = await run(fresh, { action: "acquire", h: H });
    expect(freshText).toContain("acquired");
    expect(freshText).toContain("rev 44");
    expect(freshText).toContain("subscribe now");

    const denied = createThreadTool({
      current: () => fakeOps({ acquire: async () => ({ ok: false, code: "E_THR_NO_OWNER", effect: "none" }) }),
      rebind: true,
    });
    const deniedText = await run(denied, { action: "acquire", h: H });
    expect(deniedText).toContain("E_THR_NO_OWNER");
  });

  it("rebind-off surface: the actions answer the fixed off line (schema never offers them)", async () => {
    const tool = createThreadTool({ current: () => fakeOps(), rebind: false });
    // ops.acquire/rebind are absent on a rebind-off stub — defensive branch
    const text = await run(tool, { action: "acquire", h: H } as Record<string, unknown>);
    expect(text).toContain("E_THR_UNSUPPORTED");
  });

  it("input validation: rebind needs h and to; acquire needs a handle or origin", async () => {
    const never = async (): Promise<never> => {
      throw new Error("must not be called");
    };
    const tool = createThreadTool({
      current: () => fakeOps({ acquire: never, rebind: never }),
      rebind: true,
    });
    expect(await run(tool, { action: "rebind", h: H })).toContain('rebind needs "to"');
    expect(await run(tool, { action: "rebind", h: "nope", to: SID })).toContain('rebind needs "h"');
    expect(await run(tool, { action: "acquire" })).toContain('acquire needs "h"');
  });
});

describe("/thread command USAGE variants (rebind-plan §4.8)", () => {
  async function help(rebind: boolean | undefined): Promise<string> {
    const cmd = createThreadCommand({
      current: () => fakeOps(),
      ...(rebind === undefined ? {} : { rebind }),
    });
    const notices: string[] = [];
    await cmd.handler("help", { ui: { notify: (m: string) => notices.push(m) } } as never);
    expect(notices).toHaveLength(1);
    return notices[0]!;
  }

  it("rebind off/absent ⇒ the legacy USAGE, byte-identical to the golden", async () => {
    expect(await help(false)).toBe(REBIND_OFF_GOLDEN.threadCommand.usage);
    expect(await help(undefined)).toBe(REBIND_OFF_GOLDEN.threadCommand.usage);
  });

  it("rebind on ⇒ USAGE_REBIND carries both new verbs and keeps the legacy text as prefix", async () => {
    const usage = await help(true);
    expect(usage).toContain("/thread rebind <h|origin> <to>");
    expect(usage).toContain("/thread acquire <h|origin>");
    expect(usage.startsWith("用法：/thread status · /thread drop <subId> · /thread sub <run> <h|origin>")).toBe(true);
  });

  it("rebind/acquire subcommands parse and reach the surface; off ⇒ fixed notice", async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const ops = fakeOps({
      acquire: async (input) => {
        calls.push({ kind: "acquire", input });
        return { ok: true, already: false, label: "topic", rev: 7 };
      },
      rebind: async (input) => {
        calls.push({ kind: "rebind", input });
        return { ok: true, h: "fs:aaaaaaaaaaaa", sessionId: "sid-full", rev: 8, changed: true, label: "topic" };
      },
    });
    const cmd = createThreadCommand({ current: () => ops, rebind: true });
    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } } as never;
    await cmd.handler("acquire fs:aaaaaaaaaaaa", ctx);
    await cmd.handler("rebind fs:aaaaaaaaaaaa worker-sid", ctx);
    expect(calls).toEqual([
      { kind: "acquire", input: { h: "fs:aaaaaaaaaaaa", origin: false } },
      { kind: "rebind", input: { h: "fs:aaaaaaaaaaaa", to: "worker-sid", origin: false } },
    ]);
    expect(notices[0]).toContain("已登记");
    expect(notices[1]).toContain("已换绑");
    expect(notices[1]).toContain("sid-full");

    const offCmd = createThreadCommand({ current: () => ops, rebind: false });
    const offNotices: string[] = [];
    await offCmd.handler("rebind fs:aaaaaaaaaaaa x", { ui: { notify: (m: string) => offNotices.push(m) } } as never);
    expect(offNotices[0]).toContain("fabric.threads.rebind=false");
    expect(calls).toHaveLength(2); // never reached the surface
  });
});

describe("message_session description rebind suffix (rebind-plan §3.2 steps 6–7)", () => {
  const sender = {
    message: async (): Promise<XsSendOutcome> => ({ status: "ok", effect: "none" }) as unknown as XsSendOutcome,
  } as unknown as XsSender;

  it("threadRebind unset/false ⇒ NEVER appended (byte-identical); true ⇒ the convention line", () => {
    const off = createMessageSessionTool({ sender });
    const offJson = JSON.stringify(off.description);
    expect(offJson).not.toContain("acquire");
    expect(offJson).not.toContain("rebind");
    const off2 = createMessageSessionTool({ sender, threadRebind: false });
    expect(off2.description).toBe(off.description);

    const on = createMessageSessionTool({ sender, threadRebind: true });
    expect(on.description).toContain('thread(action:"rebind"');
    expect(on.description).toContain('thread(action:"acquire"');
    expect(on.description).toContain("FULL sessionId");
    expect(on.description.startsWith(off.description)).toBe(true);
    // the schema is untouched by the suffix
    expect(on.parameters).toBe(off.parameters);
  });
});
