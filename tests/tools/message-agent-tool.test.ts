import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageAgentTool,
  MessageAgentParams,
  messageAgentKindHint,
} from "../../src/tools/message-agent-tool.js";
import type { FabricRecord, NodeRef } from "../../src/core/message.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter, type FabricRouterConfig } from "../../src/fabric/router.js";

const testToolContext = {} as ExtensionToolContext;

const generation = () => 3;
const reportQuotaSnapshot = () => ({ used: 0, limit: 3, remaining: 3 });
const LEGACY_KIND: string = "finding"; // #34 legacy input
const params = { to: "r_PARENT01", kind: "report" as const, text: "status" };

describe("tools/message-agent", () => {
  it("passes the host-owned sender and generation to the router", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "admitted" as const, key: "k", seq: 1 }));
    const tool = createMessageAgentTool({
      router: { admit, reportQuotaSnapshot } as never,
      from: "r_CHILD001",
      generation,
    });

    const result = await tool.execute("call", params);

    expect(admit).toHaveBeenCalledWith("r_CHILD001", {
      ...params,
      generation: 3,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("routes @label through mention and returns structured details", async () => {
    const send = vi.fn(async () => ({ ok: false as const, status: "unknown_label" as const, label: "builder" }));
    const admit = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit, reportQuotaSnapshot } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    const result = await tool.execute("call", { to: "@builder", kind: "report", text: "status" });
    expect(send).toHaveBeenCalledWith("builder", "report", "status");
    expect(admit).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      ok: false,
      status: "unknown_label",
      label: "builder",
      reportQuota: { used: 0, limit: 3, remaining: 3 },
    });
  });

  it("keeps bare run ids and root on the original admission path", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 }));
    const send = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit, reportQuotaSnapshot } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    await tool.execute("call", { to: "root", kind: "report", text: "status" });
    await tool.execute("call", { to: "r_PARENT01", kind: "report", text: "status" });
    expect(send).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("documents root versus @label addressing in the to schema", () => {
    const description = (MessageAgentParams.properties.to as { description: string }).description;
    expect(description).toContain('"root" for the root session');
    expect(description).toContain("@label for a registered top-level agent");
  });

  it("surfaces a synchronous router rejection as a failed tool call", async () => {
    const tool = createMessageAgentTool({
      router: {
        reportQuotaSnapshot,
        admit: () => {
          throw new Error("message not authorized");
        },
      } as never,
      from: "r_CHILD001",
      generation,
    });
    await expect(tool.execute("call", params)).rejects.toThrow("message not authorized");
  });

  it("still rejects with the router text when the sender is not running (no kind guidance appended)", async () => {
    const tool = createMessageAgentTool({
      router: {
        reportQuotaSnapshot,
        admit: () => {
          throw new Error("sender is not running");
        },
      } as never,
      from: "r_CHILD001",
      generation,
    });
    await expect(tool.execute("call", params)).rejects.toThrow("sender is not running");
  });
});

/** Real in-memory fabric (engine+tree+router), so the authorization shapes below are the shipped ones, not mocks. */
function makeFabric(edges: readonly (readonly [NodeRef, NodeRef])[], config: Partial<FabricRouterConfig> = {}) {
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store: new MemoryOutboxStore<FabricRecord>(),
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  for (const [parent, child] of edges) tree.append(parent, child);
  const nodes = new Set<NodeRef>(edges.flat());
  for (const node of nodes) if (node !== "root") tree.markRunning(node);
  const router = new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    {
      maxPerRun: 2,
      reportQuota: 2,
      directiveQuota: 2,
      deadLetterQuota: 1,
      maxChars: 100,
      progressTtlMs: 100,
      reconcileTtlMs: 100,
      rootInboxCap: 4,
      progressChannel: "display" as const,
      ...config,
    },
    () => 1,
  );
  return router;
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the tool call to fail");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("tools/message-agent kind guidance (#33)", () => {
  it("documents the four kind semantics in the tool description", () => {
    const tool = createMessageAgentTool({ router: {} as never, from: "r_CHILD001", generation });
    const description = tool.description;
    expect(description).toContain('"report" is injected into the target');
    expect(description).toContain('"progress" only renders in the TUI display');
    expect(description).toContain('"directive" may only be sent by a parent to its own child run');
    expect(description).toContain('the "result" channel');
  });

  it("passes a direct child's report to root through the real router", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([["root", "r_ABCD0001"]]),
      from: "r_ABCD0001",
      generation,
    });
    const result = await tool.execute("call", { to: "root", kind: "report", text: "question?" });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("rejects directive→root and appends self-correction guidance after the router text", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([["root", "r_ABCD0001"]]),
      from: "r_ABCD0001",
      generation,
    });
    const message = await errorMessage(tool.execute("call", { to: "root", kind: "directive", text: "do x" }));
    expect(message.startsWith("message not authorized")).toBe(true);
    expect(message).toContain('kind "directive" may only be sent by a parent');
    expect(message).toContain("do not switch kind or address to bypass authorization");
    expect(message).not.toContain('use kind:"report" instead');
    expect(message).toContain("the model never sees it");
  });

  it("rejects a grandchild's report→root and points at the direct parent / result channel", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([
        ["root", "r_M1DD9E01"],
        ["r_M1DD9E01", "r_9RAND922"],
      ]),
      from: "r_9RAND922",
      generation,
    });
    const message = await errorMessage(tool.execute("call", { to: "root", kind: "report", text: "question?" }));
    expect(message.startsWith("message not authorized")).toBe(true);
    expect(message).toContain("direct parent");
    expect(message).toContain('the "result" channel');
    // The very same grandchild CAN reach its direct parent — that is the correction the hint suggests.
    const up = await tool.execute("call", { to: "r_M1DD9E01", kind: "report", text: "question?" });
    expect(up.details).toMatchObject({ ok: true });
  });

  it("hints at the mention route limits for @label denials", () => {
    const hint = messageAgentKindHint({ to: "@builder", kind: "directive" });
    expect(hint).toContain("can_message: mention");
    expect(hint).toContain('kind "directive" is parent-to-child only');
  });

  it("lists the sender's effective can_message set in the report/progress hint", () => {
    const hint = messageAgentKindHint({ to: "root", kind: "report" });
    expect(hint).toContain("(parent; default: direct parent only)");
  });
  it("#34 T-U3: execute rejects a pre-#34 kind before router/mention, listing the valid kinds", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 }));
    const send = vi.fn(async () => ({
      ok: true as const,
      status: "resumed" as const,
      label: "l",
      runId: "r_RUNRUN01",
    }));
    for (const to of ["root", "@lbl"]) {
      const tool = createMessageAgentTool({
        router: { admit, reportQuotaSnapshot } as never,
        mention: { send } as never,
        from: "r_CHILD001",
        generation,
      });
      const message = await errorMessage(tool.execute("call", { to, kind: LEGACY_KIND as never, text: "x" }));
      expect(message.startsWith("message_agent: unknown kind — valid kinds:")).toBe(true);
      expect(message).not.toContain("message not authorized");
      for (const kind of ['"report"', '"progress"', '"directive"']) expect(message).toContain(kind);
    }
    expect(admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // The guard precedes the wake handling too: a wake-on tool answers the same way before any wake logic.
    const wakeTool = createMessageAgentTool({
      router: { admit, reportQuotaSnapshot } as never,
      from: "r_CHILD001",
      generation,
      wakeOn: true,
    });
    const wakeMessage = await errorMessage(
      wakeTool.execute("call", { to: "root", kind: LEGACY_KIND as never, text: "x", wake: true } as never),
    );
    expect(wakeMessage.startsWith("message_agent: unknown kind — valid kinds:")).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
});

it("shows report receipt and exhaustion guidance in model text, including mention", async () => {
  const router = makeFabric([
    ["root", "r_ABCD0001"],
    ["root", "r_TARGET01"],
  ]);
  const { createMentionChannel } = await import("../../src/fabric/mention.js");
  const mention = createMentionChannel({
    router,
    registry: { resolve: () => ({ runId: "r_TARGET01", type: "worker", parent: "root" }) },
    query: { get: () => ({ status: "running" }) as never },
    spawn: {
      spawn: async () => {
        throw new Error("not used");
      },
    },
    from: "r_ABCD0001",
    generation,
    canMessage: ["mention"],
  });
  const tool = createMessageAgentTool({ router, mention, from: "r_ABCD0001", generation });
  const result = await tool.execute("call", { to: "@builder", kind: "report", text: "x" });
  expect(result.details).toMatchObject({ ok: true, quota: { used: 1, limit: 2, remaining: 1 } });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: `${JSON.stringify(result.details)}（report 1/2 已用，剩 1 次）`,
  });
  await tool.execute("call", { to: "root", kind: "report", text: "x" });
  const exhausted = await tool.execute("call", { to: "@builder", kind: "report", text: "x" });
  expect(exhausted.details).toMatchObject({ status: "quota_exhausted", used: 2, quota: 2 });
  expect(exhausted.content[0]).toMatchObject({
    text: expect.stringContaining("请勿再试；请在最终结果或完成汇报中提供信息"),
  });
});

describe("report quota on all exits", () => {
  it.each(["sync throw", "async reject", "post-reservation level failure"] as const)(
    "returns the reserved receipt and error in model text on %s",
    async (failure) => {
      const { createMentionChannel } = await import("../../src/fabric/mention.js");
      const router = makeFabric([
        ["root", "r_ABCD0001"],
        ["root", "r_TARGET01"],
      ]);
      const spawn =
        failure === "sync throw"
          ? () => {
              throw new Error("spawn rejected unexpectedly");
            }
          : async () => {
              throw new Error("spawn rejected unexpectedly");
            };
      const mention = createMentionChannel({
        router,
        registry: { resolve: () => ({ runId: "r_TARGET01", type: "worker", parent: "root" }) },
        query: { get: () => ({ status: "completed" }) as never },
        spawn: { spawn: spawn as never },
        from: "r_ABCD0001",
        generation,
        canMessage: ["mention"],
        ...(failure === "post-reservation level failure"
          ? {
              level: {
                levelOf: () => {
                  throw new Error("level failed");
                },
              },
            }
          : {}),
      });
      const tool = createMessageAgentTool({ router, mention, from: "r_ABCD0001", generation });
      const result = await tool.execute("call", { to: "@builder", kind: "report", text: "x" });
      const message = (result.content[0] as { text: string }).text;
      expect(result.details).toMatchObject({
        ok: false,
        status: "resume_failed",
        quota: { used: 1, limit: 2, remaining: 1 },
      });
      expect(message).toContain("message_agent: resume failed");
      expect(JSON.stringify(result)).not.toContain("spawn rejected unexpectedly");
      expect(JSON.stringify(result)).not.toContain("level failed");
      expect(message).toContain("不能据此证明没有副作用");
      expect(message).toContain("额度不退款");
      expect(message).toContain("report 1/2 已用，剩 1 次");
      const next = await tool.execute("call", { to: "root", kind: "report", text: "x" });
      expect(next.details).toMatchObject({ quota: { used: 2, limit: 2, remaining: 0 } });
      const exhausted = await tool.execute("call", { to: "root", kind: "report", text: "x" });
      expect(exhausted.details).toMatchObject({
        status: "quota_exhausted",
        used: 2,
        quota: 2,
        reportQuota: { used: 2, limit: 2, remaining: 0 },
      });
      expect((exhausted.content[0] as { text: string }).text).toContain("report 2/2 已用，剩 0 次");
    },
  );

  it.each([
    { ok: false, status: "unknown_label", label: "x" },
    { ok: false, status: "not_root_child", label: "x", runId: "r_TARGET01" },
    { ok: false, status: "not_authorized", label: "x", runId: "r_TARGET01" },
    { ok: false, status: "target_not_ready", label: "x", runId: "r_TARGET01" },
    { ok: false, status: "not_wakeable", reason: "legacy_unknown" },
    { ok: false, status: "target_backpressure", key: "k", seq: 1, retryAfterMs: 0 },
    { ok: false, status: "resume_failed", label: "x", error: "failed" },
  ])("adds ledger snapshot to $status without spending", async (rejection) => {
    const router = makeFabric([["root", "r_ABCD0001"]]);
    const mention = { send: async () => rejection } as never;
    const tool = createMessageAgentTool({ router, mention, from: "r_ABCD0001", generation });
    const result = await tool.execute("call", { to: "@x", kind: "report", text: "x" });
    expect(result.details).toMatchObject({
      ...rejection,
      ...(rejection.status === "resume_failed" ? { error: "message_agent: resume failed" } : {}),
      reportQuota: { used: 0, limit: 2, remaining: 2 },
    });
    expect((result.content[0] as { text: string }).text).toContain("report 0/2 已用，剩 2 次");
    expect(router.reportQuotaSnapshot("r_ABCD0001")).toEqual({ used: 0, limit: 2, remaining: 2 });
  });

  it("covers real unknown label and root backpressure without spending quota", async () => {
    const router = makeFabric([
      ["root", "r_ABCD0001"],
      ["root", "r_SENDER02"],
      ["root", "r_SENDER03"],
    ]);
    const tool = createMessageAgentTool({ router, from: "r_ABCD0001", generation });
    const unknown = await tool.execute("call", { to: "@missing", kind: "report", text: "x" });
    expect(unknown.details).toMatchObject({
      status: "unknown_label",
      reportQuota: { used: 0, limit: 2, remaining: 2 },
    });
    for (const from of ["r_SENDER02", "r_SENDER03"] as const) {
      for (let i = 0; i < 2; i++)
        expect(router.admit(from, { to: "root", kind: "report", text: "x", generation: 3 }).ok).toBe(true);
    }
    const blocked = await tool.execute("call", { to: "root", kind: "report", text: "x" });
    expect(blocked.details).toMatchObject({
      status: "target_backpressure",
      reportQuota: { used: 0, limit: 2, remaining: 2 },
    });
    expect((blocked.content[0] as { text: string }).text).toContain("report 0/2 已用，剩 2 次");
    expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
  });

  it("adds quota to report throws and never adds it to progress or directive", async () => {
    const router = makeFabric([
      ["root", "r_ABCD0001"],
      ["r_ABCD0001", "r_ABCD0002"],
    ]);
    const tool = createMessageAgentTool({ router, from: "r_ABCD0001", generation, wakeOn: true });
    await expect(tool.execute("call", { to: "root", kind: "report", text: "x", wake: "bad" } as never)).rejects.toThrow(
      "report 0/2 已用，剩 2 次",
    );
    const progress = await tool.execute("call", { to: "root", kind: "progress", text: "x" });
    const directive = await tool.execute("call", { to: "r_ABCD0002", kind: "directive", text: "x" });
    for (const r of [progress, directive]) {
      expect(r.details).not.toHaveProperty("reportQuota");
      expect(r.details).not.toHaveProperty("quota");
      expect((r.content[0] as { text: string }).text).not.toContain("report 0/2");
    }
  });
});

// #84 D1 — real admission/mention implementations, controlled ports only; no host delivery.
describe("message_agent admission-only boundary advice (#84 D1)", () => {
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

  it.each(["progress", "report", "directive"] as const)(
    "does not spend a denied %s or teach kind switching",
    async (kind) => {
      const router = makeFabric([
        ["root", "r_PARENT01"],
        ["r_PARENT01", "r_ABCD0001"],
      ]);
      const admit = vi.spyOn(router, "admit");
      const tool = createMessageAgentTool({ router, from: "r_ABCD0001", generation });
      const message = await errorMessage(
        tool.execute("c", { to: "root", kind, text: "question" }, undefined, undefined, testToolContext),
      );
      expect(message).toContain("message not authorized");
      expect(message).toContain("do not switch kind or address to bypass authorization");
      expect(message).not.toContain('use kind:"report" instead');
      expect(admit).toHaveBeenCalledTimes(1);
      expect(router.rootInbox()).toBe(0);
      expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
    },
  );

  it.each(["progress", "report", "directive"] as const)(
    "exhausted %s stops retries without another admission",
    async (kind) => {
      const router = makeFabric([["root", "r_ABCD0001"]]);
      const from = kind === "directive" ? "root" : "r_ABCD0001";
      const to = kind === "directive" ? "r_ABCD0001" : "root";
      const tool = createMessageAgentTool({ router, from, generation });
      for (let i = 0; i < 2; i++)
        expect(
          (await tool.execute("c", { to, kind, text: "x" }, undefined, undefined, testToolContext)).details,
        ).toMatchObject({ ok: true });
      const admit = vi.spyOn(router, "admit");
      const exhausted = await tool.execute("c", { to, kind, text: "x" }, undefined, undefined, testToolContext);
      expect(exhausted.details).toMatchObject({ ok: false, status: "quota_exhausted", kind, used: 2, quota: 2 });
      expect(text(exhausted)).toContain("不要换 kind、目标或省略 wake 绕过额度");
      expect(admit).toHaveBeenCalledTimes(1);
      expect(router.reportQuotaSnapshot(from).used).toBe(kind === "report" ? 2 : 0);
    },
  );

  it("capacity failure keeps retryAfterMs=0, no guessed delay and no quota charge", async () => {
    const router = makeFabric([["root", "r_ABCD0001"]], { rootInboxCap: 0 });
    const admit = vi.spyOn(router, "admit");
    const result = await createMessageAgentTool({ router, from: "r_ABCD0001", generation }).execute(
      "c",
      {
        to: "root",
        kind: "report",
        text: "x",
      },
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toMatchObject({
      status: "target_backpressure",
      retryAfterMs: 0,
      reportQuota: { used: 0, remaining: 2 },
    });
    expect(text(result)).toContain("等待目标消费已有消息");
    expect(text(result)).not.toMatch(/\d+\s*(秒|分钟|ms|s 后)/);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(router.rootInbox()).toBe(0);
    expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
  });

  it("not_wakeable preserves the exclusion and never wakes or spends", async () => {
    const router = makeFabric([["root", "r_ABCD0001"]], {
      wakePolicy: {
        levelOf: () => 0,
        hopAllowed: () => true,
        perRunQuota: 2,
        reviveGate: () => ({ refuse: "user_aborted" }),
      },
    });
    router.onRunSettled("r_ABCD0001");
    const admit = vi.spyOn(router, "admit");
    const result = await createMessageAgentTool({ router, from: "root", generation, wakeOn: true }).execute(
      "c",
      {
        to: "r_ABCD0001",
        kind: "directive",
        text: "x",
        wake: true,
      } as never,
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toEqual({ ok: false, status: "not_wakeable", reason: "user_aborted" });
    expect(text(result)).toContain("不要改 wake 或路由绕过");
    expect(admit).toHaveBeenCalledTimes(1);
    expect(router.wakeUsed("root")).toBe(0);
  });

  it.each(["unknown_label", "not_root_child", "not_authorized", "target_not_ready"] as const)(
    "real mention %s has safe next steps and no spawn/admission",
    async (status) => {
      const { createMentionChannel } = await import("../../src/fabric/mention.js");
      const router = makeFabric([
        ["root", "r_ABCD0001"],
        ["root", "r_TARGET01"],
      ]);
      const admit = vi.spyOn(router, "admit");
      const spawn = vi.fn();
      const mention = createMentionChannel({
        router,
        registry: {
          resolve: () =>
            status === "unknown_label"
              ? undefined
              : { runId: "r_TARGET01", type: "worker", parent: status === "not_root_child" ? "r_ABCD0001" : "root" },
        },
        query: { get: () => ({ status: "pending_start" }) as never },
        spawn: { spawn },
        from: "r_ABCD0001",
        generation,
        canMessage: status === "not_authorized" ? [] : ["mention"],
      });
      const result = await createMessageAgentTool({ router, mention, from: "r_ABCD0001", generation }).execute(
        "c",
        {
          to: "@builder",
          kind: "report",
          text: "x",
        },
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toMatchObject({ ok: false, status, reportQuota: { used: 0, limit: 2, remaining: 2 } });
      expect(text(result).split("\n")[1]).toBeTruthy();
      expect(text(result)).toMatch(/确认/);
      expect(admit).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
    },
  );

  it("lifecycle errors are whitelisted and remain failures without retries", async () => {
    for (const frozen of [false, true]) {
      const router = makeFabric([["root", "r_ABCD0001"]]);
      if (frozen) router.freeze();
      else router.onRunSettled("r_ABCD0001");
      const admit = vi.spyOn(router, "admit");
      const message = await errorMessage(
        createMessageAgentTool({ router, from: "r_ABCD0001", generation }).execute(
          "c",
          {
            to: "root",
            kind: "report",
            text: "x",
          },
          undefined,
          undefined,
          testToolContext,
        ),
      );
      expect(message).toContain(frozen ? "shutting down" : "sender is not running");
      expect(message).toContain("停止重试");
      expect(admit).toHaveBeenCalledTimes(1);
      expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
    }
  });

  it.each([new Error("SECRET_provider_token"), "SECRET_non_error"])(
    "does not leak arbitrary port exceptions or their cause",
    async (failure) => {
      const { createMentionChannel } = await import("../../src/fabric/mention.js");
      const router = makeFabric([["root", "r_ABCD0001"]]);
      const resolve = vi.fn(() => {
        throw failure;
      });
      const spawn = vi.fn();
      const mention = createMentionChannel({
        router,
        registry: { resolve },
        query: { get: vi.fn() },
        spawn: { spawn },
        from: "r_ABCD0001",
        generation,
      });
      const message = await errorMessage(
        createMessageAgentTool({ router, mention, from: "r_ABCD0001", generation }).execute(
          "c",
          {
            to: "@builder",
            kind: "report",
            text: "x",
          },
          undefined,
          undefined,
          testToolContext,
        ),
      );
      expect(message).toContain("unexpected failure");
      expect(message).toContain("不要自动重发正文");
      expect(message).not.toContain("SECRET");
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(router.reportQuotaSnapshot("r_ABCD0001").used).toBe(0);
    },
  );

  it("unknown kind never reflects arbitrary input or reaches admission", async () => {
    const router = makeFabric([["root", "r_ABCD0001"]]);
    const admit = vi.spyOn(router, "admit");
    const message = await errorMessage(
      createMessageAgentTool({ router, from: "r_ABCD0001", generation }).execute(
        "c",
        {
          to: "root",
          kind: "SECRET_kind" as never,
          text: "x",
        },
        undefined,
        undefined,
        testToolContext,
      ),
    );
    expect(message).toContain("unknown kind");
    expect(message).not.toContain("SECRET");
    expect(admit).not.toHaveBeenCalled();
  });
});
